import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../../lib/auth";
import { changeExportAttachmentPolicy, exportAttachmentPolicy } from "../../../../../../../lib/compliance-pack";
import { DocumentError } from "../../../../../../../lib/document";
import { repository } from "../../../../../../../lib/repository";

const schema = z.object({
  operationId: z.string().uuid(),
  spaceId: z.string().min(1).max(200),
  attachments: z.boolean(),
  expectedVersion: z.number().int().positive(),
}).strict();

async function workspaceId(params: Promise<{ id: string }>) {
  const id = (await params).id;
  if (!id || id.length > 200) throw new DocumentError("Export unavailable", "not_found", 404);
  return id;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(req, async actor => {
    const spaceId = new URL(req.url).searchParams.get("spaceId") ?? "";
    if (!spaceId || spaceId.length > 200) throw new DocumentError("Export unavailable", "not_found", 404);
    return exportAttachmentPolicy(await repository(localPreview(req)), actor, await workspaceId(params), spaceId);
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(req, async actor => {
    const input = schema.safeParse(await readJson(req, 2048));
    if (!input.success) throw new DocumentError("Invalid export policy request");
    return changeExportAttachmentPolicy(await repository(localPreview(req)), actor, await workspaceId(params), input.data);
  }, true);
}
