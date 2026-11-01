import { z } from "zod";
import { readJson, sameOrigin } from "../../../../../../../../lib/auth";
import { DocumentError } from "../../../../../../../../lib/document";
import { repository } from "../../../../../../../../lib/repository";
import { recordImportMapping } from "../../../../../../../../lib/shared-record-import-values";
import { SharedRecordImportProfileRepository } from "../../../../../../../../lib/shared-record-import-profiles";
import { authenticateRecordAuthority } from "../../../../../../../../lib/suite-tenant-authority";

const id = z.string().uuid();
const headers = { "Cache-Control": "no-store", "Vary": "Cookie, Authorization" };
type Context = { params: Promise<{ id: string; tenantId: string }> };
const name = z.string().trim().min(1).max(100).refine((value) => !/[\p{Cc}]/u.test(value));
const save = z.object({
  kind: z.literal("save"),
  id,
  operationId: id,
  jobId: id,
  collection: z.string().min(1).max(100),
  scope: z.enum(["personal", "shared"]),
  name,
  expectedVersion: z.number().int().nonnegative(),
  mapping: recordImportMapping,
}).strict();
const draft = save.extend({ kind: z.literal("draft"), draftId: id }).strict();
const discard = z.object({ kind: z.literal("discard"), id, operationId: id, expectedVersion: z.number().int().positive() }).strict();
const remove = z.object({ kind: z.literal("delete"), id, operationId: id, expectedVersion: z.number().int().positive() }).strict();
const apply = z.object({ kind: z.literal("apply"), id, operationId: id, jobId: id, draft: z.boolean().optional() }).strict();
const command = z.discriminatedUnion("kind", [save, draft, discard, remove, apply]);

export async function GET(request: Request, { params }: Context) {
  try {
    const { id: workspaceId, tenantId } = await params;
    const { actor, authority } = await authenticateRecordAuthority(request);
    const url = new URL(request.url);
    const query = z.object({ collection: z.string().min(1).max(100), q: z.string().max(100).optional() }).strict().safeParse({ collection: url.searchParams.get("collection") ?? "", q: url.searchParams.get("q") ?? undefined });
    if (!query.success) throw new DocumentError("Review the profile search.", "import_profile_validation", 400);
    const repo = new SharedRecordImportProfileRepository(await repository(), authority);
    return Response.json(await repo.listProfiles({ actor, workspaceId, tenantId }, query.data.collection, query.data.q ?? ""), { headers });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    sameOrigin(request);
    const parsed = command.safeParse(await readJson(request, 64_000));
    if (!parsed.success) throw new DocumentError("Review the import profile.", "import_profile_validation", 400);
    const { id: workspaceId, tenantId } = await params;
    const { actor, authority } = await authenticateRecordAuthority(request);
    const repo = new SharedRecordImportProfileRepository(await repository(), authority);
    const ctx = { actor, workspaceId, tenantId };
    const data = parsed.data;
    if (data.kind === "delete") { const { kind: _kind, ...input } = data; return Response.json(await repo.deleteProfile(ctx, input), { headers }); }
    if (data.kind === "discard") { const { kind: _kind, ...input } = data; return Response.json(await repo.discardDraft(ctx, input), { headers }); }
    if (data.kind === "apply") { const { kind: _kind, ...input } = data; return Response.json(await repo.applyProfile(ctx, input), { headers }); }
    if (data.kind === "draft") { const { kind: _kind, ...input } = data; return Response.json(await repo.saveDraft(ctx, input), { headers }); }
    const { kind: _kind, ...input } = data;
    return Response.json(await repo.saveProfile(ctx, input), { headers });
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown) {
  if (error instanceof DocumentError) return Response.json({ error: error.message, code: error.code, retryable: error.status >= 500 }, { status: error.status, headers });
  return Response.json({ error: "Service temporarily unavailable.", code: "service_unavailable", retryable: true }, { status: 503, headers });
}
