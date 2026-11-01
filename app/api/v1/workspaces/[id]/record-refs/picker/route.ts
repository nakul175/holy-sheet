import { api, localPreview } from "../../../../../../../lib/auth";
import { listRecordViewsHttp, searchRecordRefsHttp } from "../../../../../../../lib/record-page-ref-http";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const workspaceId = (await params).id;
  const views = new URL(request.url).searchParams.get("views") === "1";
  return api(request, async actor => views ? listRecordViewsHttp(request, actor, workspaceId, localPreview(request)) : searchRecordRefsHttp(request, actor, workspaceId, localPreview(request)));
}
