import { api, localPreview, readJson } from "../../../../../../../../lib/auth";
import { DocumentError } from "../../../../../../../../lib/document";
import { repository } from "../../../../../../../../lib/repository";
import { SPACE_HOME_UNAVAILABLE } from "../../../../../../../../lib/space-home-shared";
import { changeSpaceHome, readSpaceHome } from "../../../../../../../../lib/space-home";

type Context = { params: Promise<{ id: string; spaceId: string }> };

function target(workspaceId: string, spaceId: string) {
  if (!workspaceId || workspaceId.length > 200 || !spaceId || spaceId.length > 200) throw new DocumentError(SPACE_HOME_UNAVAILABLE, "not_found", 404);
  return { workspaceId, spaceId };
}

export async function GET(request: Request, { params }: Context) {
  return api(request, async actor => {
    const { id, spaceId } = await params;
    const ids = target(id, spaceId);
    return readSpaceHome(await repository(localPreview(request)), actor, ids.workspaceId, ids.spaceId);
  });
}

export async function POST(request: Request, { params }: Context) {
  return api(request, async actor => {
    const { id, spaceId } = await params;
    const ids = target(id, spaceId);
    const body = await readJson(request, 16_000);
    return changeSpaceHome(await repository(localPreview(request)), actor, ids.workspaceId, ids.spaceId, body);
  }, true);
}
