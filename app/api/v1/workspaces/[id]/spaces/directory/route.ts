import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../../lib/auth";
import { DocumentError } from "../../../../../../../lib/document";
import { repository } from "../../../../../../../lib/repository";
import { SPACE_UNAVAILABLE, archiveSpace, joinSpace, listSpaceDirectory, requestSpaceAccess, setSpaceVisibility } from "../../../../../../../lib/space-directory";

type Context = { params: Promise<{ id: string }> };

function workspaceId(id: string) {
  if (!id || id.length > 200) throw new DocumentError(SPACE_UNAVAILABLE, "not_found", 404);
  return id;
}

const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("join"), spaceId: z.string().min(1).max(200), operationId: z.uuid() }).strict(),
  z.object({ action: z.literal("request-access"), spaceId: z.string().min(1).max(200), operationId: z.uuid() }).strict(),
  z.object({ action: z.literal("archive"), spaceId: z.string().min(1).max(200), operationId: z.uuid() }).strict(),
  z.object({ action: z.literal("unarchive"), spaceId: z.string().min(1).max(200), operationId: z.uuid() }).strict(),
  z.object({ action: z.literal("visibility"), spaceId: z.string().min(1).max(200), visibility: z.enum(["open", "discoverable", "private"]), operationId: z.uuid() }).strict(),
]);

export async function GET(request: Request, { params }: Context) {
  return api(request, async actor => {
    const id = workspaceId((await params).id);
    const includeArchived = new URL(request.url).searchParams.get("archived") === "1";
    return listSpaceDirectory(await repository(localPreview(request)), actor, id, includeArchived);
  });
}

export async function POST(request: Request, { params }: Context) {
  return api(request, async actor => {
    const id = workspaceId((await params).id);
    const parsed = command.safeParse(await readJson(request, 8_000));
    if (!parsed.success) throw new DocumentError(SPACE_UNAVAILABLE, "not_found", 404);
    const body = parsed.data;
    const repo = await repository(localPreview(request));
    if (body.action === "join") return joinSpace(repo, actor, id, body.spaceId, body.operationId);
    if (body.action === "request-access") return requestSpaceAccess(repo, actor, id, body.spaceId, body.operationId);
    if (body.action === "visibility") return setSpaceVisibility(repo, actor, id, body.spaceId, body.visibility, body.operationId);
    return archiveSpace(repo, actor, id, body.spaceId, body.operationId, body.action === "archive");
  }, true);
}
