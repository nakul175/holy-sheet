import { api, localPreview } from "../../../../../../../../lib/auth";
import { DocumentError } from "../../../../../../../../lib/document";
import { repository } from "../../../../../../../../lib/repository";
import { SPACE_UNAVAILABLE, readSpaceBySlug } from "../../../../../../../../lib/space-directory";

type Context = { params: Promise<{ id: string; slug: string }> };

export async function GET(request: Request, { params }: Context) {
  return api(request, async actor => {
    const { id, slug } = await params;
    if (!id || id.length > 200 || !slug || slug.length > 80) throw new DocumentError(SPACE_UNAVAILABLE, "not_found", 404);
    return readSpaceBySlug(await repository(localPreview(request)), actor, slug, id);
  });
}
