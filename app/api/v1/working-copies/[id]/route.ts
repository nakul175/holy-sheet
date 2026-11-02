import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../lib/auth";
import { DocumentError } from "../../../../../lib/document";
import { repository } from "../../../../../lib/repository";
import { abandonWorkingCopy, applyWorkingCopy, archiveWorkingCopy, readWorkingCopy, reconcileWorkingCopy, saveWorkingCopyChoices } from "../../../../../lib/working-copies";

const choice = z.enum(["original", "copy"]);
const choices = z.record(z.string().min(1).max(120), choice).refine(value => Object.keys(value).length <= 400, "Too many choices");
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reconcile") }).strict(),
  z.object({ action: z.literal("save-choices"), operationId: z.string().uuid(), expectedVersion: z.number().int().positive(), choices }).strict(),
  z.object({ action: z.literal("apply"), operationId: z.string().uuid(), expectedVersion: z.number().int().positive(), expectedSourceVersion: z.number().int().positive(), choices }).strict(),
  z.object({ action: z.literal("abandon"), operationId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("archive"), operationId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
]);

async function copyId(params: Promise<{ id: string }>) {
  const id = (await params).id;
  if (!z.string().uuid().safeParse(id).success) throw new DocumentError("Working copy unavailable", "not_found", 404);
  return id;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(req, async actor => readWorkingCopy(await repository(localPreview(req)), actor, await copyId(params)));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(req, async actor => {
    const input = command.safeParse(await readJson(req, 64_000));
    if (!input.success) throw new DocumentError("Invalid working copy request", "working_copy_validation", 422);
    const repo = await repository(localPreview(req));
    const id = await copyId(params);
    const body = input.data;
    if (body.action === "reconcile") return reconcileWorkingCopy(repo, actor, id);
    if (body.action === "save-choices") return saveWorkingCopyChoices(repo, actor, id, body);
    if (body.action === "apply") return applyWorkingCopy(repo, actor, id, body);
    if (body.action === "abandon") return abandonWorkingCopy(repo, actor, id, body);
    return archiveWorkingCopy(repo, actor, id, body);
  }, true);
}
