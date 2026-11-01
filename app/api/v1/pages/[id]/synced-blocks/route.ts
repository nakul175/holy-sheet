import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { DocumentError } from "../../../../../../lib/document";
import { repository } from "../../../../../../lib/repository";
import { deleteAllSyncedCopies, deleteSyncedPlacement, grantSyncedAccess, listSyncedViews, previewDeleteAll, restoreSyncedSource, undoDeleteAll, unsyncPlacement } from "../../../../../../lib/synced-blocks";

const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("unsync"), operationId: z.string().uuid(), blockId: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal("delete-placement"), operationId: z.string().uuid(), blockId: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal("delete-all-preview"), blockId: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal("delete-all"), operationId: z.string().uuid(), blockId: z.string().min(1).max(100), confirm: z.literal(true), titles: z.array(z.string().max(240)).max(100), hiddenCount: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal("undo-delete"), operationId: z.string().uuid(), blockId: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal("restore-source"), operationId: z.string().uuid(), blockId: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal("grant"), operationId: z.string().uuid(), blockId: z.string().min(1).max(100), subject: z.string().min(1).max(200), role: z.enum(["viewer", "editor"]) }).strict(),
]);

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => listSyncedViews(await repository(localPreview(request)), actor, (await params).id));
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const parsed = command.safeParse(await readJson(request));
    if (!parsed.success) throw new DocumentError("Invalid synced block operation");
    const pages = await repository(localPreview(request));
    const pageId = (await params).id;
    const body = parsed.data;
    if (body.action === "unsync") return unsyncPlacement(pages, actor, pageId, body);
    if (body.action === "delete-placement") return deleteSyncedPlacement(pages, actor, pageId, body);
    if (body.action === "delete-all-preview") return previewDeleteAll(pages, actor, pageId, body.blockId);
    if (body.action === "delete-all") return deleteAllSyncedCopies(pages, actor, pageId, body);
    if (body.action === "undo-delete") return undoDeleteAll(pages, actor, pageId, body);
    if (body.action === "restore-source") return restoreSyncedSource(pages, actor, pageId, body);
    return grantSyncedAccess(pages, actor, pageId, body);
  }, true);
}
