import { z } from "zod";
import { ContractChangeRepository } from "../../../../../../../../../lib/contract-changes-store";
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
    const query = z.object({ collection: z.literal("contracts"), changeId: z.string().uuid() }).strict().safeParse({
      collection: url.searchParams.get("collection") ?? "",
      changeId: url.searchParams.get("changeId") ?? "",
    });
    if (!query.success) throw new DocumentError("Review the contract change download.", "change_invalid", 400);
    const repo = new ContractChangeRepository(await repository(), authority);
    const file = await repo.download({ actor, workspaceId, tenantId }, { changeId: query.data.changeId });
    return new Response(file.bytes, { headers: { ...headers, "Content-Type": file.contentType, "Content-Disposition": "attachment; filename=\"contract-change.json\"" } });
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown) {
  if (error instanceof DocumentError) return Response.json({ error: error.message, code: error.code, retryable: error.status >= 500 }, { status: error.status, headers });
  return Response.json({ error: "Service temporarily unavailable.", code: "service_unavailable", retryable: true }, { status: 503, headers });
}
