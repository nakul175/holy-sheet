import { api, localPreview, readJson } from "../../../../lib/auth";
import { changeFollowSettings, listPageFollows } from "../../../../lib/page-follows";
import { repository } from "../../../../lib/repository";

export async function GET(request: Request) {
  return api(request, async actor => listPageFollows(await repository(localPreview(request)), actor));
}

export async function POST(request: Request) {
  return api(request, async actor => changeFollowSettings(await repository(localPreview(request)), actor, await readJson(request, 20_000)), true);
}
