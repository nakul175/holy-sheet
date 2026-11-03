import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../lib/auth";
import {
  downloadDependencyImpact,
  grantDependencyManager,
  listDependencyImpact,
  mergeDependencySource,
  noteDependencyMaterial,
  noteDependencyMetadata,
  parseDependencyKind,
  previewDependencyImpact,
  recordDependencyEdge,
  retireDependencySource,
  revokeDependencyManager,
  traverseDependencyImpact,
} from "../../../../../../lib/dependency-impact";
import { DocumentError } from "../../../../../../lib/document";
import { repository } from "../../../../../../lib/repository";

const kind = z.enum(["link", "template", "snippet", "synced-source"]);
const command = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("record"),
    operationId: z.string().uuid(),
    kind,
    sourceId: z.string().trim().min(1).max(200),
    sourceRevision: z.number().int().positive(),
    dependentPageId: z.string().trim().min(1).max(200),
    reviewerId: z.string().trim().min(1).max(200),
    note: z.string().trim().max(2000).optional().default(""),
  }).strict(),
  z.object({ action: z.literal("grant-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("revoke-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
  z.object({
    action: z.literal("note-material"),
    operationId: z.string().uuid(),
    kind,
    sourceId: z.string().trim().min(1).max(200),
    sourceRevision: z.number().int().positive(),
    expectedVersion: z.number().int().positive(),
  }).strict(),
  z.object({
    action: z.literal("note-metadata"),
    operationId: z.string().uuid(),
    kind,
    sourceId: z.string().trim().min(1).max(200),
    note: z.string().trim().max(2000),
    expectedVersion: z.number().int().positive(),
  }).strict(),
  z.object({
    action: z.literal("retire"),
    operationId: z.string().uuid(),
    kind,
    sourceId: z.string().trim().min(1).max(200),
    expectedVersion: z.number().int().positive(),
  }).strict(),
  z.object({
    action: z.literal("merge"),
    operationId: z.string().uuid(),
    kind,
    sourceId: z.string().trim().min(1).max(200),
    mergedIntoId: z.string().trim().min(1).max(200),
    expectedVersion: z.number().int().positive(),
  }).strict(),
  z.object({
    action: z.literal("download"),
    operationId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    kind: kind.optional(),
    sourceId: z.string().trim().min(1).max(200).optional(),
    pageId: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().positive().max(50).optional(),
  }).strict(),
]);

async function workspaceId(params: Promise<{ id: string }>) {
  const id = (await params).id;
  if (!id || id.length > 200) throw new DocumentError("Dependency unavailable", "not_found", 404);
  return id;
}

function scope(url: URL) {
  const limit = Number(url.searchParams.get("limit") ?? "50");
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new DocumentError("Dependency unavailable", "not_found", 404);
  return {
    kind: parseDependencyKind(url.searchParams.get("kind")),
    sourceId: url.searchParams.get("sourceId") || undefined,
    pageId: url.searchParams.get("pageId") || undefined,
    limit,
  };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const url = new URL(request.url);
    const pages = await repository(localPreview(request));
    const id = await workspaceId(params);
    const view = url.searchParams.get("view");
    if (view === "impact") return traverseDependencyImpact(pages, actor, id, scope(url));
    if (view === "preview") return previewDependencyImpact(pages, actor, id, scope(url));
    return listDependencyImpact(pages, actor, id, url.searchParams.get("q") ?? "", url.searchParams.get("pageId"));
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const parsed = command.safeParse(await readJson(request, 64_000));
    if (!parsed.success) throw new DocumentError("Invalid dependency request", "dependency_validation", 422);
    const pages = await repository(localPreview(request));
    const id = await workspaceId(params);
    const body = parsed.data;
    if (body.action === "grant-manager") return grantDependencyManager(pages, actor, id, body);
    if (body.action === "revoke-manager") return revokeDependencyManager(pages, actor, id, body);
    if (body.action === "note-material") return noteDependencyMaterial(pages, actor, id, body);
    if (body.action === "note-metadata") return noteDependencyMetadata(pages, actor, id, body);
    if (body.action === "retire") return retireDependencySource(pages, actor, id, body);
    if (body.action === "merge") return mergeDependencySource(pages, actor, id, body);
    if (body.action === "download") return downloadDependencyImpact(pages, actor, id, body);
    return recordDependencyEdge(pages, actor, id, body);
  }, true);
}
