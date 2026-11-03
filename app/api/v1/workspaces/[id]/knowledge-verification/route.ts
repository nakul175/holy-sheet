import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { DocumentError } from "../../../../../../lib/document";
import { repository } from "../../../../../../lib/repository";
import {
  applyKnowledgeVerification,
  discardKnowledgeVerificationDraft,
  discardKnowledgeVerificationPolicy,
  downloadKnowledgeVerification,
  grantKnowledgeSteward,
  knowledgeVerificationCatalogue,
  knowledgeVerificationHistory,
  knowledgeVerificationSourcePreview,
  previewKnowledgeVerification,
  projectKnowledgeVerification,
  readKnowledgeBadge,
  reportKnowledgeConcern,
  revokeKnowledgeSteward,
  saveKnowledgeVerificationFieldPolicy,
  saveKnowledgeVerificationPolicy,
  searchKnowledgeVerification,
  setKnowledgeVerificationActions,
  stashKnowledgeVerification,
  stashKnowledgeVerificationPolicy,
} from "../../../../../../lib/knowledge-verification";

const access = z.object({ userId: z.string().trim().min(1).max(200), canView: z.boolean(), canWrite: z.boolean(), canHistory: z.boolean() }).strict();
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("configure"), operationId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), bases: z.array(z.string()).max(8), defaultExpiryDays: z.number().int(), titleOnly: z.string().optional() }).strict(),
  z.object({ action: z.literal("stash-policy"), operationId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), bases: z.array(z.string()).max(8), defaultExpiryDays: z.number().int() }).strict(),
  z.object({ action: z.literal("discard-policy"), operationId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("field-policy"), operationId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), sensitive: z.boolean(), access: z.array(access).max(50) }).strict(),
  z.object({ action: z.literal("actions"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200), expectedVersion: z.number().int().nonnegative(), actions: z.array(z.string()).max(7) }).strict(),
  z.object({ action: z.literal("grant-steward"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("revoke-steward"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
  z.object({
    action: z.literal("stash"), operationId: z.string().uuid(), targetKind: z.enum(["page", "record"]), targetId: z.string().trim().min(1).max(200),
    expectedVersion: z.number().int().nonnegative(), ownerId: z.string().trim().min(1).max(200), basis: z.string().trim().min(1).max(80),
    basisNote: z.string().trim().min(1).max(240), expiryDays: z.number().int(),
  }).strict(),
  z.object({ action: z.literal("discard-draft"), operationId: z.string().uuid(), targetKind: z.enum(["page", "record"]), targetId: z.string().trim().min(1).max(200) }).strict(),
  z.object({
    action: z.literal("preview"), operationId: z.string().uuid(), kind: z.enum(["verify", "renew", "revoke"]), expectedVersion: z.number().int().nonnegative(),
    targetKind: z.enum(["page", "record"]).optional(), targetId: z.string().trim().min(1).max(200).optional(), badgeId: z.string().uuid().optional(),
    ownerId: z.string().trim().min(1).max(200).optional(), basis: z.string().trim().min(1).max(80).optional(), basisNote: z.string().trim().min(1).max(240).optional(),
    expiryDays: z.number().int().optional(), reason: z.string().trim().min(1).max(500).optional(),
  }).strict(),
  z.object({ action: z.literal("apply"), operationId: z.string().uuid(), previewId: z.string().uuid(), expectedVersion: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal("report"), operationId: z.string().uuid(), badgeId: z.string().uuid(), reason: z.string().trim().min(1).max(500) }).strict(),
  z.object({ action: z.literal("download"), operationId: z.string().uuid(), badgeId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
]);

async function workspaceId(params: Promise<{ id: string }>) {
  const id = (await params).id;
  if (!id || id.length > 200) throw new DocumentError("Verification is restricted or unavailable.", "not_found", 404);
  return id;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const id = await workspaceId(params);
    const url = new URL(request.url);
    const pages = await repository(localPreview(request));
    const view = url.searchParams.get("view");
    const badgeId = url.searchParams.get("badgeId") ?? "";
    if (view === "badge") {
      if (!badgeId) throw new DocumentError("Verification is restricted or unavailable.", "not_found", 404);
      return readKnowledgeBadge(pages, actor, id, badgeId);
    }
    if (view === "search") {
      const query = url.searchParams.get("q");
      if (!query) throw new DocumentError("Check the verification request.", "knowledge_verification_validation", 422);
      return searchKnowledgeVerification(pages, actor, id, query);
    }
    if (view === "history") {
      if (!badgeId) throw new DocumentError("Verification is restricted or unavailable.", "not_found", 404);
      return knowledgeVerificationHistory(pages, actor, id, badgeId);
    }
    if (view === "source") {
      if (!badgeId) throw new DocumentError("Verification is restricted or unavailable.", "not_found", 404);
      return knowledgeVerificationSourcePreview(pages, actor, id, badgeId);
    }
    if (view === "interfaces") {
      return projectKnowledgeVerification(pages, actor, id, { recordIds: url.searchParams.getAll("recordId"), pageIds: url.searchParams.getAll("pageId") });
    }
    if (view) throw new DocumentError("Verification is restricted or unavailable.", "not_found", 404);
    return knowledgeVerificationCatalogue(pages, actor, id);
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const parsed = command.safeParse(await readJson(request, 64_000));
    if (!parsed.success) throw new DocumentError("Check the verification request.", "knowledge_verification_validation", 422);
    const pages = await repository(localPreview(request));
    const id = await workspaceId(params);
    const body = parsed.data;
    if (body.action === "configure") return saveKnowledgeVerificationPolicy(pages, actor, id, body);
    if (body.action === "stash-policy") return stashKnowledgeVerificationPolicy(pages, actor, id, body);
    if (body.action === "discard-policy") return discardKnowledgeVerificationPolicy(pages, actor, id, body);
    if (body.action === "field-policy") return saveKnowledgeVerificationFieldPolicy(pages, actor, id, body);
    if (body.action === "actions") return setKnowledgeVerificationActions(pages, actor, id, body);
    if (body.action === "grant-steward") return grantKnowledgeSteward(pages, actor, id, body);
    if (body.action === "revoke-steward") return revokeKnowledgeSteward(pages, actor, id, body);
    if (body.action === "stash") return stashKnowledgeVerification(pages, actor, id, body);
    if (body.action === "discard-draft") return discardKnowledgeVerificationDraft(pages, actor, id, body);
    if (body.action === "preview") return previewKnowledgeVerification(pages, actor, id, body);
    if (body.action === "apply") return applyKnowledgeVerification(pages, actor, id, body);
    if (body.action === "report") return reportKnowledgeConcern(pages, actor, id, body);
    return downloadKnowledgeVerification(pages, actor, id, body);
  }, true);
}
