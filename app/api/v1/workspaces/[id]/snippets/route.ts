import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { DocumentError } from "../../../../../../lib/document";
import { repository } from "../../../../../../lib/repository";
import { createSnippet, grantSnippetRole, listSnippetLibrary, revokeSnippetRole } from "../../../../../../lib/snippets";

const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), operationId: z.string().uuid(), spaceId: z.string().min(1).max(100), title: z.string().min(1).max(120), content: z.unknown() }).strict(),
  z.object({ action: z.literal("grant"), operationId: z.string().uuid(), spaceId: z.string().min(1).max(100), userId: z.string().min(1).max(200), role: z.enum(["manager", "approver", "reviewer"]) }).strict(),
  z.object({ action: z.literal("revoke"), operationId: z.string().uuid(), spaceId: z.string().min(1).max(100), userId: z.string().min(1).max(200), role: z.enum(["manager", "approver", "reviewer"]) }).strict(),
]);

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const spaceId = new URL(request.url).searchParams.get("spaceId") ?? undefined;
    return listSnippetLibrary(await repository(localPreview(request)), actor, (await params).id, spaceId);
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const parsed = command.safeParse(await readJson(request));
    if (!parsed.success) throw new DocumentError("Invalid snippet operation");
    const pages = await repository(localPreview(request));
    const workspaceId = (await params).id;
    const body = parsed.data;
    if (body.action === "create") return createSnippet(pages, actor, workspaceId, body);
    if (body.action === "grant") return grantSnippetRole(pages, actor, workspaceId, body);
    return revokeSnippetRole(pages, actor, workspaceId, body);
  }, true);
}
