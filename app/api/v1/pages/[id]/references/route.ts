import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { insertSearchReference } from "../../../../../../lib/search-jump";
import { repository } from "../../../../../../lib/repository";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  return api(request, async actor => {
    const { id } = await context.params;
    return insertSearchReference(await repository(localPreview(request)), actor, id, await readJson(request, 16_000));
  }, true);
}
