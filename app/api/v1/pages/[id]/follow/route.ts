import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { changePageFollow, pageFollowState } from "../../../../../../lib/page-follows";
import { repository } from "../../../../../../lib/repository";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  return api(request, async actor => pageFollowState(await repository(localPreview(request)), actor, (await params).id));
}

export async function POST(request: Request, { params }: Context) {
  return api(request, async actor => changePageFollow(await repository(localPreview(request)), actor, (await params).id, await readJson(request, 20_000)), true);
}
