import { DocumentError, stableStringify } from "./document";
import { recordHash, recordName, recordValueEmpty, typedRecordValue, type RecordField } from "./shared-record-types";

export const actionButtonBoundary = "Buttons run allowlisted Pages by Aplyd action contracts only. They do not run scripts or open arbitrary URLs.";
export const actionButtonAssignment = "Configuring or assigning an action button does not grant access to a page, record, collection, or field.";
export const actionButtonAuthority = "Seeing a button or belonging to the workspace does not grant the action. The server checks the current user's record, field, and action rights.";
export const actionButtonReview = "Review the impact. Confirming is the only way to run a change.";
export const actionButtonSchedules = "Existing schedules stay paused. Action buttons do not activate a schedule.";
export const actionButtonAccounts = "Accounts still require an Organisation. An action button cannot change that relationship.";
export const actionButtonSource = "action-button";
export const actionControlSize = 44;
export const actionButtonLimits = { label: 80, inputs: 8, buttons: 100, bytes: 32_000 } as const;

export const actionContracts = [
  { id: "hs.record.set-field", mutates: true, deprecated: false },
  { id: "hs.record.clear-field", mutates: true, deprecated: false },
  { id: "hs.record.append-note", mutates: true, deprecated: false },
  { id: "hs.record.legacy-note", mutates: true, deprecated: true },
] as const;

export const actionLinks = [
  { id: "hs.record.open", deprecated: false },
  { id: "suite.record.open", deprecated: false },
  { id: "hs.page.open", deprecated: false },
  { id: "hs.page.open-url", deprecated: true },
] as const;

export const actionPlacements = ["record", "page"] as const;
export type ActionPlacement = (typeof actionPlacements)[number];
export type ActionContractId = (typeof actionContracts)[number]["id"];
export type ActionLinkId = (typeof actionLinks)[number]["id"];
type LiveActionId = "hs.record.set-field" | "hs.record.clear-field" | "hs.record.append-note";
type LiveLinkId = "hs.record.open" | "suite.record.open" | "hs.page.open";

export type ActionButtonInput = { id: string; field: string; required: boolean; default?: unknown };
export type ActionButtonTarget =
  | { actionId: "hs.record.clear-field"; field: string }
  | { actionId: "hs.record.set-field" | "hs.record.append-note"; field: string; inputId: string };
export type ActionButtonLink =
  | { linkId: "hs.record.open" | "suite.record.open"; inputId: string }
  | { linkId: "hs.page.open"; pageId: string };
export type ActionButtonDefinition = {
  context: { collection: string; placement: ActionPlacement };
  inputs: ActionButtonInput[];
  target: ActionButtonTarget;
  link: ActionButtonLink | null;
};
export type AvailabilityReason = "draft" | "paused" | "deprecated-target" | "stale-target" | "context" | "forbidden";
export type ActionButtonStatus = "draft" | "paused" | "active";

const control = /[\p{Cc}]/u;
const inputIdPattern = /^[a-z][a-z0-9-]{0,40}$/;
const pageIdPattern = /^[A-Za-z0-9_-]{1,80}$/;
const definitionKeys = ["context", "inputs", "target", "link"];
const fieldError = () => new DocumentError("Check the action button fields.", "action_button_field", 422);
const invalid = () => new DocumentError("Check the action button request.", "action_button_validation", 422);
const deprecated = () => new DocumentError("This action target is disabled.", "action_button_deprecated", 422);

export function actionButtonLabel(value: string) {
  const label = value.trim().normalize("NFC");
  if (!label || Array.from(label).length > actionButtonLimits.label || control.test(label)) {
    throw new DocumentError("Enter an action label of 1–80 characters.", "action_button_validation", 422);
  }
  return label;
}

export function isDeprecatedAction(id: string | undefined) {
  return actionContracts.some(contract => contract.id === id && contract.deprecated);
}

export function isDeprecatedLink(id: string | undefined) {
  return actionLinks.some(link => link.id === id && link.deprecated);
}

export function peekActionButton(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const body = input as Record<string, unknown>;
  const target = body.target;
  const link = body.link;
  const targetRecord = target && typeof target === "object" && !Array.isArray(target) ? target as Record<string, unknown> : undefined;
  const linkRecord = link && typeof link === "object" && !Array.isArray(link) ? link as Record<string, unknown> : undefined;
  return {
    actionId: typeof targetRecord?.actionId === "string" ? targetRecord.actionId : undefined,
    field: typeof targetRecord?.field === "string" ? targetRecord.field : undefined,
    linkId: typeof linkRecord?.linkId === "string" ? linkRecord.linkId : undefined,
  };
}

export function buttonAvailability(input: {
  status: ActionButtonStatus;
  contractDeprecated: boolean;
  fieldDeprecated: boolean;
  contextMatches: boolean;
  canAct: boolean;
  stale: boolean;
}): { enabled: boolean; reason: AvailabilityReason | null } {
  if (input.stale) return { enabled: false, reason: "stale-target" };
  if (input.contractDeprecated || input.fieldDeprecated) return { enabled: false, reason: "deprecated-target" };
  if (input.status === "draft") return { enabled: false, reason: "draft" };
  if (input.status === "paused") return { enabled: false, reason: "paused" };
  if (!input.contextMatches) return { enabled: false, reason: "context" };
  if (!input.canAct) return { enabled: false, reason: "forbidden" };
  return { enabled: true, reason: null };
}

export function actionOperationHash(parts: unknown) {
  return recordHash(parts);
}

export function receiptSeparatesLink(receipt: { actionStatus: string; linkStatus: string; recoverable: boolean }) {
  return receipt.recoverable === true && receipt.actionStatus === "succeeded" && receipt.linkStatus === "failed";
}

function usable(field: RecordField, writing: boolean) {
  if (field.deprecated || field.kind === "attachment" || field.kind === "record") return false;
  if (writing && field.unique) return false;
  return true;
}

function typed(field: RecordField, value: unknown) {
  try {
    return field.key === "name" ? recordName(value) : typedRecordValue(field, value);
  } catch {
    throw fieldError();
  }
}

export function compileActionButton(input: unknown, fields: readonly RecordField[], collection: string): ActionButtonDefinition {
  if (Buffer.byteLength(JSON.stringify(input) ?? "") > actionButtonLimits.bytes) throw invalid();
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => !definitionKeys.includes(key))) throw invalid();
  const context = body.context;
  if (!context || typeof context !== "object" || Array.isArray(context)) throw invalid();
  const contextBody = context as Record<string, unknown>;
  if (Object.keys(contextBody).some(key => key !== "collection" && key !== "placement")) throw invalid();
  if (contextBody.collection !== collection || !actionPlacements.includes(contextBody.placement as ActionPlacement)) throw fieldError();
  if (!Array.isArray(body.inputs) || body.inputs.length > actionButtonLimits.inputs) throw invalid();
  const byKey = new Map(fields.filter(field => !field.deprecated).map(field => [field.key, field]));
  const inputs: ActionButtonInput[] = [];
  const seen = new Set<string>();
  for (const entry of body.inputs) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid();
    const input = entry as Record<string, unknown>;
    if (Object.keys(input).some(key => !["id", "field", "required", "default"].includes(key))) throw invalid();
    if (typeof input.id !== "string" || !inputIdPattern.test(input.id) || seen.has(input.id)) throw fieldError();
    if (typeof input.field !== "string" || typeof input.required !== "boolean") throw fieldError();
    const field = byKey.get(input.field);
    if (!field || !usable(field, false)) throw fieldError();
    seen.add(input.id);
    if (input.default === undefined) inputs.push({ id: input.id, field: field.key, required: input.required });
    else inputs.push({ id: input.id, field: field.key, required: input.required, default: typed(field, input.default) });
  }
  const target = body.target;
  if (!target || typeof target !== "object" || Array.isArray(target)) throw invalid();
  const targetBody = target as Record<string, unknown>;
  if (typeof targetBody.actionId !== "string" || typeof targetBody.field !== "string") throw invalid();
  const contract = actionContracts.find(item => item.id === targetBody.actionId);
  if (!contract) throw invalid();
  if (contract.deprecated) throw deprecated();
  const actionId = contract.id as LiveActionId;
  if (Object.keys(targetBody).some(key => !["actionId", "field", "inputId"].includes(key))) throw invalid();
  const targetField = byKey.get(targetBody.field);
  if (!targetField || !usable(targetField, true)) throw fieldError();
  let compiledTarget: ActionButtonTarget;
  if (actionId === "hs.record.clear-field") {
    if (targetBody.inputId !== undefined || targetField.required || targetField.key === "name") throw fieldError();
    compiledTarget = { actionId, field: targetField.key };
  } else {
    if (typeof targetBody.inputId !== "string") throw fieldError();
    const source = inputs.find(item => item.id === targetBody.inputId);
    if (!source || source.field !== targetField.key) throw fieldError();
    if (actionId === "hs.record.append-note" && targetField.kind !== "long-text") throw fieldError();
    compiledTarget = { actionId, field: targetField.key, inputId: source.id };
  }
  let link: ActionButtonLink | null = null;
  if (body.link !== null) {
    if (!body.link || typeof body.link !== "object" || Array.isArray(body.link)) throw invalid();
    const linkBody = body.link as Record<string, unknown>;
    if (typeof linkBody.linkId !== "string") throw invalid();
    const known = actionLinks.find(item => item.id === linkBody.linkId);
    if (!known) throw invalid();
    if (known.deprecated) throw deprecated();
    const linkId = known.id as LiveLinkId;
    if (linkId === "hs.page.open") {
      if (Object.keys(linkBody).some(key => key !== "linkId" && key !== "pageId")) throw invalid();
      if (typeof linkBody.pageId !== "string" || !pageIdPattern.test(linkBody.pageId)) throw fieldError();
      link = { linkId, pageId: linkBody.pageId };
    } else {
      if (Object.keys(linkBody).some(key => key !== "linkId" && key !== "inputId") || typeof linkBody.inputId !== "string") throw fieldError();
      const source = inputs.find(item => item.id === linkBody.inputId);
      const sourceField = source ? byKey.get(source.field) : undefined;
      if (!source || !sourceField || (sourceField.kind !== "text" && sourceField.kind !== "long-text")) throw fieldError();
      link = { linkId, inputId: source.id };
    }
  }
  return {
    context: { collection, placement: contextBody.placement as ActionPlacement },
    inputs,
    target: compiledTarget,
    link,
  };
}

export function resolveActionInputs(definition: ActionButtonDefinition, supplied: unknown, fields: readonly RecordField[]) {
  if (supplied !== undefined && (!supplied || typeof supplied !== "object" || Array.isArray(supplied))) throw invalid();
  const body = (supplied ?? {}) as Record<string, unknown>;
  if (Object.keys(body).some(key => !definition.inputs.some(input => input.id === key))) throw invalid();
  const byKey = new Map(fields.map(field => [field.key, field]));
  const resolved: Record<string, unknown> = {};
  for (const input of definition.inputs) {
    const field = byKey.get(input.field);
    if (!field || field.deprecated) throw new DocumentError("This action target is disabled.", "action_button_disabled", 409);
    const raw = Object.prototype.hasOwnProperty.call(body, input.id) ? body[input.id] : input.default;
    if (raw === undefined || recordValueEmpty(raw)) {
      if (input.required) throw new DocumentError("A required input is missing.", "action_button_validation", 422);
      continue;
    }
    resolved[input.id] = typed(field, raw);
  }
  const target = definition.target;
  if (target.actionId !== "hs.record.clear-field" && resolved[target.inputId] === undefined) {
    throw new DocumentError("A required input is missing.", "action_button_validation", 422);
  }
  return resolved;
}

export function actionImpact(field: RecordField, current: unknown, target: ActionButtonTarget, value: unknown) {
  if (!usable(field, true) || field.key !== target.field) throw fieldError();
  if (target.actionId === "hs.record.clear-field") {
    if (field.required || field.key === "name") throw fieldError();
    return null;
  }
  if (target.actionId === "hs.record.append-note") {
    if (field.kind !== "long-text") throw fieldError();
    const base = typeof current === "string" ? current : "";
    const text = typeof value === "string" ? value : "";
    return typed(field, base ? `${base}\n${text}` : text);
  }
  return typed(field, value);
}

export function redactActionButton(definition: ActionButtonDefinition, visible: ReadonlySet<string>): ActionButtonDefinition {
  const hide = (field: string) => visible.has(field);
  return {
    context: definition.context,
    inputs: definition.inputs.map(input => hide(input.field) ? input : { id: input.id, field: "restricted", required: input.required }),
    target: hide(definition.target.field)
      ? definition.target
      : definition.target.actionId === "hs.record.clear-field"
        ? { actionId: "hs.record.clear-field", field: "restricted" }
        : { actionId: definition.target.actionId, field: "restricted", inputId: definition.target.inputId },
    link: definition.link,
  };
}

export function definitionFields(definition: ActionButtonDefinition) {
  return [...new Set([definition.target.field, ...definition.inputs.map(input => input.field)])];
}

export function actionButtonDocument(
  button: { label: string; status: string; version: number; collection: string; definition: ActionButtonDefinition },
  receipts: { revision: number; actionStatus: string; linkStatus: string; atIst: string }[],
) {
  const lines = [
    "# Action button",
    "",
    `Label: ${button.label}`,
    `Status: ${button.status}`,
    `Version: ${button.version}`,
    `Collection: ${button.collection}`,
    "",
    actionButtonAssignment,
    actionButtonAuthority,
    actionButtonBoundary,
    actionButtonSchedules,
    "",
    "## Definition",
    stableStringify(button.definition),
    "",
    "## Receipts",
  ];
  if (!receipts.length) lines.push("No visible receipts.");
  for (const receipt of receipts) lines.push(`- revision ${receipt.revision} · action ${receipt.actionStatus} · link ${receipt.linkStatus} · ${receipt.atIst}`);
  return lines.join("\n");
}
