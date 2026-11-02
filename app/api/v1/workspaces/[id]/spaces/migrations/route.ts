import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../../lib/auth";
import { DocumentError } from "../../../../../../../lib/document";
import { repository } from "../../../../../../../lib/repository";
import { SPACE_UNAVAILABLE, previewSpaceMigration, startSpaceMigration, stepSpaceMigration } from "../../../../../../../lib/space-directory";

type Context = { params: Promise<{ id: string }> };
const pageId = z.string().min(1).max(200);

const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview"), rootPageId: pageId, targetSpaceId: pageId, parentId: pageId.nullable().optional() }).strict(),
  z.object({ action: z.literal("start"), rootPageId: pageId, targetSpaceId: pageId, parentId: pageId.nullable().optional(), operationId: z.uuid(), previewDigest: z.string().regex(/^[a-f0-9]{64}$/), confirmAccess: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("step"), jobId: z.uuid(), operationId: z.uuid() }).strict(),
  z.object({ action: z.literal("resume"), jobId: z.uuid(), operationId: z.uuid() }).strict(),
]);

export async function POST(request: Request, { params }: Context) {
  return api(request, async actor => {
    const id = (await params).id;
    if (!id || id.length > 200) throw new DocumentError(SPACE_UNAVAILABLE, "not_found", 404);
    const parsed = command.safeParse(await readJson(request, 16_000));
    if (!parsed.success) throw new DocumentError(SPACE_UNAVAILABLE, "not_found", 404);
    const body = parsed.data;
    const repo = await repository(localPreview(request));
    if (body.action === "preview") return previewSpaceMigration(repo, actor, id, body);
    if (body.action === "start") return startSpaceMigration(repo, actor, id, body);
    return stepSpaceMigration(repo, actor, id, { jobId: body.jobId, operationId: body.operationId, resume: body.action === "resume" });
  }, true);
}
