import { z } from "zod";
import { readJson, sameOrigin } from "../../../../../../../../../../lib/auth";
import { DocumentError } from "../../../../../../../../../../lib/document";
import { repository } from "../../../../../../../../../../lib/repository";
import { authenticateRecordAuthority } from "../../../../../../../../../../lib/suite-tenant-authority";
import { SharedRecordRelationshipRepository } from "../../../../../../../../../../lib/shared-record-relationships";

const uuid = z.string().uuid(),
  preview = z.object({ action: z.literal("preview"), newOrganisationId: uuid }).strict(),
  apply = z
    .object({
      action: z.literal("apply"),
      operationId: uuid,
      expectedVersion: z.number().int().positive(),
      newOrganisationId: uuid,
      previewToken: z.string().regex(/^[a-f0-9]{64}$/),
      confirmed: z.literal(true),
    })
    .strict(),
  body = z.discriminatedUnion("action", [preview, apply]);
type Context = {
  params: Promise<{ id: string; tenantId: string; recordId: string }>;
};
export async function POST(request: Request, { params }: Context) {
  try {
    sameOrigin(request);
    const parsed = body.safeParse(await readJson(request, 64_000));
    if (!parsed.success) throw new DocumentError("Invalid account reparent request.", "record_validation", 400);
    const { id: workspaceId, tenantId, recordId } = await params,
      { actor, authority } = await authenticateRecordAuthority(request),
      repo = new SharedRecordRelationshipRepository(await repository(), authority),
      ctx = { actor, workspaceId, tenantId };
    return response(parsed.data.action === "preview" ? await repo.previewReparent(ctx, recordId, parsed.data) : await repo.reparent(ctx, recordId, parsed.data));
  } catch (error) {
    return failure(error);
  }
}
function response(value: unknown) {
  return Response.json(value, {
    headers: { "Cache-Control": "no-store", Vary: "Cookie, Authorization" },
  });
}
function failure(error: unknown) {
  if (error instanceof DocumentError)
    return Response.json(
      {
        error: error.message,
        code: error.code,
        retryable: error.status >= 500,
      },
      {
        status: error.status,
        headers: { "Cache-Control": "no-store", Vary: "Cookie, Authorization" },
      },
    );
  return Response.json(
    {
      error: "Service temporarily unavailable.",
      code: "service_unavailable",
      retryable: true,
    },
    {
      status: 503,
      headers: { "Cache-Control": "no-store", Vary: "Cookie, Authorization" },
    },
  );
}
