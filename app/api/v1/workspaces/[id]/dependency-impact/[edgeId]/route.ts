import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../../lib/auth";
import {
  acknowledgeDependency,
  dependencyHistory,
  discardDependencyDraft,
  readDependencyEdge,
  reassignDependencyReviewer,
  saveDependencyEdge,
  stashDependencyEdge,
} from "../../../../../../../lib/dependency-impact";
import { DocumentError } from "../../../../../../../lib/document";
import { repository } from "../../../../../../../lib/repository";

const save = {
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
  note: z.string().trim().max(2000),
  reviewerId: z.string().trim().min(1).max(200),
};
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), ...save }).strict(),
  z.object({ action: z.literal("stash"), ...save }).strict(),
  z.object({ action: z.literal("discard-draft"), operationId: z.string().uuid() }).strict(),
  z.object({
    action: z.literal("acknowledge"),
    operationId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    sourceRevision: z.number().int().positive(),
    dependentRevision: z.number().int().positive(),
  }).strict(),
  z.object({
    action: z.literal("reassign"),
    operationId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    reviewerId: z.string().trim().min(1).max(200),
  }).strict(),
]);

async function ids(params: Promise<{ id: string; edgeId: string }>) {
  const value = await params;
  if (!value.id || value.id.length > 200 || !z.string().uuid().safeParse(value.edgeId).success) throw new DocumentError("Dependency unavailable", "not_found", 404);
  return value;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string; edgeId: string }> }) {
  return api(request, async actor => {
    const { id, edgeId } = await ids(params);
    const pages = await repository(localPreview(request));
    if (new URL(request.url).searchParams.get("view") === "history") return dependencyHistory(pages, actor, id, edgeId);
    return readDependencyEdge(pages, actor, id, edgeId);
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string; edgeId: string }> }) {
  return api(request, async actor => {
    const parsed = command.safeParse(await readJson(request, 64_000));
    if (!parsed.success) throw new DocumentError("Invalid dependency request", "dependency_validation", 422);
    const { id, edgeId } = await ids(params);
    const pages = await repository(localPreview(request));
    const body = parsed.data;
    if (body.action === "save") return saveDependencyEdge(pages, actor, id, edgeId, body);
    if (body.action === "stash") return stashDependencyEdge(pages, actor, id, edgeId, body);
    if (body.action === "discard-draft") return discardDependencyDraft(pages, actor, id, edgeId, body.operationId);
    if (body.action === "acknowledge") return acknowledgeDependency(pages, actor, id, edgeId, body);
    return reassignDependencyReviewer(pages, actor, id, edgeId, body);
  }, true);
}
