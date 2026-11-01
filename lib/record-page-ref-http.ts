import { z } from "zod";
import type { Actor } from "./auth";
import { DocumentError } from "./document";
import { readJson } from "./auth";
import { repository } from "./repository";
import { listRecordViews, searchRecordRefs } from "./record-page-ref-picker";
import { pollRecordPageRefs, requestRecordPageAccess, resolveRecordPageRefs, restoreRecordPageRef } from "./record-page-ref-store";

const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/);
const id = z.string().uuid();
const resolveBody = z.object({
  records: z.array(z.object({ recordId: id, collectionId: key, fields: z.array(key).max(12) }).strict()).max(80),
  views: z.array(z.object({ viewId: id, collectionId: key, layout: z.enum(["table", "list"]), columns: z.array(key).min(1).max(12), limit: z.number().int().min(1).max(25) }).strict()).max(3),
}).strict();
const pollBody = z.object({ recordIds: z.array(id).max(80), viewIds: z.array(id).max(9), cursor: z.string().regex(/^\d+$/).max(30) }).strict();
const accessBody = z.object({ operationId: id, recordId: id }).strict();

function fault(request: Request) {
  if (process.env.HS_RECORD_REF_FAULT === "1" && request.headers.get("x-hs-record-ref-fault") === "1") throw new DocumentError("Couldn't load records", "record_ref_unavailable", 500);
}

export async function resolveRecordRefsHttp(request: Request, actor: Actor, workspaceId: string, local: boolean) {
  fault(request);
  const parsed = resolveBody.safeParse(await readJson(request, 64_000));
  if (!parsed.success) throw new DocumentError("Invalid record reference request.", "record_ref_validation", 400);
  const pages = await repository(local);
  return pages.db.transaction(tx => resolveRecordPageRefs(tx, actor, workspaceId, parsed.data));
}

export async function pollRecordRefsHttp(request: Request, actor: Actor, workspaceId: string, local: boolean) {
  const parsed = pollBody.safeParse(await readJson(request, 16_000));
  if (!parsed.success) throw new DocumentError("Invalid record reference request.", "record_ref_validation", 400);
  const pages = await repository(local);
  return pages.db.transaction(tx => pollRecordPageRefs(tx, actor, workspaceId, parsed.data));
}

export async function requestRecordAccessHttp(request: Request, actor: Actor, workspaceId: string, local: boolean) {
  const parsed = accessBody.safeParse(await readJson(request, 4_000));
  if (!parsed.success) throw new DocumentError("Invalid record reference request.", "record_ref_validation", 400);
  const pages = await repository(local);
  return pages.db.transaction(tx => requestRecordPageAccess(tx, actor, workspaceId, parsed.data));
}

export async function restoreRecordRefHttp(request: Request, actor: Actor, workspaceId: string, local: boolean) {
  const parsed = accessBody.safeParse(await readJson(request, 4_000));
  if (!parsed.success) throw new DocumentError("Invalid record reference request.", "record_ref_validation", 400);
  const pages = await repository(local);
  return pages.db.transaction(tx => restoreRecordPageRef(tx, actor, workspaceId, parsed.data));
}

export async function searchRecordRefsHttp(request: Request, actor: Actor, workspaceId: string, local: boolean) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const collection = url.searchParams.get("collection") ?? undefined;
  if (query.length > 200 || (collection && !key.safeParse(collection).success)) throw new DocumentError("Invalid record reference request.", "record_ref_validation", 400);
  return searchRecordRefs(await repository(local), actor, workspaceId, query, collection);
}

export async function listRecordViewsHttp(request: Request, actor: Actor, workspaceId: string, local: boolean) {
  const collection = new URL(request.url).searchParams.get("collection") ?? undefined;
  if (collection && !key.safeParse(collection).success) throw new DocumentError("Invalid record reference request.", "record_ref_validation", 400);
  return listRecordViews(await repository(local), actor, workspaceId, collection);
}
