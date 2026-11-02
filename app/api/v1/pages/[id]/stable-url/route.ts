import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { repository } from "../../../../../../lib/repository";
import { changePublishedPage, draftPublication } from "../../../../../../lib/published-pages";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  return api(request, async actor => draftPublication(await repository(localPreview(request)), actor, (await params).id));
}

export async function POST(request: Request, { params }: Context) {
  return api(request, async actor => changePublishedPage(await repository(localPreview(request)), actor, (await params).id, await readJson(request, 16_000)), true);
}
