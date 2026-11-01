import { z } from "zod";
import { DocumentError } from "../../../../../../../../../lib/document";
import { EffectiveDateRepository } from "../../../../../../../../../lib/effective-dates-store";
import { repository } from "../../../../../../../../../lib/repository";
import { authenticateRecordAuthority } from "../../../../../../../../../lib/suite-tenant-authority";

const headers = { "Cache-Control": "no-store", "Vary": "Cookie, Authorization", "X-Content-Type-Options": "nosniff" };
type Context = { params: Promise<{ id: string; tenantId: string }> };
const fieldKey = z.string().regex(/^(core:[a-z0-9-]{1,40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);

export async function GET(request: Request, { params }: Context) {
  try {
    const { id: workspaceId, tenantId } = await params;
    const { actor, authority } = await authenticateRecordAuthority(request);
    const url = new URL(request.url);
    const query = z.object({ collection: z.string().min(1).max(100), recordId: z.string().uuid(), fieldKey }).strict().safeParse({
      collection: url.searchParams.get("collection") ?? "",
      recordId: url.searchParams.get("recordId") ?? "",
      fieldKey: url.searchParams.get("fieldKey") ?? "",
    });
    if (!query.success) throw new DocumentError("Review the effective-date history.", "effective_invalid", 400);
    const repo = new EffectiveDateRepository(await repository(), authority);
    return Response.json(await repo.intervalHistory({ actor, workspaceId, tenantId }, query.data), { headers });
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown) {
  if (error instanceof DocumentError) return Response.json({ error: error.message, code: error.code, retryable: error.status >= 500 }, { status: error.status, headers });
  return Response.json({ error: "Service temporarily unavailable.", code: "service_unavailable", retryable: true }, { status: 503, headers });
}
