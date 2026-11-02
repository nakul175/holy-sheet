import { api, localPreview } from "../../../../../../../../../lib/auth";
import { DocumentError } from "../../../../../../../../../lib/document";
import { repository } from "../../../../../../../../../lib/repository";
import { SPACE_UNAVAILABLE, resolveSpacePage } from "../../../../../../../../../lib/space-directory";

type Context = { params: Promise<{ id: string; spaceId: string; pageId: string }> };

export async function GET(request: Request, { params }: Context) {
  return api(request, async actor => {
    const { id, spaceId, pageId } = await params;
    if (!id || !spaceId || !pageId) throw new DocumentError(SPACE_UNAVAILABLE, "not_found", 404);
    return resolveSpacePage(await repository(localPreview(request)), actor, id, spaceId, pageId);
  });
}
