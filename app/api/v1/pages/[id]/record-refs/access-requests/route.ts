import { api, localPreview } from "../../../../../../../lib/auth";
import { requestRecordAccessHttp } from "../../../../../../../lib/record-page-ref-http";
import { repository } from "../../../../../../../lib/repository";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const page = await (await repository(localPreview(request))).get((await params).id, actor);
    return requestRecordAccessHttp(request, actor, page.workspaceId, localPreview(request));
  }, true);
}
