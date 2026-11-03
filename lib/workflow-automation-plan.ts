import { DocumentError, stableStringify } from "./document";
import { recordHash, recordName, recordValueEmpty, typedRecordValue, type RecordField } from "./shared-record-types";

export const workflowBoundary = "Deterministic triggers, conditions, and actions only. No AI agent runs a workflow.";
export const workflowAssignment = "Configuring or assigning a workflow does not grant access to a page, record, collection, or field.";
export const workflowReview = "Review the impact. Confirming is the only way to activate, pause, change version, roll back, or replay.";
export const workflowSchedules = "Existing schedules stay paused. This builder does not activate a schedule.";
export const workflowAccounts = "Accounts still require an Organisation. A workflow cannot change that relationship.";
export const workflowLimits = { name: 80, conditions: 8, actions: 8, depth: 10, attempts: 3, workflows: 100, backoffMs: [1_000, 4_000, 16_000] as const, bytes: 32_000 } as const;
export const workflowEvents = ["record.created", "record.updated", "record.field-changed"] as const;
export const workflowOperators = ["is-empty", "is-not-empty", "equals", "not-equals", "greater-than", "less-than"] as const;
export const workflowActionTypes = ["set-field", "clear-field", "append-note"] as const;
export const workflowSource = "workflow-automation";

export type WorkflowEvent = (typeof workflowEvents)[number];
export type WorkflowOperator = (typeof workflowOperators)[number];
export type WorkflowStatus = "draft" | "paused" | "active";
export type WorkflowIdentity = { kind: "delegated" | "service"; subjectId: string };
export type WorkflowClause = { field: string; operator: WorkflowOperator; value?: unknown };
export type WorkflowAction =
  | { type: "set-field"; field: string; value: unknown }
  | { type: "clear-field"; field: string }
  | { type: "append-note"; field: string; text: string };
export type WorkflowDefinition = {
  trigger: { event: WorkflowEvent; field?: string };
  conditions: { all: WorkflowClause[] };
  actions: WorkflowAction[];
  identity: WorkflowIdentity;
};

const control = /[\p{Cc}]/u;
const fieldError = () => new DocumentError("Check the workflow fields.", "workflow_field", 422);
const invalid = () => new DocumentError("Check the workflow request.", "workflow_validation", 422);

export function workflowName(value: string) {
  const name = value.trim().normalize("NFC");
  if (!name || Array.from(name).length > workflowLimits.name || control.test(name)) throw new DocumentError("Enter a workflow name of 1–80 characters.", "workflow_validation", 422);
  return name;
}

/** Identity is explicit. There is no creator argument and no inherited permission. */
export function assertRuntimeIdentity(value: unknown): WorkflowIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DocumentError("Choose a delegated or service identity.", "workflow_identity", 422);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== "kind" && key !== "subjectId")) throw new DocumentError("Choose a delegated or service identity.", "workflow_identity", 422);
  if (record.kind !== "delegated" && record.kind !== "service") throw new DocumentError("Choose a delegated or service identity.", "workflow_identity", 422);
  if (typeof record.subjectId !== "string") throw new DocumentError("Choose a delegated or service identity.", "workflow_identity", 422);
  const subjectId = record.subjectId.trim();
  if (!subjectId || subjectId.length > 200 || control.test(subjectId)) throw new DocumentError("Choose a delegated or service identity.", "workflow_identity", 422);
  return { kind: record.kind, subjectId };
}

export function workflowEventKey(parts: { tenantId: string; workflowId: string; recordId: string; event: string; sourceKey: string }) {
  return recordHash(parts);
}

export function workflowStepKey(eventKey: string, actionIndex: number) {
  return recordHash({ eventKey, actionIndex });
}

/** Failed attempt 1 waits 1s, attempt 2 waits 4s, attempt 3 is dead-letter. */
export function workflowBackoff(failedAttempts: number) {
  if (!Number.isInteger(failedAttempts) || failedAttempts < 1 || failedAttempts >= workflowLimits.attempts) return null;
  return workflowLimits.backoffMs[failedAttempts - 1] ?? null;
}

export function workflowDepthOutcome(depth: number) {
  if (!Number.isInteger(depth) || depth < 1) throw invalid();
  return depth > workflowLimits.depth ? "dead-letter" as const : "run" as const;
}

export function workflowMatchesTrigger(definition: WorkflowDefinition, event: WorkflowEvent, field?: string | null) {
  if (definition.trigger.event !== event) return false;
  if (event === "record.field-changed") return definition.trigger.field === field;
  return !definition.trigger.field;
}

function usable(field: RecordField, action: boolean) {
  if (field.deprecated || field.kind === "attachment" || field.kind === "record") return false;
  if (action && field.unique) return false;
  return true;
}

function comparison(field: RecordField, operator: WorkflowOperator, value: unknown) {
  if (operator === "is-empty" || operator === "is-not-empty") {
    if (value !== undefined) throw fieldError();
    return undefined;
  }
  if (value === undefined || recordValueEmpty(value)) throw fieldError();
  if ((operator === "greater-than" || operator === "less-than") && field.kind !== "number" && field.kind !== "date") throw fieldError();
  try { return typedRecordValue(field, value, { historical: true }); }
  catch { throw fieldError(); }
}

export function compileWorkflowDefinition(input: unknown, fields: readonly RecordField[]): WorkflowDefinition {
  if (Buffer.byteLength(JSON.stringify(input) ?? "") > workflowLimits.bytes) throw invalid();
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => !["trigger", "conditions", "actions", "identity"].includes(key))) throw invalid();
  const trigger = body.trigger;
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) throw invalid();
  const triggerBody = trigger as Record<string, unknown>;
  if (Object.keys(triggerBody).some(key => key !== "event" && key !== "field")) throw invalid();
  if (!workflowEvents.includes(triggerBody.event as WorkflowEvent)) throw invalid();
  const event = triggerBody.event as WorkflowEvent;
  const byKey = new Map(fields.filter(field => !field.deprecated).map(field => [field.key, field]));
  let triggerField: string | undefined;
  if (event === "record.field-changed") {
    if (typeof triggerBody.field !== "string" || !byKey.get(triggerBody.field) || !usable(byKey.get(triggerBody.field)!, false)) throw fieldError();
    triggerField = triggerBody.field;
  } else if (triggerBody.field !== undefined) throw fieldError();
  const conditions = body.conditions;
  if (!conditions || typeof conditions !== "object" || Array.isArray(conditions)) throw invalid();
  const conditionBody = conditions as Record<string, unknown>;
  if (Object.keys(conditionBody).some(key => key !== "all") || !Array.isArray(conditionBody.all) || conditionBody.all.length > workflowLimits.conditions) throw invalid();
  const all: WorkflowClause[] = [];
  for (const entry of conditionBody.all) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid();
    const clause = entry as Record<string, unknown>;
    if (Object.keys(clause).some(key => !["field", "operator", "value"].includes(key))) throw invalid();
    if (typeof clause.field !== "string" || !workflowOperators.includes(clause.operator as WorkflowOperator)) throw fieldError();
    const field = byKey.get(clause.field);
    if (!field || !usable(field, false)) throw fieldError();
    const operator = clause.operator as WorkflowOperator;
    const value = comparison(field, operator, clause.value);
    all.push(value === undefined ? { field: field.key, operator } : { field: field.key, operator, value });
  }
  if (!Array.isArray(body.actions) || body.actions.length < 1 || body.actions.length > workflowLimits.actions) throw invalid();
  const actions: WorkflowAction[] = [];
  for (const entry of body.actions) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid();
    const action = entry as Record<string, unknown>;
    if (typeof action.type !== "string" || !workflowActionTypes.includes(action.type as (typeof workflowActionTypes)[number])) throw invalid();
    if (typeof action.field !== "string") throw fieldError();
    const field = byKey.get(action.field);
    if (!field || !usable(field, true)) throw fieldError();
    if (action.type === "clear-field") {
      if (Object.keys(action).some(key => key !== "type" && key !== "field") || field.required || field.key === "name") throw fieldError();
      actions.push({ type: "clear-field", field: field.key });
    } else if (action.type === "append-note") {
      if (Object.keys(action).some(key => !["type", "field", "text"].includes(key)) || field.kind !== "long-text" || typeof action.text !== "string") throw fieldError();
      const text = action.text.normalize("NFC");
      if (!text.trim() || Array.from(text).length > 2000 || text.includes("\0")) throw fieldError();
      actions.push({ type: "append-note", field: field.key, text });
    } else {
      if (Object.keys(action).some(key => !["type", "field", "value"].includes(key)) || action.value === undefined) throw fieldError();
      const value = field.key === "name" ? recordName(action.value) : comparison(field, "equals", action.value);
      actions.push({ type: "set-field", field: field.key, value });
    }
  }
  return {
    trigger: triggerField ? { event, field: triggerField } : { event },
    conditions: { all },
    actions,
    identity: assertRuntimeIdentity(body.identity),
  };
}

export function definitionFields(definition: WorkflowDefinition) {
  const fields = new Set<string>();
  if (definition.trigger.field) fields.add(definition.trigger.field);
  for (const clause of definition.conditions.all) fields.add(clause.field);
  for (const action of definition.actions) fields.add(action.field);
  return [...fields];
}

export function evaluateWorkflowConditions(definition: WorkflowDefinition, values: Record<string, unknown>, withheld: ReadonlySet<string>) {
  for (const clause of definition.conditions.all) {
    if (withheld.has(clause.field)) return { matched: false, blocked: "field" as const };
    const value = values[clause.field];
    const empty = recordValueEmpty(value);
    if (clause.operator === "is-empty") { if (!empty) return { matched: false, blocked: null }; continue; }
    if (clause.operator === "is-not-empty") { if (empty) return { matched: false, blocked: null }; continue; }
    if (empty) { if (clause.operator !== "not-equals") return { matched: false, blocked: null }; continue; }
    if (clause.operator === "greater-than" || clause.operator === "less-than") {
      if (typeof value !== typeof clause.value || (typeof value !== "number" && typeof value !== "string")) return { matched: false, blocked: "field" as const };
      const ok = typeof value === "number" && typeof clause.value === "number"
        ? (clause.operator === "greater-than" ? value > clause.value : value < clause.value)
        : typeof value === "string" && typeof clause.value === "string"
          ? (clause.operator === "greater-than" ? value > clause.value : value < clause.value)
          : false;
      if (!ok) return { matched: false, blocked: null };
      continue;
    }
    const equal = recordHash(value) === recordHash(clause.value);
    if (clause.operator === "equals" ? !equal : equal) return { matched: false, blocked: null };
  }
  return { matched: true, blocked: null };
}

export function applyWorkflowAction(field: RecordField, current: unknown, action: WorkflowAction) {
  if (!usable(field, true) || field.key !== action.field) throw fieldError();
  if (action.type === "clear-field") {
    if (field.required || field.key === "name") throw fieldError();
    return null;
  }
  if (action.type === "append-note") {
    if (field.kind !== "long-text") throw fieldError();
    const base = typeof current === "string" ? current : "";
    return typedRecordValue(field, base ? `${base}\n${action.text}` : action.text);
  }
  if (field.key === "name") return recordName(action.value);
  return typedRecordValue(field, action.value, { previous: current });
}

export function redactWorkflowDefinition(definition: WorkflowDefinition, visible: ReadonlySet<string>): WorkflowDefinition {
  const hide = (field: string) => visible.has(field);
  return {
    trigger: definition.trigger.field && !hide(definition.trigger.field) ? { event: definition.trigger.event, field: "restricted" } : definition.trigger,
    conditions: {
      all: definition.conditions.all.map(clause => hide(clause.field) ? clause : { field: "restricted", operator: clause.operator }),
    },
    actions: definition.actions.map(action => {
      if (hide(action.field)) return action;
      if (action.type === "append-note") return { type: "append-note", field: "restricted", text: "" };
      if (action.type === "clear-field") return { type: "clear-field", field: "restricted" };
      return { type: "set-field", field: "restricted", value: null };
    }),
    identity: definition.identity,
  };
}

export function workflowDocument(workflow: { name: string; status: string; version: number; collection: string; definition: WorkflowDefinition }, runs: { revision: number; outcome: string; status: string; atIst: string }[]) {
  const lines = ["# Workflow", "", `Name: ${workflow.name}`, `Status: ${workflow.status}`, `Version: ${workflow.version}`, `Collection: ${workflow.collection}`, "", workflowAssignment, workflowSchedules, workflowBoundary, "", "## Definition", stableStringify(workflow.definition), "", "## Runs"];
  if (!runs.length) lines.push("No visible runs.");
  for (const run of runs) lines.push(`- revision ${run.revision} · ${run.outcome} · ${run.status} · ${run.atIst}`);
  return lines.join("\n");
}
