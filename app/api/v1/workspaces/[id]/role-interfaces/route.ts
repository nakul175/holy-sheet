import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { DocumentError } from "../../../../../../lib/document";
import { repository } from "../../../../../../lib/repository";
import {
  applyRoleInterfacePreview,
  createRoleInterface,
  discardRoleInterfaceDraft,
  downloadRoleInterface,
  grantRoleInterfaceManager,
  previewRoleInterface,
  readRoleInterface,
  renderRoleInterface,
  revokeRoleInterfaceManager,
  roleInterfaceCatalogue,
  roleInterfaceHistory,
  searchRoleInterfaces,
  stashRoleInterface,
} from "../../../../../../lib/role-interface";

const definition = z.record(z.string(), z.unknown());
const values = z.record(z.string(), z.unknown());
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), operationId: z.string().uuid(), name: z.string().trim().min(1).max(80), definition }).strict(),
  z.object({ action: z.literal("stash"), operationId: z.string().uuid(), interfaceId: z.string().uuid(), expectedVersion: z.number().int().positive(), definition }).strict(),
  z.object({ action: z.literal("discard-draft"), operationId: z.string().uuid(), interfaceId: z.string().uuid() }).strict(),
  z.object({
    action: z.literal("preview"), operationId: z.string().uuid(), interfaceId: z.string().uuid(),
    kind: z.enum(["stage", "publish", "version-change", "rollback", "submit"]),
    expectedVersion: z.number().int().positive(), definition: definition.optional(), name: z.string().trim().min(1).max(80).optional(),
    targetVersion: z.number().int().positive().optional(), componentId: z.string().trim().min(1).max(80).optional(),
    recordId: z.string().uuid().optional(), schemaVersion: z.number().int().positive().optional(), values: values.optional(),
  }).strict(),
  z.object({ action: z.literal("apply"), operationId: z.string().uuid(), previewId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("download"), operationId: z.string().uuid(), interfaceId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("grant-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("revoke-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
]);

async function workspaceId(params: Promise<{ id: string }>) {
  const id = (await params).id;
  if (!id || id.length > 200) throw new DocumentError("Interfaces are restricted or unavailable.", "not_found", 404);
  return id;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const id = await workspaceId(params);
    const url = new URL(request.url);
    const pages = await repository(localPreview(request));
    const view = url.searchParams.get("view");
    const interfaceId = url.searchParams.get("interfaceId");
    if (view === "interface") {
      if (!interfaceId) throw new DocumentError("Interfaces are restricted or unavailable.", "not_found", 404);
      return readRoleInterface(pages, actor, id, interfaceId);
    }
    if (view === "search") {
      const query = url.searchParams.get("q");
      if (!query) throw new DocumentError("Check the interface request.", "role_interface_validation", 422);
      return searchRoleInterfaces(pages, actor, id, query);
    }
    if (view === "history") {
      if (!interfaceId) throw new DocumentError("Interfaces are restricted or unavailable.", "not_found", 404);
      return roleInterfaceHistory(pages, actor, id, interfaceId);
    }
    if (view === "render") {
      if (!interfaceId) throw new DocumentError("Interfaces are restricted or unavailable.", "not_found", 404);
      return renderRoleInterface(pages, actor, id, interfaceId, { recordId: url.searchParams.get("recordId"), q: url.searchParams.get("q"), screenId: url.searchParams.get("screenId") });
    }
    if (view) throw new DocumentError("Interfaces are restricted or unavailable.", "not_found", 404);
    return roleInterfaceCatalogue(pages, actor, id);
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const parsed = command.safeParse(await readJson(request, 64_000));
    if (!parsed.success) throw new DocumentError("Check the interface request.", "role_interface_validation", 422);
    const pages = await repository(localPreview(request));
    const id = await workspaceId(params);
    const body = parsed.data;
    if (body.action === "create") return createRoleInterface(pages, actor, id, body);
    if (body.action === "stash") return stashRoleInterface(pages, actor, id, body);
    if (body.action === "discard-draft") return discardRoleInterfaceDraft(pages, actor, id, body);
    if (body.action === "preview") return previewRoleInterface(pages, actor, id, body);
    if (body.action === "apply") return applyRoleInterfacePreview(pages, actor, id, body);
    if (body.action === "download") return downloadRoleInterface(pages, actor, id, body);
    if (body.action === "grant-manager") return grantRoleInterfaceManager(pages, actor, id, body);
    return revokeRoleInterfaceManager(pages, actor, id, body);
  }, true);
}
