import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { DocumentError } from "../../../../../../lib/document";
import { repository } from "../../../../../../lib/repository";
import { detachSnippetPlacement, insertSnippetPlacement, listSnippetPicker, listSnippetPlacements, updateSnippetPlacement } from "../../../../../../lib/snippets";

const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("insert"), operationId: z.string().uuid(), snippetId: z.string().uuid(), pinVersion: z.number().int().positive().nullable().optional(), blockId: z.string().min(1).max(100).optional() }).strict(),
  z.object({ action: z.literal("detach"), operationId: z.string().uuid(), blockId: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal("update"), operationId: z.string().uuid(), blockId: z.string().min(1).max(100) }).strict(),
]);

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const pages = await repository(localPreview(request));
    const pageId = (await params).id;
    if (new URL(request.url).searchParams.get("picker") === "1") return listSnippetPicker(pages, actor, pageId);
    return listSnippetPlacements(pages, actor, pageId);
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const parsed = command.safeParse(await readJson(request));
    if (!parsed.success) throw new DocumentError("Invalid snippet operation");
    const pages = await repository(localPreview(request));
    const pageId = (await params).id;
    const body = parsed.data;
    if (body.action === "insert") return insertSnippetPlacement(pages, actor, pageId, body);
    if (body.action === "detach") return detachSnippetPlacement(pages, actor, pageId, body);
    return updateSnippetPlacement(pages, actor, pageId, body);
  }, true);
}
