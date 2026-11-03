import { DocumentError, stableStringify } from "./document";
import { recordHash, type RecordField } from "./shared-record-types";

export const roleInterfaceBoundary = "Interfaces compose approved record lists, details, forms, charts, and buttons. They do not run scripts or open public links.";
export const roleInterfaceAssignment = "Configuring or assigning an interface does not grant access to a page, record, collection, or field.";
export const roleInterfaceAuthority = "A role shown on an interface is presentation only. It does not grant collection browse. The server checks the current user's record, field, and action rights.";
export const roleInterfaceReview = "Review the impact. Confirming is the only way to publish a change.";
export const roleInterfaceSchedules = "Existing schedules stay paused. Interfaces do not activate a schedule.";
export const roleInterfaceAccounts = "Accounts still require an Organisation. An interface cannot change that relationship.";
export const roleInterfaceSharing = "Interfaces are private. They are not shared publicly.";
export const roleInterfaceSource = "role-interface";
export const roleInterfaceControlSize = 44;
export const roleInterfaceLimits = { name: 80, screens: 8, navigation: 8, components: 12, fields: 12, interfaces: 100, bytes: 32_000, roles: 4 } as const;

export const interfaceRoles = ["owner", "admin", "member", "observer"] as const;
export const interfaceComponentKinds = ["list", "detail", "form", "chart", "button"] as const;
export const ownedFieldKeys = ["parent_organisation_id", "created_by", "updated_by"] as const;
export type InterfaceRole = (typeof interfaceRoles)[number];
export type InterfaceComponentKind = (typeof interfaceComponentKinds)[number];
export type InterfaceStatus = "draft" | "preview" | "published";
export type InterfaceFieldBinding = { key: string; version: number };
export type InterfaceComponent =
  | { id: string; kind: "list"; collection: string; viewId: string | null; fields: InterfaceFieldBinding[] }
  | { id: string; kind: "detail"; collection: string; fields: InterfaceFieldBinding[] }
  | { id: string; kind: "form"; collection: string; fields: InterfaceFieldBinding[] }
  | { id: string; kind: "chart"; collection: string; viewId: string | null; field: InterfaceFieldBinding }
  | { id: string; kind: "button"; buttonId: string };
export type InterfaceScreen = { id: string; name: string; components: InterfaceComponent[] };
export type InterfaceNavigation = { id: string; label: string; screenId: string };
export type InterfaceDefinition = { navigation: InterfaceNavigation[]; screens: InterfaceScreen[]; roles: InterfaceRole[] };
export type InterfaceCompileContext = {
  collections: ReadonlyMap<string, { fields: readonly RecordField[]; calculated: ReadonlySet<string>; owned: ReadonlySet<string> }>;
  views: ReadonlyMap<string, { collection: string }>;
  buttons: ReadonlySet<string>;
};
export type BindingAssessment = {
  collectionPresent: boolean;
  collectionDeprecated: boolean;
  viewBound: boolean;
  viewPresent: boolean;
  viewVisible: boolean;
  fields: { present: boolean; deprecated: boolean; version: number; boundVersion: number; calculated: boolean; owned: boolean }[];
  buttonBound: boolean;
  buttonPresent: boolean;
  buttonDeprecated: boolean;
  buttonCalculated: boolean;
  buttonOwned: boolean;
};

const control = /[\p{Cc}]/u;
const idPattern = /^[a-z][a-z0-9-]{0,40}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bannedKeys = new Set(["sharing", "visibility", "audience", "public", "anonymous", "href", "url", "script"]);
const publicKeys = new Set(["sharing", "visibility", "audience", "public", "anonymous"]);
const definitionKeys = ["navigation", "screens", "roles"];
const fieldError = () => new DocumentError("Check the interface fields.", "role_interface_field", 422);
const invalid = () => new DocumentError("Check the interface request.", "role_interface_validation", 422);
const calculatedError = () => new DocumentError("Calculated fields are read-only.", "role_interface_calculated", 422);
const ownedError = () => new DocumentError("Owned fields are read-only.", "role_interface_owned", 422);
const publicError = () => new DocumentError("Interfaces are private and are not shared publicly.", "role_interface_public", 422);

export function roleInterfaceName(value: string) {
  const name = value.trim().normalize("NFC");
  if (!name || Array.from(name).length > roleInterfaceLimits.name || control.test(name)) {
    throw new DocumentError("Enter an interface name of 1–80 characters.", "role_interface_validation", 422);
  }
  return name;
}

export function roleInterfaceOperationHash(parts: unknown) {
  return recordHash(parts);
}

export function assessBinding(input: BindingAssessment): { status: "ready" | "broken"; reason: string | null } {
  if (!input.collectionPresent) return { status: "broken", reason: "missing-collection" };
  if (input.collectionDeprecated) return { status: "broken", reason: "deprecated-collection" };
  if (input.viewBound && !input.viewPresent) return { status: "broken", reason: "missing-view" };
  if (input.viewBound && !input.viewVisible) return { status: "broken", reason: "view-unavailable" };
  for (const field of input.fields) {
    if (field.calculated) return { status: "broken", reason: "calculated-field" };
    if (field.owned) return { status: "broken", reason: "owned-field" };
    if (!field.present) return { status: "broken", reason: "missing-field" };
    if (field.deprecated) return { status: "broken", reason: "deprecated-field" };
    if (field.version !== field.boundVersion) return { status: "broken", reason: "schema-changed" };
  }
  if (input.buttonBound && !input.buttonPresent) return { status: "broken", reason: "missing-button" };
  if (input.buttonBound && input.buttonCalculated) return { status: "broken", reason: "calculated-field" };
  if (input.buttonBound && input.buttonOwned) return { status: "broken", reason: "owned-field" };
  if (input.buttonBound && input.buttonDeprecated) return { status: "broken", reason: "deprecated-button" };
  return { status: "ready", reason: null };
}

export function componentResults(results: { status: "ready" | "broken" }[]) {
  const ready = results.filter(item => item.status === "ready");
  const broken = results.filter(item => item.status === "broken");
  return { ready: ready.length, broken: broken.length, usable: ready.length > 0 && broken.length > 0 };
}

export function interfaceButtonState(input: { status: "draft" | "paused" | "active"; canAct: boolean; hasRecord: boolean }) {
  if (input.status !== "active") return { enabled: false, reason: input.status };
  if (!input.hasRecord) return { enabled: false, reason: "context" };
  if (!input.canAct) return { enabled: false, reason: "forbidden" };
  return { enabled: true, reason: null as string | null };
}

function rejectBanned(value: unknown) {
  if (Array.isArray(value)) {
    value.forEach(rejectBanned);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (bannedKeys.has(key)) throw publicKeys.has(key) ? publicError() : invalid();
    rejectBanned(item);
  }
}

function text(value: unknown, label: string) {
  if (typeof value !== "string") throw fieldError();
  const name = value.trim().normalize("NFC");
  if (!name || Array.from(name).length > roleInterfaceLimits.name || control.test(name)) {
    throw new DocumentError(`Enter a ${label} of 1–80 characters.`, "role_interface_field", 422);
  }
  return name;
}

function identifier(value: unknown) {
  if (typeof value !== "string" || !idPattern.test(value)) throw fieldError();
  return value;
}

function isOwned(collection: { owned: ReadonlySet<string> }, key: string) {
  return (ownedFieldKeys as readonly string[]).includes(key) || collection.owned.has(key);
}

function binding(collection: { fields: readonly RecordField[]; calculated: ReadonlySet<string>; owned: ReadonlySet<string> }, entry: unknown, writing: boolean): InterfaceFieldBinding {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid();
  const body = entry as Record<string, unknown>;
  if (Object.keys(body).some(key => key !== "key" && key !== "version")) throw invalid();
  if (typeof body.key !== "string" || !body.key || body.key.length > 80) throw fieldError();
  if (collection.calculated.has(body.key)) throw calculatedError();
  if (isOwned(collection, body.key)) throw ownedError();
  const field = collection.fields.find(item => item.key === body.key);
  if (!field || field.deprecated) throw fieldError();
  if (writing && (field.kind === "attachment" || field.kind === "record")) throw fieldError();
  return { key: field.key, version: field.version };
}

function fieldsOf(collection: { fields: readonly RecordField[]; calculated: ReadonlySet<string>; owned: ReadonlySet<string> }, value: unknown, writing: boolean) {
  if (!Array.isArray(value) || value.length < 1 || value.length > roleInterfaceLimits.fields) throw invalid();
  const fields = value.map(entry => binding(collection, entry, writing));
  if (new Set(fields.map(field => field.key)).size !== fields.length) throw fieldError();
  return fields;
}

export function compileRoleInterface(input: unknown, context: InterfaceCompileContext): InterfaceDefinition {
  if (Buffer.byteLength(JSON.stringify(input) ?? "") > roleInterfaceLimits.bytes) throw invalid();
  rejectBanned(input);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => !definitionKeys.includes(key))) throw invalid();
  if (!Array.isArray(body.navigation) || body.navigation.length < 1 || body.navigation.length > roleInterfaceLimits.navigation) throw invalid();
  if (!Array.isArray(body.screens) || body.screens.length < 1 || body.screens.length > roleInterfaceLimits.screens) throw invalid();
  if (!Array.isArray(body.roles) || body.roles.length > roleInterfaceLimits.roles) throw invalid();
  const roles: InterfaceRole[] = [];
  for (const role of body.roles) {
    if (typeof role !== "string" || !interfaceRoles.includes(role as InterfaceRole) || roles.includes(role as InterfaceRole)) throw fieldError();
    roles.push(role as InterfaceRole);
  }
  const screens: InterfaceScreen[] = [];
  const screenIds = new Set<string>();
  const componentIds = new Set<string>();
  for (const entry of body.screens) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid();
    const screen = entry as Record<string, unknown>;
    if (Object.keys(screen).some(key => !["id", "name", "components"].includes(key))) throw invalid();
    const id = identifier(screen.id);
    if (screenIds.has(id)) throw fieldError();
    screenIds.add(id);
    if (!Array.isArray(screen.components) || screen.components.length < 1 || screen.components.length > roleInterfaceLimits.components) throw invalid();
    const components: InterfaceComponent[] = [];
    for (const item of screen.components) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid();
      const component = item as Record<string, unknown>;
      if (typeof component.kind !== "string" || !interfaceComponentKinds.includes(component.kind as InterfaceComponentKind)) throw invalid();
      const componentId = identifier(component.id);
      if (componentIds.has(componentId)) throw fieldError();
      componentIds.add(componentId);
      if (component.kind === "button") {
        if (Object.keys(component).some(key => !["id", "kind", "buttonId"].includes(key))) throw invalid();
        if (typeof component.buttonId !== "string" || !uuidPattern.test(component.buttonId) || !context.buttons.has(component.buttonId)) throw fieldError();
        components.push({ id: componentId, kind: "button", buttonId: component.buttonId });
        continue;
      }
      if (typeof component.collection !== "string") throw fieldError();
      const collection = context.collections.get(component.collection);
      if (!collection) throw fieldError();
      if (component.kind === "chart") {
        if (Object.keys(component).some(key => !["id", "kind", "collection", "viewId", "field"].includes(key))) throw invalid();
        const viewId = viewOf(context, component.viewId, component.collection);
        const field = binding(collection, component.field, false);
        if (["attachment", "record"].includes(collection.fields.find(item => item.key === field.key)?.kind ?? "")) throw fieldError();
        components.push({ id: componentId, kind: "chart", collection: component.collection, viewId, field });
        continue;
      }
      const allowed = component.kind === "list" ? ["id", "kind", "collection", "viewId", "fields"] : ["id", "kind", "collection", "fields"];
      if (Object.keys(component).some(key => !allowed.includes(key))) throw invalid();
      const viewId = component.kind === "list" ? viewOf(context, component.viewId, component.collection) : null;
      const fields = fieldsOf(collection, component.fields, component.kind === "form");
      if (component.kind === "list") components.push({ id: componentId, kind: "list", collection: component.collection, viewId, fields });
      else if (component.kind === "detail") components.push({ id: componentId, kind: "detail", collection: component.collection, fields });
      else components.push({ id: componentId, kind: "form", collection: component.collection, fields });
    }
    screens.push({ id, name: text(screen.name, "screen name"), components });
  }
  const navigation: InterfaceNavigation[] = [];
  const linked = new Set<string>();
  const navigationIds = new Set<string>();
  for (const entry of body.navigation) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid();
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).some(key => !["id", "label", "screenId"].includes(key))) throw invalid();
    const id = identifier(item.id);
    if (navigationIds.has(id)) throw fieldError();
    navigationIds.add(id);
    if (typeof item.screenId !== "string" || !screenIds.has(item.screenId)) throw fieldError();
    linked.add(item.screenId);
    navigation.push({ id, label: text(item.label, "navigation label"), screenId: item.screenId });
  }
  if (linked.size !== screenIds.size) throw fieldError();
  return { navigation, screens, roles };
}

function viewOf(context: InterfaceCompileContext, value: unknown, collection: string) {
  if (value === null) return null;
  if (typeof value !== "string" || !uuidPattern.test(value)) throw fieldError();
  const view = context.views.get(value);
  if (!view || view.collection !== collection) throw fieldError();
  return value;
}

export function definitionFieldKeys(definition: InterfaceDefinition) {
  const keys = new Set<string>();
  for (const screen of definition.screens) {
    for (const component of screen.components) {
      if (component.kind === "button") continue;
      if (component.kind === "chart") keys.add(component.field.key);
      else component.fields.forEach(field => keys.add(field.key));
    }
  }
  return keys;
}

export function redactRoleInterface(definition: InterfaceDefinition, visibleFields: ReadonlySet<string>, visibleViews: ReadonlySet<string>): InterfaceDefinition {
  const field = (binding: InterfaceFieldBinding): InterfaceFieldBinding => visibleFields.has(binding.key) ? binding : { key: "restricted", version: binding.version };
  return {
    roles: definition.roles,
    navigation: definition.navigation,
    screens: definition.screens.map(screen => ({
      ...screen,
      components: screen.components.map(component => {
        if (component.kind === "button") return component;
        if (component.kind === "chart") return { ...component, viewId: component.viewId && visibleViews.has(component.viewId) ? component.viewId : null, field: field(component.field) };
        if (component.kind === "list") return { ...component, viewId: component.viewId && visibleViews.has(component.viewId) ? component.viewId : null, fields: component.fields.map(field) };
        return { ...component, fields: component.fields.map(field) };
      }),
    })),
  };
}

export function roleInterfaceDocument(
  item: { name: string; status: string; version: number; sharing: string; definition: InterfaceDefinition },
  submissions: { recordVersion: number; atIst: string }[],
) {
  const lines = [
    "# Interface",
    "",
    `Name: ${item.name}`,
    `Status: ${item.status}`,
    `Version: ${item.version}`,
    `Sharing: ${item.sharing}`,
    "",
    roleInterfaceAssignment,
    roleInterfaceAuthority,
    roleInterfaceBoundary,
    roleInterfaceSharing,
    roleInterfaceSchedules,
    "",
    "## Definition",
    stableStringify(item.definition),
    "",
    "## Submissions",
  ];
  if (!submissions.length) lines.push("No visible submissions.");
  for (const submission of submissions) lines.push(`- record version ${submission.recordVersion} · ${submission.atIst}`);
  return lines.join("\n");
}
