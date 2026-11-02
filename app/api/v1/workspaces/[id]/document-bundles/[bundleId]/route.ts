import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../../lib/auth";
import { DocumentError } from "../../../../../../../lib/document";
import {
  archiveDocumentBundle,
  bundleHistory,
  discardDocumentBundleDraft,
  downloadDocumentBundle,
  previewDocumentBundle,
  publishDocumentBundle,
  readDocumentBundle,
  readPublishedSnapshot,
  saveDocumentBundle,
  shareDocumentBundle,
  stashDocumentBundle,
  unshareDocumentBundle,
} from "../../../../../../../lib/document-bundles";
import { repository } from "../../../../../../../lib/repository";

const member = z.object({
  pageId: z.string().trim().min(1).max(200),
  mode: z.enum(["live", "pinned"]),
  pinnedVersion: z.number().int().positive().nullable().optional(),
}).strict();
const save = {
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000),
  ownerId: z.string().trim().min(1).max(200),
  members: z.array(member).max(100),
};
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), ...save }).strict(),
  z.object({ action: z.literal("stash"), ...save }).strict(),
  z.object({ action: z.literal("discard-draft"), operationId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("publish"), operationId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("share"), operationId: z.string().uuid(), expectedVersion: z.number().int().positive(), subjectId: z.string().trim().min(1).max(200), role: z.enum(["viewer", "editor"]) }).strict(),
  z.object({ action: z.literal("unshare"), operationId: z.string().uuid(), expectedVersion: z.number().int().positive(), subjectId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("archive"), operationId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("download"), operationId: z.string().uuid(), expectedVersion: z.number().int().positive(), publicationId: z.string().uuid().nullable().optional() }).strict(),
]);

async function ids(params: Promise<{ id: string; bundleId: string }>) {
  const value = await params;
  if (!value.id || value.id.length > 200 || !z.string().uuid().safeParse(value.bundleId).success) throw new DocumentError("Document bundle unavailable", "not_found", 404);
  return value;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string; bundleId: string }> }) {
  return api(request, async actor => {
    const { id, bundleId } = await ids(params);
    const url = new URL(request.url);
    const pages = await repository(localPreview(request));
    const view = url.searchParams.get("view");
    const publicationId = url.searchParams.get("publicationId");
    if (view === "history") return bundleHistory(pages, actor, id, bundleId);
    if (view === "preview") return previewDocumentBundle(pages, actor, id, bundleId, publicationId);
    if (view === "snapshot") {
      if (!publicationId) throw new DocumentError("Document bundle unavailable", "not_found", 404);
      return readPublishedSnapshot(pages, actor, id, bundleId, publicationId);
    }
    return readDocumentBundle(pages, actor, id, bundleId);
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string; bundleId: string }> }) {
  return api(request, async actor => {
    const parsed = command.safeParse(await readJson(request, 64_000));
    if (!parsed.success) throw new DocumentError("Invalid document bundle request", "bundle_validation", 422);
    const { id, bundleId } = await ids(params);
    const pages = await repository(localPreview(request));
    const body = parsed.data;
    if (body.action === "save") return saveDocumentBundle(pages, actor, id, bundleId, body);
    if (body.action === "stash") return stashDocumentBundle(pages, actor, id, bundleId, body);
    if (body.action === "discard-draft") return discardDocumentBundleDraft(pages, actor, id, bundleId, body.operationId);
    if (body.action === "publish") return publishDocumentBundle(pages, actor, id, bundleId, body);
    if (body.action === "share") return shareDocumentBundle(pages, actor, id, bundleId, body);
    if (body.action === "unshare") return unshareDocumentBundle(pages, actor, id, bundleId, body);
    if (body.action === "archive") return archiveDocumentBundle(pages, actor, id, bundleId, body);
    return downloadDocumentBundle(pages, actor, id, bundleId, body);
  }, true);
}
