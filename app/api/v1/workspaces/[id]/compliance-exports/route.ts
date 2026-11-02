import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { complianceSessionBinding, createComplianceExport, listComplianceExports } from "../../../../../../lib/compliance-pack";
import { DocumentError } from "../../../../../../lib/document";
import { repository } from "../../../../../../lib/repository";

const scope = z.enum(["page", "tree", "space"]);
const format = z.enum(["pdf", "html", "markdown", "compliance-pack"]);
const schema = z.object({
  operationId: z.string().uuid(),
  scope,
  format,
  targetId: z.string().min(1).max(200),
  includeDraft: z.boolean(),
  includeTrash: z.boolean(),
  allAttachmentVersions: z.boolean(),
}).strict();

async function workspaceId(params: Promise<{ id: string }>) {
  const id = (await params).id;
  if (!id || id.length > 200) throw new DocumentError("Export unavailable", "not_found", 404);
  return id;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(req, async actor => {
    const repo = await repository(localPreview(req));
    return listComplianceExports(repo, actor, await workspaceId(params), complianceSessionBinding(req, actor.id));
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(req, async actor => {
    const input = schema.safeParse(await readJson(req, 4096));
    if (!input.success) throw new DocumentError("Invalid export request");
    const repo = await repository(localPreview(req));
    return createComplianceExport(repo, actor, await workspaceId(params), input.data, complianceSessionBinding(req, actor.id));
  }, true);
}
