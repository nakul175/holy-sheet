import { DocumentError } from "../../../../../../../../../../lib/document";
import { repository } from "../../../../../../../../../../lib/repository";
import { SharedRecordImportProfileRepository } from "../../../../../../../../../../lib/shared-record-import-profiles";
import { authenticateRecordAuthority } from "../../../../../../../../../../lib/suite-tenant-authority";

const headers = { "Cache-Control": "no-store", "Vary": "Cookie, Authorization" };
type Context = { params: Promise<{ id: string; tenantId: string; profileId: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const { id: workspaceId, tenantId, profileId } = await params;
    const { actor, authority } = await authenticateRecordAuthority(request);
    const repo = new SharedRecordImportProfileRepository(await repository(), authority);
    return Response.json(await repo.profileHistory({ actor, workspaceId, tenantId }, profileId), { headers });
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown) {
  if (error instanceof DocumentError) return Response.json({ error: error.message, code: error.code, retryable: error.status >= 500 }, { status: error.status, headers });
  return Response.json({ error: "Service temporarily unavailable.", code: "service_unavailable", retryable: true }, { status: 503, headers });
}
