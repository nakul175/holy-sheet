import { api, localPreview } from "../../../../../../../lib/auth";
import { listRecordViewsHttp, searchRecordRefsHttp } from "../../../../../../../lib/record-page-ref-http";
import { repository } from "../../../../../../../lib/repository";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const page = await (await repository(localPreview(request))).get((await params).id, actor);
    const views = new URL(request.url).searchParams.get("views") === "1";
    return views ? listRecordViewsHttp(request, actor, page.workspaceId, localPreview(request)) : searchRecordRefsHttp(request, actor, page.workspaceId, localPreview(request));
  });
}
