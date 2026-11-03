import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../lib/auth";
import {
  applyClassificationChange,
  assignClassification,
  classificationCatalogue,
  classificationFacets,
  classificationHistory,
  createClassificationTag,
  deprecateClassificationTag,
  discardClassificationDraft,
  downloadClassification,
  grantClassificationManager,
  previewClassification,
  readClassificationTag,
  revokeClassificationManager,
  saveClassificationFieldPolicy,
  saveClassificationTag,
  searchClassification,
  stashClassificationTag,
} from "../../../../../../lib/classification";
import { DocumentError } from "../../../../../../lib/document";
import { repository } from "../../../../../../lib/repository";

const handling = z.enum(["metadata", "restrict"]);
const access = z.object({ userId: z.string().trim().min(1).max(200), canView: z.boolean(), canAssign: z.boolean(), canHistory: z.boolean() }).strict();
const save = {
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
  label: z.string().trim().min(1).max(80),
  parentId: z.string().uuid().nullable(),
  documents: z.boolean(),
  collections: z.array(z.string().trim().min(1).max(80)).max(40),
  handling,
  clearedUserIds: z.array(z.string().trim().min(1).max(200)).max(100),
};
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), code: z.string().trim().min(1).max(32), ...save }).strict(),
  z.object({ action: z.literal("save"), tagId: z.string().uuid(), ...save }).strict(),
  z.object({ action: z.literal("stash"), tagId: z.string().uuid(), ...save }).strict(),
  z.object({ action: z.literal("discard-draft"), tagId: z.string().uuid(), operationId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("deprecate"), tagId: z.string().uuid(), operationId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("apply"), operationId: z.string().uuid(), previewId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("assign"), operationId: z.string().uuid(), targetKind: z.enum(["page", "record"]), targetId: z.string().trim().min(1).max(200), expectedVersion: z.number().int().nonnegative(), tagIds: z.array(z.string().uuid()).max(100) }).strict(),
  z.object({ action: z.literal("download"), operationId: z.string().uuid(), targetKind: z.enum(["page", "record"]), targetId: z.string().trim().min(1).max(200), expectedVersion: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal("grant-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("revoke-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("field-policy"), operationId: z.string().uuid(), scopeKey: z.string().trim().min(1).max(80), sensitive: z.boolean(), expectedVersion: z.number().int().nonnegative(), access: z.array(access).max(100) }).strict(),
]);

async function workspaceId(params: Promise<{ id: string }>) {
  const id = (await params).id;
  if (!id || id.length > 200) throw new DocumentError("Classification is restricted or unavailable.", "not_found", 404);
  return id;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const id = await workspaceId(params);
    const url = new URL(request.url);
    const pages = await repository(localPreview(request));
    const view = url.searchParams.get("view");
    const tagId = url.searchParams.get("tagId");
    if (view === "tag") {
      if (!tagId) throw new DocumentError("Classification is restricted or unavailable.", "not_found", 404);
      return readClassificationTag(pages, actor, id, tagId);
    }
    if (view === "search") {
      if (!tagId) throw new DocumentError("Classification is restricted or unavailable.", "not_found", 404);
      return searchClassification(pages, actor, id, tagId);
    }
    if (view === "facets") {
      const kind = url.searchParams.get("kind");
      if (kind !== "page" && kind !== "record") throw new DocumentError("Check the classification request.", "classification_validation", 422);
      return classificationFacets(pages, actor, id, { kind, collection: url.searchParams.get("collection") });
    }
    if (view === "history") {
      const targetKind = url.searchParams.get("targetKind");
      return classificationHistory(pages, actor, id, {
        tagId,
        targetKind: targetKind === "page" || targetKind === "record" ? targetKind : null,
        targetId: url.searchParams.get("targetId"),
      });
    }
    if (view === "preview") {
      const action = url.searchParams.get("action");
      if (!tagId || (action !== "merge" && action !== "remove")) throw new DocumentError("Classification is restricted or unavailable.", "not_found", 404);
      return previewClassification(pages, actor, id, { tagId, action, intoId: url.searchParams.get("intoId") });
    }
    return classificationCatalogue(pages, actor, id, { pageId: url.searchParams.get("pageId"), recordId: url.searchParams.get("recordId") });
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const parsed = command.safeParse(await readJson(request, 64_000));
    if (!parsed.success) throw new DocumentError("Check the classification request.", "classification_validation", 422);
    const pages = await repository(localPreview(request));
    const id = await workspaceId(params);
    const body = parsed.data;
    if (body.action === "create") return createClassificationTag(pages, actor, id, body);
    if (body.action === "save") return saveClassificationTag(pages, actor, id, body.tagId, body);
    if (body.action === "stash") return stashClassificationTag(pages, actor, id, body.tagId, body);
    if (body.action === "discard-draft") return discardClassificationDraft(pages, actor, id, body.tagId, body.operationId);
    if (body.action === "deprecate") return deprecateClassificationTag(pages, actor, id, body.tagId, body);
    if (body.action === "apply") return applyClassificationChange(pages, actor, id, body);
    if (body.action === "assign") return assignClassification(pages, actor, id, body);
    if (body.action === "download") return downloadClassification(pages, actor, id, body);
    if (body.action === "grant-manager") return grantClassificationManager(pages, actor, id, body);
    if (body.action === "revoke-manager") return revokeClassificationManager(pages, actor, id, body);
    return saveClassificationFieldPolicy(pages, actor, id, body);
  }, true);
}
