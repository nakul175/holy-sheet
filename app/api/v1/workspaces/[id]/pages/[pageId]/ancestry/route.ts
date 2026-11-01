import { api, localPreview } from "../../../../../../../../lib/auth";
import { ancestryQuery, readPageAncestry } from "../../../../../../../../lib/breadcrumb";
import { repository } from "../../../../../../../../lib/repository";

type Context = { params: Promise<{ id: string; pageId: string }> };

export async function GET(request: Request, context: Context) {
  return api(request, async actor => {
    const { id, pageId } = await context.params;
    return readPageAncestry(await repository(localPreview(request)), actor, id, pageId, ancestryQuery(new URL(request.url)));
  });
}
