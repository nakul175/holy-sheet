import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { DocumentError } from "../../../../../../lib/document";
import { createDocumentBundle, grantBundleManager, listDocumentBundles, revokeBundleManager } from "../../../../../../lib/document-bundles";
import { repository } from "../../../../../../lib/repository";

const member = z.object({
  pageId: z.string().trim().min(1).max(200),
  mode: z.enum(["live", "pinned"]),
  pinnedVersion: z.number().int().positive().nullable().optional(),
}).strict();
const command = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    operationId: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(2000).optional().default(""),
    ownerId: z.string().trim().min(1).max(200),
    members: z.array(member).max(100).optional().default([]),
  }).strict(),
  z.object({ action: z.literal("grant-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("revoke-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
]);

async function workspaceId(params: Promise<{ id: string }>) {
  const id = (await params).id;
  if (!id || id.length > 200) throw new DocumentError("Document bundle unavailable", "not_found", 404);
  return id;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const url = new URL(request.url);
    return listDocumentBundles(await repository(localPreview(request)), actor, await workspaceId(params), url.searchParams.get("q") ?? "", url.searchParams.get("pageId"));
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const parsed = command.safeParse(await readJson(request, 64_000));
    if (!parsed.success) throw new DocumentError("Invalid document bundle request", "bundle_validation", 422);
    const pages = await repository(localPreview(request));
    const id = await workspaceId(params);
    const body = parsed.data;
    if (body.action === "grant-manager") return grantBundleManager(pages, actor, id, body);
    if (body.action === "revoke-manager") return revokeBundleManager(pages, actor, id, body);
    return createDocumentBundle(pages, actor, id, body);
  }, true);
}
