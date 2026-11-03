import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { DocumentError } from "../../../../../../lib/document";
import {
  activateIntakeForm,
  commitIntake,
  disableIntakeForm,
  discardIntakeDraft,
  downloadIntakeReport,
  grantIntakeManager,
  intakeFormCatalogue,
  intakeFormHistory,
  issueIntakeChallenge,
  previewIntakeForm,
  readIntakeForm,
  readIntakeReceipt,
  reviewIntake,
  revokeIntakeForm,
  revokeIntakeManager,
  saveIntakeForm,
  searchIntakeForms,
  setIntakeActions,
  setIntakeAnonymousPolicy,
  stashIntakeForm,
  submitIntake,
} from "../../../../../../lib/intake-form";
import { repository } from "../../../../../../lib/repository";

const definition = z.record(z.string(), z.unknown());
const values = z.record(z.string(), z.string().max(2000));
const attachment = z.object({ name: z.string().trim().min(1).max(120), mediaType: z.string().trim().min(1).max(80), byteSize: z.number().int().positive().max(2_000_000) }).strict();
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("configure"), operationId: z.string().uuid(), formId: z.string().uuid().optional(), expectedVersion: z.number().int().nonnegative(), name: z.string().trim().min(1).max(80), definition }).strict(),
  z.object({ action: z.literal("stash"), operationId: z.string().uuid(), formId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), name: z.string().trim().min(1).max(80), definition }).strict(),
  z.object({ action: z.literal("discard-draft"), operationId: z.string().uuid(), formId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("preview"), operationId: z.string().uuid(), formId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("disable"), operationId: z.string().uuid(), formId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("revoke"), operationId: z.string().uuid(), formId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("activate"), operationId: z.string().uuid(), formId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("policy"), operationId: z.string().uuid(), expectedVersion: z.number().int().nonnegative(), allowed: z.boolean() }).strict(),
  z.object({ action: z.literal("actions"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200), expectedVersion: z.number().int().nonnegative(), actions: z.array(z.string()).max(12) }).strict(),
  z.object({ action: z.literal("grant-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("revoke-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("challenge"), operationId: z.string().uuid(), formId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("submit"), operationId: z.string().uuid(), formId: z.string().uuid(), expectedVersion: z.number().int().positive(), intentToken: z.string().uuid(), botToken: z.string().uuid(), anonymous: z.boolean().optional(), recordName: z.string().trim().min(1).max(80), values, consentVersion: z.number().int().positive().nullable().optional(), consentAccepted: z.boolean().optional(), attachments: z.array(attachment).max(3).optional() }).strict(),
  z.object({ action: z.literal("review"), operationId: z.string().uuid(), formId: z.string().uuid(), submissionId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("commit"), operationId: z.string().uuid(), formId: z.string().uuid(), submissionId: z.string().uuid(), expectedVersion: z.number().int().positive(), recordId: z.string().uuid().nullable().optional(), expectedRecordVersion: z.number().int().positive().nullable().optional() }).strict(),
  z.object({ action: z.literal("download"), operationId: z.string().uuid(), formId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
]);

async function workspaceId(params: Promise<{ id: string }>) {
  const id = (await params).id;
  if (!id || id.length > 200) throw new DocumentError("Intake forms are restricted or unavailable.", "not_found", 404);
  return id;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const id = await workspaceId(params);
    const url = new URL(request.url);
    const pages = await repository(localPreview(request));
    const view = url.searchParams.get("view");
    const formId = url.searchParams.get("formId") ?? "";
    if (view === "form") {
      if (!formId) throw new DocumentError("Intake forms are restricted or unavailable.", "not_found", 404);
      return readIntakeForm(pages, actor, id, formId);
    }
    if (view === "search") {
      const query = url.searchParams.get("q");
      if (!query) throw new DocumentError("Check the form.", "intake_validation", 422);
      return searchIntakeForms(pages, actor, id, query);
    }
    if (view === "history") {
      if (!formId) throw new DocumentError("Intake forms are restricted or unavailable.", "not_found", 404);
      return intakeFormHistory(pages, actor, id, formId);
    }
    if (view === "receipt") {
      const code = url.searchParams.get("code");
      if (!code) throw new DocumentError("Intake forms are restricted or unavailable.", "not_found", 404);
      return readIntakeReceipt(pages, actor, id, code);
    }
    if (view) throw new DocumentError("Intake forms are restricted or unavailable.", "not_found", 404);
    return intakeFormCatalogue(pages, actor, id);
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const parsed = command.safeParse(await readJson(request, 80_000));
    if (!parsed.success) throw new DocumentError("Check the form.", "intake_validation", 422);
    const pages = await repository(localPreview(request));
    const id = await workspaceId(params);
    const body = parsed.data;
    if (body.action === "configure") return saveIntakeForm(pages, actor, id, body);
    if (body.action === "stash") return stashIntakeForm(pages, actor, id, body);
    if (body.action === "discard-draft") return discardIntakeDraft(pages, actor, id, body);
    if (body.action === "preview") return previewIntakeForm(pages, actor, id, body);
    if (body.action === "disable") return disableIntakeForm(pages, actor, id, body);
    if (body.action === "revoke") return revokeIntakeForm(pages, actor, id, body);
    if (body.action === "activate") return activateIntakeForm(pages, actor, id, body);
    if (body.action === "policy") return setIntakeAnonymousPolicy(pages, actor, id, body);
    if (body.action === "actions") return setIntakeActions(pages, actor, id, body);
    if (body.action === "grant-manager") return grantIntakeManager(pages, actor, id, body);
    if (body.action === "revoke-manager") return revokeIntakeManager(pages, actor, id, body);
    if (body.action === "challenge") return issueIntakeChallenge(pages, actor, id, body);
    if (body.action === "submit") return submitIntake(pages, actor, id, body);
    if (body.action === "review") return reviewIntake(pages, actor, id, body);
    if (body.action === "commit") return commitIntake(pages, actor, id, body);
    return downloadIntakeReport(pages, actor, id, body);
  }, true);
}
