import { z } from "zod";
import { api, localPreview, readJson } from "../../../../../../lib/auth";
import { DocumentError } from "../../../../../../lib/document";
import { repository } from "../../../../../../lib/repository";
import {
  advanceWorkflowRun,
  applyWorkflowPreview,
  createWorkflow,
  discardWorkflowDraft,
  downloadWorkflow,
  grantWorkflowManager,
  ingestWorkflow,
  previewWorkflow,
  readWorkflow,
  revokeWorkflowManager,
  searchWorkflows,
  stashWorkflow,
  workflowCatalogue,
  workflowHistory,
} from "../../../../../../lib/workflow-automation";

const definition = z.record(z.string(), z.unknown());
const event = z.enum(["record.created", "record.updated", "record.field-changed"]);
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), operationId: z.string().uuid(), collection: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(80), definition }).strict(),
  z.object({ action: z.literal("stash"), operationId: z.string().uuid(), workflowId: z.string().uuid(), expectedVersion: z.number().int().positive(), definition }).strict(),
  z.object({ action: z.literal("discard-draft"), operationId: z.string().uuid(), workflowId: z.string().uuid() }).strict(),
  z.object({
    action: z.literal("preview"), operationId: z.string().uuid(), workflowId: z.string().uuid(),
    kind: z.enum(["activate", "pause", "version-change", "rollback", "replay", "dry-run"]),
    expectedVersion: z.number().int().positive(), definition: definition.optional(), targetVersion: z.number().int().positive().optional(),
    runId: z.string().uuid().optional(), recordId: z.string().uuid().optional(), useDraft: z.boolean().optional(),
  }).strict(),
  z.object({ action: z.literal("apply"), operationId: z.string().uuid(), previewId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("ingest"), operationId: z.string().uuid(), workflowId: z.string().uuid(), recordId: z.string().uuid(), event, sourceKey: z.string().trim().min(1).max(200), field: z.string().trim().min(1).max(100).nullable().optional() }).strict(),
  z.object({ action: z.literal("advance"), operationId: z.string().uuid(), runId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("download"), operationId: z.string().uuid(), workflowId: z.string().uuid(), expectedVersion: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("grant-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal("revoke-manager"), operationId: z.string().uuid(), userId: z.string().trim().min(1).max(200) }).strict(),
]);

async function workspaceId(params: Promise<{ id: string }>) {
  const id = (await params).id;
  if (!id || id.length > 200) throw new DocumentError("Workflow automation is restricted or unavailable.", "not_found", 404);
  return id;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const id = await workspaceId(params);
    const url = new URL(request.url);
    const pages = await repository(localPreview(request));
    const view = url.searchParams.get("view");
    const workflowId = url.searchParams.get("workflowId");
    if (view === "workflow") {
      if (!workflowId) throw new DocumentError("Workflow automation is restricted or unavailable.", "not_found", 404);
      return readWorkflow(pages, actor, id, workflowId);
    }
    if (view === "search") {
      const query = url.searchParams.get("q");
      if (!query) throw new DocumentError("Check the workflow request.", "workflow_validation", 422);
      return searchWorkflows(pages, actor, id, query);
    }
    if (view === "history") {
      if (!workflowId) throw new DocumentError("Workflow automation is restricted or unavailable.", "not_found", 404);
      return workflowHistory(pages, actor, id, workflowId);
    }
    if (view) throw new DocumentError("Workflow automation is restricted or unavailable.", "not_found", 404);
    return workflowCatalogue(pages, actor, id);
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(request, async actor => {
    const parsed = command.safeParse(await readJson(request, 64_000));
    if (!parsed.success) throw new DocumentError("Check the workflow request.", "workflow_validation", 422);
    const pages = await repository(localPreview(request));
    const id = await workspaceId(params);
    const body = parsed.data;
    if (body.action === "create") return createWorkflow(pages, actor, id, body);
    if (body.action === "stash") return stashWorkflow(pages, actor, id, body);
    if (body.action === "discard-draft") return discardWorkflowDraft(pages, actor, id, body);
    if (body.action === "preview") return previewWorkflow(pages, actor, id, body);
    if (body.action === "apply") return applyWorkflowPreview(pages, actor, id, body);
    if (body.action === "ingest") return ingestWorkflow(pages, actor, id, body);
    if (body.action === "advance") return advanceWorkflowRun(pages, actor, id, body);
    if (body.action === "download") return downloadWorkflow(pages, actor, id, body);
    if (body.action === "grant-manager") return grantWorkflowManager(pages, actor, id, body);
    return revokeWorkflowManager(pages, actor, id, body);
  }, true);
}
