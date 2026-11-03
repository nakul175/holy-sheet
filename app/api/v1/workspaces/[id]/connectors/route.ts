import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { DocumentError } from "../../../../../../lib/document";
import {
  activateConnector,
  connectorCatalogue,
  connectorHistory,
  connectorInventoryView,
  delegateConnector,
  discardConnectorDraft,
  disconnectConnector,
  downloadConnectorReport,
  enableConnector,
  grantConnectorManager,
  mergeConnector,
  pauseConnector,
  previewConnector,
  readConnector,
  reviewConnectorConflict,
  revokeConnectorManager,
  saveConnector,
  searchConnectors,
  setConnectorActions,
  stashConnector,
  syncConnector,
} from "../../../../../../lib/connector";
import { repository } from "../../../../../../lib/repository";

const definition = z.record(z.string(), z.unknown());
const item = z.object({
  externalId: z.string().trim().min(1).max(80),
  externalField: z.string().trim().min(1).max(40),
  value: z.string().max(2000),
  externalVersion: z.number().int().positive().max(1_000_000),
  tombstone: z.boolean().optional(),
  canonicalVersion: z.number().int().positive().nullable().optional(),
}).strict();
const sync = {
  operationId: z.string().uuid(),
  connectorId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  mode: z.enum(["initial", "incremental"]),
  checkpoint: z.string().min(1).max(80).nullable(),
  items: z.array(item).min(1).max(20),
};
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("configure"), operationId: z.string().uuid(), connectorId: z.string().uuid().optional(), expectedVersion: z.number().int().nonnegative(), name: z.string().trim().min(1).max(80), definition }).strict(),
  z.object({ action: z.literal("stash"), operationId: z.string().uuid(), connectorId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), name: z.string().trim().min(1).max(80), definition }).strict(),
  z.object({ action: z.literal("discard-draft"), operationId: z.string().uuid(), connectorId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("preview"), operationId: z.string().uuid(), connectorId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("enable"), operationId: z.string().uuid(), connectorId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("pause"), operationId: z.string().uuid(), connectorId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("disconnect"), operationId: z.string().uuid(), connectorId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("activate"), operationId: z.string().uuid(), connectorId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("delegate"), operationId: z.string().uuid(), connectorId: z.string().uuid(), expectedVersion: z.number().int().positive(), subjectKind: z.enum(["user", "app"]), subjectId: z.string().trim().min(1).max(80), field: z.string().trim().min(1).max(80) }).strict(),
  z.object({ action: z.literal("sync"), ...sync, failed: z.literal(false).optional() }).strict(),
  z.object({ action: z.literal("retry"), ...sync, failed: z.literal(true).optional() }).strict(),
  z.object({ action: z.literal("review"), operationId: z.string().uuid(), connectorId: z.string().uuid(), expectedVersion: z.number().int().positive(), externalId: z.string().trim().min(1).max(80), externalField: z.string().trim().min(1).max(40), decision: z.enum(["keep-canonical", "accept-external"]) }).strict(),
  z.object({ action: z.literal("merge"), operationId: z.string().uuid(), connectorId: z.string().uuid(), expectedVersion: z.number().int().positive(), externalId: z.string().trim().min(1).max(80), externalField: z.string().trim().min(1).max(40), survivorExternalId: z.string().trim().min(1).max(80) }).strict(),
  z.object({ action: z.literal("download"), operationId: z.string().uuid(), connectorId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("actions"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200), expectedVersion: z.number().int().nonnegative(), actions: z.array(z.string()).max(12) }).strict(),
  z.object({ action: z.literal("grant-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("revoke-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
]);

async function workspaceId(params: Promise<{ id: string }>) {
  const id = (await params).id;
  if (!id || id.length > 200) throw new DocumentError("Connectors are restricted or unavailable.", "not_found", 404);
  return id;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const id = await workspaceId(params);
    const url = new URL(request.url);
    const pages = await repository(localPreview(request));
    const view = url.searchParams.get("view");
    const connectorId = url.searchParams.get("connectorId") ?? "";
    if (view === "connector") {
      if (!connectorId) throw new DocumentError("Connectors are restricted or unavailable.", "not_found", 404);
      return readConnector(pages, actor, id, connectorId);
    }
    if (view === "search") {
      const query = url.searchParams.get("q");
      if (!query) throw new DocumentError("Check the connector.", "connector_validation", 422);
      return searchConnectors(pages, actor, id, query);
    }
    if (view === "history") {
      if (!connectorId) throw new DocumentError("Connectors are restricted or unavailable.", "not_found", 404);
      return connectorHistory(pages, actor, id, connectorId);
    }
    if (view === "inventory") return connectorInventoryView(pages, actor, id);
    if (view) throw new DocumentError("Connectors are restricted or unavailable.", "not_found", 404);
    return connectorCatalogue(pages, actor, id);
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const parsed = command.safeParse(await readJson(request, 80_000));
    if (!parsed.success) throw new DocumentError("Check the connector.", "connector_validation", 422);
    const pages = await repository(localPreview(request));
    const id = await workspaceId(params);
    const body = parsed.data;
    if (body.action === "configure") return saveConnector(pages, actor, id, body);
    if (body.action === "stash") return stashConnector(pages, actor, id, body);
    if (body.action === "discard-draft") return discardConnectorDraft(pages, actor, id, body);
    if (body.action === "preview") return previewConnector(pages, actor, id, body);
    if (body.action === "enable") return enableConnector(pages, actor, id, body);
    if (body.action === "pause") return pauseConnector(pages, actor, id, body);
    if (body.action === "disconnect") return disconnectConnector(pages, actor, id, body);
    if (body.action === "activate") return activateConnector(pages, actor, id, body);
    if (body.action === "delegate") return delegateConnector(pages, actor, id, body);
    if (body.action === "sync") return syncConnector(pages, actor, id, body);
    if (body.action === "retry") return syncConnector(pages, actor, id, { ...body, failed: true });
    if (body.action === "review") return reviewConnectorConflict(pages, actor, id, body);
    if (body.action === "merge") return mergeConnector(pages, actor, id, body);
    if (body.action === "actions") return setConnectorActions(pages, actor, id, body);
    if (body.action === "grant-manager") return grantConnectorManager(pages, actor, id, body);
    if (body.action === "revoke-manager") return revokeConnectorManager(pages, actor, id, body);
    return downloadConnectorReport(pages, actor, id, body);
  }, true);
}
