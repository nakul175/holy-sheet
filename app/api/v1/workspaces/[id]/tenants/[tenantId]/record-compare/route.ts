import { z } from "zod";
import { readJson, sameOrigin } from "../../../../../../../../lib/auth";
import { DocumentError } from "../../../../../../../../lib/document";
import { repository } from "../../../../../../../../lib/repository";
import { SharedRecordCompareRepository } from "../../../../../../../../lib/shared-record-compare";
import { authenticateRecordAuthority } from "../../../../../../../../lib/suite-tenant-authority";

const headers = { "Cache-Control": "no-store", Vary: "Cookie, Authorization" };
const bodySchema = z.object({ recordIds: z.array(z.string().uuid()).min(2).max(4) }).strict();
type Context = { params: Promise<{ id: string; tenantId: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].length) throw new DocumentError("Review the record comparison.", "record_compare_validation", 400);
    sameOrigin(request);
    const { actor, authority } = await authenticateRecordAuthority(request);
    const parsed = bodySchema.safeParse(await readJson(request, 4_000));
    if (!parsed.success) throw new DocumentError("Review the record comparison.", "record_compare_validation", 400);
    const { id: workspaceId, tenantId } = await context.params;
    const comparison = await new SharedRecordCompareRepository(await repository(), authority).compare({ actor, workspaceId, tenantId }, parsed.data);
    return Response.json(comparison, { headers });
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown) {
  if (error instanceof DocumentError) return Response.json({ error: error.message, code: error.code, retryable: error.status >= 500 }, { status: error.status, headers });
  console.error("HS record comparison failed", error instanceof Error ? error.name : "UnknownError");
  return Response.json({ error: "Service temporarily unavailable.", code: "service_unavailable", retryable: true }, { status: 503, headers });
}
