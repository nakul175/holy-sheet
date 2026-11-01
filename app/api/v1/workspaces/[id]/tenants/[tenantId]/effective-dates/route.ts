import { z } from "zod";
import { readJson, sameOrigin } from "../../../../../../../../lib/auth";
import { DocumentError } from "../../../../../../../../lib/document";
import { EffectiveDateRepository } from "../../../../../../../../lib/effective-dates-store";
import { repository } from "../../../../../../../../lib/repository";
import { authenticateRecordAuthority } from "../../../../../../../../lib/suite-tenant-authority";

const id = z.string().uuid();
const fieldKey = z.string().regex(/^(core:[a-z0-9-]{1,40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
const headers = { "Cache-Control": "no-store", "Vary": "Cookie, Authorization", "X-Content-Type-Options": "nosniff" };
type Context = { params: Promise<{ id: string; tenantId: string }> };
const confirms = ["configure-effective-field", "assign-effective-access", "propose-effective-value", "activate-effective-value", "cancel-effective-value"] as const;
const preview = z.discriminatedUnion("action", [
  z.object({ kind: z.literal("preview"), action: z.literal("configure"), collection: z.string().min(1).max(100), fieldKey, enabled: z.boolean() }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("assign"), collection: z.string().min(1).max(100), userId: z.string().min(1).max(200), canPropose: z.boolean(), canCorrect: z.boolean(), canActivate: z.boolean(), canCancel: z.boolean() }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("propose"), collection: z.string().min(1).max(100), recordId: id, fieldKey, value: z.unknown(), start: z.string().min(16).max(40), end: z.string().max(40).nullable(), timezone: z.string().min(1).max(100), reason: z.string().max(500).optional(), expectedRecordVersion: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("activate"), collection: z.string().min(1).max(100), recordId: id, intervalId: id, expectedRecordVersion: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("cancel"), collection: z.string().min(1).max(100), recordId: id, intervalId: id, reason: z.string().max(500).optional(), expectedRecordVersion: z.number().int().positive() }).strict(),
]);
const confirm = z.object({ kind: z.literal("confirm"), operationId: id, previewId: id, reviewHash: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.enum(confirms) }).strict();
const draft = z.object({ kind: z.literal("draft"), draftId: id, collection: z.string().min(1).max(100), recordId: id, fieldKey, value: z.unknown(), start: z.string().max(40), end: z.string().max(40).nullable(), timezone: z.string().max(100), reason: z.string().max(500).optional(), operationId: id, expectedVersion: z.number().int().nonnegative() }).strict();
const discard = z.object({ kind: z.literal("discard"), draftId: id, collection: z.string().min(1).max(100), operationId: id, expectedVersion: z.number().int().positive() }).strict();

export async function GET(request: Request, { params }: Context) {
  try {
    const { id: workspaceId, tenantId } = await params;
    const { actor, authority } = await authenticateRecordAuthority(request);
    const url = new URL(request.url);
    const query = z.object({ collection: z.string().min(1).max(100), q: z.string().max(100).optional(), recordId: id.optional(), fieldKey: fieldKey.optional(), asOf: z.string().min(16).max(40).optional() }).strict().safeParse({
      collection: url.searchParams.get("collection") ?? "",
      q: url.searchParams.get("q") ?? undefined,
      recordId: url.searchParams.get("recordId") ?? undefined,
      fieldKey: url.searchParams.get("fieldKey") ?? undefined,
      asOf: url.searchParams.get("asOf") ?? undefined,
    });
    if (!query.success) throw new DocumentError("Review the effective-date search.", "effective_invalid", 400);
    const repo = new EffectiveDateRepository(await repository(), authority);
    return Response.json(await repo.listEffective({ actor, workspaceId, tenantId }, { collection: query.data.collection, query: query.data.q, recordId: query.data.recordId, fieldKey: query.data.fieldKey, asOf: query.data.asOf }), { headers });
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
    const repo = new EffectiveDateRepository(await repository(), authority);
    const ctx = { actor, workspaceId, tenantId };
    const kind = body && typeof body === "object" && !Array.isArray(body) ? (body as { kind?: unknown }).kind : undefined;
    if (kind === "preview") {
      const parsed = preview.safeParse(body);
      if (!parsed.success) throw new DocumentError("Review the effective-date request.", "effective_invalid", 400);
      const { kind: _kind, ...input } = parsed.data;
      return Response.json(await repo.preview(ctx, input), { headers });
    }
    if (kind === "draft") {
      const parsed = draft.safeParse(body);
      if (!parsed.success) throw new DocumentError("Review the draft.", "effective_invalid", 400);
      const { kind: _kind, ...input } = parsed.data;
      return Response.json(await repo.saveDraft(ctx, input), { headers });
    }
    const parsed = z.discriminatedUnion("kind", [confirm, discard]).safeParse(body);
    if (!parsed.success) throw new DocumentError("Review the effective-date request.", "effective_invalid", 400);
    if (parsed.data.kind === "confirm") {
      const { kind: _kind, ...input } = parsed.data;
      return Response.json(await repo.confirm(ctx, input), { headers });
    }
    const { kind: _kind, ...input } = parsed.data;
    return Response.json(await repo.discardDraft(ctx, input), { headers });
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown) {
  if (error instanceof DocumentError) return Response.json({ error: error.message, code: error.code, retryable: error.status >= 500 }, { status: error.status, headers });
  return Response.json({ error: "Service temporarily unavailable.", code: "service_unavailable", retryable: true }, { status: 503, headers });
}
