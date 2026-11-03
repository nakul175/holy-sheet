import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../lib/auth";
import {
  applyHierarchyImpact,
  discardHierarchyDraft,
  downloadHierarchy,
  grantHierarchyManager,
  hierarchyCatalogue,
  hierarchyHistory,
  hierarchyNodes,
  previewHierarchyImpact,
  readHierarchyRecord,
  revokeHierarchyManager,
  saveHierarchyConfig,
  saveHierarchyFieldPolicy,
  searchHierarchy,
  stashHierarchyConfig,
  stashHierarchyPlacement,
} from "../../../../../../lib/collection-hierarchy";
import { DocumentError } from "../../../../../../lib/document";
import { repository } from "../../../../../../lib/repository";

const access = z.object({ userId: z.string().trim().min(1).max(200), canView: z.boolean(), canAssign: z.boolean(), canHistory: z.boolean() }).strict();
const config = {
  operationId: z.string().uuid(),
  collection: z.string().trim().min(1).max(100),
  expectedVersion: z.number().int().nonnegative(),
  enabled: z.boolean(),
  allowRoots: z.boolean(),
  depthLimit: z.number().int().min(1).max(20),
};
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save-config"), ...config }).strict(),
  z.object({ action: z.literal("stash-config"), ...config }).strict(),
  z.object({ action: z.literal("stash-placement"), operationId: z.string().uuid(), collection: z.string().trim().min(1).max(100), recordId: z.string().uuid(), parentId: z.string().uuid().nullable(), expectedVersion: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal("discard-draft"), operationId: z.string().uuid(), collection: z.string().trim().min(1).max(100), kind: z.enum(["config", "placement"]), recordId: z.string().uuid().nullable().optional() }).strict(),
  z.object({ action: z.literal("apply"), operationId: z.string().uuid(), previewId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("download"), operationId: z.string().uuid(), collection: z.string().trim().min(1).max(100) }).strict(),
  z.object({ action: z.literal("grant-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("revoke-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("field-policy"), operationId: z.string().uuid(), collection: z.string().trim().min(1).max(100), sensitive: z.boolean(), expectedVersion: z.number().int().nonnegative(), access: z.array(access).max(100) }).strict(),
]);

async function workspaceId(params: Promise<{ id: string }>) {
  const id = (await params).id;
  if (!id || id.length > 200) throw new DocumentError("Collection hierarchy is restricted or unavailable.", "not_found", 404);
  return id;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const id = await workspaceId(params);
    const url = new URL(request.url);
    const pages = await repository(localPreview(request));
    const view = url.searchParams.get("view");
    const collection = url.searchParams.get("collection");
    if (view === "tree" || view === "list") {
      if (!collection) throw new DocumentError("Collection hierarchy is restricted or unavailable.", "not_found", 404);
      return hierarchyNodes(pages, actor, id, { collection, view, parentId: url.searchParams.get("parentId"), afterId: url.searchParams.get("afterId") });
    }
    if (view === "search") {
      if (!collection) throw new DocumentError("Collection hierarchy is restricted or unavailable.", "not_found", 404);
      return searchHierarchy(pages, actor, id, { collection, query: url.searchParams.get("q") ?? "" });
    }
    if (view === "history") {
      if (!collection) throw new DocumentError("Collection hierarchy is restricted or unavailable.", "not_found", 404);
      return hierarchyHistory(pages, actor, id, { collection, recordId: url.searchParams.get("recordId") });
    }
    if (view === "record") {
      const recordId = url.searchParams.get("recordId");
      if (!collection || !recordId) throw new DocumentError("Collection hierarchy is restricted or unavailable.", "not_found", 404);
      return readHierarchyRecord(pages, actor, id, collection, recordId);
    }
    if (view === "preview") {
      const action = url.searchParams.get("action");
      const recordId = url.searchParams.get("recordId");
      if (!collection || !recordId || (action !== "reparent" && action !== "archive" && action !== "delete")) throw new DocumentError("Collection hierarchy is restricted or unavailable.", "not_found", 404);
      return previewHierarchyImpact(pages, actor, id, { collection, recordId, action, parentId: url.searchParams.get("parentId") });
    }
    return hierarchyCatalogue(pages, actor, id);
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const parsed = command.safeParse(await readJson(request, 64_000));
    if (!parsed.success) throw new DocumentError("Check the hierarchy request.", "hierarchy_validation", 422);
    const pages = await repository(localPreview(request));
    const id = await workspaceId(params);
    const body = parsed.data;
    if (body.action === "save-config") return saveHierarchyConfig(pages, actor, id, body);
    if (body.action === "stash-config") return stashHierarchyConfig(pages, actor, id, body);
    if (body.action === "stash-placement") return stashHierarchyPlacement(pages, actor, id, body);
    if (body.action === "discard-draft") return discardHierarchyDraft(pages, actor, id, body);
    if (body.action === "apply") return applyHierarchyImpact(pages, actor, id, body);
    if (body.action === "download") return downloadHierarchy(pages, actor, id, body);
    if (body.action === "grant-manager") return grantHierarchyManager(pages, actor, id, body);
    if (body.action === "revoke-manager") return revokeHierarchyManager(pages, actor, id, body);
    return saveHierarchyFieldPolicy(pages, actor, id, body);
  }, true);
}
