import { z } from "zod";
import {
  attachmentTextConfigHistory,
  attachmentTextHistory,
  discardAttachmentTextDraft,
  downloadAttachmentText,
  grantAttachmentTextManager,
  listAttachmentText,
  previewAttachmentText,
  readAttachmentTextConfig,
  reindexAttachmentText,
  revokeAttachmentTextManager,
  saveAttachmentTextConfig,
  searchAttachmentText,
  stashAttachmentTextConfig,
} from "../../../../../../lib/attachment-text";
import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { DocumentError } from "../../../../../../lib/document";
import { repository } from "../../../../../../lib/repository";

const item = z.object({
  recordId: z.string().uuid(),
  fileId: z.string().uuid(),
  versionNo: z.number().int().positive().optional(),
  expectedVersion: z.number().int().positive().optional(),
}).strict();
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reindex"), operationId: z.string().uuid(), items: z.array(item).min(1).max(20) }).strict(),
  z.object({ action: z.literal("save"), operationId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), enabled: z.boolean(), language: z.literal("en") }).strict(),
  z.object({ action: z.literal("stash"), operationId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), enabled: z.boolean(), language: z.literal("en") }).strict(),
  z.object({ action: z.literal("discard-draft"), operationId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("grant-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("revoke-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("download"), operationId: z.string().uuid(), recordId: z.string().uuid(), versionId: z.string().uuid() }).strict(),
]);

async function workspaceId(params: Promise<{ id: string }>) {
  const id = (await params).id;
  if (!id || id.length > 200) throw new DocumentError("Attachment text is unavailable.", "not_found", 404);
  return id;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const url = new URL(request.url);
    const pages = await repository(localPreview(request));
    const id = await workspaceId(params);
    const view = url.searchParams.get("view");
    if (view === "config") return readAttachmentTextConfig(pages, actor, id);
    if (view === "catalogue") return listAttachmentText(pages, actor, id);
    if (view === "config-history") return attachmentTextConfigHistory(pages, actor, id);
    if (view === "history") return attachmentTextHistory(pages, actor, id, { recordId: url.searchParams.get("recordId") ?? "", fileId: url.searchParams.get("fileId") ?? "" });
    if (view === "preview") {
      const page = Number(url.searchParams.get("page"));
      return previewAttachmentText(pages, actor, id, { recordId: url.searchParams.get("recordId") ?? "", versionId: url.searchParams.get("versionId") ?? "", page });
    }
    if (view) throw new DocumentError("Attachment text is unavailable.", "not_found", 404);
    return searchAttachmentText(pages, actor, id, url.searchParams.get("q") ?? "");
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const parsed = command.safeParse(await readJson(request, 64_000));
    if (!parsed.success) throw new DocumentError("Invalid attachment text request", "attachment_text_validation", 422);
    const pages = await repository(localPreview(request));
    const id = await workspaceId(params);
    const body = parsed.data;
    if (body.action === "reindex") return reindexAttachmentText(pages, actor, id, body);
    if (body.action === "save") return saveAttachmentTextConfig(pages, actor, id, body);
    if (body.action === "stash") return stashAttachmentTextConfig(pages, actor, id, body);
    if (body.action === "discard-draft") return discardAttachmentTextDraft(pages, actor, id, body);
    if (body.action === "grant-manager") return grantAttachmentTextManager(pages, actor, id, body);
    if (body.action === "revoke-manager") return revokeAttachmentTextManager(pages, actor, id, body);
    return downloadAttachmentText(pages, actor, id, body);
  }, true);
}
