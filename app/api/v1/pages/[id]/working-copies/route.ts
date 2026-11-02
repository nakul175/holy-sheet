import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { DocumentError } from "../../../../../../lib/document";
import { repository } from "../../../../../../lib/repository";
import { createWorkingCopy, listWorkingCopies } from "../../../../../../lib/working-copies";

const create = z.object({ operationId: z.string().uuid() }).strict();

async function pageId(params: Promise<{ id: string }>) {
  const id = (await params).id;
  if (!id || id.length > 200) throw new DocumentError("Working copy unavailable", "not_found", 404);
  return id;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(req, async actor => listWorkingCopies(await repository(localPreview(req)), actor, await pageId(params)));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(req, async actor => {
    const input = create.safeParse(await readJson(req, 1024));
    if (!input.success) throw new DocumentError("Invalid working copy request", "working_copy_validation", 422);
    return createWorkingCopy(await repository(localPreview(req)), actor, await pageId(params), input.data.operationId);
  }, true);
}
