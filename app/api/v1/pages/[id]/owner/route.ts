import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { changePageOwner, pageOwner } from "../../../../../../lib/page-owners";
import { repository } from "../../../../../../lib/repository";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  return api(request, async actor => pageOwner(await repository(localPreview(request)), actor, (await params).id));
}

export async function POST(request: Request, { params }: Context) {
  return api(request, async actor => changePageOwner(await repository(localPreview(request)), actor, (await params).id, await readJson(request, 8_000)), true);
}
