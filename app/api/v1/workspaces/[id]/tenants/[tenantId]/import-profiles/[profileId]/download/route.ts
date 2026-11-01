import { DocumentError } from "../../../../../../../../../../lib/document";
import { repository } from "../../../../../../../../../../lib/repository";
import { SharedRecordImportProfileRepository } from "../../../../../../../../../../lib/shared-record-import-profiles";
import { authenticateRecordAuthority } from "../../../../../../../../../../lib/suite-tenant-authority";

const headers = { "Cache-Control": "no-store", "Vary": "Cookie, Authorization", "X-Content-Type-Options": "nosniff" };
type Context = { params: Promise<{ id: string; tenantId: string; profileId: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const { id: workspaceId, tenantId, profileId } = await params;
    const { actor, authority } = await authenticateRecordAuthority(request);
    const repo = new SharedRecordImportProfileRepository(await repository(), authority);
    const file = await repo.downloadProfile({ actor, workspaceId, tenantId }, profileId);
    return new Response(file.bytes, { headers: { ...headers, "Content-Type": file.contentType, "Content-Disposition": "attachment; filename=\"import-mapping-profile.json\"" } });
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown) {
  if (error instanceof DocumentError) return Response.json({ error: error.message, code: error.code, retryable: error.status >= 500 }, { status: error.status, headers });
  return Response.json({ error: "Service temporarily unavailable.", code: "service_unavailable", retryable: true }, { status: 503, headers });
}
