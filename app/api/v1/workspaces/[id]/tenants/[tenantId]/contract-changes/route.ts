import { z } from "zod";
import { changeKinds, renewalDecisions } from "../../../../../../../../lib/contract-changes";
import { ContractChangeRepository } from "../../../../../../../../lib/contract-changes-store";
import { readJson, sameOrigin } from "../../../../../../../../lib/auth";
import { DocumentError } from "../../../../../../../../lib/document";
import { repository } from "../../../../../../../../lib/repository";
import { authenticateRecordAuthority } from "../../../../../../../../lib/suite-tenant-authority";

const id = z.string().uuid();
const userId = z.string().min(1).max(200);
const headers = { "Cache-Control": "no-store", "Vary": "Cookie, Authorization", "X-Content-Type-Options": "nosniff" };
type Context = { params: Promise<{ id: string; tenantId: string }> };
const confirms = ["configure-contract-change", "assign-contract-change", "create-contract-change", "propose-contract-change", "approve-contract-change", "effectuate-contract-change", "decide-contract-change"] as const;
const collection = z.literal("contracts");
const preview = z.discriminatedUnion("action", [
  z.object({ kind: z.literal("preview"), action: z.literal("configure"), collection, reviewRequired: z.boolean() }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("assign"), collection, userId, canPropose: z.boolean(), canApprove: z.boolean(), canEffectuate: z.boolean(), canDecide: z.boolean() }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("create"), collection, relationKind: z.enum(changeKinds), parentRecordId: id, successorRecordId: id, start: z.string().min(16).max(40), timezone: z.string().min(1).max(100), documentFileId: id, documentVersionNo: z.number().int().positive(), proposedEnd: z.string().max(10).nullable().optional(), responsibleUserId: userId.nullable().optional(), decision: z.enum(renewalDecisions).optional() }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("propose"), collection, changeId: id, expectedVersion: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("approve"), collection, changeId: id, expectedVersion: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("effectuate"), collection, changeId: id, expectedVersion: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("preview"), action: z.literal("decide"), collection, changeId: id, expectedVersion: z.number().int().positive(), decision: z.enum(renewalDecisions), responsibleUserId: userId.nullable() }).strict(),
]);
const confirm = z.object({ kind: z.literal("confirm"), operationId: id, previewId: id, reviewHash: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.enum(confirms) }).strict();
const draft = z.object({ kind: z.literal("draft"), collection, draftId: id, relationKind: z.enum(changeKinds), parentRecordId: id, successorRecordId: id, start: z.string().max(40), proposedEnd: z.string().max(10).nullable(), timezone: z.string().max(100), documentFileId: id, documentVersionNo: z.number().int().positive(), responsibleUserId: z.string().max(200).nullable(), decision: z.enum(renewalDecisions), operationId: id, expectedVersion: z.number().int().nonnegative() }).strict();
const draftVersion = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("discard"), collection, draftId: id, operationId: id, expectedVersion: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("restore"), collection, draftId: id, operationId: id, expectedVersion: z.number().int().positive() }).strict(),
]);

export async function GET(request: Request, { params }: Context) {
  try {
    const { id: workspaceId, tenantId } = await params;
    const { actor, authority } = await authenticateRecordAuthority(request);
    const url = new URL(request.url);
    const query = z.object({ collection, q: z.string().max(100).optional(), changeId: id.optional(), parentId: id.optional() }).strict().safeParse({
      collection: url.searchParams.get("collection") ?? "",
      q: url.searchParams.get("q") ?? undefined,
      changeId: url.searchParams.get("changeId") ?? undefined,
      parentId: url.searchParams.get("parentId") ?? undefined,
    });
    if (!query.success) throw new DocumentError("Review the contract change search.", "change_invalid", 400);
    const repo = new ContractChangeRepository(await repository(), authority);
    return Response.json(await repo.listChanges({ actor, workspaceId, tenantId }, { query: query.data.q, changeId: query.data.changeId, parentId: query.data.parentId }), { headers });
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
    const repo = new ContractChangeRepository(await repository(), authority);
    const ctx = { actor, workspaceId, tenantId };
    const kind = body && typeof body === "object" && !Array.isArray(body) ? (body as { kind?: unknown }).kind : undefined;
    if (kind === "preview") {
      const parsed = preview.safeParse(body);
      if (!parsed.success) throw new DocumentError("Review the contract change.", "change_invalid", 400);
      if (parsed.data.action === "create") {
        const { kind: _kind, collection: _collection, relationKind, ...rest } = parsed.data;
        return Response.json(await repo.preview(ctx, { ...rest, kind: relationKind }), { headers });
      }
      const { kind: _kind, collection: _collection, ...rest } = parsed.data;
      return Response.json(await repo.preview(ctx, rest), { headers });
    }
    if (kind === "draft") {
      const parsed = draft.safeParse(body);
      if (!parsed.success) throw new DocumentError("Review the draft.", "change_invalid", 400);
      const { kind: _kind, collection: _collection, relationKind, ...rest } = parsed.data;
      return Response.json(await repo.saveDraft(ctx, { ...rest, kind: relationKind }), { headers });
    }
    const parsed = z.union([confirm, draftVersion]).safeParse(body);
    if (!parsed.success) throw new DocumentError("Review the contract change.", "change_invalid", 400);
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
