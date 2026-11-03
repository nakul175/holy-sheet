import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { DocumentError } from "../../../../../../lib/document";
import { repository } from "../../../../../../lib/repository";
import {
  applyQuickCapture,
  discardQuickCaptureDraft,
  discardQuickCapturePolicy,
  downloadQuickCapture,
  grantQuickCaptureOperator,
  previewQuickCapture,
  quickCaptureCatalogue,
  quickCaptureHistory,
  quickCaptureSourcePreview,
  readQuickCapture,
  revokeQuickCaptureOperator,
  saveQuickCaptureFieldPolicy,
  saveQuickCapturePolicy,
  searchQuickCapture,
  setQuickCaptureActions,
  stashQuickCapture,
  stashQuickCapturePolicy,
} from "../../../../../../lib/quick-capture";

const access = z.object({ userId: z.string().trim().min(1).max(200), canView: z.boolean(), canWrite: z.boolean(), canHistory: z.boolean() }).strict();
const asset = z.object({ name: z.string().trim().min(1).max(200), selected: z.boolean() }).strict();
const capture = {
  kind: z.enum(["text", "link", "note"]),
  title: z.string().trim().min(1).max(200),
  body: z.string().max(50_000).optional(),
  sourceUrl: z.string().max(2_000).optional(),
  sourceTitle: z.string().max(200).optional(),
  sourcePageId: z.string().trim().min(1).max(200).optional(),
  sourceAccess: z.string().max(40).optional(),
  destinationKind: z.enum(["space", "intake"]).optional(),
  destinationId: z.string().trim().min(1).max(200).optional(),
  assets: z.array(asset).max(20).optional(),
  draftKey: z.string().trim().min(1).max(80).optional(),
};
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("configure"), operationId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), kinds: z.array(z.string()).max(3), defaultDestination: z.string(), offlinePolicy: z.string().optional(), visibility: z.string().optional(), inheritExternal: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("stash-policy"), operationId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), kinds: z.array(z.string()).max(3), defaultDestination: z.string() }).strict(),
  z.object({ action: z.literal("discard-policy"), operationId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("field-policy"), operationId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), sensitive: z.boolean(), access: z.array(access).max(50) }).strict(),
  z.object({ action: z.literal("actions"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200), expectedVersion: z.number().int().nonnegative(), actions: z.array(z.string()).max(7) }).strict(),
  z.object({ action: z.literal("grant-operator"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("revoke-operator"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("stash"), operationId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), ...capture }).strict(),
  z.object({ action: z.literal("discard-draft"), operationId: z.string().uuid(), draftKey: z.string().trim().min(1).max(80).optional() }).strict(),
  z.object({ action: z.literal("preview"), operationId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), ...capture }).strict(),
  z.object({ action: z.literal("apply"), operationId: z.string().uuid(), previewId: z.string().uuid(), expectedVersion: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal("download"), operationId: z.string().uuid(), captureId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
]);

async function workspaceId(params: Promise<{ id: string }>) {
  const id = (await params).id;
  if (!id || id.length > 200) throw new DocumentError("Quick capture is restricted or unavailable.", "not_found", 404);
  return id;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const id = await workspaceId(params);
    const url = new URL(request.url);
    const pages = await repository(localPreview(request));
    const view = url.searchParams.get("view");
    const captureId = url.searchParams.get("captureId") ?? "";
    if (view === "capture") {
      if (!captureId) throw new DocumentError("Quick capture is restricted or unavailable.", "not_found", 404);
      return readQuickCapture(pages, actor, id, captureId);
    }
    if (view === "search") {
      const query = url.searchParams.get("q");
      if (!query) throw new DocumentError("Check the capture.", "quick_capture_validation", 422);
      return searchQuickCapture(pages, actor, id, query);
    }
    if (view === "history") {
      if (!captureId) throw new DocumentError("Quick capture is restricted or unavailable.", "not_found", 404);
      return quickCaptureHistory(pages, actor, id, captureId);
    }
    if (view === "source") {
      if (!captureId) throw new DocumentError("Quick capture is restricted or unavailable.", "not_found", 404);
      return quickCaptureSourcePreview(pages, actor, id, captureId);
    }
    if (view) throw new DocumentError("Quick capture is restricted or unavailable.", "not_found", 404);
    return quickCaptureCatalogue(pages, actor, id);
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const parsed = command.safeParse(await readJson(request, 80_000));
    if (!parsed.success) throw new DocumentError("Check the capture.", "quick_capture_validation", 422);
    const pages = await repository(localPreview(request));
    const id = await workspaceId(params);
    const body = parsed.data;
    if (body.action === "configure") return saveQuickCapturePolicy(pages, actor, id, body);
    if (body.action === "stash-policy") return stashQuickCapturePolicy(pages, actor, id, body);
    if (body.action === "discard-policy") return discardQuickCapturePolicy(pages, actor, id, body);
    if (body.action === "field-policy") return saveQuickCaptureFieldPolicy(pages, actor, id, body);
    if (body.action === "actions") return setQuickCaptureActions(pages, actor, id, body);
    if (body.action === "grant-operator") return grantQuickCaptureOperator(pages, actor, id, body);
    if (body.action === "revoke-operator") return revokeQuickCaptureOperator(pages, actor, id, body);
    if (body.action === "stash") return stashQuickCapture(pages, actor, id, body);
    if (body.action === "discard-draft") return discardQuickCaptureDraft(pages, actor, id, body);
    if (body.action === "preview") return previewQuickCapture(pages, actor, id, body);
    if (body.action === "apply") return applyQuickCapture(pages, actor, id, body);
    return downloadQuickCapture(pages, actor, id, body);
  }, true);
}
