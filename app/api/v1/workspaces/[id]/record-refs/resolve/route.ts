import { api, localPreview } from "../../../../../../../lib/auth";
import { resolveRecordRefsHttp } from "../../../../../../../lib/record-page-ref-http";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => resolveRecordRefsHttp(request, actor, (await params).id, localPreview(request)), true);
}
