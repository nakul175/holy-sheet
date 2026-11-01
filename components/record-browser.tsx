"use client";
import { FormEvent, useEffect, useState } from "react";
import BulkRelationships from "./bulk-relationships";
import RecordBoard, { acceptedBoard, type BoardCard, type BoardColumnModel, type BoardModel } from "./record-board";
import RecordComments from "./record-comments";
import RecordCompare from "./record-compare";
import RecordGraph from "./record-graph";
import ExternalIdentifierMappings from "./external-identifier-mappings";
import RecordResponsibility from "./record-responsibility";
import RecordNotifications from "./record-notifications";
import RecordCalendar, { acceptedCalendar, calendarMonthRange, currentCalendarMonth, type CalendarEvent, type CalendarModel } from "./record-calendar";
import RecordDashboard, { acceptedDashboard, type DashboardModel } from "./record-dashboard";
import RecordExport from "./record-export";
import RecordHistory from "./record-history";
import RecordImport from "./record-import";
import RecordLayout, { type LayoutField, type LayoutSnapshot } from "./record-layout";
import { RecordDocuments } from "./document-associations";

type Summary = {
  id: string;
  name: string;
  collection: string;
  state: string;
  version: number;
  values: Record<string, unknown>;
};
type Link = {
  id: string;
  kind: string;
  role: string;
  primary: boolean;
  status: string;
  target: { id: string; name: string; collection: string };
};
type Detail = Summary & {
  schemaVersion: number;
  capabilities: string[];
  parentOrganisation: { id: string; name?: string } | { unavailable: true } | null;
  documents: { id: string; pageId: string; title: string }[];
  related: Link[];
  calculated?: { fieldKey: string; label: string; value: unknown; sensitive: boolean; stale: boolean; readOnly: true; error?: string }[];
};
type ReferenceChoice = { id: string; label: string; deprecated: boolean };
type FieldMeta = {
  key: string;
  label: string;
  kind: string;
  sensitive: boolean;
  choices: string[];
  referenceItems?: ReferenceChoice[];
  canWrite: boolean;
  canHistory: boolean;
  required?: boolean;
  calculated?: boolean;
};
type PermissionMember = {
  id: string;
  name: string;
  collection: { capabilities: string[]; version: number };
  record: { capabilities: string[]; version: number } | null;
  fields: { key: string; canView: boolean; canWrite: boolean; canHistory: boolean; version: number }[];
};
type PermissionMatrix = {
  sensitiveFields: { key: string; label: string; kind: string }[];
  members: PermissionMember[];
};
type SchemaField = {
  key: string;
  label: string;
  kind: string;
  required: boolean;
  defaultValue?: unknown;
  choices: string[];
  referenceListId?: string;
  sensitive: boolean;
  unique: boolean;
  deprecated: boolean;
  core: boolean;
  version: number;
};
type SchemaCatalogue = {
  schemaVersion: number;
  canManage: boolean;
  customFieldCount: number;
  limits: { maxFields: number; maxChoices: number };
  fields: SchemaField[];
};
type SchemaPreview = {
  previewId: string;
  fieldKey: string;
  reviewHash: string;
  expiresAt: string;
  impact: {
    recordCount: number;
    populatedCount: number;
    missingCount: number;
    duplicateValues: number;
    dependencies: { kind: string; label: string; version: number }[];
    blockers: string[];
    changes: string[];
    defaultBehavior: string;
  };
};
type SchemaDraft = {
  fieldKey?: string;
  label: string;
  kind: string;
  required: boolean;
  unique: boolean;
  sensitive: boolean;
  deprecated: boolean;
  choices: string;
  defaultValue: string;
  referenceListId?: string;
  lockedSensitive: boolean;
};
const recordPermissionNames = ["view", "edit", "link", "import", "export", "bulk", "archive", "delete", "restore", "merge", "history", "restore-values", "review"] as const;
const customFieldKinds = ["text", "long-text", "number", "currency", "date", "boolean", "single-select", "multi-select", "email", "phone", "url", "attachment", "record"] as const;
const emptySchemaDraft = (): SchemaDraft => ({ label: "", kind: "text", required: false, unique: false, sensitive: false, deprecated: false, choices: "", defaultValue: "", lockedSensitive: false });
function formatSchemaDefault(kind: string, value: unknown) {
  if (value === undefined) return "";
  if (kind === "currency" && value && typeof value === "object") {
    const current = value as { currency?: string; minorUnits?: string; scale?: number };
    return `${current.currency ?? ""},${current.minorUnits ?? ""},${current.scale ?? 2}`;
  }
  if (kind === "multi-select" && Array.isArray(value)) return value.map(String).join("\n");
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}
function acceptedSchema(schema: Partial<SchemaCatalogue> | null): SchemaCatalogue | null {
  if (!schema || schema.canManage !== true || typeof schema.schemaVersion !== "number" || !Array.isArray(schema.fields) || !schema.limits) return null;
  return schema as SchemaCatalogue;
}
function schemaDefinition(draft: SchemaDraft) {
  const choices = draft.choices.split("\n").map((item) => item.trim()).filter(Boolean);
  if (choices.length > 100) throw Error("A select field supports at most 100 choices.");
  const select = draft.kind === "single-select" || draft.kind === "multi-select";
  const definition: Record<string, unknown> = {
    label: draft.label.trim(),
    kind: draft.kind,
    required: draft.required,
    sensitive: draft.lockedSensitive ? true : draft.sensitive,
    unique: draft.unique,
    deprecated: draft.deprecated,
    choices: draft.referenceListId || !select ? [] : choices,
  };
  if (draft.referenceListId) definition.referenceListId = draft.referenceListId;
  const raw = draft.defaultValue.trim();
  if (!raw || draft.kind === "attachment" || draft.kind === "record") return definition;
  if (draft.kind === "boolean") {
    if (raw !== "true" && raw !== "false") throw Error("Use true or false for a boolean default.");
    definition.defaultValue = raw === "true";
  } else if (draft.kind === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw Error("Use a finite number default.");
    definition.defaultValue = value;
  } else if (draft.kind === "multi-select") definition.defaultValue = raw.split("\n").map((item) => item.trim()).filter(Boolean);
  else if (draft.kind === "currency") {
    const [currency, minorUnits, scale] = raw.split(",").map((item) => item.trim());
    definition.defaultValue = { currency, minorUnits, scale: Number(scale) };
  } else definition.defaultValue = raw;
  return definition;
}
function displayValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
function referenceItemsOf(value: unknown): ReferenceChoice[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const items: ReferenceChoice[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.label !== "string" || typeof row.deprecated !== "boolean") return undefined;
    if (Object.keys(row).some((key) => key !== "id" && key !== "label" && key !== "deprecated")) return undefined;
    items.push({ id: row.id, label: row.label, deprecated: row.deprecated });
  }
  return items;
}
function withReferenceItems(field: FieldMeta): FieldMeta {
  if (!Object.hasOwn(field, "referenceItems")) return field;
  const referenceItems = referenceItemsOf(field.referenceItems);
  if (!referenceItems) {
    const rest = { ...field };
    delete rest.referenceItems;
    return rest;
  }
  return { ...field, referenceItems };
}
function heldIds(value: unknown) {
  if (typeof value === "string" && value) return new Set([value]);
  if (Array.isArray(value)) return new Set(value.filter((item): item is string => typeof item === "string"));
  return new Set<string>();
}
function selectOptions(field: FieldMeta, value: unknown) {
  if (!field.referenceItems) return field.choices.map((choice) => ({ id: choice, label: choice, deprecated: false }));
  const held = heldIds(value);
  return field.referenceItems.filter((item) => !item.deprecated || held.has(item.id));
}
function optionText(option: { label: string; deprecated: boolean }) {
  return option.deprecated ? `${option.label} (deprecated)` : option.label;
}
function calculatedText(field: FieldMeta, value: unknown, row?: { value: unknown; stale: boolean; error?: string }) {
  if (row?.stale) return row.error === "formula_divide_by_zero" ? "Division by zero has no value." : "Unavailable";
  return displayFieldValue(field, row ? row.value : value);
}
function CalculatedFields({ fields, values, calculated }: { fields: FieldMeta[]; values: Record<string, unknown>; calculated?: Detail["calculated"] }) {
  const derived = fields.filter((field) => field.calculated);
  if (!derived.length) return null;
  return (
    <section aria-label="Calculated fields">
      <h3>Calculated fields</h3>
      <p>Derived values are read-only. They recompute from confirmed source values and cannot be edited.</p>
      <dl>
        {derived.map((field) => {
          const row = calculated?.find((item) => item.fieldKey === field.key);
          return (
            <div key={field.key}>
              <dt>{field.label}{field.sensitive ? " (sensitive)" : ""}</dt>
              <dd>{calculatedText(field, values[field.key], row)} · read-only</dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
function displayFieldValue(field: FieldMeta | undefined, value: unknown) {
  if (!field?.referenceItems) return displayValue(value);
  const label = (id: string) => {
    const item = field.referenceItems?.find((choice) => choice.id === id);
    return item ? optionText(item) : "Unavailable choice";
  };
  if (Array.isArray(value)) {
    const labels = value.filter((item): item is string => typeof item === "string").map(label);
    return labels.length ? labels.join(", ") : "—";
  }
  if (typeof value === "string" && value) return label(value);
  return displayValue(value);
}
function ChoiceControl({ field, value, disabled, id, onChange }: { field: FieldMeta; value: unknown; disabled: boolean; id?: string; onChange: (value: unknown) => void }) {
  if (field.kind !== "single-select" && !(field.kind === "multi-select" && field.referenceItems)) return null;
  const options = selectOptions(field, value);
  if (field.kind === "multi-select") {
    const selected = heldIds(value);
    return <div id={id} role="group">{options.map((option) => <label key={option.id}><input type="checkbox" checked={selected.has(option.id)} disabled={disabled} onChange={(event) => {
      if (disabled) return;
      const next = new Set(selected);
      if (event.target.checked) {
        if (option.deprecated) return;
        next.add(option.id);
      } else next.delete(option.id);
      onChange([...next]);
    }} /> {optionText(option)}</label>)}</div>;
  }
  return <select id={id} value={typeof value === "string" ? value : ""} disabled={disabled} onChange={(event) => { if (!disabled) onChange(event.target.value); }}><option value="">Choose</option>{options.map((option) => <option key={option.id} value={option.id}>{optionText(option)}</option>)}</select>;
}
type SavedView = {
  id: string;
  collection: string;
  scope: "private" | "workspace";
  name: string;
  version: number;
  canManage: boolean;
  unavailable: boolean;
  definition: {
    columns: string[];
    filters: { field: string; operator: string; value?: unknown }[];
    sort: { field: string; direction: "asc" | "desc" }[];
    includeArchived: boolean;
    presentation?: { kind: "table" } | { kind: "board"; groupBy: string } | { kind: "calendar"; dateField: string } | { kind: "dashboard"; widgets: { id: string; label: string; metric: "count" | "sum" | "group"; field?: string }[] };
  } | null;
};
type ViewColumn = { key: string; label: string; kind: string; calculated?: boolean };
type DashboardWidgetDraft = { id: string; label: string; metric: "count" | "sum" | "group"; field: string };
type ViewFilterDraft = { field: string; operator: string; value: string };
type ViewSortDraft = { field: string; direction: "asc" | "desc" };
type ViewDraft = {
  id?: string;
  version: number;
  name: string;
  scope: "private" | "workspace";
  columns: string[];
  filters: ViewFilterDraft[];
  sorts: ViewSortDraft[];
  includeArchived: boolean;
  lockedScope: boolean;
  presentation: "table" | "board" | "calendar" | "dashboard";
  groupBy: string;
  dateField: string;
  widgets: DashboardWidgetDraft[];
};
type ViewRow = { id: string; name: string; values: Record<string, unknown> };
const emptyViewDraft = (): ViewDraft => ({ version: 0, name: "", scope: "private", columns: ["name"], filters: [], sorts: [], includeArchived: false, lockedScope: false, presentation: "table", groupBy: "", dateField: "", widgets: [] });
function operatorsFor(kind: string) {
  if (["text", "email", "phone", "url"].includes(kind)) return ["equal", "contains", "prefix", "in", "empty"];
  if (kind === "long-text") return ["equal", "contains", "prefix", "empty"];
  if (kind === "number") return ["equal", "greater", "less", "empty"];
  if (kind === "date") return ["equal", "greater", "less", "in", "empty"];
  if (kind === "boolean") return ["equal", "empty"];
  if (kind === "single-select") return ["equal", "in", "empty"];
  if (["multi-select", "record", "attachment"].includes(kind)) return ["includes", "empty"];
  if (kind === "currency") return ["empty"];
  return [];
}
function sortableField(kind: string) {
  return ["text", "email", "phone", "url", "number", "date", "boolean", "single-select"].includes(kind);
}
function filterValueText(value: unknown) {
  if (Array.isArray(value)) return value.map(String).join("\n");
  if (value === undefined || value === null) return "";
  return String(value);
}
function acceptedViews(body: { views?: SavedView[] } | null): SavedView[] {
  return Array.isArray(body?.views) ? body.views.filter((view) => view && typeof view.id === "string" && typeof view.name === "string" && (view.scope === "private" || view.scope === "workspace")) : [];
}
function draftFrom(view: SavedView): ViewDraft {
  return {
    id: view.id,
    version: view.version,
    name: view.name,
    scope: view.scope,
    columns: view.definition?.columns.length ? view.definition.columns : ["name"],
    filters: (view.definition?.filters ?? []).map((filter) => ({ field: filter.field, operator: filter.operator, value: filterValueText(filter.value) })),
    sorts: (view.definition?.sort ?? []).map((item) => ({ field: item.field, direction: item.direction })),
    includeArchived: view.definition?.includeArchived === true,
    lockedScope: true,
    presentation: view.definition?.presentation?.kind === "board" ? "board" : view.definition?.presentation?.kind === "calendar" ? "calendar" : view.definition?.presentation?.kind === "dashboard" ? "dashboard" : "table",
    groupBy: view.definition?.presentation?.kind === "board" ? view.definition.presentation.groupBy : "",
    dateField: view.definition?.presentation?.kind === "calendar" ? view.definition.presentation.dateField : "",
    widgets: view.definition?.presentation?.kind === "dashboard" ? view.definition.presentation.widgets.map((widget) => ({ id: widget.id, label: widget.label, metric: widget.metric, field: widget.field ?? "" })) : [],
  };
}
function viewDefinition(draft: ViewDraft, catalogue: ViewColumn[], metrics: ViewColumn[] = []) {
  const name = draft.name.trim();
  if (!name || name.length > 100) throw Error("Use a view name of 1–100 characters.");
  if (!draft.columns.length || draft.columns.length > 100) throw Error("Choose 1–100 columns.");
  if (draft.filters.length > 12) throw Error("A view supports at most 12 filters, combined with AND.");
  if (draft.sorts.length > 3) throw Error("A view supports at most 3 sorts.");
  const known = new Map(catalogue.map((field) => [field.key, field]));
  const filters = draft.filters.map((filter) => {
    const field = known.get(filter.field);
    const operators = operatorsFor(field?.kind ?? "");
    if (!field || !operators.includes(filter.operator)) throw Error("A view field, filter or sort is unavailable.");
    if (filter.operator === "empty") return { field: filter.field, operator: filter.operator };
    if (filter.operator === "in") {
      const list = filter.value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
      if (!list.length || list.length > 100) throw Error("Membership filters need 1–100 values.");
      return { field: filter.field, operator: filter.operator, value: list };
    }
    if (field.kind === "number") {
      const value = Number(filter.value);
      if (!Number.isFinite(value)) throw Error("Use a finite number.");
      return { field: filter.field, operator: filter.operator, value };
    }
    if (field.kind === "boolean") {
      if (filter.value !== "true" && filter.value !== "false") throw Error("Use true or false.");
      return { field: filter.field, operator: filter.operator, value: filter.value === "true" };
    }
    if (!filter.value.trim() || filter.value.length > 200) throw Error("Use a filter value of 1–200 characters.");
    return { field: filter.field, operator: filter.operator, value: filter.value };
  });
  if (new Set(draft.sorts.map((item) => item.field)).size !== draft.sorts.length) throw Error("Each sort field can be used once.");
  const sort = draft.sorts.map((item) => {
    const field = known.get(item.field);
    if (!field || !sortableField(field.kind)) throw Error("A view field, filter or sort is unavailable.");
    return { field: item.field, direction: item.direction };
  });
  if (draft.presentation === "board") {
    const group = known.get(draft.groupBy);
    if (!group || group.kind !== "single-select") throw Error("Choose a select or single reference field.");
    return { columns: draft.columns, filters, sort, includeArchived: draft.includeArchived, presentation: { kind: "board" as const, groupBy: draft.groupBy } };
  }
  if (draft.presentation === "calendar") {
    const dateField = known.get(draft.dateField);
    if (!dateField || dateField.kind !== "date") throw Error("Choose a date field.");
    return { columns: draft.columns, filters, sort, includeArchived: draft.includeArchived, presentation: { kind: "calendar" as const, dateField: draft.dateField } };
  }
  if (draft.presentation === "dashboard") {
    if (!draft.widgets.length || draft.widgets.length > 6) throw Error("A dashboard supports 1–6 widgets.");
    if (new Set(draft.widgets.map((widget) => widget.id)).size !== draft.widgets.length) throw Error("A view field, filter or sort is unavailable.");
    const knownMetrics = new Map([...catalogue, ...metrics].map((field) => [field.key, field]));
    const widgets = draft.widgets.map((widget) => {
      const label = widget.label.trim();
      if (!label || label.length > 80) throw Error("Use a widget label of 1–80 characters.");
      if (widget.metric === "count") return { id: widget.id, label, metric: "count" as const };
      const field = knownMetrics.get(widget.field);
      if (widget.metric === "sum") {
        if (!field || field.kind !== "number") throw Error("A view field, filter or sort is unavailable.");
        return { id: widget.id, label, metric: "sum" as const, field: widget.field };
      }
      if (!field || field.kind !== "single-select" || field.calculated) throw Error("Choose a select or single reference field.");
      return { id: widget.id, label, metric: "group" as const, field: widget.field };
    });
    return { columns: draft.columns, filters, sort, includeArchived: draft.includeArchived, presentation: { kind: "dashboard" as const, widgets } };
  }
  return { columns: draft.columns, filters, sort, includeArchived: draft.includeArchived };
}
function FieldEditor({ field, value, disabled, onChange }: { field: FieldMeta; value: unknown; disabled: boolean; onChange: (value: unknown) => void }) {
  if (!field.canWrite || disabled) return <p><span>{field.label}</span> {displayFieldValue(field, value)}{field.sensitive ? " · sensitive" : ""}</p>;
  if (field.kind === "boolean") return <label className="record-check"><input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} /> {field.label}</label>;
  if (field.kind === "single-select" || (field.kind === "multi-select" && field.referenceItems)) {
    const choices = <ChoiceControl field={field} value={value} disabled={false} onChange={onChange} />;
    return field.kind === "multi-select" ? <fieldset><legend>{field.label}</legend>{choices}</fieldset> : <label>{field.label}{choices}</label>;
  }
  if (field.kind === "long-text") return <label>{field.label}<textarea value={value === undefined || value === null ? "" : String(value)} onChange={(event) => onChange(event.target.value)} /></label>;
  if (field.kind === "currency") {
    const current = value && typeof value === "object" ? value as { currency?: string; minorUnits?: string; scale?: number } : {};
    const next = (patch: { currency?: string; minorUnits?: string; scale?: number }) => onChange({ currency: current.currency ?? "", minorUnits: current.minorUnits ?? "", scale: current.scale ?? 2, ...patch });
    return <fieldset><legend>{field.label}</legend><label>Currency code <input value={current.currency ?? ""} maxLength={3} onChange={(event) => next({ currency: event.target.value.toUpperCase() })} /></label><label>Minor units <input value={current.minorUnits ?? ""} onChange={(event) => next({ minorUnits: event.target.value })} /></label><label>Scale <input type="number" min={0} max={4} value={current.scale ?? 2} onChange={(event) => next({ scale: Number(event.target.value) })} /></label></fieldset>;
  }
  const type = field.kind === "date" ? "date" : field.kind === "number" ? "number" : field.kind === "email" ? "email" : "text";
  return <label>{field.label}{field.sensitive ? " (sensitive)" : ""} <input type={type} value={value === undefined || value === null ? "" : String(value)} onChange={(event) => onChange(field.kind === "number" ? Number(event.target.value) : event.target.value)} /></label>;
}
function LayoutFieldControl({ field, value, disabled, readOnly, id, onChange }: { field: FieldMeta; value: unknown; disabled: boolean; readOnly: boolean; id?: string; onChange: (value: unknown) => void }) {
  const locked = disabled || readOnly || !field.canWrite;
  const change = (next: unknown) => { if (!locked) onChange(next); };
  if (field.kind === "boolean") return <input id={id} type="checkbox" checked={value === true} disabled={locked} onChange={(event) => change(event.target.checked)} />;
  if (field.kind === "single-select" || (field.kind === "multi-select" && field.referenceItems)) return <ChoiceControl field={field} value={value} disabled={locked} id={id} onChange={change} />;
  if (field.kind === "long-text") return <textarea id={id} readOnly={locked} required={field.required && !locked} value={value === undefined || value === null ? "" : String(value)} onChange={(event) => change(event.target.value)} />;
  if (field.kind === "currency") {
    const current = value && typeof value === "object" ? value as { currency?: string; minorUnits?: string; scale?: number } : {};
    const next = (patch: { currency?: string; minorUnits?: string; scale?: number }) => change({ currency: current.currency ?? "", minorUnits: current.minorUnits ?? "", scale: current.scale ?? 2, ...patch });
    return <fieldset><legend>{field.label}</legend><label>Currency code <input id={id} readOnly={locked} value={current.currency ?? ""} maxLength={3} onChange={(event) => next({ currency: event.target.value.toUpperCase() })} /></label><label>Minor units <input readOnly={locked} value={current.minorUnits ?? ""} onChange={(event) => next({ minorUnits: event.target.value })} /></label><label>Scale <input readOnly={locked} type="number" min={0} max={4} value={current.scale ?? 2} onChange={(event) => next({ scale: Number(event.target.value) })} /></label></fieldset>;
  }
  const type = field.kind === "date" ? "date" : field.kind === "number" ? "number" : field.kind === "email" ? "email" : "text";
  return <input id={id} type={type} readOnly={locked} required={field.required && !locked} value={value === undefined || value === null ? "" : String(value)} onChange={(event) => change(field.kind === "number" ? Number(event.target.value) : event.target.value)} />;
}
type PublishedLayout = {
  publicationRevision: number;
  schemaVersion: number;
  definition: LayoutSnapshot["definition"];
  fields: { key: string; label: string; kind: string; required: boolean; canWrite: boolean }[];
  needsLayoutReview: boolean;
  canCreate: boolean;
};
type ConditionProjection = { field: string; visible: boolean; required: boolean };
function acceptedConditionProjection(body: unknown): ConditionProjection[] | null {
  if (!body || typeof body !== "object" || !Array.isArray((body as { fields?: unknown }).fields)) return null;
  const states: ConditionProjection[] = [];
  for (const item of (body as { fields: unknown[] }).fields) {
    if (!item || typeof item !== "object") return null;
    const row = item as Record<string, unknown>;
    if (typeof row.field !== "string" || typeof row.visible !== "boolean" || typeof row.required !== "boolean") return null;
    if ("hiddenValues" in row && row.hiddenValues !== "retained") return null;
    if (Object.keys(row).some((key) => key !== "field" && key !== "visible" && key !== "required" && key !== "hiddenValues")) return null;
    states.push({ field: row.field, visible: row.visible, required: row.required });
  }
  return states;
}
function conditionVisible(states: ConditionProjection[] | null, key: string) {
  return states?.find((state) => state.field === key)?.visible !== false;
}
function acceptedPublishedLayout(body: unknown): PublishedLayout | null {
  if (!body || typeof body !== "object" || !("published" in body)) return null;
  const published = (body as { published?: unknown }).published;
  if (!published || typeof published !== "object") return null;
  const layout = published as Partial<PublishedLayout>;
  if (typeof layout.publicationRevision !== "number" || typeof layout.schemaVersion !== "number" || typeof layout.canCreate !== "boolean" || typeof layout.needsLayoutReview !== "boolean") return null;
  if (!layout.definition || !Array.isArray(layout.definition.tabs) || !Array.isArray(layout.fields)) return null;
  return layout as PublishedLayout;
}
function layoutHostFields(layout: PublishedLayout, catalogue: FieldMeta[], nameWritable: boolean): LayoutField[] {
  const keys = layout.definition.tabs.flatMap((tab) => tab.sections.flatMap((section) => section.fields.map((slot) => slot.field)));
  const fields: LayoutField[] = [];
  for (const key of keys) {
    if (fields.some((field) => field.key === key)) continue;
    if (key === "name") {
      const described = layout.fields.find((field) => field.key === "name");
      fields.push({ key, label: described?.label ?? "Name", required: true, canWrite: nameWritable && described?.canWrite !== false });
      continue;
    }
    const meta = catalogue.find((field) => field.key === key);
    if (!meta) continue;
    const described = layout.fields.find((field) => field.key === key);
    fields.push({ key, label: meta.sensitive ? `${meta.label} (sensitive)` : meta.label, required: described?.required ?? false, canWrite: meta.canWrite && described?.canWrite !== false });
  }
  return fields;
}
function RecordFormLayout({ layout, fields, name, values, nameDisabled, fieldsDisabled, nameWritable, hasUnsavedChanges, scopeKey, conditions, onName, onValue }: { layout: PublishedLayout; fields: FieldMeta[]; name: string; values: Record<string, unknown>; nameDisabled: boolean; fieldsDisabled: boolean; nameWritable: boolean; hasUnsavedChanges: boolean; scopeKey: string; conditions?: ConditionProjection[]; onName: (value: string) => void; onValue: (key: string, value: unknown) => void }) {
  return <RecordLayout scopeKey={scopeKey} snapshot={{ publicationRevision: layout.publicationRevision, schemaVersion: layout.schemaVersion, definition: layout.definition }} fields={layoutHostFields(layout, fields, nameWritable)} conditions={conditions} hasUnsavedChanges={hasUnsavedChanges} renderField={(field, control) => {
    if (field.key === "name") return <input id={control.id} required={!control.readOnly && !nameDisabled} minLength={1} maxLength={200} value={name} disabled={nameDisabled} readOnly={control.readOnly} onChange={(event) => { if (!control.readOnly && !nameDisabled) onName(event.target.value); }} />;
    const meta = fields.find((item) => item.key === field.key);
    if (!meta) return null;
    return <LayoutFieldControl id={control.id} field={{ ...meta, required: field.required }} value={values[field.key]} disabled={fieldsDisabled} readOnly={control.readOnly} onChange={(value) => onValue(field.key, value)} />;
  }} />;
}
type ReparentPreview = {
  previewToken: string;
  expectedVersion: number;
  newOrganisationId: string;
  newOrganisation: { id: string; name: string };
  affectedContracts: { id: string; name: string }[];
  contextReferences: {
    source_app: string;
    source_type: string;
    source_id: string;
  }[];
  legalPartiesWillChange: false;
};
type DeletePreview = {
  previewId: string;
  reviewHash: string;
  recordVersion: number;
  blocked: boolean;
  message: string;
  expiresAt: string;
  trashDays: number;
  permanentRemovalAvailable: boolean;
};
type TrashRow = {
  id: string;
  name: string;
  collection: string;
  version: number;
  deletedAt: string;
  recoveryDeadline: string;
  retentionHold: boolean;
};
const duplicateReasons = ["normalised-name", "email", "website-domain"] as const;
type DuplicateSuggestion = { id: string; name: string; state: "active" | "archived"; reasons: string[] };
type DuplicateResult = { suggestions: DuplicateSuggestion[]; hasMore: boolean };
type MergeSide = "source" | "survivor";
type MergeConflict = { key: string; label: string; source: unknown; survivor: unknown };
type MergeRelationshipSide = { role: string; is_primary: boolean; status: string };
type MergeRelationshipConflict = { key: string; source: MergeRelationshipSide; survivor: MergeRelationshipSide };
type MergePreview = {
  previewId: string;
  reviewHash: string;
  source: { id: string; name: string; version: number };
  survivor: { id: string; name: string; version: number };
  conflicts: MergeConflict[];
  relationshipConflicts: MergeRelationshipConflict[];
  documents: { id: string; title: string }[];
  blockers: string[];
  integrationReady: boolean;
  expiresAt: string;
  sourceHistoryRetained: boolean;
};
function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
function businessUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}
function acceptedDuplicates(value: unknown): DuplicateResult {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const suggestions = Array.isArray(body.suggestions) ? body.suggestions.slice(0, 10).flatMap((item): DuplicateSuggestion[] => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.name !== "string") return [];
    const reasons = Array.isArray(row.reasons) ? row.reasons.filter((reason): reason is DuplicateSuggestion["reasons"][number] => typeof reason === "string" && (duplicateReasons as readonly string[]).includes(reason)) : [];
    return [{ id: row.id, name: row.name, state: row.state === "archived" ? "archived" : "active", reasons }];
  }) : [];
  return { suggestions, hasMore: body.hasMore === true };
}
function mergeSideRecord(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.name !== "string" || typeof row.version !== "number") return null;
  return { id: row.id, name: row.name, version: row.version };
}
function relationshipSide(value: unknown): MergeRelationshipSide | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.role !== "string" || typeof row.is_primary !== "boolean" || typeof row.status !== "string") return null;
  return { role: row.role, is_primary: row.is_primary, status: row.status };
}
function acceptedMergePreview(value: unknown): MergePreview | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const source = mergeSideRecord(body.source), survivor = mergeSideRecord(body.survivor);
  if (typeof body.previewId !== "string" || typeof body.reviewHash !== "string" || !source || !survivor || typeof body.expiresAt !== "string") return null;
  const conflicts = Array.isArray(body.conflicts) ? body.conflicts.flatMap((item): MergeConflict[] => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.key !== "string" || typeof row.label !== "string") return [];
    return [{ key: row.key, label: row.label, source: row.source ?? null, survivor: row.survivor ?? null }];
  }) : [];
  const relationshipConflicts = Array.isArray(body.relationshipConflicts) ? body.relationshipConflicts.flatMap((item): MergeRelationshipConflict[] => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const sourceSide = relationshipSide(row.source), survivorSide = relationshipSide(row.survivor);
    if (typeof row.key !== "string" || !sourceSide || !survivorSide) return [];
    return [{ key: row.key, source: sourceSide, survivor: survivorSide }];
  }) : [];
  const documents = Array.isArray(body.documents) ? body.documents.flatMap((item): { id: string; title: string }[] => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.title !== "string") return [];
    return [{ id: row.id, title: row.title }];
  }) : [];
  const blockers = Array.isArray(body.blockers) ? body.blockers.filter((item): item is string => typeof item === "string") : [];
  return { previewId: body.previewId, reviewHash: body.reviewHash, source, survivor, conflicts, relationshipConflicts, documents, blockers, integrationReady: body.integrationReady === true, expiresAt: body.expiresAt, sourceHistoryRetained: body.sourceHistoryRetained === true };
}
function relationshipChoiceLabel(side: MergeRelationshipSide) {
  return `${side.role || "No role"} · ${side.is_primary ? "primary" : "not primary"} · ${side.status}`;
}
const collections = ["organisations", "accounts", "contacts", "employees", "contracts"] as const;
const relationshipKind = (collection: string) => (collection === "contacts" ? "contact-account" : collection === "employees" ? "employee-account" : collection === "contracts" ? "contract-account" : null);
const ids = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export default function RecordBrowser({ workspaceId, tenantId, initialCollection, initialRecordId }: { workspaceId: string; tenantId: string; initialCollection?: string; initialRecordId?: string }) {
  const base = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/records`,
    [collection, setCollection] = useState<(typeof collections)[number]>(collections.includes(initialCollection as (typeof collections)[number]) ? initialCollection as (typeof collections)[number] : "organisations"),
    [query, setQuery] = useState(""),
    [items, setItems] = useState<Summary[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [selected, setSelected] = useState<Detail | null>(null),
    [createName, setCreateName] = useState(""),
    [createParent, setCreateParent] = useState(""),
    [createLegal, setCreateLegal] = useState(""),
    [createAccounts, setCreateAccounts] = useState(""),
    [editName, setEditName] = useState(""),
    [schemaVersion, setSchemaVersion] = useState(1),
    [targetId, setTargetId] = useState(""),
    [role, setRole] = useState(""),
    [primary, setPrimary] = useState(false),
    [relationStatus, setRelationStatus] = useState<"active" | "inactive">("active"),
    [contractRelationKind, setContractRelationKind] = useState<"contract-account" | "contract-legal-party">("contract-account"),
    [newParent, setNewParent] = useState(""),
    [preview, setPreview] = useState<ReparentPreview | null>(null),
    [fields, setFields] = useState<FieldMeta[]>([]),
    [canManage, setCanManage] = useState(false),
    [canCreate, setCanCreate] = useState<boolean | null>(null),
    [collectionLayout, setCollectionLayout] = useState<PublishedLayout | null>(null),
    [recordLayout, setRecordLayout] = useState<PublishedLayout | null>(null),
    [createConditions, setCreateConditions] = useState<ConditionProjection[] | null>(null),
    [recordConditions, setRecordConditions] = useState<ConditionProjection[] | null>(null),
    [canImport, setCanImport] = useState(false),
    [canBulkRelate, setCanBulkRelate] = useState(false),
    [canExport, setCanExport] = useState(false),
    [drafts, setDrafts] = useState<Record<string, unknown>>({}),
    [edits, setEdits] = useState<Record<string, unknown>>({}),
    [matrix, setMatrix] = useState<PermissionMatrix | null>(null),
    [schemaCatalogue, setSchemaCatalogue] = useState<SchemaCatalogue | null>(null),
    [schemaDraft, setSchemaDraft] = useState<SchemaDraft>(emptySchemaDraft),
    [schemaPreview, setSchemaPreview] = useState<SchemaPreview | null>(null),
    [views, setViews] = useState<SavedView[]>([]),
    [canManageViews, setCanManageViews] = useState(false),
    [canManageImportProfiles, setCanManageImportProfiles] = useState(false),
    [activeViewId, setActiveViewId] = useState(""),
    [viewDraft, setViewDraft] = useState<ViewDraft>(emptyViewDraft),
    [viewRows, setViewRows] = useState<ViewRow[]>([]),
    [viewColumns, setViewColumns] = useState<ViewColumn[]>([]),
    [viewCursor, setViewCursor] = useState<string | null>(null),
    [board, setBoard] = useState<BoardModel | null>(null),
    [calendar, setCalendar] = useState<CalendarModel | null>(null),
    [dashboard, setDashboard] = useState<DashboardModel | null>(null),
    [calendarMonth, setCalendarMonth] = useState(currentCalendarMonth),
    [memberId, setMemberId] = useState(""),
    [grantCapabilities, setGrantCapabilities] = useState<string[]>([]),
    [grantFields, setGrantFields] = useState<PermissionMember["fields"]>([]),
    [includeArchived, setIncludeArchived] = useState(false),
    [deletePreview, setDeletePreview] = useState<DeletePreview | null>(null),
    [trashOpen, setTrashOpen] = useState(false),
    [trashRows, setTrashRows] = useState<TrashRow[]>([]),
    [trashCursor, setTrashCursor] = useState<string | null>(null),
    [compareIds, setCompareIds] = useState<string[]>([]),
    [duplicates, setDuplicates] = useState<DuplicateResult | null>(null),
    [mergeSurvivorId, setMergeSurvivorId] = useState(""),
    [mergeNameFrom, setMergeNameFrom] = useState<MergeSide>("survivor"),
    [mergeParentFrom, setMergeParentFrom] = useState<MergeSide | "">(""),
    [mergeFieldFrom, setMergeFieldFrom] = useState<Record<string, MergeSide>>({}),
    [mergeRelationshipFrom, setMergeRelationshipFrom] = useState<Record<string, MergeSide>>({}),
    [mergePreview, setMergePreview] = useState<MergePreview | null>(null),
    [mergeReviewStale, setMergeReviewStale] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const permissionsBase = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/record-permissions`;
  const schemaBase = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/record-schema`;
  const viewsBase = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/record-views`;
  const trashBase = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/record-trash`;
  const duplicatesBase = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/record-duplicates`;
  const mergesBase = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/record-merges`;
  const layoutsBase = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/record-layouts`;
  const conditionsBase = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/record-conditions`;
  async function json(url: string, init?: RequestInit) {
    const response = await fetch(url, {
        credentials: "same-origin",
        cache: "no-store",
        ...init,
      }),
      body = await response.json();
    if (!response.ok) throw Error(body.error ?? "Record request failed.");
    return body;
  }
  async function readPublishedLayout(collectionId: string, recordId?: string) {
    const params = new URLSearchParams({ collection: collectionId });
    if (recordId) params.set("recordId", recordId);
    try { return acceptedPublishedLayout(await json(`${layoutsBase}?${params}`)); }
    catch { return null; }
  }
  async function readConditionProjection(collectionId: string, recordId?: string, values?: Record<string, unknown>) {
    try {
      const body = values && Object.keys(values).length
        ? await json(conditionsBase, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "state", collection: collectionId, ...(recordId ? { recordId } : {}), values }) })
        : await json(`${conditionsBase}?${new URLSearchParams({ collection: collectionId, projection: "state", ...(recordId ? { recordId } : {}) })}`);
      return acceptedConditionProjection(body);
    } catch { return null; }
  }
  function submittedFieldValues(source: Record<string, unknown>, layout: PublishedLayout | null) {
    const editable = layout ? new Set(layout.definition.tabs.flatMap((tab) => tab.sections.flatMap((section) => section.fields.filter((slot) => slot.mode === "edit").map((slot) => slot.field)))) : null;
    return Object.fromEntries(Object.entries(source).filter(([key]) => fields.some((field) => field.key === key && field.canWrite && !field.calculated) && (!editable || editable.has(key))));
  }
  async function load(reset = true, archived = includeArchived) {
    setBusy(true);
    setError("");
    try {
      const p = new URLSearchParams({ collection, query });
      if (archived) p.set("includeArchived", "1");
      if (!reset && cursor) p.set("cursor", cursor);
      const data = await json(`${base}?${p}`);
      setSchemaVersion(data.schemaVersion);
      setItems((old) => (reset ? data.results : [...old, ...data.results]));
      setCursor(data.nextCursor);
      if (reset) {
        const [permissionResult, schemaResult, viewResult, layoutResult] = await Promise.all([
          json(`${permissionsBase}?collection=${encodeURIComponent(collection)}`).then(
            (catalogue) => catalogue,
            () => null,
          ),
          json(`${schemaBase}?collection=${encodeURIComponent(collection)}`).then(
            (schema) => acceptedSchema(schema),
            () => null,
          ),
          json(`${viewsBase}?collection=${encodeURIComponent(collection)}`).then(
            (catalogue) => acceptedViews(catalogue),
            () => [],
          ),
          readPublishedLayout(collection),
        ]);
        setFields(Array.isArray(permissionResult?.fields) ? permissionResult.fields.map((field: FieldMeta) => withReferenceItems(field)) : []);
        setCollectionLayout(layoutResult);
        setCanManage(permissionResult?.canManage === true);
        setCanCreate(Array.isArray(permissionResult?.collectionCapabilities) ? permissionResult.collectionCapabilities.includes("create") : null);
        setCanImport(Array.isArray(permissionResult?.collectionCapabilities) && permissionResult.collectionCapabilities.includes("view") && permissionResult.collectionCapabilities.includes("import"));
        setCanBulkRelate(Array.isArray(permissionResult?.collectionCapabilities) && ["view", "edit", "link", "bulk"].every((capability) => permissionResult.collectionCapabilities.includes(capability)));
        setCanExport(Array.isArray(permissionResult?.collectionCapabilities) && permissionResult.collectionCapabilities.includes("view") && permissionResult.collectionCapabilities.includes("export"));
        setCanManageViews(Array.isArray(permissionResult?.collectionCapabilities) ? permissionResult.collectionCapabilities.includes("manage-views") : false);
        setCanManageImportProfiles(Array.isArray(permissionResult?.collectionCapabilities) ? permissionResult.collectionCapabilities.includes("manage-import-profiles") : false);
        setSchemaCatalogue(schemaResult);
        setViews(viewResult);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load records.");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    setSelected(null);
    setPreview(null);
    setIncludeArchived(false);
    setDeletePreview(null);
    setTrashOpen(false);
    setTrashRows([]);
    setTrashCursor(null);
    setDuplicates(null);
    setCanImport(false);
    setCanManageImportProfiles(false);
    setCanExport(false);
    setCanBulkRelate(false);
    setMergeSurvivorId("");
    setMergeNameFrom("survivor");
    setMergeParentFrom("");
    setMergeFieldFrom({});
    setMergeRelationshipFrom({});
    setMergePreview(null);
    setMergeReviewStale(false);
    setDrafts({});
    setEdits({});
    setMatrix(null);
    setSchemaCatalogue(null);
    setSchemaDraft(emptySchemaDraft());
    setSchemaPreview(null);
    setCollectionLayout(null);
    setRecordLayout(null);
    setCreateConditions(null);
    setRecordConditions(null);
    setViews([]);
    setCanManageViews(false);
    setActiveViewId("");
    setViewDraft(emptyViewDraft());
    setViewRows([]);
    setViewColumns([]);
    setViewCursor(null);
    setBoard(null);
    setCalendar(null);
    setDashboard(null);
    setCalendarMonth(currentCalendarMonth());
    void load(true, false);
  }, [collection]);
  const draftKey = JSON.stringify(drafts);
  const editKey = JSON.stringify(edits);
  useEffect(() => {
    const recordId = selected?.id;
    const layout = recordId ? recordLayout : collectionLayout;
    const values = recordId ? edits : drafts;
    if (!layout && Object.keys(values).length === 0) return;
    const targetCollection = selected?.collection ?? collection;
    let cancel = false;
    void readConditionProjection(targetCollection, recordId, values).then((projection) => {
      if (cancel) return;
      if (recordId) setRecordConditions(projection);
      else setCreateConditions(projection);
    });
    return () => { cancel = true; };
  }, [collection, selected?.id, selected?.collection, collectionLayout, recordLayout, draftKey, editKey]);
  useEffect(() => {
    if (!initialRecordId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(initialRecordId)) return;
    void open(initialRecordId);
    // Deep link from search. Collection changes must not reopen a record the reader closed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function open(id: string) {
    setBusy(true);
    setError("");
    try {
      const record = await json(`${base}/${encodeURIComponent(id)}`);
      const layout = await readPublishedLayout(record.collection, record.id);
      setSelected(record);
      setEditName(record.name);
      setEdits({});
      setRecordLayout(layout);
      setRecordConditions(null);
      setPreview(null);
      setDeletePreview(null);
      setDuplicates(null);
      setMergeSurvivorId("");
      setMergeNameFrom("survivor");
      setMergeParentFrom("");
      setMergeFieldFrom({});
      setMergeRelationshipFrom({});
      setMergePreview(null);
      setMergeReviewStale(false);
      setMatrix(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to open this record.");
    } finally {
      setBusy(false);
    }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const relationships =
        collection === "accounts"
          ? { parentOrganisationId: createParent.trim() }
          : collection === "contracts"
            ? {
                legalOrganisationIds: ids(createLegal),
                accountIds: ids(createAccounts),
              }
            : {};
      const data = await json(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "create",
          operationId: crypto.randomUUID(),
          collection,
          name: createName,
          schemaVersion,
          values: submittedFieldValues(drafts, collectionLayout),
          ...relationships,
        }),
      });
      setDrafts({});
      setCreateName("");
      setDuplicates(null);
      setCreateParent("");
      setCreateLegal("");
      setCreateAccounts("");
      setNotice("Record created and durably saved.");
      await load(true);
      await open(data.record.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to create this record.");
    } finally {
      setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await json(`${base}/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          expectedVersion: selected.version,
          schemaVersion: selected.schemaVersion,
          name: editName,
          ...(Object.keys(edits).length ? { values: submittedFieldValues(edits, recordLayout) } : {}),
        }),
      });
      setSelected(data.record);
      setEditName(data.record.name);
      setEdits({});
      setRecordLayout(await readPublishedLayout(data.record.collection, data.record.id));
      setNotice("Record changes saved.");
      await load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save this record.");
    } finally {
      setBusy(false);
    }
  }
  async function relationship(event: FormEvent, action: "upsert" | "remove" = "upsert", link?: Link) {
    event.preventDefault();
    if (!selected) return;
    const kind = link?.kind ?? (selected.collection === "contracts" ? contractRelationKind : relationshipKind(selected.collection));
    if (!kind) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await json(`${base}/${encodeURIComponent(selected.id)}/relationships`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          expectedVersion: selected.version,
          kind,
          targetId: link?.target.id ?? targetId.trim(),
          action,
          role: link?.role ?? role,
          primary: link?.primary ?? primary,
          status: link?.status ?? relationStatus,
        }),
      });
      setSelected(data.record);
      setTargetId("");
      setRole("");
      setPrimary(false);
      setNotice(action === "remove" ? "Relationship removed." : "Relationship saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to change this relationship.");
    } finally {
      setBusy(false);
    }
  }
  async function previewReparent(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setPreview(
        await json(`${base}/${encodeURIComponent(selected.id)}/reparent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "preview",
            newOrganisationId: newParent.trim(),
          }),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to preview this move.");
    } finally {
      setBusy(false);
    }
  }
  async function applyReparent() {
    if (!selected || !preview) return;
    setBusy(true);
    setError("");
    try {
      const data = await json(`${base}/${encodeURIComponent(selected.id)}/reparent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "apply",
          operationId: crypto.randomUUID(),
          expectedVersion: preview.expectedVersion,
          newOrganisationId: preview.newOrganisationId,
          previewToken: preview.previewToken,
          confirmed: true,
        }),
      });
      setSelected(data.record);
      setPreview(null);
      setNewParent("");
      setNotice("Account moved. Contract legal parties were not changed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to move this account.");
    } finally {
      setBusy(false);
    }
  }
  async function postLifecycle(recordId: string, body: Record<string, unknown>) {
    return json(`${base}/${encodeURIComponent(recordId)}/lifecycle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  async function checkDuplicates() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const params = new URLSearchParams({ collection, name: createName });
      const emailField = fields.find((field) => field.key === "core:email" && field.canWrite);
      const domainField = fields.find((field) => field.key === "core:domain" && field.canWrite);
      const email = textValue(drafts["core:email"]);
      const domain = textValue(drafts["core:domain"]);
      if (emailField && email) {
        if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw Error("Enter a valid email to include it in duplicate suggestions.");
        params.set("email", email);
      }
      if (domainField && domain) {
        if (!businessUrl(domain)) throw Error("Use a valid business website URL to include it in duplicate suggestions.");
        params.set("domain", domain);
      }
      setDuplicates(acceptedDuplicates(await json(`${duplicatesBase}?${params}`)));
    } catch (e) {
      setDuplicates(null);
      setError(e instanceof Error ? e.message : "Unable to check for duplicates.");
    } finally {
      setBusy(false);
    }
  }
  function chooseMergeSide(kind: "name" | "parent" | "field" | "relationship", side: MergeSide, key = "") {
    if (kind === "name") setMergeNameFrom(side);
    if (kind === "parent") setMergeParentFrom(side);
    if (kind === "field") setMergeFieldFrom((current) => ({ ...current, [key]: side }));
    if (kind === "relationship") setMergeRelationshipFrom((current) => ({ ...current, [key]: side }));
    setMergeReviewStale(true);
  }
  async function reviewMerge(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    const survivorId = mergeSurvivorId.trim();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (survivorId === selected.id) throw Error("Choose two distinct records.");
      const survivor = await json(`${base}/${encodeURIComponent(survivorId)}`);
      if (survivor.collection !== selected.collection || survivor.state !== "active") throw Error("Choose an active record in the same collection.");
      if (!survivor.capabilities?.includes("edit") || !survivor.capabilities?.includes("merge")) throw Error("The survivor needs current edit and merge rights.");
      if (typeof survivor.version !== "number" || !Number.isInteger(survivor.version) || survivor.version < 1) throw Error("The survivor version is unavailable.");
      const reviewed = acceptedMergePreview(await json(mergesBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "preview",
          sourceId: selected.id,
          survivorId,
          sourceVersion: selected.version,
          survivorVersion: survivor.version,
          nameFrom: mergeNameFrom,
          fieldFrom: mergeFieldFrom,
          relationshipFrom: mergeRelationshipFrom,
          ...(selected.collection === "accounts" && mergeParentFrom ? { parentFrom: mergeParentFrom } : {}),
        }),
      }));
      if (!reviewed) throw Error("The merge review is unavailable.");
      setMergePreview(reviewed);
      setMergeReviewStale(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to review this merge.");
    } finally {
      setBusy(false);
    }
  }
  async function applyReviewedMerge() {
    if (!selected || !mergePreview || mergeReviewStale || mergePreview.blockers.length > 0 || !mergePreview.integrationReady) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await json(mergesBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "apply",
          operationId: crypto.randomUUID(),
          previewId: mergePreview.previewId,
          reviewHash: mergePreview.reviewHash,
          confirm: "merge-and-retain-source-history",
        }),
      });
      const survivorId = typeof data.record?.id === "string" ? data.record.id : mergePreview.survivor.id;
      setMergePreview(null);
      setMergeSurvivorId("");
      setMergeFieldFrom({});
      setMergeRelationshipFrom({});
      setMergeParentFrom("");
      setMergeNameFrom("survivor");
      setNotice("Records merged. Source history stays with the old ID, which now opens the survivor. No access grants were created.");
      await load(true);
      await open(survivorId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to apply this merge.");
    } finally {
      setBusy(false);
    }
  }
  async function refreshOpen(id: string) {
    const record = await json(`${base}/${encodeURIComponent(id)}`);
    setSelected(record);
    setEditName(record.name);
    setEdits({});
    setRecordLayout(await readPublishedLayout(record.collection, record.id));
    setPreview(null);
    setDeletePreview(null);
    setMergePreview(null);
    setMergeReviewStale(false);
    setMatrix(null);
    return record;
  }
  async function setArchived(archived: boolean) {
    if (!selected) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await postLifecycle(selected.id, { kind: "archive", operationId: crypto.randomUUID(), expectedVersion: selected.version, archived });
      await refreshOpen(selected.id);
      setNotice(archived ? "Record archived. Its ID, history and references are unchanged." : "Record unarchived. Editing and new links are available again.");
      await load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to change archive state.");
    } finally {
      setBusy(false);
    }
  }
  async function reviewDelete() {
    if (!selected) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const previewResult = await postLifecycle(selected.id, { kind: "preview-delete", expectedVersion: selected.version });
      setDeletePreview({
        previewId: previewResult.previewId,
        reviewHash: previewResult.reviewHash,
        recordVersion: previewResult.recordVersion,
        blocked: previewResult.blocked === true,
        message: typeof previewResult.message === "string" ? previewResult.message : "Review this deletion again.",
        expiresAt: previewResult.expiresAt,
        trashDays: previewResult.trashDays,
        permanentRemovalAvailable: previewResult.permanentRemovalAvailable === true,
      });
    } catch (e) {
      setDeletePreview(null);
      setError(e instanceof Error ? e.message : "Unable to review deletion.");
    } finally {
      setBusy(false);
    }
  }
  async function confirmTrash() {
    if (!selected || !deletePreview || deletePreview.blocked || deletePreview.recordVersion !== selected.version) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const removed = await postLifecycle(selected.id, {
        kind: "trash",
        operationId: crypto.randomUUID(),
        previewId: deletePreview.previewId,
        reviewHash: deletePreview.reviewHash,
        confirm: "move-to-tenant-trash",
      });
      setSelected(null);
      setDeletePreview(null);
      setEditName("");
      setEdits({});
      setPreview(null);
      setMatrix(null);
      setNotice(`Moved to Trash until ${removed.recoveryDeadline}. The record ID is unchanged. No permanent removal was performed.`);
      await load(true);
      if (trashOpen) await loadTrash(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to move this record to Trash.");
    } finally {
      setBusy(false);
    }
  }
  async function loadTrash(reset = true) {
    setBusy(true);
    setError("");
    try {
      const p = new URLSearchParams({ collection });
      if (!reset && trashCursor) p.set("cursor", trashCursor);
      const data = await json(`${trashBase}?${p}`);
      const rows = Array.isArray(data.results) ? data.results : [];
      setTrashRows((old) => (reset ? rows : [...old, ...rows]));
      setTrashCursor(typeof data.nextCursor === "string" ? data.nextCursor : null);
      setTrashOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load Trash.");
    } finally {
      setBusy(false);
    }
  }
  async function restoreTrash(row: TrashRow) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await postLifecycle(row.id, { kind: "restore", operationId: crypto.randomUUID(), expectedVersion: row.version });
      setNotice("Record restored with the same ID.");
      await loadTrash(true);
      await load(true);
      await open(row.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to restore this record.");
    } finally {
      setBusy(false);
    }
  }
  function chooseMember(id: string, source = matrix) {
    const member = source?.members.find((item) => item.id === id);
    setMemberId(id);
    setGrantCapabilities(member?.record?.capabilities ?? []);
    setGrantFields(member?.fields.map((field) => ({ ...field })) ?? []);
  }
  async function loadMatrix() {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const next = await json(`${permissionsBase}?collection=${encodeURIComponent(selected.collection)}&recordId=${encodeURIComponent(selected.id)}&manage=1`);
      setMatrix(next);
      const initial = next.members.find((member: PermissionMember) => member.id !== selected.id) ?? next.members[0];
      if (initial) chooseMember(initial.id, next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load permissions.");
    } finally {
      setBusy(false);
    }
  }
  async function savePermissions(event: FormEvent) {
    event.preventDefault();
    if (!selected || !matrix || !memberId) return;
    const member = matrix.members.find((item) => item.id === memberId);
    if (!member?.record) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await json(permissionsBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          collection: selected.collection,
          subjectId: memberId,
          recordGrant: { recordId: selected.id, expectedVersion: member.record.version, capabilities: grantCapabilities },
          fields: grantFields.map((field) => ({ key: field.key, expectedVersion: field.version, canView: field.canView, canWrite: field.canWrite, canHistory: field.canHistory })),
        }),
      });
      setNotice("Permissions saved. Current access is checked on the next read.");
      setMatrix(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save permissions.");
    } finally {
      setBusy(false);
    }
  }
  function toggleCapability(name: string) {
    setGrantCapabilities((current) => {
      const has = current.includes(name);
      if (name === "view" && has) return [];
      const next = has ? current.filter((item) => item !== name) : [...current, name];
      return next.length && !next.includes("view") ? ["view", ...next] : next;
    });
  }
  function editSchema(patch: Partial<SchemaDraft>) {
    setSchemaPreview(null);
    setSchemaDraft((current) => ({ ...current, ...patch }));
  }
  function chooseSchemaField(key: string) {
    const field = schemaCatalogue?.fields.find((item) => item.key === key && !item.core);
    setSchemaPreview(null);
    if (!field) {
      setSchemaDraft(emptySchemaDraft());
      return;
    }
    setSchemaDraft({
      fieldKey: field.key,
      label: field.label,
      kind: field.kind,
      required: field.required,
      unique: field.unique,
      sensitive: field.sensitive,
      deprecated: field.deprecated,
      choices: field.choices.join("\n"),
      defaultValue: formatSchemaDefault(field.kind, field.defaultValue),
      referenceListId: field.referenceListId,
      lockedSensitive: field.sensitive,
    });
  }
  async function previewSchemaChange(event: FormEvent) {
    event.preventDefault();
    if (!schemaCatalogue) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setSchemaPreview(await json(schemaBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "preview",
          prepareId: crypto.randomUUID(),
          collection,
          expectedSchemaVersion: schemaCatalogue.schemaVersion,
          definition: schemaDefinition(schemaDraft),
          ...(schemaDraft.fieldKey ? { fieldKey: schemaDraft.fieldKey } : {}),
        }),
      }));
    } catch (e) {
      setSchemaPreview(null);
      setError(e instanceof Error ? e.message : "Unable to review this field.");
    } finally {
      setBusy(false);
    }
  }
  async function applySchemaChange() {
    if (!schemaPreview || schemaPreview.impact.blockers.length) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const applied = await json(schemaBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "apply", previewId: schemaPreview.previewId, reviewHash: schemaPreview.reviewHash, operationId: crypto.randomUUID() }),
      });
      if (typeof applied.currentSchemaVersion === "number") setSchemaVersion(applied.currentSchemaVersion);
      setSchemaCatalogue(acceptedSchema(await json(`${schemaBase}?collection=${encodeURIComponent(collection)}`)));
      setSchemaDraft(emptySchemaDraft());
      setSchemaPreview(null);
      setNotice("Custom field saved. Defaults apply only to future records. Reopen a record before editing it.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to apply this field.");
    } finally {
      setBusy(false);
    }
  }
  const viewFieldCatalogue: ViewColumn[] = [{ key: "name", label: "Name", kind: "text" }, ...fields.filter((field) => !field.calculated).map((field) => ({ key: field.key, label: field.label, kind: field.kind }))];
  const metricCatalogue: ViewColumn[] = fields.filter((field) => field.calculated).map((field) => ({ key: field.key, label: field.label, kind: field.kind, calculated: true }));
  const activeView = views.find((view) => view.id === activeViewId) ?? null;
  function editView(patch: Partial<ViewDraft>) {
    setViewDraft((current) => ({ ...current, ...patch }));
  }
  function toggleColumn(key: string) {
    setViewDraft((current) => ({ ...current, columns: current.columns.includes(key) ? current.columns.filter((item) => item !== key) : [...current.columns, key] }));
  }
  function rememberBoard(next: BoardModel | null, append?: BoardColumnModel) {
    if (!next) {
      setBoard(null);
      return;
    }
    if (!append) {
      setBoard(next);
      return;
    }
    setBoard((current) => {
      if (!current) return next;
      return { ...current, schemaVersion: next.schemaVersion, columns: current.columns.map((column) => column.key === append.key ? { ...append, cards: [...column.cards, ...append.cards] } : column) };
    });
  }
  function rememberCalendar(next: CalendarModel | null, append = false) {
    if (!next) {
      setCalendar(null);
      return;
    }
    if (!append) {
      setCalendar(next);
      return;
    }
    setCalendar((current) => {
      if (!current) return next;
      const seen = new Set(current.events.map((event) => event.id));
      return { ...next, events: [...current.events, ...next.events.filter((event) => !seen.has(event.id))] };
    });
  }
  async function runCalendar(id: string, known?: SavedView, month = calendarMonth, cursor?: string) {
    setDashboard(null);
    const range = calendarMonthRange(month);
    setBusy(true);
    setError("");
    try {
      if (!range) throw Error("Review the calendar range.");
      const params = new URLSearchParams({ from: range.from, to: range.to });
      if (cursor) params.set("cursor", cursor);
      const data = await json(`${viewsBase}/${encodeURIComponent(id)}/calendar?${params}`);
      const next = acceptedCalendar(data);
      if (!next) throw Error("This view configuration is unavailable.");
      const view = data.view as SavedView | undefined;
      if (view?.id) setViews((current) => current.map((item) => (item.id === view.id ? view : item)));
      if (view?.unavailable || view?.definition === null) {
        rememberCalendar(null);
        setError("This view configuration is unavailable.");
        return;
      }
      rememberCalendar(next, !!cursor);
      setBoard(null);
      setViewRows([]);
      setViewColumns([]);
      setViewCursor(null);
      setCalendarMonth(month);
      if (view?.canManage) setViewDraft(draftFrom(view));
      else if (known?.canManage && known.definition) setViewDraft(draftFrom(known));
    } catch (e) {
      if (!cursor) rememberCalendar(null);
      setError(e instanceof Error ? e.message : "Unable to load this calendar.");
    } finally {
      setBusy(false);
    }
  }
  async function rescheduleCalendarEvent(card: CalendarEvent, date: string) {
    if (!activeViewId || !calendar || !card.canReschedule || card.date === date) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await json(`${viewsBase}/${encodeURIComponent(activeViewId)}/calendar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "reschedule",
          operationId: crypto.randomUUID(),
          recordId: card.id,
          expectedVersion: card.version,
          schemaVersion: calendar.schemaVersion,
          date,
        }),
      });
      setNotice("Record rescheduled.");
      await runCalendar(activeViewId, undefined, calendarMonth);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to reschedule this record.");
    } finally {
      setBusy(false);
    }
  }
  async function runBoard(id: string, known?: SavedView, column?: BoardColumnModel) {
    setCalendar(null);
    setDashboard(null);
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (column?.nextCursor) {
        params.set("column", column.key);
        params.set("cursor", column.nextCursor);
      }
      const data = await json(`${viewsBase}/${encodeURIComponent(id)}/board${params.size ? `?${params}` : ""}`);
      const next = acceptedBoard(data);
      if (!next) throw Error("This view configuration is unavailable.");
      const view = data.view as SavedView | undefined;
      if (view?.id) setViews((current) => current.map((item) => (item.id === view.id ? view : item)));
      if (view?.unavailable || view?.definition === null) {
        rememberBoard(null);
        setError("This view configuration is unavailable.");
        return;
      }
      rememberBoard(next, column);
      setViewRows([]);
      setViewColumns([]);
      setViewCursor(null);
      if (view?.canManage) setViewDraft(draftFrom(view));
      else if (known?.canManage && known.definition) setViewDraft(draftFrom(known));
    } catch (e) {
      if (!column) rememberBoard(null);
      setError(e instanceof Error ? e.message : "Unable to load this board.");
    } finally {
      setBusy(false);
    }
  }
  async function moveBoardCard(card: BoardCard, column: BoardColumnModel) {
    if (!activeViewId || !board || !card.canMove || !column.acceptsCards || board.columns.some((item) => item.key === column.key && item.cards.some((row) => row.id === card.id))) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await json(`${viewsBase}/${encodeURIComponent(activeViewId)}/board`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "move",
          operationId: crypto.randomUUID(),
          recordId: card.id,
          expectedVersion: card.version,
          schemaVersion: board.schemaVersion,
          column: column.kind === "unassigned" ? { kind: "unassigned" } : { kind: "choice", value: column.value },
        }),
      });
      setNotice("Record moved.");
      await runBoard(activeViewId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to move this record.");
    } finally {
      setBusy(false);
    }
  }
  async function runDashboard(id: string, known?: SavedView) {
    setBoard(null);
    setCalendar(null);
    setBusy(true);
    setError("");
    try {
      const data = await json(`${viewsBase}/${encodeURIComponent(id)}/dashboard`);
      const next = acceptedDashboard(data);
      if (!next) throw Error("This view configuration is unavailable.");
      const view = data.view as SavedView | undefined;
      if (view?.id) setViews((current) => current.map((item) => (item.id === view.id ? view : item)));
      if (view?.unavailable || view?.definition === null) {
        setDashboard(null);
        setError("This view configuration is unavailable.");
        return;
      }
      setDashboard(next);
      setViewRows([]);
      setViewColumns([]);
      setViewCursor(null);
      if (view?.canManage) setViewDraft(draftFrom(view));
      else if (known?.canManage && known.definition) setViewDraft(draftFrom(known));
    } catch (e) {
      setDashboard(null);
      setError(e instanceof Error ? e.message : "Unable to load this dashboard.");
    } finally {
      setBusy(false);
    }
  }
  async function runView(id: string, reset = true, known?: SavedView) {
    const selected = known ?? views.find((view) => view.id === id);
    if (selected?.definition?.presentation?.kind === "dashboard") {
      await runDashboard(id, selected);
      return;
    }
    if (selected?.definition?.presentation?.kind === "board") {
      setCalendar(null);
      await runBoard(id, selected);
      return;
    }
    if (selected?.definition?.presentation?.kind === "calendar") {
      setBoard(null);
      await runCalendar(id, selected);
      return;
    }
    setBoard(null);
    setCalendar(null);
    setDashboard(null);
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (!reset && viewCursor) params.set("cursor", viewCursor);
      const data = await json(`${viewsBase}/${encodeURIComponent(id)}${params.size ? `?${params}` : ""}`);
      const view = data.view as SavedView;
      setViews((current) => current.map((item) => (item.id === view.id ? view : item)));
      if (view.unavailable || !view.definition) {
        setViewRows([]);
        setViewColumns([]);
        setViewCursor(null);
        setError("This view includes a restricted filter or sort. Review its configuration.");
        return;
      }
      const reported = Array.isArray(data.fields) ? data.fields as ViewColumn[] : [];
      setViewColumns(view.definition.columns.map((key) => key === "name" ? { key, label: "Name", kind: "text" } : reported.find((field) => field.key === key) ?? { key, label: "Field", kind: "text" }));
      setViewRows((current) => (reset ? data.results ?? [] : [...current, ...(data.results ?? [])]));
      setViewCursor(data.nextCursor ?? null);
      if (view.canManage) setViewDraft(draftFrom(view));
    } catch (e) {
      setViewRows([]);
      setViewColumns([]);
      setViewCursor(null);
      setError(e instanceof Error ? e.message : "Unable to run this view.");
    } finally {
      setBusy(false);
    }
  }
  function chooseView(id: string) {
    setActiveViewId(id);
    if (!id) {
      setViewRows([]);
      setViewColumns([]);
      setViewCursor(null);
      setBoard(null);
      setCalendar(null);
      setDashboard(null);
      setError("");
      return;
    }
    const view = views.find((item) => item.id === id);
    if (!view || view.unavailable || !view.definition) {
      setViewRows([]);
      setViewColumns([]);
      setViewCursor(null);
      setBoard(null);
      setCalendar(null);
      setDashboard(null);
      setViewDraft(emptyViewDraft());
      setError("This view includes a restricted filter or sort. Review its configuration.");
      return;
    }
    if (view.canManage) setViewDraft(draftFrom(view));
    else setViewDraft(emptyViewDraft());
    void runView(id, true, view);
  }
  async function refreshViews(selectId?: string) {
    const next = acceptedViews(await json(`${viewsBase}?collection=${encodeURIComponent(collection)}`));
    setViews(next);
    if (!selectId) return;
    setActiveViewId(selectId);
    const view = next.find((item) => item.id === selectId);
    if (view?.canManage && view.definition) setViewDraft(draftFrom(view));
    if (view && !view.unavailable && view.definition) await runView(selectId, true, view);
    else {
      setBoard(null);
      setCalendar(null);
      setDashboard(null);
    }
  }
  async function saveView(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const definition = viewDefinition(viewDraft, viewFieldCatalogue, metricCatalogue);
      const id = viewDraft.id ?? crypto.randomUUID();
      const saved = await json(viewsBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "save",
          id,
          operationId: crypto.randomUUID(),
          collection,
          scope: viewDraft.scope,
          name: viewDraft.name.trim(),
          expectedVersion: viewDraft.id ? viewDraft.version : 0,
          definition,
        }),
      });
      setNotice(viewDraft.id ? "Saved view updated." : "Saved view created.");
      await refreshViews(saved.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save this view.");
    } finally {
      setBusy(false);
    }
  }
  async function publishView() {
    if (!activeView?.definition || activeView.scope !== "private" || !activeView.canManage || !canManageViews) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await json(viewsBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "save",
          id: crypto.randomUUID(),
          operationId: crypto.randomUUID(),
          collection,
          scope: "workspace",
          name: `${activeView.name.slice(0, 93)} shared`,
          expectedVersion: 0,
          definition: activeView.definition,
        }),
      });
      setNotice("Shared copy created. The personal view was not changed.");
      await refreshViews(saved.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to publish a shared copy.");
    } finally {
      setBusy(false);
    }
  }
  async function removeView() {
    if (!viewDraft.id) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await json(viewsBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "delete", id: viewDraft.id, operationId: crypto.randomUUID(), expectedVersion: viewDraft.version }),
      });
      setActiveViewId("");
      setViewDraft(emptyViewDraft());
      setViewRows([]);
      setViewColumns([]);
      setViewCursor(null);
      setBoard(null);
      setCalendar(null);
      setDashboard(null);
      setViews(acceptedViews(await json(`${viewsBase}?collection=${encodeURIComponent(collection)}`)));
      setNotice("Saved view deleted. Records were not changed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to delete this view.");
    } finally {
      setBusy(false);
    }
  }
  function toggleCompare(id: string) {
    if (compareIds.includes(id)) {
      setCompareIds(compareIds.filter((item) => item !== id));
      return;
    }
    if (compareIds.length >= 4) {
      setNotice("Compare up to 4 records.");
      return;
    }
    setCompareIds([...compareIds, id]);
  }
  function compareBox(id: string, name: string) {
    return (
      <label className="record-check">
        <input type="checkbox" checked={compareIds.includes(id)} aria-label={`Select ${name} for comparison`} onChange={() => toggleCompare(id)} />
      </label>
    );
  }
  function toggleField(key: string, flag: "canView" | "canWrite" | "canHistory") {
    setGrantFields((current) => current.map((field) => {
      if (field.key !== key) return field;
      const next = { ...field, [flag]: !field[flag] };
      if (flag === "canView" && !next.canView) return { ...next, canWrite: false, canHistory: false };
      if ((flag === "canWrite" || flag === "canHistory") && next[flag]) next.canView = true;
      return next;
    }));
  }
  const archivedRecord = selected?.state === "archived";
  const currentDeletePreview = deletePreview && selected && deletePreview.recordVersion === selected.version ? deletePreview : null;
  const canRelate = !!selected && !archivedRecord && selected.capabilities.includes("edit") && selected.capabilities.includes("link") && !!relationshipKind(selected.collection);
  const canMerge = !!selected && selected.state === "active" && selected.capabilities.includes("edit") && selected.capabilities.includes("merge");
  const writableFields = fields.filter((field) => field.canWrite);
  return (
    <main className="record-browser">
      <header>
        <p>Holy Sheet · shared data</p>
        <h1>Records</h1>
        <p>Tenant-owned structured data. Opening or relating a record never grants access.</p>
        <RecordNotifications workspaceId={workspaceId} tenantId={tenantId} onOpen={(id) => void open(id)} />
      </header>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {board && <RecordBoard board={board} busy={busy} selectedIds={compareIds} onToggleSelect={toggleCompare} onOpen={(id) => void open(id)} onMove={(card, column) => void moveBoardCard(card, column)} onLoadMore={(column) => { if (activeViewId) void runBoard(activeViewId, undefined, column); }} />}
      {calendar && <RecordCalendar calendar={calendar} month={calendarMonth} busy={busy} selectedIds={compareIds} onToggleSelect={toggleCompare} onOpen={(id) => void open(id)} onReschedule={(card, date) => void rescheduleCalendarEvent(card, date)} onLoadMore={() => { if (activeViewId && calendar.nextCursor) void runCalendar(activeViewId, undefined, calendarMonth, calendar.nextCursor); }} onMonth={(month) => { if (activeViewId) void runCalendar(activeViewId, undefined, month); }} />}
      {dashboard && <RecordDashboard dashboard={dashboard} />}
      <RecordCompare workspaceId={workspaceId} tenantId={tenantId} recordIds={compareIds} onClear={() => setCompareIds([])} />
      <div className="record-browser-grid">
        <section aria-label="Record list">
          <label>
            Collection{" "}
            <select value={collection} onChange={(event) => setCollection(event.target.value as typeof collection)}>
              {collections.map((value) => (
                <option key={value} value={value}>
                  {value[0].toUpperCase() + value.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <p><a href={`/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/collections/${encodeURIComponent(collection)}/intake`}>Internal intake</a>. Signed-in workspace members fill a collection form to create or update a record. The form uses the same permissions as the record and does not grant access.</p>
          <p><a href={`/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/collections/${encodeURIComponent(collection)}/review`}>Record review</a>. Signed-in members submit a record or decide a review they are permitted to decide. Review uses the same permissions and does not grant access.</p>
          <p><a href={`/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/collections/${encodeURIComponent(collection)}/quality`}>Record quality</a>. Define completeness and quality checks for this collection, then see how the current record scores. Checks follow the permissions you already have and do not grant access.</p>
          <p><a href={`/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/collections/${encodeURIComponent(collection)}/periodic-review`}>Periodic review</a>. Schedule a recurring review for this collection and open records that are due. Starting a review uses the existing review workflow and does not grant access.</p>
          <p><a href={`/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/catalogue?collection=${encodeURIComponent(collection)}`}>Data catalogue</a>. Browse the collections and field definitions you are allowed to view. Restricted definitions stay omitted, and opening the catalogue does not grant access.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void load(true);
            }}
          >
            <label>
              Find records <input value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <label className="record-check">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(event) => {
                  const next = event.target.checked;
                  setIncludeArchived(next);
                  void load(true, next);
                }}
              />{" "}
              Include archived records
            </label>
            <p>Archived records stay out of this list until you include them.</p>
            <button disabled={busy}>Search</button>
          </form>
          {activeView?.definition && !activeView.unavailable ? null : (
          <ul>
            {items.map((item) => (
              <li key={item.id} className="record-compare-pick">
                {compareBox(item.id, item.name)}
                <button onClick={() => void open(item.id)} aria-current={selected?.id === item.id ? "true" : undefined}>
                  {item.name}{item.state === "archived" ? " · archived" : ""}
                </button>
              </li>
            ))}
          </ul>
          )}
          {activeView?.definition && !activeView.unavailable && activeView.definition.presentation?.kind !== "board" && activeView.definition.presentation?.kind !== "calendar" && activeView.definition.presentation?.kind !== "dashboard" ? (
            <table aria-label={activeView.name}>
              <caption>{activeView.scope === "private" ? "Personal" : "Shared"} · {activeView.name}</caption>
              <thead>
                <tr>
                  <th scope="col">Compare</th>
                  {viewColumns.map((column) => <th key={column.key} scope="col">{column.label}</th>)}
                  <th scope="col">Open</th>
                </tr>
              </thead>
              <tbody>
                {viewRows.map((row) => (
                  <tr key={row.id}>
                    <td>{compareBox(row.id, row.name)}</td>
                    {viewColumns.map((column) => <td key={column.key}>{column.key === "name" ? row.name : displayFieldValue(fields.find((field) => field.key === column.key), row.values?.[column.key])}</td>)}
                    <td><button type="button" disabled={busy} onClick={() => void open(row.id)}>Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {board || calendar ? null : activeViewId ? (viewCursor && <button disabled={busy} onClick={() => void runView(activeViewId, false)}>Load 50 more</button>) : (cursor && (
            <button disabled={busy} onClick={() => void load(false)}>
              Load 50 more
            </button>
          ))}
          {canBulkRelate && collection !== "organisations" ? (
            <BulkRelationships
              key={collection}
              workspaceId={workspaceId}
              tenantId={tenantId}
              collection={collection}
              records={(activeViewId && viewRows.length ? viewRows : items).map((item) => ({ id: item.id, name: item.name }))}
            />
          ) : null}
          {canImport && (
            <RecordImport
              key={collection}
              workspaceId={workspaceId}
              tenantId={tenantId}
              collection={collection}
              canCreate={canCreate === true}
              canManageSharedProfiles={canManageImportProfiles}
              fields={writableFields.map((field) => ({
                key: field.key,
                label: field.label,
                kind: field.kind,
                referenceList: schemaCatalogue?.fields.some((item) => item.key === field.key && !!item.referenceListId) ?? false,
              }))}
              onCommitted={() => void load(true)}
            />
          )}
          <section aria-label="Tenant Trash">
            <h2>Tenant Trash</h2>
            <p>Recoverable records for this collection, 50 at a time. Restoring keeps the same ID and returns the previous active or archived state. This screen does not permanently remove records.</p>
            <button type="button" disabled={busy} onClick={() => void loadTrash(true)}>{trashOpen ? "Refresh Trash" : "Open Trash"}</button>
            {trashOpen && (
              trashRows.length ? (
                <ul>
                  {trashRows.map((row) => (
                    <li key={row.id}>
                      <span>{row.name}</span>
                      <span> Recover until {row.recoveryDeadline}.</span>
                      {row.retentionHold && <span> A retention hold preserves storage after that deadline. Recovery is still denied then.</span>}
                      <button type="button" disabled={busy} onClick={() => void restoreTrash(row)}>Restore</button>
                    </li>
                  ))}
                </ul>
              ) : <p>No recoverable records in Trash.</p>
            )}
            {trashOpen && trashCursor && <button type="button" disabled={busy} onClick={() => void loadTrash(false)}>Load 50 more</button>}
          </section>
          <section aria-label="Saved table views">
            <h2>Saved table views</h2>
            <p>Personal views stay with you. A shared workspace view needs manage-views and does not grant record editing or schema changes. Sharing a personal view creates a new copy; the original stays personal. Trash is excluded. Archived records appear only when the view includes them. A board groups the same filtered records by a select or single reference field. A calendar places those records on a date field. A dashboard summarises those records with counts, sums and groups.</p>
            <label>
              Saved view{" "}
              <select aria-label="Saved view" value={activeViewId} onChange={(event) => chooseView(event.target.value)}>
                <option value="">All records</option>
                {views.filter((view) => view.scope === "private").map((view) => <option key={view.id} value={view.id}>Personal · {view.name}</option>)}
                {views.filter((view) => view.scope === "workspace").map((view) => <option key={view.id} value={view.id}>Shared · {view.name}</option>)}
              </select>
            </label>
            <form aria-label="Save table view" onSubmit={saveView}>
              <button type="button" disabled={busy} onClick={() => setViewDraft(emptyViewDraft())}>New view</button>
              <label>Name <input name="view-name" required minLength={1} maxLength={100} value={viewDraft.name} onChange={(event) => editView({ name: event.target.value })} /></label>
              <fieldset>
                <legend>Audience</legend>
                <label className="record-check"><input type="radio" name="view-audience" value="private" checked={viewDraft.scope === "private"} disabled={viewDraft.lockedScope} onChange={() => editView({ scope: "private" })} /> Personal</label>
                <label className="record-check"><input type="radio" name="view-audience" value="workspace" checked={viewDraft.scope === "workspace"} disabled={viewDraft.lockedScope || !canManageViews} onChange={() => editView({ scope: "workspace" })} /> Shared workspace</label>
                {!canManageViews && <p>Shared workspace views need the manage-views capability.</p>}
                {viewDraft.lockedScope && <p>Audience is fixed. Publish a new shared copy to share a personal view.</p>}
              </fieldset>
              <fieldset>
                <legend>Presentation</legend>
                <label className="record-check"><input type="radio" name="view-presentation" value="table" checked={viewDraft.presentation === "table"} onChange={() => editView({ presentation: "table" })} /> Table</label>
                <label className="record-check"><input type="radio" name="view-presentation" value="board" checked={viewDraft.presentation === "board"} onChange={() => editView({ presentation: "board", groupBy: viewDraft.groupBy || viewFieldCatalogue.find((field) => field.kind === "single-select")?.key || "" })} /> Board</label>
                <label className="record-check"><input type="radio" name="view-presentation" value="calendar" checked={viewDraft.presentation === "calendar"} onChange={() => editView({ presentation: "calendar", dateField: viewDraft.dateField || viewFieldCatalogue.find((field) => field.kind === "date")?.key || "" })} /> Calendar</label>
                <label className="record-check"><input type="radio" name="view-presentation" value="dashboard" checked={viewDraft.presentation === "dashboard"} onChange={() => editView({ presentation: "dashboard", widgets: viewDraft.widgets.length ? viewDraft.widgets : [{ id: crypto.randomUUID(), label: "Records", metric: "count", field: "" }] })} /> Dashboard</label>
                {viewDraft.presentation === "board" && (
                  <label>
                    Group by{" "}
                    <select aria-label="Board group field" value={viewFieldCatalogue.some((field) => field.key === viewDraft.groupBy && field.kind === "single-select") ? viewDraft.groupBy : ""} onChange={(event) => editView({ groupBy: event.target.value })}>
                      <option value="">Choose a select field</option>
                      {viewFieldCatalogue.filter((field) => field.kind === "single-select").map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}
                    </select>
                  </label>
                )}
                {viewDraft.presentation === "calendar" && (
                  <label>
                    Date field{" "}
                    <select aria-label="Calendar date field" value={viewFieldCatalogue.some((field) => field.key === viewDraft.dateField && field.kind === "date") ? viewDraft.dateField : ""} onChange={(event) => editView({ dateField: event.target.value })}>
                      <option value="">Choose a date field</option>
                      {viewFieldCatalogue.filter((field) => field.kind === "date").map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}
                    </select>
                  </label>
                )}
                {viewDraft.presentation === "dashboard" && (
                  <>
                    {viewDraft.widgets.map((widget, index) => (
                      <fieldset key={widget.id} aria-label={`Widget ${index + 1}`}>
                        <legend>Widget {index + 1}</legend>
                        <label>Label <input aria-label={`Widget ${index + 1} label`} value={widget.label} maxLength={80} onChange={(event) => setViewDraft((current) => ({ ...current, widgets: current.widgets.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item) }))} /></label>
                        <label>
                          Metric{" "}
                          <select aria-label={`Widget ${index + 1} metric`} value={widget.metric} onChange={(event) => {
                            const metric = event.target.value as DashboardWidgetDraft["metric"];
                            const field = metric === "sum"
                              ? (widget.field && [...viewFieldCatalogue, ...metricCatalogue].some((item) => item.key === widget.field && item.kind === "number") ? widget.field : [...viewFieldCatalogue, ...metricCatalogue].find((item) => item.kind === "number")?.key ?? "")
                              : metric === "group"
                                ? (viewFieldCatalogue.some((item) => item.key === widget.field && item.kind === "single-select") ? widget.field : viewFieldCatalogue.find((item) => item.kind === "single-select")?.key ?? "")
                                : "";
                            setViewDraft((current) => ({ ...current, widgets: current.widgets.map((item, itemIndex) => itemIndex === index ? { ...item, metric, field } : item) }));
                          }}>
                            <option value="count">Count</option>
                            <option value="sum">Sum</option>
                            <option value="group">Group</option>
                          </select>
                        </label>
                        {widget.metric === "sum" && (
                          <label>
                            Number field{" "}
                            <select aria-label={`Widget ${index + 1} field`} value={[...viewFieldCatalogue, ...metricCatalogue].some((field) => field.key === widget.field && field.kind === "number") ? widget.field : ""} onChange={(event) => setViewDraft((current) => ({ ...current, widgets: current.widgets.map((item, itemIndex) => itemIndex === index ? { ...item, field: event.target.value } : item) }))}>
                              <option value="">Choose a number field</option>
                              {viewFieldCatalogue.filter((field) => field.kind === "number").map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}
                              {metricCatalogue.filter((field) => field.kind === "number").map((field) => <option key={field.key} value={field.key}>{field.label} (read-only)</option>)}
                            </select>
                          </label>
                        )}
                        {widget.metric === "group" && (
                          <label>
                            Group by{" "}
                            <select aria-label={`Widget ${index + 1} field`} value={viewFieldCatalogue.some((field) => field.key === widget.field && field.kind === "single-select") ? widget.field : ""} onChange={(event) => setViewDraft((current) => ({ ...current, widgets: current.widgets.map((item, itemIndex) => itemIndex === index ? { ...item, field: event.target.value } : item) }))}>
                              <option value="">Choose a select field</option>
                              {viewFieldCatalogue.filter((field) => field.kind === "single-select").map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}
                            </select>
                          </label>
                        )}
                        <button type="button" disabled={busy || viewDraft.widgets.length === 1} onClick={() => setViewDraft((current) => ({ ...current, widgets: current.widgets.filter((_, itemIndex) => itemIndex !== index) }))}>Remove widget</button>
                      </fieldset>
                    ))}
                    <button type="button" name="add-widget" disabled={busy || viewDraft.widgets.length >= 6} onClick={() => editView({ widgets: [...viewDraft.widgets, { id: crypto.randomUUID(), label: "Summary", metric: "count", field: "" }] })}>Add widget</button>
                  </>
                )}
                <p>A board groups by one select field or a single reference catalogue. A calendar places records on one date field. A dashboard counts, sums and groups only records you can view. Calculated metrics stay read-only.</p>
              </fieldset>
              <fieldset>
                <legend>Columns</legend>
                {viewFieldCatalogue.map((field) => (
                  <label className="record-check" key={field.key}>
                    <input type="checkbox" checked={viewDraft.columns.includes(field.key)} onChange={() => toggleColumn(field.key)} /> {field.label}
                  </label>
                ))}
              </fieldset>
              <label className="record-check"><input type="checkbox" checked={viewDraft.includeArchived} onChange={(event) => editView({ includeArchived: event.target.checked })} /> Include archived records</label>
              {viewDraft.filters.map((filter, index) => {
                const field = viewFieldCatalogue.find((item) => item.key === filter.field) ?? viewFieldCatalogue[0];
                const operators = operatorsFor(field?.kind ?? "");
                return (
                  <fieldset key={`${filter.field}-${index}`} aria-label={`Filter ${index + 1}`}>
                    <legend>Filter {index + 1}</legend>
                    <label>
                      Field{" "}
                      <select value={filter.field} onChange={(event) => {
                        const next = viewFieldCatalogue.find((item) => item.key === event.target.value);
                        const nextOperators = operatorsFor(next?.kind ?? "");
                        setViewDraft((current) => ({ ...current, filters: current.filters.map((item, itemIndex) => itemIndex === index ? { field: event.target.value, operator: nextOperators.includes(item.operator) ? item.operator : nextOperators[0] ?? "empty", value: "" } : item) }));
                      }}>
                        {viewFieldCatalogue.filter((item) => operatorsFor(item.kind).length).map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
                      </select>
                    </label>
                    <label>
                      Operator{" "}
                      <select aria-label={`Filter ${index + 1} operator`} value={filter.operator} onChange={(event) => setViewDraft((current) => ({ ...current, filters: current.filters.map((item, itemIndex) => itemIndex === index ? { ...item, operator: event.target.value, value: event.target.value === "empty" ? "" : item.value } : item) }))}>
                        {operators.map((operator) => <option key={operator} value={operator}>{operator}</option>)}
                      </select>
                    </label>
                    {filter.operator !== "empty" && <label>Value <input aria-label={`Filter ${index + 1} value`} value={filter.value} maxLength={2000} onChange={(event) => setViewDraft((current) => ({ ...current, filters: current.filters.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item) }))} /></label>}
                    <button type="button" disabled={busy} onClick={() => setViewDraft((current) => ({ ...current, filters: current.filters.filter((_, itemIndex) => itemIndex !== index) }))}>Remove filter</button>
                  </fieldset>
                );
              })}
              <button type="button" name="add-filter" disabled={busy || viewDraft.filters.length >= 12} onClick={() => editView({ filters: [...viewDraft.filters, { field: "name", operator: "equal", value: "" }] })}>Add filter</button>
              {viewDraft.sorts.map((item, index) => (
                <fieldset key={`${item.field}-${index}`} aria-label={`Sort ${index + 1}`}>
                  <legend>Sort {index + 1}</legend>
                  <label>
                    Field{" "}
                    <select value={item.field} onChange={(event) => setViewDraft((current) => ({ ...current, sorts: current.sorts.map((sort, sortIndex) => sortIndex === index ? { ...sort, field: event.target.value } : sort) }))}>
                      {viewFieldCatalogue.filter((field) => sortableField(field.kind)).map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}
                    </select>
                  </label>
                  <label>
                    Direction{" "}
                    <select aria-label={`Sort ${index + 1} direction`} value={item.direction} onChange={(event) => setViewDraft((current) => ({ ...current, sorts: current.sorts.map((sort, sortIndex) => sortIndex === index ? { ...sort, direction: event.target.value as "asc" | "desc" } : sort) }))}>
                      <option value="asc">Ascending</option>
                      <option value="desc">Descending</option>
                    </select>
                  </label>
                  <button type="button" disabled={busy} onClick={() => setViewDraft((current) => ({ ...current, sorts: current.sorts.filter((_, sortIndex) => sortIndex !== index) }))}>Remove sort</button>
                </fieldset>
              ))}
              <button type="button" name="add-sort" disabled={busy || viewDraft.sorts.length >= 3} onClick={() => {
                const used = new Set(viewDraft.sorts.map((item) => item.field));
                const field = viewFieldCatalogue.find((item) => sortableField(item.kind) && !used.has(item.key));
                if (field) editView({ sorts: [...viewDraft.sorts, { field: field.key, direction: "asc" }] });
              }}>Add sort</button>
              <button disabled={busy || !viewDraft.name.trim() || (viewDraft.scope === "workspace" && !canManageViews && !viewDraft.lockedScope)}>Save view</button>
            </form>
            <div className="record-view-actions">
              {activeView?.scope === "private" && activeView.canManage && activeView.definition && canManageViews && <button type="button" disabled={busy} onClick={() => void publishView()}>Publish shared copy</button>}
              {viewDraft.id && activeView?.canManage && <button type="button" disabled={busy} onClick={() => void removeView()}>Delete view</button>}
            </div>
          </section>
          {canExport && (
            <RecordExport
              key={collection}
              workspaceId={workspaceId}
              tenantId={tenantId}
              collection={collection}
              schemaVersion={schemaVersion}
              view={activeView?.definition && !activeView.unavailable ? { id: activeView.id, name: activeView.name, version: activeView.version, columns: activeView.definition.columns } : null}
              records={(activeView?.definition && !activeView.unavailable ? (calendar ? calendar.events : board ? board.columns.flatMap((column) => column.cards) : viewRows) : items).map((row) => ({ id: row.id, name: row.name }))}
              fields={fields.map((field) => ({ key: field.key, label: field.label, kind: field.kind }))}
            />
          )}
          {schemaCatalogue && (
            <section aria-label="Collection fields">
              <h2>Collection fields</h2>
              <p>Schema permission does not grant field-value read, write, or history. Defaults apply only to future records. Built-in identity, tenant, and parent rules stay fixed. Sensitivity can be raised here and cannot be lowered. Fields are not deleted.</p>
              <p><a href={`/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/collections/${encodeURIComponent(collection)}/layout`}>Arrange record layout</a>. Publishing a layout does not change record values or grant access.</p>
              <p><a href={`/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/collections/${encodeURIComponent(collection)}/conditions`}>Conditional fields</a>. Typed conditions show or require fields. Hiding a field keeps its value until an explicit edit clears it.</p>
              <p><a href={`/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/reference-lists`}>Reference lists</a>. A select field can use a tenant catalogue. Saved values stay stable item IDs. Renaming a label does not rewrite records, and list configuration does not grant record access.</p>
              <p><a href={`/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/collections/${encodeURIComponent(collection)}/formulas`}>Calculated fields</a>. A reviewed formula adds a read-only value. It recomputes from confirmed source values and does not grant record access.</p>
              <p>{schemaCatalogue.customFieldCount} of {schemaCatalogue.limits.maxFields} custom fields. Select fields allow {schemaCatalogue.limits.maxChoices} choices.</p>
              <ul>
                {schemaCatalogue.fields.filter((field) => field.core).map((field) => <li key={field.key}>{field.label} · built-in · not editable</li>)}
              </ul>
              <ul>
                {schemaCatalogue.fields.filter((field) => !field.core).map((field) => (
                  <li key={field.key}>
                    <button type="button" disabled={busy} onClick={() => chooseSchemaField(field.key)}>{field.label}</button>
                    {field.deprecated ? " · deprecated" : ""}
                    {field.sensitive ? " · sensitive" : ""}
                    {field.referenceListId ? " · reference list" : ""}
                  </li>
                ))}
              </ul>
              <form aria-label="Custom field" onSubmit={previewSchemaChange}>
                <button type="button" disabled={busy} onClick={() => chooseSchemaField("")}>New custom field</button>
                <label>Label <input required minLength={1} maxLength={100} value={schemaDraft.label} onChange={(event) => editSchema({ label: event.target.value })} /></label>
                <label>
                  Type{" "}
                  <select value={schemaDraft.kind} disabled={!!schemaDraft.referenceListId} onChange={(event) => editSchema({ kind: event.target.value, choices: "", defaultValue: "" })}>
                    {customFieldKinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                  </select>
                </label>
                {schemaDraft.referenceListId && <p>Choices come from a reference list. This screen keeps that binding and stores item IDs. A future default must be an active item ID; a deprecated item cannot become a new default.</p>}
                {(schemaDraft.kind === "single-select" || schemaDraft.kind === "multi-select") && !schemaDraft.referenceListId && (
                  <label>Choices, one per line <textarea value={schemaDraft.choices} onChange={(event) => editSchema({ choices: event.target.value })} /></label>
                )}
                {schemaDraft.kind !== "attachment" && schemaDraft.kind !== "record" && (
                  <label>
                    Default for future records{" "}
                    <input value={schemaDraft.defaultValue} onChange={(event) => editSchema({ defaultValue: event.target.value })} placeholder={schemaDraft.kind === "currency" ? "USD,1000,2" : schemaDraft.kind === "boolean" ? "true or false" : ""} />
                  </label>
                )}
                <label className="record-check"><input type="checkbox" checked={schemaDraft.required} onChange={(event) => editSchema({ required: event.target.checked })} /> Required for new records</label>
                <label className="record-check"><input type="checkbox" checked={schemaDraft.unique} onChange={(event) => editSchema({ unique: event.target.checked })} /> Unique</label>
                <label className="record-check"><input type="checkbox" checked={schemaDraft.sensitive} disabled={schemaDraft.lockedSensitive} onChange={(event) => editSchema({ sensitive: event.target.checked })} /> Sensitive</label>
                <label className="record-check"><input type="checkbox" checked={schemaDraft.deprecated} onChange={(event) => editSchema({ deprecated: event.target.checked })} /> Deprecated</label>
                <p>Deprecated fields stay readable under field rights and cannot be edited on records.</p>
                <button disabled={busy || !schemaDraft.label.trim() || (schemaCatalogue.customFieldCount >= schemaCatalogue.limits.maxFields && !schemaDraft.fieldKey)}>Review field</button>
              </form>
              {schemaPreview && (
                <section aria-label="Schema review">
                  <p>{schemaPreview.impact.defaultBehavior}</p>
                  <p>{schemaPreview.impact.recordCount} records, {schemaPreview.impact.populatedCount} populated, {schemaPreview.impact.missingCount} missing, {schemaPreview.impact.duplicateValues} duplicate values.</p>
                  <p>Review expires {schemaPreview.expiresAt}.</p>
                  {!!schemaPreview.impact.changes.length && <p>Changes: {schemaPreview.impact.changes.join(", ")}</p>}
                  {!!schemaPreview.impact.dependencies.length && <p>Dependencies: {schemaPreview.impact.dependencies.map((item) => `${item.kind} ${item.label}`).join(", ")}</p>}
                  {schemaPreview.impact.blockers.length ? <p role="alert">{schemaPreview.impact.blockers.join(" ")}</p> : <button type="button" disabled={busy} onClick={() => void applySchemaChange()}>Apply reviewed field</button>}
                </section>
              )}
            </section>
          )}
        </section>
        <section aria-label="Record editor">
          <h2>{selected ? "Record details" : "Create record"}</h2>
          {selected ? (
            <>
              <form onSubmit={save}>
                {recordLayout ? <RecordFormLayout layout={recordLayout} fields={fields} name={editName} values={Object.fromEntries(fields.map((field) => [field.key, Object.hasOwn(edits, field.key) ? edits[field.key] : selected.values?.[field.key]]))} nameDisabled={archivedRecord} fieldsDisabled={busy || archivedRecord || !selected.capabilities.includes("edit")} nameWritable={!archivedRecord && selected.capabilities.includes("edit")} hasUnsavedChanges={editName !== selected.name || Object.keys(edits).length > 0} scopeKey={`${collection}:${selected.id}`} conditions={recordConditions ?? undefined} onName={setEditName} onValue={(key, value) => setEdits((current) => ({ ...current, [key]: value }))} /> : <label>Name <input required minLength={1} maxLength={200} value={editName} disabled={archivedRecord} onChange={(event) => setEditName(event.target.value)} /></label>}
                <button disabled={busy || archivedRecord || !selected.capabilities.includes("edit")}>Save changes</button>
                {!recordLayout && recordConditions?.some((state) => !state.visible) && <p role="note">Hidden fields retain their values. Clear them only with an explicit permitted edit.</p>}
                {!recordLayout && fields.filter((field) => !field.calculated && conditionVisible(recordConditions, field.key)).map((field) => <FieldEditor key={field.key} field={field} disabled={busy || archivedRecord || !selected.capabilities.includes("edit")} value={Object.hasOwn(edits, field.key) ? edits[field.key] : selected.values?.[field.key]} onChange={(value) => setEdits((current) => ({ ...current, [field.key]: value }))} />)}
                <CalculatedFields fields={fields} values={Object.fromEntries(fields.map((field) => [field.key, Object.hasOwn(edits, field.key) ? edits[field.key] : selected.values?.[field.key]]))} calculated={selected.calculated} />
              </form>
              {archivedRecord && <p>This record is archived and stays readable. Unarchive it before saving changes or adding links.</p>}
              <p>Fields you cannot view are omitted. A name change keeps those hidden values.</p>
              <p><a href={`/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/collections/${encodeURIComponent(selected.collection)}/review?record=${encodeURIComponent(selected.id)}`}>Review this record</a>. Submit it for review, or approve, reject, or request changes when you are permitted to decide.</p>
              <p><a href={`/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/collections/${encodeURIComponent(selected.collection)}/quality?record=${encodeURIComponent(selected.id)}`}>Check completeness</a>. See required fields and quality checks you are allowed to view. A failing check does not block saving.</p>
              <p><a href={`/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/collections/${encodeURIComponent(selected.collection)}/periodic-review`}>Periodic review for this collection</a>. See whether this collection has records due for a scheduled review you are allowed to view.</p>
              <p><a href={`/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/catalogue?collection=${encodeURIComponent(selected.collection)}`}>Field definitions for this collection</a>. Open the data catalogue for the types, required fields, and reference lists you are allowed to view.</p>
              <RecordComments key={selected.id} workspaceId={workspaceId} tenantId={tenantId} recordId={selected.id} />
              <RecordResponsibility key={`responsibility-${selected.id}`} workspaceId={workspaceId} tenantId={tenantId} recordId={selected.id} />
              <ExternalIdentifierMappings key={`external-${selected.id}`} workspaceId={workspaceId} tenantId={tenantId} collection={selected.collection} recordId={selected.id} />
              <dl>
                <dt>Immutable ID</dt>
                <dd>{selected.id}</dd>
                <dt>State</dt>
                <dd>{selected.state}</dd>
                <dt>Version</dt>
                <dd>{selected.version}</dd>
              </dl>
              {(selected.capabilities.includes("archive") || selected.capabilities.includes("delete")) && (
                <section aria-label="Archive and Trash">
                  <h3>Archive and Trash</h3>
                  {selected.capabilities.includes("archive") && (
                    archivedRecord
                      ? <button type="button" disabled={busy} onClick={() => void setArchived(false)}>Unarchive record</button>
                      : <button type="button" disabled={busy} onClick={() => void setArchived(true)}>Archive record</button>
                  )}
                  {selected.capabilities.includes("archive") && <p>Archive keeps this ID, history and references, and hides the record from active lists.</p>}
                  {selected.capabilities.includes("delete") && (
                    <>
                      <p>Deletion moves the record to tenant Trash for 30 days. Incoming associations block it. Owned outgoing relationships stay with the Trash record. Nothing is permanently removed.</p>
                      <button type="button" disabled={busy} onClick={() => void reviewDelete()}>Review deletion</button>
                      {currentDeletePreview && (
                        <section aria-label="Deletion review">
                          <p>{currentDeletePreview.message}</p>
                          {currentDeletePreview.blocked ? <p role="alert">Deletion is blocked. Resolve the associations, then review again.</p> : (
                            <>
                              <p>Review expires {currentDeletePreview.expiresAt}. Trash keeps the record for {currentDeletePreview.trashDays} days.</p>
                              <p>Permanent removal is not part of this review.</p>
                              <button type="button" disabled={busy} onClick={() => void confirmTrash()}>Move to Trash</button>
                            </>
                          )}
                        </section>
                      )}
                    </>
                  )}
                </section>
              )}
              {canMerge && (
                <section aria-label="Merge records">
                  <h3>Merge records</h3>
                  <p>The open record is the source. Choose a different active record in this collection as the survivor. Both need current read, edit and merge rights. Each field choice needs current write rights, including when the survivor value stays. Unreadable fields block the merge. This does not grant record or page access.</p>
                  {selected.collection === "contracts" && <p>Legal parties and covered accounts are combined. Conflicting roles, status or primary flags need an explicit choice. More than one primary account blocks the merge until it is reconciled.</p>}
                  {selected.collection === "accounts" && <p>When the parent organisations differ, choose the current authorised parent. The parent record must be one you can link.</p>}
                  <form aria-label="Review merge" onSubmit={reviewMerge}>
                    <label>
                      Survivor record ID{" "}
                      <input required value={mergeSurvivorId} onChange={(event) => { setMergeSurvivorId(event.target.value); setMergePreview(null); setMergeFieldFrom({}); setMergeRelationshipFrom({}); setMergeReviewStale(false); }} />
                    </label>
                    <fieldset>
                      <legend>Name</legend>
                      <label className="record-check"><input type="radio" name="merge-name" value="source" checked={mergeNameFrom === "source"} onChange={() => chooseMergeSide("name", "source")} /> Keep source name</label>
                      <label className="record-check"><input type="radio" name="merge-name" value="survivor" checked={mergeNameFrom === "survivor"} onChange={() => chooseMergeSide("name", "survivor")} /> Keep survivor name</label>
                    </fieldset>
                    {selected.collection === "accounts" && (
                      <fieldset>
                        <legend>Account parent</legend>
                        <label className="record-check"><input type="radio" name="merge-parent" value="source" checked={mergeParentFrom === "source"} onChange={() => chooseMergeSide("parent", "source")} /> Source parent</label>
                        <label className="record-check"><input type="radio" name="merge-parent" value="survivor" checked={mergeParentFrom === "survivor"} onChange={() => chooseMergeSide("parent", "survivor")} /> Survivor parent</label>
                      </fieldset>
                    )}
                    <button disabled={busy || !mergeSurvivorId.trim() || mergeSurvivorId.trim() === selected.id}>Review merge</button>
                  </form>
                  {mergePreview && (
                    <section aria-label="Merge review">
                      <p>Source {mergePreview.source.name}, version {mergePreview.source.version}. Survivor {mergePreview.survivor.name}, version {mergePreview.survivor.version}.</p>
                      <p>Review expires {mergePreview.expiresAt}. {mergePreview.sourceHistoryRetained ? "Source history is retained." : "Review this merge again."}</p>
                      {mergePreview.conflicts.map((conflict) => (
                        <fieldset key={conflict.key} aria-label={`Field ${conflict.label}`}>
                          <legend>{conflict.label}</legend>
                          <p>Source value: {displayValue(conflict.source)}</p>
                          <p>Survivor value: {displayValue(conflict.survivor)}</p>
                          <label className="record-check"><input type="radio" name={`merge-field-${conflict.key}`} value="source" checked={mergeFieldFrom[conflict.key] === "source"} onChange={() => chooseMergeSide("field", "source", conflict.key)} /> Use source value</label>
                          <label className="record-check"><input type="radio" name={`merge-field-${conflict.key}`} value="survivor" checked={mergeFieldFrom[conflict.key] === "survivor"} onChange={() => chooseMergeSide("field", "survivor", conflict.key)} /> Use survivor value</label>
                        </fieldset>
                      ))}
                      {mergePreview.relationshipConflicts.map((conflict) => (
                        <fieldset key={conflict.key} aria-label={`Relationship ${conflict.key}`}>
                          <legend>{conflict.key}</legend>
                          <p>Source relationship: {relationshipChoiceLabel(conflict.source)}</p>
                          <p>Survivor relationship: {relationshipChoiceLabel(conflict.survivor)}</p>
                          <label className="record-check"><input type="radio" name={`merge-relationship-${conflict.key}`} value="source" checked={mergeRelationshipFrom[conflict.key] === "source"} onChange={() => chooseMergeSide("relationship", "source", conflict.key)} /> Use source relationship</label>
                          <label className="record-check"><input type="radio" name={`merge-relationship-${conflict.key}`} value="survivor" checked={mergeRelationshipFrom[conflict.key] === "survivor"} onChange={() => chooseMergeSide("relationship", "survivor", conflict.key)} /> Use survivor relationship</label>
                        </fieldset>
                      ))}
                      {!!mergePreview.documents.length && (
                        <>
                          <p>Permitted document associations to copy. Each page keeps its own access. Merge does not create a page grant.</p>
                          <ul>{mergePreview.documents.map((document) => <li key={document.id}>{document.title}</li>)}</ul>
                        </>
                      )}
                      {!!mergePreview.blockers.length && <p role="alert">{mergePreview.blockers.join(" ")}</p>}
                      {mergeReviewStale && <p>Review the merge again so these choices are bound to the current records.</p>}
                      {!mergePreview.integrationReady && <p>Apply is unavailable. No qualified connected-app alias consumer is connected, so this review cannot be committed.</p>}
                      <button type="button" disabled={busy || mergeReviewStale || mergePreview.blockers.length > 0 || !mergePreview.integrationReady} onClick={() => void applyReviewedMerge()}>Apply merge</button>
                    </section>
                  )}
                </section>
              )}
              <RecordDocuments workspaceId={workspaceId} tenantId={tenantId} recordId={selected.id} />
              <h3>Linked documents</h3>
              {selected.documents.length ? (
                <ul>
                  {selected.documents.map((document) => (
                    <li key={document.id}>
                      <a href={`/pages/${document.pageId}`}>{document.title}</a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No documents you can access are linked.</p>
              )}
              <RecordGraph key={`graph-${selected.id}`} workspaceId={workspaceId} tenantId={tenantId} recordId={selected.id} version={selected.version} onOpenRecord={(id) => void refreshOpen(id)} />
              <h3>Related records</h3>
              {selected.related.length ? (
                <ul>
                  {selected.related.map((link) => (
                    <li key={link.id}>
                      {link.kind}: {link.target.name}
                      {link.role ? ` · ${link.role}` : ""}
                      {link.primary ? " · primary" : ""}
                      {canRelate && (
                        <button disabled={busy} onClick={(event) => void relationship(event, "remove", link)}>
                          Remove
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No visible relationships.</p>
              )}
              {canRelate && (
                <form aria-label="Add relationship" onSubmit={relationship}>
                  {selected.collection === "contracts" && (
                    <label>
                      Relationship type{" "}
                      <select value={contractRelationKind} onChange={(event) => setContractRelationKind(event.target.value as "contract-account" | "contract-legal-party")}>
                        <option value="contract-account">Covered account</option>
                        <option value="contract-legal-party">Legal organisation</option>
                      </select>
                    </label>
                  )}
                  <label>
                    Target record ID <input required value={targetId} onChange={(event) => setTargetId(event.target.value)} />
                  </label>
                  <label>
                    Role <input maxLength={100} value={role} onChange={(event) => setRole(event.target.value)} />
                  </label>
                  {selected.collection === "contacts" && (
                    <label>
                      <input type="checkbox" checked={primary} onChange={(event) => setPrimary(event.target.checked)} /> Primary account
                    </label>
                  )}
                  <label>
                    Status{" "}
                    <select value={relationStatus} onChange={(event) => setRelationStatus(event.target.value as "active" | "inactive")}>
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </label>
                  <button disabled={busy}>Add relationship</button>
                </form>
              )}
              {selected.capabilities.includes("history") && (
                <RecordHistory
                  key={`${selected.id}:${selected.version}`}
                  workspaceId={workspaceId}
                  tenantId={tenantId}
                  recordId={selected.id}
                  recordVersion={selected.version}
                  canRestore={selected.capabilities.includes("edit") && selected.capabilities.includes("restore-values")}
                  fields={fields}
                  onRestored={async (result) => {
                    await refreshOpen(selected.id);
                    setNotice(result.replayed ? "This restore was already saved. The record was opened again under your current access." : "Selected values restored as a new version. Unselected fields, identity, relationships, documents, lifecycle and grants were kept.");
                  }}
                />
              )}
              {canManage && (
                <section aria-label="Record permissions">
                  <h3>Record permissions</h3>
                  <p>Collection access still applies. A record grant adds access to this record; it does not hide records a collection grant already shows. Sensitive fields stay hidden until view is granted. You cannot change your own access here.</p>
                  {!matrix ? <button type="button" disabled={busy} onClick={() => void loadMatrix()}>Review member access</button> : (
                    <form aria-label="Edit member access" onSubmit={savePermissions}>
                      <label>Member <select value={memberId} onChange={(event) => chooseMember(event.target.value)}>{matrix.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
                      <p>Collection capabilities: {(matrix.members.find((member) => member.id === memberId)?.collection.capabilities ?? []).join(", ") || "none"}</p>
                      <fieldset>
                        <legend>This record</legend>
                        {recordPermissionNames.map((name) => <label className="record-check" key={name}><input type="checkbox" checked={grantCapabilities.includes(name)} onChange={() => toggleCapability(name)} /> {name}</label>)}
                      </fieldset>
                      {matrix.sensitiveFields.map((field) => {
                        const flags = grantFields.find((item) => item.key === field.key);
                        return <fieldset key={field.key}><legend>{field.label}</legend><label className="record-check"><input type="checkbox" checked={!!flags?.canView} onChange={() => toggleField(field.key, "canView")} /> View</label><label className="record-check"><input type="checkbox" checked={!!flags?.canWrite} onChange={() => toggleField(field.key, "canWrite")} /> Write</label><label className="record-check"><input type="checkbox" checked={!!flags?.canHistory} onChange={() => toggleField(field.key, "canHistory")} /> History</label></fieldset>;
                      })}
                      <button disabled={busy || !memberId}>Save permissions</button>
                    </form>
                  )}
                </section>
              )}
              {selected.collection === "accounts" && !archivedRecord && selected.capabilities.includes("edit") && selected.capabilities.includes("link") && (
                <form aria-label="Move account" onSubmit={previewReparent}>
                  <label>
                    New parent organisation ID <input required value={newParent} onChange={(event) => setNewParent(event.target.value)} />
                  </label>
                  <button disabled={busy}>Preview move</button>
                  {preview && (
                    <section aria-label="Move impact">
                      <p>
                        {preview.affectedContracts.length} contract context(s) and {preview.contextReferences.length} external context reference(s) are affected.
                      </p>
                      <p>Legal parties will not change.</p>
                      <button type="button" disabled={busy} onClick={() => void applyReparent()}>
                        Confirm account move
                      </button>
                    </section>
                  )}
                </form>
              )}
            </>
          ) : (
            <form onSubmit={create}>
              {collectionLayout ? <RecordFormLayout layout={collectionLayout} fields={fields} name={createName} values={drafts} nameDisabled={false} fieldsDisabled={busy} nameWritable={canCreate !== false} hasUnsavedChanges={createName.trim().length > 0 || Object.keys(drafts).length > 0} scopeKey={`${collection}:create`} conditions={createConditions ?? undefined} onName={(value) => { setCreateName(value); setDuplicates(null); }} onValue={(key, value) => { setDrafts((current) => ({ ...current, [key]: value })); setDuplicates(null); }} /> : <label>Name <input required minLength={1} maxLength={200} value={createName} onChange={(event) => { setCreateName(event.target.value); setDuplicates(null); }} /></label>}
              {collection === "accounts" && (
                <label>
                  Parent organisation ID <input required value={createParent} onChange={(event) => setCreateParent(event.target.value)} />
                </label>
              )}
              {collection === "contracts" && (
                <>
                  <label>
                    Legal organisation IDs <input required value={createLegal} onChange={(event) => setCreateLegal(event.target.value)} placeholder="Comma separated" />
                  </label>
                  <label>
                    Covered account IDs <input value={createAccounts} onChange={(event) => setCreateAccounts(event.target.value)} placeholder="Optional, comma separated" />
                  </label>
                </>
              )}
              {!collectionLayout && createConditions?.some((state) => !state.visible) && <p role="note">Hidden fields retain their values. Clear them only with an explicit permitted edit.</p>}
              {!collectionLayout && writableFields.filter((field) => !field.calculated && conditionVisible(createConditions, field.key)).map((field) => <FieldEditor key={field.key} field={field} disabled={busy} value={drafts[field.key]} onChange={(value) => { setDrafts((current) => ({ ...current, [field.key]: value })); setDuplicates(null); }} />)}
              <CalculatedFields fields={fields} values={drafts} />
              {collectionLayout && canCreate === true && collectionLayout.canCreate === false && <p role="status">Creation is paused until the published layout places every required field in an editable slot.</p>}
              {(collection === "accounts" || collection === "contracts") && <p>Linked organisations and accounts must be active. Unarchive a record before using it in a new link.</p>}
              <section aria-label="Duplicate suggestions">
                <h3>Duplicate suggestions</h3>
                <p>Advisory only. At most ten current permitted name, website or email matches are shown. An email match needs current read permission for that field. Hidden or unshared records are omitted and do not change the result. This check does not block creating a record.</p>
                <button type="button" disabled={busy || !createName.trim()} onClick={() => void checkDuplicates()}>Check for duplicates</button>
                {duplicates && (duplicates.suggestions.length ? (
                  <ul>
                    {duplicates.suggestions.map((item) => (
                      <li key={item.id}>
                        <button type="button" disabled={busy} onClick={() => void open(item.id)}>{item.name}</button>
                        {item.state === "archived" ? " · archived" : ""}
                        {item.reasons.length ? ` · ${item.reasons.join(", ")}` : ""}
                      </li>
                    ))}
                  </ul>
                ) : <p>No permitted matches.</p>)}
                {duplicates?.hasMore && <p>More than ten permitted matches exist. This list stops at ten.</p>}
              </section>
              <button disabled={busy || !createName.trim() || canCreate === false || collectionLayout?.canCreate === false}>Create record</button>
            </form>
          )}
        </section>
      </div>
    </main>
  );
}
