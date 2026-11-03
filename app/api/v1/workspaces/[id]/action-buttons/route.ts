import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { DocumentError } from "../../../../../../lib/document";
import { repository } from "../../../../../../lib/repository";
import {
  actionButtonCatalogue,
  actionButtonHistory,
  applyActionButtonPreview,
  createActionButton,
  discardActionButtonDraft,
  downloadActionButton,
  grantActionButtonManager,
  previewActionButton,
  readActionButton,
  readActionReceipt,
  retryActionButtonLink,
  revokeActionButtonManager,
  searchActionButtons,
  stashActionButton,
} from "../../../../../../lib/action-button";

const definition = z.record(z.string(), z.unknown());
const inputs = z.record(z.string(), z.unknown());
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), operationId: z.string().uuid(), collection: z.string().trim().min(1).max(80), label: z.string().trim().min(1).max(80), definition }).strict(),
  z.object({ action: z.literal("stash"), operationId: z.string().uuid(), buttonId: z.string().uuid(), expectedVersion: z.number().int().positive(), definition }).strict(),
  z.object({ action: z.literal("discard-draft"), operationId: z.string().uuid(), buttonId: z.string().uuid() }).strict(),
  z.object({
    action: z.literal("preview"), operationId: z.string().uuid(), buttonId: z.string().uuid(),
    kind: z.enum(["activate", "pause", "version-change", "rollback", "invoke"]),
    expectedVersion: z.number().int().positive(), definition: definition.optional(), label: z.string().trim().min(1).max(80).optional(),
    targetVersion: z.number().int().positive().optional(), recordId: z.string().uuid().optional(),
    pageId: z.string().trim().min(1).max(80).optional(), inputs: inputs.optional(),
  }).strict(),
  z.object({ action: z.literal("apply"), operationId: z.string().uuid(), previewId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("retry-link"), operationId: z.string().uuid(), receiptId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("download"), operationId: z.string().uuid(), buttonId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("grant-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("revoke-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
]);

async function workspaceId(params: Promise<{ id: string }>) {
  const id = (await params).id;
  if (!id || id.length > 200) throw new DocumentError("Action buttons are restricted or unavailable.", "not_found", 404);
  return id;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const id = await workspaceId(params);
    const url = new URL(request.url);
    const pages = await repository(localPreview(request));
    const view = url.searchParams.get("view");
    const buttonId = url.searchParams.get("buttonId");
    if (view === "button") {
      if (!buttonId) throw new DocumentError("Action buttons are restricted or unavailable.", "not_found", 404);
      return readActionButton(pages, actor, id, buttonId);
    }
    if (view === "search") {
      const query = url.searchParams.get("q");
      if (!query) throw new DocumentError("Check the action button request.", "action_button_validation", 422);
      return searchActionButtons(pages, actor, id, query);
    }
    if (view === "history") {
      if (!buttonId) throw new DocumentError("Action buttons are restricted or unavailable.", "not_found", 404);
      return actionButtonHistory(pages, actor, id, buttonId);
    }
    if (view === "receipt") {
      const receiptId = url.searchParams.get("receiptId");
      if (!receiptId) throw new DocumentError("Action buttons are restricted or unavailable.", "not_found", 404);
      return readActionReceipt(pages, actor, id, receiptId);
    }
    if (view) throw new DocumentError("Action buttons are restricted or unavailable.", "not_found", 404);
    return actionButtonCatalogue(pages, actor, id, { recordId: url.searchParams.get("recordId"), pageId: url.searchParams.get("pageId") });
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const parsed = command.safeParse(await readJson(request, 64_000));
    if (!parsed.success) throw new DocumentError("Check the action button request.", "action_button_validation", 422);
    const pages = await repository(localPreview(request));
    const id = await workspaceId(params);
    const body = parsed.data;
    if (body.action === "create") return createActionButton(pages, actor, id, body);
    if (body.action === "stash") return stashActionButton(pages, actor, id, body);
    if (body.action === "discard-draft") return discardActionButtonDraft(pages, actor, id, body);
    if (body.action === "preview") return previewActionButton(pages, actor, id, body);
    if (body.action === "apply") return applyActionButtonPreview(pages, actor, id, body);
    if (body.action === "retry-link") return retryActionButtonLink(pages, actor, id, body);
    if (body.action === "download") return downloadActionButton(pages, actor, id, body);
    if (body.action === "grant-manager") return grantActionButtonManager(pages, actor, id, body);
    return revokeActionButtonManager(pages, actor, id, body);
  }, true);
}
