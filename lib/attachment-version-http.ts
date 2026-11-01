import { z } from "zod";
import type { Actor } from "./auth";
import { readBytes, readJson } from "./auth";
import {
  assertNoDirectStorageKey,
  attachmentByteLimit,
  attachmentDeniedResponse,
  attachmentSessionKey,
  deleteAttachmentVersion,
  finishAttachmentVersion,
  issueAttachmentDownload,
  listAttachmentVersions,
  openAttachmentReference,
  pinAttachmentReference,
  redeemAttachmentDownload,
  reserveAttachmentVersion,
  restoreAttachmentVersion,
} from "./attachment-versions";
import { DocumentError } from "./document";
import { repository } from "./repository";

const uuid = z.string().uuid();
const tenant = { tenantId: uuid.optional(), recordId: uuid, fileId: uuid };
const reserveBody = z.object({ action: z.literal("reserve"), operationId: uuid, ...tenant, name: z.string().min(1).max(240), size: z.number().int().positive().max(attachmentByteLimit), note: z.string().max(500).optional(), fieldKey: z.string().max(100).optional() }).strict();
const restoreBody = z.object({ action: z.literal("restore"), operationId: uuid, ...tenant, versionNo: z.number().int().positive() }).strict();
const deleteBody = z.object({ action: z.literal("delete"), operationId: uuid, ...tenant, versionNo: z.number().int().positive(), reason: z.string().min(1).max(500), successorVersionNo: z.number().int().positive().optional() }).strict();
const pinBody = z.object({ action: z.literal("pin"), operationId: uuid, ...tenant, sourceKind: z.enum(["page", "record"]), sourceId: z.string().min(1).max(100), versionNo: z.number().int().positive().nullable() }).strict();
const downloadBody = z.object({ action: z.literal("download"), operationId: uuid, ...tenant, versionNo: z.number().int().positive() }).strict();
const mutation = z.discriminatedUnion("action", [reserveBody, restoreBody, deleteBody, pinBody, downloadBody]);

function unavailable() {
  return new DocumentError("This item is restricted or unavailable.", "not_found", 404);
}

function queryStorageKey(request: Request) {
  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) if (["key", "blobkey", "objectkey", "storagekey", "blob_key", "object_key", "storage_key"].includes(key.toLowerCase())) throw unavailable();
}

export async function getAttachmentVersions(request: Request, actor: Actor, workspaceId: string, local: boolean) {
  queryStorageKey(request);
  const url = new URL(request.url);
  const recordId = url.searchParams.get("recordId") ?? "";
  const fileId = url.searchParams.get("fileId") ?? "";
  const tenantId = url.searchParams.get("tenantId") ?? undefined;
  if (!uuid.safeParse(recordId).success || !uuid.safeParse(fileId).success || (tenantId && !uuid.safeParse(tenantId).success)) throw unavailable();
  const pages = await repository(local);
  const version = url.searchParams.get("versionNo");
  if (version) {
    const versionNo = Number(version);
    if (!Number.isSafeInteger(versionNo) || versionNo < 1) throw unavailable();
    return openAttachmentReference(pages, actor, workspaceId, { tenantId, recordId, fileId, versionNo });
  }
  const sourceKind = url.searchParams.get("sourceKind");
  const sourceId = url.searchParams.get("sourceId") ?? undefined;
  if (sourceKind && sourceKind !== "page" && sourceKind !== "record") throw unavailable();
  if ((sourceKind === "page" || sourceKind === "record") && sourceId) return openAttachmentReference(pages, actor, workspaceId, { tenantId, recordId, fileId, sourceKind, sourceId });
  return listAttachmentVersions(pages, actor, workspaceId, { tenantId, recordId, fileId });
}

export async function postAttachmentVersions(request: Request, actor: Actor, workspaceId: string, local: boolean) {
  queryStorageKey(request);
  const url = new URL(request.url);
  const pages = await repository(local);
  if (url.searchParams.get("reservationId")) {
    const reservationId = url.searchParams.get("reservationId") ?? "";
    const recordId = url.searchParams.get("recordId") ?? "";
    const operationId = request.headers.get("x-hs-operation-id") ?? "";
    const tenantId = url.searchParams.get("tenantId") ?? undefined;
    if (!uuid.safeParse(reservationId).success || !uuid.safeParse(recordId).success || !uuid.safeParse(operationId).success) throw unavailable();
    const bytes = new Uint8Array(await readBytes(request, attachmentByteLimit));
    return finishAttachmentVersion(pages, actor, workspaceId, { operationId, tenantId, recordId, reservationId, bytes });
  }
  const body = await readJson(request, 8_000);
  assertNoDirectStorageKey(body);
  const parsed = mutation.safeParse(body);
  if (!parsed.success) throw new DocumentError("Check the attachment request.", "attachment_validation", 400);
  const command = parsed.data;
  if (command.action === "reserve") return reserveAttachmentVersion(pages, actor, workspaceId, command);
  if (command.action === "restore") return restoreAttachmentVersion(pages, actor, workspaceId, command);
  if (command.action === "delete") return deleteAttachmentVersion(pages, actor, workspaceId, command);
  if (command.action === "pin") return pinAttachmentReference(pages, actor, workspaceId, command);
  return issueAttachmentDownload(pages, actor, workspaceId, { ...command, sessionKey: attachmentSessionKey(request) });
}

export function attachmentDownloadHeaders(file: { mime: string; name: string; bytes: Uint8Array }) {
  const headers = new Headers({
    "Content-Type": file.mime,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "private, no-store",
    Vary: "Cookie, Authorization",
    "Content-Length": String(file.bytes.byteLength),
    "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
  });
  return headers;
}

export async function downloadAttachment(request: Request, actor: Actor, workspaceId: string, token: string, local: boolean) {
  queryStorageKey(request);
  const file = await redeemAttachmentDownload(await repository(local), actor, workspaceId, token, attachmentSessionKey(request));
  return new Response(Buffer.from(file.bytes), { status: 200, headers: attachmentDownloadHeaders(file) });
}

export { attachmentDeniedResponse };
