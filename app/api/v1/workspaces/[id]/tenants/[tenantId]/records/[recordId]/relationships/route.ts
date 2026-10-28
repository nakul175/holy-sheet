import { z } from "zod";
import { readJson, sameOrigin } from "../../../../../../../../../../lib/auth";
import { DocumentError } from "../../../../../../../../../../lib/document";
import { repository } from "../../../../../../../../../../lib/repository";
import { authenticateRecordAuthority } from "../../../../../../../../../../lib/suite-tenant-authority";
import { SharedRecordRelationshipRepository } from "../../../../../../../../../../lib/shared-record-relationships";

const uuid = z.string().uuid(),
  body = z
    .object({
      operationId: uuid,
      expectedVersion: z.number().int().positive(),
      kind: z.enum(["contact-account", "employee-account", "contract-legal-party", "contract-account"]),
      targetId: uuid,
      action: z.enum(["upsert", "remove"]),
      role: z.string().trim().max(100).default(""),
      primary: z.boolean().default(false),
      status: z.enum(["active", "inactive"]).default("active"),
    })
    .strict();
type Context = {
  params: Promise<{ id: string; tenantId: string; recordId: string }>;
};
export async function POST(request: Request, { params }: Context) {
  try {
    sameOrigin(request);
    const parsed = body.safeParse(await readJson(request, 64_000));
    if (!parsed.success) throw new DocumentError("Invalid relationship update.", "record_validation", 400);
    const { id: workspaceId, tenantId, recordId } = await params,
      { actor, authority } = await authenticateRecordAuthority(request),
      repo = new SharedRecordRelationshipRepository(await repository(), authority);
    return response(await repo.mutateRelationship({ actor, workspaceId, tenantId }, recordId, parsed.data));
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
