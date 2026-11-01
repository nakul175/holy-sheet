import { z } from "zod";
import { checklistPhases, lifecycleStates } from "../../../../../../../../lib/staff-lifecycle";
import { StaffLifecycleRepository } from "../../../../../../../../lib/staff-lifecycle-store";
import { readJson, sameOrigin } from "../../../../../../../../lib/auth";
import { DocumentError } from "../../../../../../../../lib/document";
import { repository } from "../../../../../../../../lib/repository";
import { authenticateRecordAuthority } from "../../../../../../../../lib/suite-tenant-authority";

const id = z.string().uuid();
const userId = z.string().min(1).max(200);
const day = z.string().min(10).max(10);
const headers = { "Cache-Control": "no-store", "Vary": "Cookie, Authorization", "X-Content-Type-Options": "nosniff" };
type Context = { params: Promise<{ id: string; tenantId: string }> };
const confirms = ["configure-staff-lifecycle", "assign-staff-lifecycle", "create-staff-lifecycle", "transition-staff-lifecycle", "checklist-staff-lifecycle", "link-accounts-staff-lifecycle", "name-recipient-staff-lifecycle", "complete-handover-staff-lifecycle", "identity-evidence-staff-lifecycle"] as const;
const collection = z.literal("employees");
const item = z.object({ id, phase: z.enum(checklistPhases), title: z.string().min(1).max(200), dueOn: day, ownerUserId: userId, done: z.boolean() }).strict();
const preview = z.discriminatedUnion("action", [
  z.object({ kind: z.literal("preview"), action: z.literal("configure"), collection, acknowledgementRequired: z.boolean() }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("assign"), collection, userId, canMaintain: z.boolean(), canHandover: z.boolean(), canRecordEvidence: z.boolean() }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("create"), collection, employeeRecordId: id, plannedOn: day, directoryUserId: userId.nullable().optional(), checklist: z.array(item).max(50).optional() }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("transition"), collection, lifecycleId: id, expectedVersion: z.number().int().positive(), to: z.enum(lifecycleStates), date: day.nullable() }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("checklist"), collection, lifecycleId: id, expectedVersion: z.number().int().positive(), items: z.array(item).max(50) }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("link-accounts"), collection, lifecycleId: id, expectedVersion: z.number().int().positive(), accountIds: z.array(id).max(50) }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("name-recipient"), collection, lifecycleId: id, expectedVersion: z.number().int().positive(), recipientUserId: userId.nullable() }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("complete-handover"), collection, lifecycleId: id, expectedVersion: z.number().int().positive(), exceptionsAcknowledged: z.boolean(), exceptionNote: z.string().max(500).nullable() }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("identity-evidence"), collection, lifecycleId: id, expectedVersion: z.number().int().positive(), evidenceReference: z.string().min(1).max(200), sourceSystem: z.string().min(1).max(80), observedAccessRevoked: z.boolean() }).strict(),
]);
const confirm = z.object({ kind: z.literal("confirm"), operationId: id, previewId: id, reviewHash: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.enum(confirms) }).strict();
const draft = z.object({ kind: z.literal("draft"), collection, draftId: id, employeeRecordId: id, directoryUserId: z.string().max(200).nullable(), plannedOn: z.string().max(10).nullable(), startOn: z.string().max(10).nullable(), leavingOn: z.string().max(10).nullable(), leftOn: z.string().max(10).nullable(), checklist: z.array(item).max(50), accountIds: z.array(id).max(50), recipientUserId: z.string().max(200).nullable(), exceptionsAcknowledged: z.boolean(), exceptionNote: z.string().max(500).nullable(), operationId: id, expectedVersion: z.number().int().nonnegative() }).strict();
const draftVersion = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("discard"), collection, draftId: id, operationId: id, expectedVersion: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("restore"), collection, draftId: id, operationId: id, expectedVersion: z.number().int().positive() }).strict(),
]);

export async function GET(request: Request, { params }: Context) {
  try {
    const { id: workspaceId, tenantId } = await params;
    const { actor, authority } = await authenticateRecordAuthority(request);
    const url = new URL(request.url);
    const query = z.object({ collection, q: z.string().max(100).optional(), lifecycleId: id.optional() }).strict().safeParse({
      collection: url.searchParams.get("collection") ?? "",
      q: url.searchParams.get("q") ?? undefined,
      lifecycleId: url.searchParams.get("lifecycleId") ?? undefined,
    });
    if (!query.success) throw new DocumentError("Review the staff lifecycle search.", "lifecycle_invalid", 400);
    const repo = new StaffLifecycleRepository(await repository(), authority);
    return Response.json(await repo.listLifecycles({ actor, workspaceId, tenantId }, { query: query.data.q, lifecycleId: query.data.lifecycleId }), { headers });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    sameOrigin(request);
    const body = await readJson(request, 48_000);
    const { id: workspaceId, tenantId } = await params;
    const { actor, authority } = await authenticateRecordAuthority(request);
    const repo = new StaffLifecycleRepository(await repository(), authority);
    const ctx = { actor, workspaceId, tenantId };
    const kind = body && typeof body === "object" && !Array.isArray(body) ? (body as { kind?: unknown }).kind : undefined;
    if (kind === "preview") {
      const parsed = preview.safeParse(body);
      if (!parsed.success) throw new DocumentError("Review the staff lifecycle.", "lifecycle_invalid", 400);
      const { kind: _kind, collection: _collection, ...rest } = parsed.data;
      return Response.json(await repo.preview(ctx, rest), { headers });
    }
    if (kind === "draft") {
      const parsed = draft.safeParse(body);
      if (!parsed.success) throw new DocumentError("Review the draft.", "lifecycle_invalid", 400);
      const { kind: _kind, collection: _collection, ...rest } = parsed.data;
      return Response.json(await repo.saveDraft(ctx, rest), { headers });
    }
    const parsed = z.union([confirm, draftVersion]).safeParse(body);
    if (!parsed.success) throw new DocumentError("Review the staff lifecycle.", "lifecycle_invalid", 400);
    if (parsed.data.kind === "confirm") {
      const { kind: _kind, ...input } = parsed.data;
      return Response.json(await repo.confirm(ctx, input), { headers });
    }
    const { kind: action, collection: _collection, ...input } = parsed.data;
    if (action === "restore") return Response.json(await repo.restoreDraft(ctx, input), { headers });
    return Response.json(await repo.discardDraft(ctx, input), { headers });
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown) {
  if (error instanceof DocumentError) return Response.json({ error: error.message, code: error.code, retryable: error.status >= 500 }, { status: error.status, headers });
  return Response.json({ error: "Service temporarily unavailable.", code: "service_unavailable", retryable: true }, { status: 503, headers });
}
