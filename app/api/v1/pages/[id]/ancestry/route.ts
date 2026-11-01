import { api, localPreview } from "../../../../../../lib/auth";
import { ancestryQuery, readPageAncestryForPage } from "../../../../../../lib/breadcrumb";
import { repository } from "../../../../../../lib/repository";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return api(request, async actor => {
    const { id } = await context.params;
    return readPageAncestryForPage(await repository(localPreview(request)), actor, id, ancestryQuery(new URL(request.url)));
  });
}
