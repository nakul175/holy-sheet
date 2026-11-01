import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../../lib/auth";
import { DocumentError } from "../../../../../../../lib/document";
import { repository } from "../../../../../../../lib/repository";
import { approveSnippetVersion, deleteSnippet, draftSnippetVersion, getSnippet, previewSnippetRetire, restoreSnippet, retireSnippet, saveSnippetDraft, submitSnippetVersion } from "../../../../../../../lib/snippets";

const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save-draft"), operationId: z.string().uuid(), versionNumber: z.number().int().positive(), content: z.unknown() }).strict(),
  z.object({ action: z.literal("submit"), operationId: z.string().uuid(), versionNumber: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("approve"), operationId: z.string().uuid(), versionNumber: z.number().int().positive(), note: z.string().min(1).max(500) }).strict(),
  z.object({ action: z.literal("draft-version"), operationId: z.string().uuid(), content: z.unknown() }).strict(),
  z.object({ action: z.literal("retire-preview") }).strict(),
  z.object({ action: z.literal("retire"), operationId: z.string().uuid(), titles: z.array(z.string().max(240)).max(500), hiddenCount: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal("delete"), operationId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("restore"), operationId: z.string().uuid() }).strict(),
]);

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; snippetId: string }> }) {
  return api(_request, async actor => {
    const { id, snippetId } = await params;
    return getSnippet(await repository(localPreview(_request)), actor, id, snippetId);
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string; snippetId: string }> }) {
  return api(request, async actor => {
    const parsed = command.safeParse(await readJson(request));
    if (!parsed.success) throw new DocumentError("Invalid snippet operation");
    const pages = await repository(localPreview(request));
    const { id, snippetId } = await params;
    const body = parsed.data;
    if (body.action === "save-draft") return saveSnippetDraft(pages, actor, id, snippetId, body);
    if (body.action === "submit") return submitSnippetVersion(pages, actor, id, snippetId, body);
    if (body.action === "approve") return approveSnippetVersion(pages, actor, id, snippetId, body);
    if (body.action === "draft-version") return draftSnippetVersion(pages, actor, id, snippetId, body);
    if (body.action === "retire-preview") return previewSnippetRetire(pages, actor, id, snippetId);
    if (body.action === "retire") return retireSnippet(pages, actor, id, snippetId, body);
    if (body.action === "delete") return deleteSnippet(pages, actor, id, snippetId, body);
    return restoreSnippet(pages, actor, id, snippetId, body);
  }, true);
}
