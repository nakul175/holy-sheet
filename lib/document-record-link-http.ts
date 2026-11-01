import { z } from "zod";
import type { Actor } from "./auth";
import { readJson } from "./auth";
import { DocumentError } from "./document";
import { linkDocumentRecord, listDocumentRecords, listPageRecords, listRecordDocuments, listUnlinkedFiles, registerLinkedFile, unlinkDocumentRecord, type DocType } from "./document-record-links";
import { repository } from "./repository";

const uuid = z.string().uuid();
const linkFields = { operationId: uuid, tenantId: uuid.optional(), docType: z.enum(["page", "file"]), docId: z.string().min(1).max(100), recordId: uuid };
const linkBody = z.object({ ...linkFields, action: z.literal("link") }).strict();
const unlinkBody = z.object({ ...linkFields, action: z.literal("unlink"), disposition: z.enum(["delete", "keep"]).optional() }).strict();
const registerBody = z.object({ action: z.literal("register-file"), operationId: uuid, tenantId: uuid.optional(), name: z.string().min(1).max(240), recordId: uuid, mediaId: uuid.optional() }).strict();
const mutation = z.discriminatedUnion("action", [linkBody, unlinkBody, registerBody]);
const pageMutation = z.discriminatedUnion("action", [
  z.object({ action: z.literal("link"), operationId: uuid, recordId: uuid }).strict(),
  z.object({ action: z.literal("unlink"), operationId: uuid, recordId: uuid, disposition: z.enum(["delete", "keep"]).optional() }).strict(),
]);

function day(value: string | null) {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new DocumentError("Check the document link request.", "document_link_validation", 400);
  return value;
}

export async function getWorkspaceDocumentLinks(request: Request, actor: Actor, workspaceId: string, local: boolean) {
  const url = new URL(request.url);
  const scopeName = url.searchParams.get("scope") ?? (url.searchParams.get("recordId") ? "record" : url.searchParams.get("docId") ? "document" : "");
  const tenantId = url.searchParams.get("tenantId") ?? undefined;
  if (tenantId && !uuid.safeParse(tenantId).success) throw new DocumentError("Check the document link request.", "document_link_validation", 400);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const pages = await repository(local);
  if (scopeName === "unlinked") return listUnlinkedFiles(pages, actor, workspaceId, { tenantId, cursor });
  if (scopeName === "record") {
    const recordId = url.searchParams.get("recordId") ?? "";
    if (!uuid.safeParse(recordId).success) throw new DocumentError("This item is restricted or unavailable.", "not_found", 404);
    return listRecordDocuments(pages, actor, workspaceId, { tenantId, recordId, type: url.searchParams.get("type") ?? undefined, owner: url.searchParams.get("owner") ?? undefined, updatedFrom: day(url.searchParams.get("updatedFrom")), updatedTo: day(url.searchParams.get("updatedTo")), cursor });
  }
  if (scopeName === "document") {
    const docType = url.searchParams.get("docType");
    const docId = url.searchParams.get("docId") ?? "";
    if (docType !== "page" && docType !== "file") throw new DocumentError("This item is restricted or unavailable.", "not_found", 404);
    return listDocumentRecords(pages, actor, workspaceId, { tenantId, docType, docId, cursor });
  }
  throw new DocumentError("Check the document link request.", "document_link_validation", 400);
}

export async function postWorkspaceDocumentLink(request: Request, actor: Actor, workspaceId: string, local: boolean) {
  const parsed = mutation.safeParse(await readJson(request, 8_000));
  if (!parsed.success) throw new DocumentError("Check the document link request.", "document_link_validation", 400);
  const pages = await repository(local);
  const body = parsed.data;
  if (body.action === "register-file") return registerLinkedFile(pages, actor, workspaceId, body);
  if (body.action === "unlink") return unlinkDocumentRecord(pages, actor, workspaceId, { ...body, docType: body.docType as DocType });
  return linkDocumentRecord(pages, actor, workspaceId, { ...body, docType: body.docType as DocType });
}

export async function getPageLinkedRecords(actor: Actor, pageId: string, cursor: string | undefined, local: boolean) {
  return listPageRecords(await repository(local), actor, pageId, cursor);
}

export async function postPageLinkedRecord(request: Request, actor: Actor, pageId: string, local: boolean) {
  const parsed = pageMutation.safeParse(await readJson(request, 4_000));
  if (!parsed.success) throw new DocumentError("Check the document link request.", "document_link_validation", 400);
  const pages = await repository(local);
  const workspace = await pages.db.transaction(async tx => (await tx.query<{ workspace_id: string }>("SELECT workspace_id FROM hs_pages WHERE id=$1", [pageId])).rows[0]?.workspace_id ?? "");
  const body = parsed.data;
  if (body.action === "unlink") return unlinkDocumentRecord(pages, actor, workspace, { ...body, docType: "page", docId: pageId });
  return linkDocumentRecord(pages, actor, workspace, { ...body, docType: "page", docId: pageId });
}
