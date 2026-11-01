import { api, localPreview } from "../../../../../../../lib/auth";
import { restoreRecordRefHttp } from "../../../../../../../lib/record-page-ref-http";
import { repository } from "../../../../../../../lib/repository";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const page = await (await repository(localPreview(request))).get((await params).id, actor);
    return restoreRecordRefHttp(request, actor, page.workspaceId, localPreview(request));
  }, true);
}
