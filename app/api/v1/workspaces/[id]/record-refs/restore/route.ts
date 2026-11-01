import { api, localPreview } from "../../../../../../../lib/auth";
import { restoreRecordRefHttp } from "../../../../../../../lib/record-page-ref-http";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => restoreRecordRefHttp(request, actor, (await params).id, localPreview(request)), true);
}
