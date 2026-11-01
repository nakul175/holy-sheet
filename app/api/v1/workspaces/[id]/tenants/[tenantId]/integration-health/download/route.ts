import { z } from "zod";
import { DocumentError } from "../../../../../../../../../lib/document";
import { IntegrationHealthRepository } from "../../../../../../../../../lib/integration-health-store";
import { repository } from "../../../../../../../../../lib/repository";
import { authenticateRecordAuthority } from "../../../../../../../../../lib/suite-tenant-authority";

const headers = { "Cache-Control": "no-store", "Vary": "Cookie, Authorization", "X-Content-Type-Options": "nosniff" };
type Context = { params: Promise<{ id: string; tenantId: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const { id: workspaceId, tenantId } = await params;
    const { actor, authority } = await authenticateRecordAuthority(request);
    const url = new URL(request.url);
    const query = z.object({ collection: z.string().min(1).max(100), consumerId: z.string().uuid().optional() }).strict().safeParse({ collection: url.searchParams.get("collection") ?? "", consumerId: url.searchParams.get("consumerId") ?? undefined });
    if (!query.success) throw new DocumentError("Review the integration health download.", "integration_invalid", 400);
    const repo = new IntegrationHealthRepository(await repository(), authority);
    const file = await repo.downloadEvidence({ actor, workspaceId, tenantId }, query.data);
    return new Response(file.bytes, { headers: { ...headers, "Content-Type": file.contentType, "Content-Disposition": "attachment; filename=\"integration-health-evidence.json\"" } });
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown) {
  if (error instanceof DocumentError) return Response.json({ error: error.message, code: error.code, retryable: error.status >= 500 }, { status: error.status, headers });
  return Response.json({ error: "Service temporarily unavailable.", code: "service_unavailable", retryable: true }, { status: 503, headers });
}
