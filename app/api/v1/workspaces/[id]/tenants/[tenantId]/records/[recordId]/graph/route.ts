import { DocumentError } from "../../../../../../../../../../lib/document";
import { repository } from "../../../../../../../../../../lib/repository";
import { SharedRecordGraphRepository } from "../../../../../../../../../../lib/shared-record-graph";
import { authenticateRecordAuthority } from "../../../../../../../../../../lib/suite-tenant-authority";

const headers = { "Cache-Control": "no-store", Vary: "Cookie, Authorization" };
type Context = { params: Promise<{ id: string; tenantId: string; recordId: string }> };

export async function GET(request: Request, c: Context) {
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].length) throw new DocumentError("Review the relationship graph request.", "record_graph_validation", 400);
    const { actor, authority } = await authenticateRecordAuthority(request);
    const { id: workspaceId, tenantId, recordId } = await c.params;
    const graph = await new SharedRecordGraphRepository(await repository(), authority).graph({ actor, workspaceId, tenantId }, recordId);
    return Response.json(graph, { headers });
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown) {
  if (error instanceof DocumentError) return Response.json({ error: error.message, code: error.code, retryable: error.status >= 500 }, { status: error.status, headers });
  console.error("HS record graph request failed", error instanceof Error ? error.name : "UnknownError");
  return Response.json({ error: "Service temporarily unavailable.", code: "service_unavailable", retryable: true }, { status: 503, headers });
}
