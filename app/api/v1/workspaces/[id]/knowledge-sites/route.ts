import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { DocumentError } from "../../../../../../lib/document";
import {
  activateKnowledgeSite,
  discardKnowledgeSiteDraft,
  downloadKnowledgeSite,
  grantKnowledgeSiteManager,
  knowledgeSiteCatalogue,
  knowledgeSiteHistory,
  previewKnowledgeSite,
  publishKnowledgeSite,
  readKnowledgeAsset,
  readKnowledgeDownload,
  readKnowledgeSite,
  renderKnowledgeSite,
  revokeKnowledgeSiteManager,
  rollbackKnowledgeSite,
  saveKnowledgeSite,
  searchKnowledgeSites,
  setKnowledgeSiteActions,
  unpublishKnowledgeSite,
} from "../../../../../../lib/knowledge-site";
import { repository } from "../../../../../../lib/repository";

const definition = z.record(z.string(), z.unknown());
const generation = z.number().int().positive();
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("configure"), operationId: z.string().uuid(), siteId: z.string().uuid().optional(), expectedVersion: z.number().int().nonnegative(), name: z.string().trim().min(1).max(80), definition }).strict(),
  z.object({ action: z.literal("discard-draft"), operationId: z.string().uuid(), siteId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("preview"), operationId: z.string().uuid(), siteId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("publish"), operationId: z.string().uuid(), siteId: z.string().uuid(), expectedVersion: z.number().int().positive(), audience: z.literal("public") }).strict(),
  z.object({ action: z.literal("unpublish"), operationId: z.string().uuid(), siteId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("rollback"), operationId: z.string().uuid(), siteId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("activate"), operationId: z.string().uuid(), siteId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("download"), operationId: z.string().uuid(), siteId: z.string().uuid(), expectedVersion: z.number().int().positive(), generation: generation.optional() }).strict(),
  z.object({ action: z.literal("actions"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200), expectedVersion: z.number().int().nonnegative(), actions: z.array(z.string()).max(12) }).strict(),
  z.object({ action: z.literal("grant-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("revoke-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
]);

function unavailable() {
  return new DocumentError("Knowledge sites are restricted or unavailable.", "not_found", 404);
}
async function workspaceId(params: Promise<{ id: string }>) {
  const id = (await params).id;
  if (!id || id.length > 200) throw unavailable();
  return id;
}
function generationOf(url: URL) {
  const raw = url.searchParams.get("generation");
  if (!raw) return null;
  if (!/^[1-9][0-9]{0,8}$/.test(raw)) throw unavailable();
  return Number(raw);
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const id = await workspaceId(params);
    const url = new URL(request.url);
    const pages = await repository(localPreview(request));
    const view = url.searchParams.get("view");
    const siteId = url.searchParams.get("siteId") ?? "";
    const generation = generationOf(url);
    if (view === "site") {
      if (!siteId) throw unavailable();
      return readKnowledgeSite(pages, actor, id, siteId);
    }
    if (view === "search") {
      const query = url.searchParams.get("q");
      if (!query) throw new DocumentError("Check the knowledge site.", "knowledge_site_validation", 422);
      return searchKnowledgeSites(pages, actor, id, query, generation);
    }
    if (view === "history") {
      if (!siteId) throw unavailable();
      return knowledgeSiteHistory(pages, actor, id, siteId);
    }
    if (view === "render") {
      if (!siteId) throw unavailable();
      return renderKnowledgeSite(pages, actor, id, siteId, generation);
    }
    if (view === "asset") {
      const mediaId = url.searchParams.get("mediaId") ?? "";
      if (!siteId || !mediaId) throw unavailable();
      return readKnowledgeAsset(pages, actor, id, siteId, mediaId, generation);
    }
    if (view === "download") {
      if (!siteId) throw unavailable();
      return readKnowledgeDownload(pages, actor, id, siteId, generation);
    }
    if (view) throw unavailable();
    return knowledgeSiteCatalogue(pages, actor, id);
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const parsed = command.safeParse(await readJson(request, 80_000));
    if (!parsed.success) throw new DocumentError("Check the knowledge site.", "knowledge_site_validation", 422);
    const pages = await repository(localPreview(request));
    const id = await workspaceId(params);
    const body = parsed.data;
    if (body.action === "configure") return saveKnowledgeSite(pages, actor, id, body);
    if (body.action === "discard-draft") return discardKnowledgeSiteDraft(pages, actor, id, body);
    if (body.action === "preview") return previewKnowledgeSite(pages, actor, id, body);
    if (body.action === "publish") return publishKnowledgeSite(pages, actor, id, body);
    if (body.action === "unpublish") return unpublishKnowledgeSite(pages, actor, id, body);
    if (body.action === "rollback") return rollbackKnowledgeSite(pages, actor, id, body);
    if (body.action === "activate") return activateKnowledgeSite(pages, actor, id, body);
    if (body.action === "actions") return setKnowledgeSiteActions(pages, actor, id, body);
    if (body.action === "grant-manager") return grantKnowledgeSiteManager(pages, actor, id, body);
    if (body.action === "revoke-manager") return revokeKnowledgeSiteManager(pages, actor, id, body);
    return downloadKnowledgeSite(pages, actor, id, body);
  }, true);
}
