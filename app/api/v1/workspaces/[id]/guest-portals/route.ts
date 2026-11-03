import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { DocumentError } from "../../../../../../lib/document";
import {
  activateGuestPortal,
  addGuestComment,
  citeGuestFile,
  discardGuestPortalDraft,
  downloadGuestPortal,
  grantGuestPortalManager,
  guestPortalCatalogue,
  guestPortalHistory,
  linkGuestIdentity,
  openGuestPortal,
  pauseGuestPortal,
  previewGuestPortal,
  readGuestPortal,
  revokeGuestPortal,
  revokeGuestPortalManager,
  saveGuestPortal,
  searchGuestPortals,
  setGuestPortalActions,
  stashGuestPortal,
  submitGuestForm,
} from "../../../../../../lib/guest-portal";
import { repository } from "../../../../../../lib/repository";

const definition = z.record(z.string(), z.unknown());
const values = z.record(z.string(), z.string().max(4000));
const claim = { urlToken: z.string().max(200).optional(), domain: z.string().max(200).optional() };
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("configure"), operationId: z.string().uuid(), portalId: z.string().uuid().optional(), expectedVersion: z.number().int().nonnegative(), name: z.string().trim().min(1).max(80), definition }).strict(),
  z.object({ action: z.literal("stash"), operationId: z.string().uuid(), portalId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), name: z.string().trim().min(1).max(80), definition }).strict(),
  z.object({ action: z.literal("discard-draft"), operationId: z.string().uuid(), portalId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("preview"), operationId: z.string().uuid(), portalId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("pause"), operationId: z.string().uuid(), portalId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("revoke"), operationId: z.string().uuid(), portalId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("activate"), operationId: z.string().uuid(), portalId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("link-identity"), operationId: z.string().uuid(), portalId: z.string().uuid(), expectedVersion: z.number().int().positive(), suiteSubject: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("actions"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200), expectedVersion: z.number().int().nonnegative(), actions: z.array(z.string()).max(12) }).strict(),
  z.object({ action: z.literal("grant-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("revoke-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("form"), operationId: z.string().uuid(), portalId: z.string().uuid(), recordId: z.string().uuid(), expectedVersion: z.number().int().positive(), recordVersion: z.number().int().positive(), values, ...claim }).strict(),
  z.object({ action: z.literal("comment"), operationId: z.string().uuid(), portalId: z.string().uuid(), recordId: z.string().uuid(), expectedVersion: z.number().int().positive(), body: z.string().max(4000), ...claim }).strict(),
  z.object({ action: z.literal("file"), operationId: z.string().uuid(), portalId: z.string().uuid(), recordId: z.string().uuid(), expectedVersion: z.number().int().positive(), name: z.string().trim().min(1).max(200), ...claim }).strict(),
  z.object({ action: z.literal("download"), operationId: z.string().uuid(), portalId: z.string().uuid(), expectedVersion: z.number().int().positive(), ...claim }).strict(),
]);

async function workspaceId(params: Promise<{ id: string }>) {
  const id = (await params).id;
  if (!id || id.length > 200) throw new DocumentError("Guest portals are restricted or unavailable.", "not_found", 404);
  return id;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const id = await workspaceId(params);
    const url = new URL(request.url);
    const pages = await repository(localPreview(request));
    const view = url.searchParams.get("view");
    const portalId = url.searchParams.get("portalId") ?? "";
    const claim = { urlToken: url.searchParams.get("urlToken"), domain: url.searchParams.get("domain") };
    if (view === "portal") {
      if (!portalId) throw new DocumentError("Guest portals are restricted or unavailable.", "not_found", 404);
      return readGuestPortal(pages, actor, id, portalId);
    }
    if (view === "open") {
      if (!portalId) throw new DocumentError("Guest portals are restricted or unavailable.", "not_found", 404);
      return openGuestPortal(pages, actor, id, portalId, claim);
    }
    if (view === "search") {
      const query = url.searchParams.get("q");
      if (!query) throw new DocumentError("Check the portal.", "guest_portal_validation", 422);
      return searchGuestPortals(pages, actor, id, query);
    }
    if (view === "history") {
      if (!portalId) throw new DocumentError("Guest portals are restricted or unavailable.", "not_found", 404);
      return guestPortalHistory(pages, actor, id, portalId);
    }
    if (view) throw new DocumentError("Guest portals are restricted or unavailable.", "not_found", 404);
    return guestPortalCatalogue(pages, actor, id);
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const parsed = command.safeParse(await readJson(request, 80_000));
    if (!parsed.success) throw new DocumentError("Check the portal.", "guest_portal_validation", 422);
    const pages = await repository(localPreview(request));
    const id = await workspaceId(params);
    const body = parsed.data;
    if (body.action === "configure") return saveGuestPortal(pages, actor, id, body);
    if (body.action === "stash") return stashGuestPortal(pages, actor, id, body);
    if (body.action === "discard-draft") return discardGuestPortalDraft(pages, actor, id, body);
    if (body.action === "preview") return previewGuestPortal(pages, actor, id, body);
    if (body.action === "pause") return pauseGuestPortal(pages, actor, id, body);
    if (body.action === "revoke") return revokeGuestPortal(pages, actor, id, body);
    if (body.action === "activate") return activateGuestPortal(pages, actor, id, body);
    if (body.action === "link-identity") return linkGuestIdentity(pages, actor, id, body);
    if (body.action === "actions") return setGuestPortalActions(pages, actor, id, body);
    if (body.action === "grant-manager") return grantGuestPortalManager(pages, actor, id, body);
    if (body.action === "revoke-manager") return revokeGuestPortalManager(pages, actor, id, body);
    if (body.action === "form") return submitGuestForm(pages, actor, id, body);
    if (body.action === "comment") return addGuestComment(pages, actor, id, body);
    if (body.action === "file") return citeGuestFile(pages, actor, id, body);
    return downloadGuestPortal(pages, actor, id, body);
  }, true);
}
