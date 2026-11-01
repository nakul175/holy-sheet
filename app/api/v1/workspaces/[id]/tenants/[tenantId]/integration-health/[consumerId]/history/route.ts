import { z } from "zod";
import { DocumentError } from "../../../../../../../../../../lib/document";
import { IntegrationHealthRepository } from "../../../../../../../../../../lib/integration-health-store";
import { repository } from "../../../../../../../../../../lib/repository";
import { authenticateRecordAuthority } from "../../../../../../../../../../lib/suite-tenant-authority";

const headers = { "Cache-Control": "no-store", "Vary": "Cookie, Authorization", "X-Content-Type-Options": "nosniff" };
type Context = { params: Promise<{ id: string; tenantId: string; consumerId: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const { id: workspaceId, tenantId, consumerId } = await params;
    const url = new URL(request.url);
    const collection = url.searchParams.get("collection") ?? "";
    if (!z.string().uuid().safeParse(consumerId).success || !z.string().min(1).max(100).safeParse(collection).success) throw new DocumentError("Integration health is unavailable.", "integration_unavailable", 404);
    const { actor, authority } = await authenticateRecordAuthority(request);
    const repo = new IntegrationHealthRepository(await repository(), authority);
    return Response.json(await repo.consumerHistory({ actor, workspaceId, tenantId }, consumerId, collection), { headers });
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown) {
  if (error instanceof DocumentError) return Response.json({ error: error.message, code: error.code, retryable: error.status >= 500 }, { status: error.status, headers });
  return Response.json({ error: "Service temporarily unavailable.", code: "service_unavailable", retryable: true }, { status: 503, headers });
}
