import { z } from "zod";
import { DocumentError } from "../../../../../../../../../../lib/document";
import { ExternalIdentifierRepository } from "../../../../../../../../../../lib/external-identifier-mappings";
import { repository } from "../../../../../../../../../../lib/repository";
import { authenticateRecordAuthority } from "../../../../../../../../../../lib/suite-tenant-authority";

const headers = { "Cache-Control": "no-store", "Vary": "Cookie, Authorization", "X-Content-Type-Options": "nosniff" };
type Context = { params: Promise<{ id: string; tenantId: string; mappingId: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const { id: workspaceId, tenantId, mappingId } = await params;
    if (!z.string().uuid().safeParse(mappingId).success) throw new DocumentError("The external identifier is unavailable.", "identifier_unavailable", 404);
    const { actor, authority } = await authenticateRecordAuthority(request);
    const repo = new ExternalIdentifierRepository(await repository(), authority);
    return Response.json(await repo.mappingHistory({ actor, workspaceId, tenantId }, mappingId), { headers });
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown) {
  if (error instanceof DocumentError) return Response.json({ error: error.message, code: error.code, retryable: error.status >= 500 }, { status: error.status, headers });
  return Response.json({ error: "Service temporarily unavailable.", code: "service_unavailable", retryable: true }, { status: 503, headers });
}
