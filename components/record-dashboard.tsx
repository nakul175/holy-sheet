"use client";

export type DashboardGroup = { key: string; label: string; value: number };
export type DashboardWidget = {
  id: string;
  label: string;
  metric: "count" | "sum" | "group";
  value?: number | null;
  fieldLabel?: string;
  groups?: DashboardGroup[];
  readOnly: true;
  calculated?: boolean;
  sensitive?: boolean;
  stale?: boolean;
};
export type DashboardModel = { schemaVersion: number; widgets: DashboardWidget[] };

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function groupsOf(value: unknown): DashboardGroup[] | null {
  if (!Array.isArray(value)) return null;
  const groups: DashboardGroup[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const row = item as Record<string, unknown>;
    if (typeof row.key !== "string" || typeof row.label !== "string" || !finite(row.value)) return null;
    if (Object.keys(row).some((key) => key !== "key" && key !== "label" && key !== "value")) return null;
    groups.push({ key: row.key, label: row.label, value: row.value });
  }
  return groups;
}

function metricText(widget: DashboardWidget) {
  if (widget.stale || widget.value === null || widget.value === undefined) return "Unavailable";
  return String(widget.value);
}

export function acceptedDashboard(body: unknown): DashboardModel | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if ("count" in record || "total" in record || "hiddenCount" in record) return null;
  if (typeof record.schemaVersion !== "number" || !Array.isArray(record.widgets)) return null;
  const widgets: DashboardWidget[] = [];
  for (const item of record.widgets) {
    if (!item || typeof item !== "object") return null;
    const widget = item as Record<string, unknown>;
    if ("count" in widget || "total" in widget || "hiddenCount" in widget) return null;
    if (typeof widget.id !== "string" || typeof widget.label !== "string" || !widget.label || widget.readOnly !== true) return null;
    if (widget.metric === "count") {
      if (!finite(widget.value)) return null;
      widgets.push({ id: widget.id, label: widget.label, metric: "count", value: widget.value, readOnly: true });
      continue;
    }
    if (widget.metric === "sum") {
      if (typeof widget.fieldLabel !== "string" || !widget.fieldLabel) return null;
      if (widget.value !== null && !finite(widget.value)) return null;
      if (widget.calculated !== undefined && typeof widget.calculated !== "boolean") return null;
      if (widget.sensitive !== undefined && typeof widget.sensitive !== "boolean") return null;
      if (widget.stale !== undefined && typeof widget.stale !== "boolean") return null;
      widgets.push({
        id: widget.id,
        label: widget.label,
        metric: "sum",
        fieldLabel: widget.fieldLabel,
        value: finite(widget.value) ? widget.value : null,
        readOnly: true,
        ...(widget.calculated === true ? { calculated: true } : {}),
        ...(typeof widget.sensitive === "boolean" ? { sensitive: widget.sensitive } : {}),
        ...(typeof widget.stale === "boolean" ? { stale: widget.stale } : {}),
      });
      continue;
    }
    if (widget.metric !== "group" || typeof widget.fieldLabel !== "string" || !widget.fieldLabel) return null;
    const groups = groupsOf(widget.groups);
    if (!groups) return null;
    widgets.push({ id: widget.id, label: widget.label, metric: "group", fieldLabel: widget.fieldLabel, groups, readOnly: true });
  }
  return { schemaVersion: record.schemaVersion, widgets };
}

export default function RecordDashboard({ dashboard }: { dashboard: DashboardModel }) {
  return (
    <section aria-label="Record dashboard" className="record-dashboard-screen">
      <h2>Dashboard</h2>
      <p>Summaries include only records you can currently view. Calculated metrics stay read-only.</p>
      <div className="record-dashboard">
        {dashboard.widgets.map((widget) => (
          <article key={widget.id} aria-label={widget.label}>
            <h3>{widget.label}</h3>
            {widget.metric === "group" ? (
              <>
                <p>Grouped by {widget.fieldLabel}</p>
                <ul>
                  {widget.groups?.map((group) => <li key={group.key}>{group.label}: {group.value}</li>)}
                </ul>
              </>
            ) : widget.calculated ? (
              <div aria-label="Calculated fields">
                <p>Derived values are read-only.</p>
                <p>{widget.fieldLabel}{widget.sensitive ? " (sensitive)" : ""}: {metricText(widget)} · read-only</p>
              </div>
            ) : (
              <p>{widget.fieldLabel ? `${widget.fieldLabel}: ` : ""}{metricText(widget)}</p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
