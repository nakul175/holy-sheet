import { api, localPreview } from "../../../../../../../lib/auth";
import { DocumentError } from "../../../../../../../lib/document";
import { resolveRecordRefsHttp } from "../../../../../../../lib/record-page-ref-http";
import { repository } from "../../../../../../../lib/repository";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const pageId = (await params).id;
    const pages = await repository(localPreview(request));
    const page = await pages.get(pageId, actor);
    if (!page.workspaceId) throw new DocumentError("Record is restricted or unavailable.", "record_not_found", 404);
    return resolveRecordRefsHttp(request, actor, page.workspaceId, localPreview(request));
  }, true);
}
