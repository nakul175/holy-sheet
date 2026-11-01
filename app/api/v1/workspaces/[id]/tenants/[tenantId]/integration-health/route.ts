import { z } from "zod";
import { readJson, sameOrigin } from "../../../../../../../../lib/auth";
import { DocumentError } from "../../../../../../../../lib/document";
import { IntegrationHealthRepository } from "../../../../../../../../lib/integration-health-store";
import { repository } from "../../../../../../../../lib/repository";
import { authenticateRecordAuthority } from "../../../../../../../../lib/suite-tenant-authority";

const id = z.string().uuid();
const headers = { "Cache-Control": "no-store", "Vary": "Cookie, Authorization", "X-Content-Type-Options": "nosniff" };
type Context = { params: Promise<{ id: string; tenantId: string }> };
const preview = z.discriminatedUnion("action", [
  z.object({ kind: z.literal("preview"), action: z.literal("register"), collection: z.string().min(1).max(100), clientId: z.string().max(80), label: z.string().max(120) }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("retry"), collection: z.string().min(1).max(100), consumerId: id, deliveryId: id }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("replay"), collection: z.string().min(1).max(100), consumerId: id, eventId: id, mismatchId: id.optional() }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("repair"), collection: z.string().min(1).max(100), consumerId: id, mismatchId: id, decision: z.string().max(80) }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("acknowledge"), collection: z.string().min(1).max(100), consumerId: id, eventId: id }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("record-failure"), collection: z.string().min(1).max(100), consumerId: id, eventId: id, failureCode: z.string().max(40), failureDetail: z.string().max(500) }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("isolate"), collection: z.string().min(1).max(100), consumerId: id }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("release"), collection: z.string().min(1).max(100), consumerId: id }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("rename"), collection: z.string().min(1).max(100), consumerId: id, label: z.string().max(120) }).strict(),
]);
const confirm = z.object({ kind: z.literal("confirm"), operationId: id, previewId: id, reviewHash: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.enum(["register-paused-consumer", "retry-delivery", "replay-delivery", "repair-keep-canonical", "repair-queue-replay", "repair-reference", "repair-keep-isolated", "record-consumer-acknowledgement", "record-delivery-failure", "isolate-consumer", "release-consumer-isolation", "rename-integration-consumer"]) }).strict();
const reconcile = z.object({ kind: z.literal("reconcile"), collection: z.string().min(1).max(100), consumerId: id, operationId: id, runId: id.optional(), expectedVersion: z.number().int().positive().optional(), bound: z.number().int().min(1).max(50).optional(), observations: z.unknown().optional() }).strict();
const draft = z.object({ kind: z.literal("draft"), draftId: id, consumerId: id, collection: z.string().min(1).max(100), operationId: id, expectedVersion: z.number().int().nonnegative(), note: z.string().max(500), observations: z.unknown().optional() }).strict();
const discard = z.object({ kind: z.literal("discard"), consumerId: id, collection: z.string().min(1).max(100), operationId: id, expectedVersion: z.number().int().positive() }).strict();
const grant = z.object({ kind: z.literal("grant"), collection: z.string().min(1).max(100), consumerId: id, userId: z.string().min(1).max(200), operationId: id, expectedVersion: z.number().int().nonnegative(), canRead: z.boolean(), canReconcile: z.boolean(), canRepair: z.boolean(), canExport: z.boolean(), canHistory: z.boolean(), confirm: z.literal("grant-integration-health-access") }).strict();

export async function GET(request: Request, { params }: Context) {
  try {
    const { id: workspaceId, tenantId } = await params;
    const { actor, authority } = await authenticateRecordAuthority(request);
    const url = new URL(request.url);
    const query = z.object({ collection: z.string().min(1).max(100), q: z.string().max(100).optional(), recordId: id.optional() }).strict().safeParse({ collection: url.searchParams.get("collection") ?? "", q: url.searchParams.get("q") ?? undefined, recordId: url.searchParams.get("recordId") ?? undefined });
    if (!query.success) throw new DocumentError("Review the integration health search.", "integration_invalid", 400);
    const repo = new IntegrationHealthRepository(await repository(), authority);
    return Response.json(await repo.listHealth({ actor, workspaceId, tenantId }, { collection: query.data.collection, query: query.data.q, recordId: query.data.recordId }), { headers });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    sameOrigin(request);
    const body = await readJson(request, 32_000);
    const { id: workspaceId, tenantId } = await params;
    const { actor, authority } = await authenticateRecordAuthority(request);
    const repo = new IntegrationHealthRepository(await repository(), authority);
    const ctx = { actor, workspaceId, tenantId };
    const kind = body && typeof body === "object" && !Array.isArray(body) ? (body as { kind?: unknown }).kind : undefined;
    if (kind === "preview") {
      const parsed = preview.safeParse(body);
      if (!parsed.success) throw new DocumentError("Review the integration health request.", "integration_invalid", 400);
      const { kind: _kind, ...input } = parsed.data;
      return Response.json(await repo.preview(ctx, input), { headers });
    }
    if (kind === "reconcile") {
      const parsed = reconcile.safeParse(body);
      if (!parsed.success) throw new DocumentError("Review the reconciliation.", "integration_invalid", 400);
      const { kind: _kind, ...input } = parsed.data;
      return Response.json(await repo.reconcile(ctx, input), { headers });
    }
    if (kind === "draft") {
      const parsed = draft.safeParse(body);
      if (!parsed.success) throw new DocumentError("Review the draft.", "integration_invalid", 400);
      const { kind: _kind, ...input } = parsed.data;
      return Response.json(await repo.saveDraft(ctx, input), { headers });
    }
    const parsed = z.discriminatedUnion("kind", [confirm, discard, grant]).safeParse(body);
    if (!parsed.success) throw new DocumentError("Review the integration health request.", "integration_invalid", 400);
    if (parsed.data.kind === "confirm") {
      const { kind: _kind, ...input } = parsed.data;
      return Response.json(await repo.confirm(ctx, input), { headers });
    }
    if (parsed.data.kind === "discard") {
      const { kind: _kind, ...input } = parsed.data;
      return Response.json(await repo.discardDraft(ctx, input), { headers });
    }
    const { kind: _kind, ...input } = parsed.data;
    return Response.json(await repo.grantHealth(ctx, input), { headers });
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown) {
  if (error instanceof DocumentError) return Response.json({ error: error.message, code: error.code, retryable: error.status >= 500 }, { status: error.status, headers });
  return Response.json({ error: "Service temporarily unavailable.", code: "service_unavailable", retryable: true }, { status: 503, headers });
}
