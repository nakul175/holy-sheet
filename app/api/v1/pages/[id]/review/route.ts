import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { changePageReview, pageReviewView } from "../../../../../../lib/page-review";
import { repository } from "../../../../../../lib/repository";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  return api(request, async actor => pageReviewView(await repository(localPreview(request)), actor, (await params).id));
}

export async function POST(request: Request, { params }: Context) {
  return api(request, async actor => changePageReview(await repository(localPreview(request)), actor, (await params).id, await readJson(request, 16_000)), true);
}
