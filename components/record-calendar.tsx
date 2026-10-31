"use client";

export type CalendarEvent = {
  id: string;
  name: string;
  state: string;
  version: number;
  date: string;
  canReschedule: boolean;
  values: Record<string, unknown>;
  calculated?: { fieldKey: string; label: string; value: unknown; sensitive: boolean; stale: boolean; readOnly: true; error?: string }[];
  references?: { fieldKey: string; items: { id: string; label: string }[] }[];
};
export type CalendarFieldModel = { key: string; label: string; kind: string; choices?: { id: string; label: string }[] };
export type CalendarDay = { date: string; inMonth: boolean };
export type CalendarModel = {
  schemaVersion: number;
  dateLabel: string;
  range: { from: string; to: string };
  fields: CalendarFieldModel[];
  events: CalendarEvent[];
  nextCursor: string | null;
};

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function choiceList(value: unknown): { id: string; label: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const choices: { id: string; label: string }[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.label !== "string") return undefined;
    if (Object.keys(row).some((key) => key !== "id" && key !== "label")) return undefined;
    choices.push({ id: row.id, label: row.label });
  }
  return choices;
}

function referenceList(value: unknown): CalendarEvent["references"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const references: NonNullable<CalendarEvent["references"]> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const row = item as Record<string, unknown>;
    if (typeof row.fieldKey !== "string" || !Array.isArray(row.items)) return undefined;
    if (Object.keys(row).some((key) => key !== "fieldKey" && key !== "items")) return undefined;
    const items = choiceList(row.items);
    if (!items) return undefined;
    references.push({ fieldKey: row.fieldKey, items });
  }
  return references;
}

function textValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return "—";
  return String(value);
}

function fieldText(field: CalendarFieldModel, value: unknown, references: CalendarEvent["references"]) {
  const linked = references?.find((item) => item.fieldKey === field.key)?.items ?? [];
  if (field.kind === "record" && Array.isArray(value)) {
    const labels = value.filter((item): item is string => typeof item === "string").map((item) => linked.find((row) => row.id === item)?.label ?? "Unavailable record");
    return labels.length ? labels.join(", ") : "—";
  }
  if (field.kind === "single-select" || field.kind === "multi-select" || field.choices) {
    const label = (id: string) => field.choices?.find((choice) => choice.id === id)?.label ?? linked.find((row) => row.id === id)?.label ?? "Unavailable choice";
    if (Array.isArray(value)) {
      const labels = value.filter((item): item is string => typeof item === "string").map(label);
      return labels.length ? labels.join(", ") : "—";
    }
    if (typeof value === "string" && value) return label(value);
    return "—";
  }
  return textValue(value);
}

function calculatedText(row: NonNullable<CalendarEvent["calculated"]>[number]) {
  if (row.stale) return row.error === "formula_divide_by_zero" ? "Division by zero has no value." : "Unavailable";
  return textValue(row.value);
}

function isoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function currentCalendarMonth() {
  return new Date().toISOString().slice(0, 7);
}

export function shiftMonth(month: string, delta: number) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return currentCalendarMonth();
  const cursor = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + delta, 1));
  return cursor.toISOString().slice(0, 7);
}

/** Sunday-start month grid, including the adjacent days needed to fill the weeks. At most 42 days. */
export function calendarMonthRange(month: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]), mon = Number(match[2]);
  if (mon < 1 || mon > 12) return null;
  const first = new Date(Date.UTC(year, mon - 1, 1));
  const start = new Date(first);
  start.setUTCDate(1 - first.getUTCDay());
  const days: CalendarDay[] = [];
  for (let index = 0; index < 42; index += 1) {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + index);
    days.push({ date: day.toISOString().slice(0, 10), inMonth: day.getUTCMonth() === mon - 1 });
  }
  return { from: days[0].date, to: days[41].date, label: `${monthNames[mon - 1]} ${year}`, days };
}

export function acceptedCalendar(body: unknown): CalendarModel | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if ("count" in record || "total" in record || "hiddenCount" in record) return null;
  if (typeof record.dateLabel !== "string" || !record.dateLabel || typeof record.schemaVersion !== "number" || !Array.isArray(record.events) || !Array.isArray(record.fields)) return null;
  if (!record.range || typeof record.range !== "object") return null;
  const range = record.range as Record<string, unknown>;
  if (!isoDate(range.from) || !isoDate(range.to)) return null;
  if (record.nextCursor !== null && record.nextCursor !== undefined && typeof record.nextCursor !== "string") return null;
  const fields: CalendarFieldModel[] = [];
  for (const item of record.fields) {
    if (!item || typeof item !== "object") return null;
    const field = item as Record<string, unknown>;
    if (typeof field.key !== "string" || typeof field.label !== "string" || typeof field.kind !== "string") return null;
    const choices = field.choices === undefined ? undefined : choiceList(field.choices);
    if (field.choices !== undefined && !choices) return null;
    fields.push({ key: field.key, label: field.label, kind: field.kind, ...(choices ? { choices } : {}) });
  }
  const events: CalendarEvent[] = [];
  for (const item of record.events) {
    if (!item || typeof item !== "object") return null;
    const row = item as Record<string, unknown>;
    if ("count" in row || "total" in row || "hiddenCount" in row) return null;
    const date = row.date;
    if (typeof row.id !== "string" || typeof row.name !== "string" || typeof row.state !== "string" || typeof row.version !== "number" || typeof row.canReschedule !== "boolean" || !isoDate(date) || !row.values || typeof row.values !== "object" || Array.isArray(row.values)) return null;
    const calculated: CalendarEvent["calculated"] = [];
    if (row.calculated !== undefined) {
      if (!Array.isArray(row.calculated)) return null;
      for (const derived of row.calculated) {
        if (!derived || typeof derived !== "object") return null;
        const entry = derived as Record<string, unknown>;
        if (typeof entry.fieldKey !== "string" || typeof entry.label !== "string" || typeof entry.sensitive !== "boolean" || typeof entry.stale !== "boolean" || entry.readOnly !== true) return null;
        calculated.push({ fieldKey: entry.fieldKey, label: entry.label, value: entry.value, sensitive: entry.sensitive, stale: entry.stale, readOnly: true, ...(typeof entry.error === "string" ? { error: entry.error } : {}) });
      }
    }
    const references = row.references === undefined ? undefined : referenceList(row.references);
    if (row.references !== undefined && !references) return null;
    events.push({ id: row.id, name: row.name, state: row.state, version: row.version, date, canReschedule: row.canReschedule, values: row.values as Record<string, unknown>, ...(calculated.length ? { calculated } : {}), ...(references?.length ? { references } : {}) });
  }
  return { schemaVersion: record.schemaVersion, dateLabel: record.dateLabel, range: { from: range.from as string, to: range.to as string }, fields, events, nextCursor: typeof record.nextCursor === "string" ? record.nextCursor : null };
}

export default function RecordCalendar({
  calendar,
  month,
  busy,
  onOpen,
  onReschedule,
  onLoadMore,
  onMonth,
  selectedIds,
  onToggleSelect,
}: {
  calendar: CalendarModel;
  month: string;
  busy: boolean;
  onOpen: (id: string) => void;
  onReschedule: (event: CalendarEvent, date: string) => void;
  onLoadMore: () => void;
  onMonth: (month: string) => void;
  selectedIds?: string[];
  onToggleSelect?: (id: string) => void;
}) {
  const grid = calendarMonthRange(month);
  if (!grid) return null;
  const placed = new Map<string, CalendarEvent[]>();
  for (const event of calendar.events) {
    const list = placed.get(event.date) ?? [];
    list.push(event);
    placed.set(event.date, list);
  }
  return (
    <section aria-label="Record calendar" className="record-calendar-screen">
      <div className="record-calendar-nav">
        <button type="button" disabled={busy} onClick={() => onMonth(shiftMonth(month, -1))}>Previous month</button>
        <h2>{grid.label}</h2>
        <button type="button" disabled={busy} onClick={() => onMonth(shiftMonth(month, 1))}>Next month</button>
      </div>
      <p>Keyed by {calendar.dateLabel}. A day lists the records you can view. Calculated values stay read-only. Rescheduling uses the same record update rules as editing the date.</p>
      <div className="record-calendar">
        {weekdays.map((day) => <div key={day} className="record-calendar-weekday">{day.slice(0, 3)}</div>)}
        {grid.days.map((day) => (
          <section
            key={day.date}
            aria-label={day.date}
            className={day.inMonth ? "record-calendar-day" : "record-calendar-day outside"}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (busy) return;
              const raw = event.dataTransfer.getData("application/x-holy-sheet-event");
              if (!raw) return;
              try {
                const parsed = JSON.parse(raw) as { recordId?: string; version?: number };
                const card = calendar.events.find((item) => item.id === parsed.recordId && item.version === parsed.version);
                if (card?.canReschedule && card.date !== day.date) onReschedule(card, day.date);
              } catch { /* malformed drag data is ignored */ }
            }}
          >
            <h3>{day.date.slice(8)}</h3>
            <ul>
              {(placed.get(day.date) ?? []).map((card) => (
                <li key={card.id}>
                  <article
                    draggable={card.canReschedule && !busy}
                    onDragStart={(event) => {
                      if (!card.canReschedule) return;
                      event.dataTransfer.setData("text/plain", card.name);
                      event.dataTransfer.setData("application/x-holy-sheet-event", JSON.stringify({ recordId: card.id, version: card.version }));
                      event.dataTransfer.effectAllowed = "move";
                    }}
                  >
                    <h4>{card.name}{card.state === "archived" ? " · archived" : ""}</h4>
                    {onToggleSelect && (
                      <label className="record-check">
                        <input type="checkbox" checked={selectedIds?.includes(card.id) ?? false} aria-label={`Select ${card.name} for comparison`} onChange={() => onToggleSelect(card.id)} />
                      </label>
                    )}
                    <dl>
                      {calendar.fields.filter((field) => field.key !== "name").map((field) => (
                        <div key={field.key}>
                          <dt>{field.label}</dt>
                          <dd>{fieldText(field, card.values[field.key], card.references)}</dd>
                        </div>
                      ))}
                    </dl>
                    {card.calculated?.length ? (
                      <div aria-label="Calculated fields">
                        <p>Derived values are read-only.</p>
                        {card.calculated.map((item) => (
                          <p key={item.fieldKey}>{item.label}{item.sensitive ? " (sensitive)" : ""}: {calculatedText(item)} · read-only</p>
                        ))}
                      </div>
                    ) : null}
                    {card.canReschedule && (
                      <label>
                        Reschedule {card.name}{" "}
                        <input
                          type="date"
                          aria-label={`Reschedule ${card.name}`}
                          disabled={busy}
                          onChange={(event) => {
                            const next = event.target.value;
                            event.target.value = "";
                            if (next && next !== card.date) onReschedule(card, next);
                          }}
                        />
                      </label>
                    )}
                    <button type="button" disabled={busy} onClick={() => onOpen(card.id)}>Open</button>
                  </article>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {calendar.nextCursor && <button type="button" disabled={busy} onClick={onLoadMore}>Load more events</button>}
    </section>
  );
}
