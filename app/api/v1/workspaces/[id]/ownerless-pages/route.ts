import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { ownerlessPages, runPageHandover } from "../../../../../../lib/page-owners";
import { repository } from "../../../../../../lib/repository";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  return api(request, async actor => ownerlessPages(await repository(localPreview(request)), actor, (await params).id));
}

export async function POST(request: Request, { params }: Context) {
  return api(request, async actor => runPageHandover(await repository(localPreview(request)), actor, (await params).id, await readJson(request, 200_000)), true);
}
