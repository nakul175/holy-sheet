import { z } from "zod";
import { readJson, sameOrigin } from "../../../../../../../../lib/auth";
import { DocumentError } from "../../../../../../../../lib/document";
import { externalIdentifierStates } from "../../../../../../../../lib/external-identifier-mapping";
import { ExternalIdentifierRepository } from "../../../../../../../../lib/external-identifier-mappings";
import { repository } from "../../../../../../../../lib/repository";
import { authenticateRecordAuthority } from "../../../../../../../../lib/suite-tenant-authority";

const id = z.string().uuid();
const headers = { "Cache-Control": "no-store", "Vary": "Cookie, Authorization", "X-Content-Type-Options": "nosniff" };
type Context = { params: Promise<{ id: string; tenantId: string }> };
const review = z.object({
  decision: z.enum(["keep", "reassign"]),
  mappingId: id,
  version: z.number().int().positive(),
  confirm: z.enum(["keep-external-identifier", "reassign-external-identifier"]),
}).strict();
const preview = z.object({ kind: z.literal("preview"), recordId: id, namespace: z.string().max(80), externalId: z.string().max(200), provenanceLabel: z.string().max(120).optional() }).strict();
const register = z.object({ kind: z.literal("register"), operationId: id, previewId: id, reviewHash: z.string().regex(/^[a-f0-9]{64}$/), review: review.optional() }).strict();
const state = z.object({ kind: z.literal("state"), mappingId: id, operationId: id, expectedVersion: z.number().int().positive(), state: z.enum(externalIdentifierStates), confirm: z.literal("set-external-identifier-state") }).strict();
const draft = z.object({ kind: z.literal("draft"), draftId: id, mappingId: id, recordId: id, operationId: id, expectedVersion: z.number().int().nonnegative(), namespace: z.string().max(80), externalId: z.string().max(200), provenanceLabel: z.string().max(120).optional() }).strict();
const discard = z.object({ kind: z.literal("discard"), mappingId: id, operationId: id, expectedVersion: z.number().int().positive() }).strict();
const grant = z.object({ kind: z.literal("grant"), collection: z.string().min(1).max(100), namespace: z.string().max(80), userId: z.string().min(1).max(200), operationId: id, expectedVersion: z.number().int().nonnegative(), canRead: z.boolean(), canWrite: z.boolean(), canExport: z.boolean(), canHistory: z.boolean(), confirm: z.literal("grant-integration-metadata-access") }).strict();
const command = z.discriminatedUnion("kind", [preview, register, state, draft, discard, grant]);

export async function GET(request: Request, { params }: Context) {
  try {
    const { id: workspaceId, tenantId } = await params;
    const { actor, authority } = await authenticateRecordAuthority(request);
    const url = new URL(request.url);
    const query = z.object({ collection: z.string().min(1).max(100), recordId: id.optional(), q: z.string().max(100).optional(), namespace: z.string().max(80).optional() }).strict().safeParse({ collection: url.searchParams.get("collection") ?? "", recordId: url.searchParams.get("recordId") ?? undefined, q: url.searchParams.get("q") ?? undefined, namespace: url.searchParams.get("namespace") ?? undefined });
    if (!query.success) throw new DocumentError("Review the identifier search.", "identifier_invalid", 400);
    const repo = new ExternalIdentifierRepository(await repository(), authority);
    return Response.json(await repo.listMappings({ actor, workspaceId, tenantId }, { collection: query.data.collection, recordId: query.data.recordId, query: query.data.q, namespace: query.data.namespace }), { headers });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    sameOrigin(request);
    const parsed = command.safeParse(await readJson(request, 16_000));
    if (!parsed.success) throw new DocumentError("Review the external identifier.", "identifier_invalid", 400);
    const { id: workspaceId, tenantId } = await params;
    const { actor, authority } = await authenticateRecordAuthority(request);
    const repo = new ExternalIdentifierRepository(await repository(), authority);
    const ctx = { actor, workspaceId, tenantId };
    const data = parsed.data;
    if (data.kind === "preview") { const { kind: _kind, ...input } = data; return Response.json(await repo.previewMapping(ctx, input), { headers }); }
    if (data.kind === "register") { const { kind: _kind, ...input } = data; return Response.json(await repo.registerMapping(ctx, input), { headers }); }
    if (data.kind === "state") { const { kind: _kind, ...input } = data; return Response.json(await repo.setMappingState(ctx, input), { headers }); }
    if (data.kind === "draft") { const { kind: _kind, ...input } = data; return Response.json(await repo.saveDraft(ctx, input), { headers }); }
    if (data.kind === "discard") { const { kind: _kind, ...input } = data; return Response.json(await repo.discardDraft(ctx, input), { headers }); }
    const { kind: _kind, ...input } = data;
    return Response.json(await repo.grantIntegration(ctx, input), { headers });
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown) {
  if (error instanceof DocumentError) {
    const conflict = reviewedConflict(error.details);
    return Response.json({ error: error.message, code: error.code, ...(conflict ? { conflict } : {}), retryable: error.status >= 500 }, { status: error.status, headers });
  }
  return Response.json({ error: "Service temporarily unavailable.", code: "service_unavailable", retryable: true }, { status: 503, headers });
}

function reviewedConflict(details: unknown) {
  if (!details || typeof details !== "object") return undefined;
  const value = details as Record<string, unknown>;
  if (value.reviewable === false) return { reviewable: false };
  if (value.reviewable === true && typeof value.mappingId === "string" && typeof value.recordId === "string" && (value.state === "active" || value.state === "archived" || value.state === "deleted") && typeof value.version === "number") {
    return { reviewable: true, mappingId: value.mappingId, recordId: value.recordId, state: value.state, version: value.version };
  }
  return undefined;
}
