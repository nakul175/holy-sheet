import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { DocumentError } from "../../../../../../lib/document";
import { applyPageTreeMove, cancelEmptyPageTreePage, createPageTreeChild, listPageTreeChildren, previewPageTreeMove, renamePageTreePage } from "../../../../../../lib/page-tree";
import { PAGE_TREE_UNAVAILABLE } from "../../../../../../lib/page-tree-model";
import { repository } from "../../../../../../lib/repository";

const unavailable = () => new DocumentError(PAGE_TREE_UNAVAILABLE, "not_found", 404);
const id = z.string().min(1).max(200);
const move = { pageId: id, spaceId: id, parentId: id.nullable(), index: z.number().int().min(0).max(1000) };
const input = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preview"), ...move }).strict(),
  z.object({ kind: z.literal("apply"), ...move, operationId: z.uuid(), expectedTreeVersion: z.number().int().positive(), previewDigest: z.string().regex(/^[a-f0-9]{64}$/), confirmExpanded: z.boolean() }).strict(),
  z.object({ kind: z.literal("create"), spaceId: id, parentId: id.nullable(), operationId: z.uuid() }).strict(),
  z.object({ kind: z.literal("rename"), pageId: id, title: z.string().max(240), baseVersion: z.number().int().positive(), operationId: z.uuid() }).strict(),
  z.object({ kind: z.literal("cancel"), operationId: z.uuid() }).strict(),
]);
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return api(request, async actor => {
    const workspaceId = (await context.params).id;
    const url = new URL(request.url);
    const spaceId = url.searchParams.get("spaceId") ?? "";
    const parent = url.searchParams.get("parentId");
    const cursor = url.searchParams.get("cursor");
    if (!spaceId || spaceId.length > 200 || (parent !== null && parent.length > 200) || (cursor !== null && cursor.length > 200)) throw unavailable();
    return listPageTreeChildren(await repository(localPreview(request)), actor, workspaceId, { spaceId, parentId: parent || null, cursor });
  });
}

export async function POST(request: Request, context: Context) {
  return api(request, async actor => {
    const workspaceId = (await context.params).id;
    const parsed = input.safeParse(await readJson(request, 16_000));
    if (!parsed.success || !workspaceId || workspaceId.length > 200) throw new DocumentError("Invalid page tree request", "invalid_page_tree", 422);
    const r = await repository(localPreview(request));
    const body = parsed.data;
    if (body.kind === "preview") return previewPageTreeMove(r, actor, workspaceId, body);
    if (body.kind === "apply") return applyPageTreeMove(r, actor, workspaceId, body);
    if (body.kind === "create") return createPageTreeChild(r, actor, workspaceId, body);
    if (body.kind === "rename") return renamePageTreePage(r, actor, workspaceId, body);
    return cancelEmptyPageTreePage(r, actor, workspaceId, body.operationId);
  }, true);
}
