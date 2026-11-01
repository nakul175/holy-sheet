import { z } from "zod";
import { StaffLifecycleRepository } from "../../../../../../../../../lib/staff-lifecycle-store";
import { DocumentError } from "../../../../../../../../../lib/document";
import { repository } from "../../../../../../../../../lib/repository";
import { authenticateRecordAuthority } from "../../../../../../../../../lib/suite-tenant-authority";

const headers = { "Cache-Control": "no-store", "Vary": "Cookie, Authorization", "X-Content-Type-Options": "nosniff" };
type Context = { params: Promise<{ id: string; tenantId: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const { id: workspaceId, tenantId } = await params;
    const { actor, authority } = await authenticateRecordAuthority(request);
    const url = new URL(request.url);
    const query = z.object({ collection: z.literal("employees"), lifecycleId: z.string().uuid() }).strict().safeParse({
      collection: url.searchParams.get("collection") ?? "",
      lifecycleId: url.searchParams.get("lifecycleId") ?? "",
    });
    if (!query.success) throw new DocumentError("Review the staff lifecycle history.", "lifecycle_invalid", 400);
    const repo = new StaffLifecycleRepository(await repository(), authority);
    return Response.json(await repo.lifecycleHistory({ actor, workspaceId, tenantId }, { lifecycleId: query.data.lifecycleId }), { headers });
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown) {
  if (error instanceof DocumentError) return Response.json({ error: error.message, code: error.code, retryable: error.status >= 500 }, { status: error.status, headers });
  return Response.json({ error: "Service temporarily unavailable.", code: "service_unavailable", retryable: true }, { status: 503, headers });
}
