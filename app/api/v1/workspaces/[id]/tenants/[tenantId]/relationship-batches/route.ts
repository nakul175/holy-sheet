import { z } from "zod";
import { readJson, sameOrigin } from "../../../../../../../../lib/auth";
import { BulkRelationshipRepository } from "../../../../../../../../lib/bulk-relationships";
import { DocumentError } from "../../../../../../../../lib/document";
import { repository } from "../../../../../../../../lib/repository";
import { authenticateRecordAuthority } from "../../../../../../../../lib/suite-tenant-authority";

const actions = ["preview", "execute", "search", "save-draft", "read-draft", "list-drafts", "discard-draft", "history", "download"] as const;
const envelope = z.object({ action: z.enum(actions) }).passthrough();
type Context = { params: Promise<{ id: string; tenantId: string }> };

export async function POST(request: Request, { params }: Context) {
  try {
    sameOrigin(request);
    const payload = envelope.safeParse(await readJson(request, 256_000));
    if (!payload.success) throw new DocumentError("Invalid relationship batch.", "record_validation", 400);
    const { action, ...input } = payload.data;
    const { id: workspaceId, tenantId } = await params;
    const { actor, authority } = await authenticateRecordAuthority(request);
    const repo = new BulkRelationshipRepository(await repository(), authority);
    const ctx = { actor, workspaceId, tenantId };
    if (action === "download") {
      const batchId = typeof input.batchId === "string" ? input.batchId : "";
      const file = await repo.download(ctx, batchId);
      return new Response(file.body, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": 'attachment; filename="relationship-batch.csv"',
          "Content-Type": "text/csv; charset=utf-8",
          Vary: "Cookie, Authorization",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    const result = await dispatch(repo, ctx, action, input);
    return Response.json(result, { headers: { "Cache-Control": "no-store", Vary: "Cookie, Authorization" } });
  } catch (error) {
    return failure(error);
  }
}

async function dispatch(repo: BulkRelationshipRepository, ctx: { actor: { id: string }; workspaceId: string; tenantId: string }, action: (typeof actions)[number], input: Record<string, unknown>) {
  if (action === "preview") return repo.preview(ctx, input);
  if (action === "execute") return repo.execute(ctx, input);
  if (action === "search") return repo.searchTargets(ctx, input);
  if (action === "save-draft") return repo.saveDraft(ctx, input);
  if (action === "read-draft") return repo.readDraft(ctx, typeof input.draftId === "string" ? input.draftId : "");
  if (action === "list-drafts") return repo.listDrafts(ctx);
  if (action === "discard-draft") return repo.discardDraft(ctx, input);
  return repo.batchHistory(ctx, typeof input.batchId === "string" ? input.batchId : "");
}

function failure(error: unknown) {
  if (error instanceof DocumentError) {
    return Response.json(
      { error: error.message, code: error.code, retryable: error.status >= 500 },
      { status: error.status, headers: { "Cache-Control": "no-store", Vary: "Cookie, Authorization" } },
    );
  }
  return Response.json(
    { error: "Service temporarily unavailable.", code: "service_unavailable", retryable: true },
    { status: 503, headers: { "Cache-Control": "no-store", Vary: "Cookie, Authorization" } },
  );
}
