"use client";

export type BoardCard = {
  id: string;
  name: string;
  state: string;
  version: number;
  canMove: boolean;
  values: Record<string, unknown>;
  calculated?: { fieldKey: string; label: string; value: unknown; sensitive: boolean; stale: boolean; readOnly: true; error?: string }[];
};
export type BoardColumnModel = {
  key: string;
  kind: "choice" | "unassigned";
  value: string | null;
  label: string;
  acceptsCards: boolean;
  cards: BoardCard[];
  nextCursor: string | null;
};
export type BoardFieldModel = { key: string; label: string; kind: string; choices?: { id: string; label: string }[] };
export type BoardModel = { schemaVersion: number; groupLabel: string; fields: BoardFieldModel[]; columns: BoardColumnModel[] };

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

function textValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return "—";
  return String(value);
}

function fieldText(field: BoardFieldModel, value: unknown) {
  if (field.kind === "single-select" || field.choices) {
    if (Array.isArray(value)) {
      const labels = value.filter((item): item is string => typeof item === "string").map((item) => field.choices?.find((choice) => choice.id === item)?.label ?? "Unavailable choice");
      return labels.length ? labels.join(", ") : "—";
    }
    if (typeof value !== "string" || !value) return "—";
    return field.choices?.find((choice) => choice.id === value)?.label ?? "Unavailable choice";
  }
  return textValue(value);
}

function calculatedText(row: NonNullable<BoardCard["calculated"]>[number]) {
  if (row.stale) return row.error === "formula_divide_by_zero" ? "Division by zero has no value." : "Unavailable";
  return textValue(row.value);
}

export function acceptedBoard(body: unknown): BoardModel | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.groupLabel !== "string" || !record.groupLabel || typeof record.schemaVersion !== "number" || !Array.isArray(record.columns) || !Array.isArray(record.fields)) return null;
  if ("count" in record || "total" in record || "hiddenCount" in record) return null;
  const fields: BoardFieldModel[] = [];
  for (const item of record.fields) {
    if (!item || typeof item !== "object") return null;
    const field = item as Record<string, unknown>;
    if (typeof field.key !== "string" || typeof field.label !== "string" || typeof field.kind !== "string") return null;
    const choices = field.choices === undefined ? undefined : choiceList(field.choices);
    if (field.choices !== undefined && !choices) return null;
    fields.push({ key: field.key, label: field.label, kind: field.kind, ...(choices ? { choices } : {}) });
  }
  const columns: BoardColumnModel[] = [];
  for (const item of record.columns) {
    if (!item || typeof item !== "object") return null;
    const column = item as Record<string, unknown>;
    if ("count" in column || "total" in column || "hiddenCount" in column) return null;
    if (typeof column.key !== "string" || (column.kind !== "choice" && column.kind !== "unassigned") || typeof column.label !== "string" || typeof column.acceptsCards !== "boolean" || !Array.isArray(column.cards)) return null;
    if (column.nextCursor !== null && typeof column.nextCursor !== "string") return null;
    if (column.kind === "choice" && typeof column.value !== "string") return null;
    if (column.kind === "unassigned" && column.value !== null) return null;
    const cards: BoardCard[] = [];
    for (const card of column.cards) {
      if (!card || typeof card !== "object") return null;
      const row = card as Record<string, unknown>;
      if (typeof row.id !== "string" || typeof row.name !== "string" || typeof row.state !== "string" || typeof row.version !== "number" || typeof row.canMove !== "boolean" || !row.values || typeof row.values !== "object" || Array.isArray(row.values)) return null;
      const calculated: BoardCard["calculated"] = [];
      if (row.calculated !== undefined) {
        if (!Array.isArray(row.calculated)) return null;
        for (const derived of row.calculated) {
          if (!derived || typeof derived !== "object") return null;
          const item = derived as Record<string, unknown>;
          if (typeof item.fieldKey !== "string" || typeof item.label !== "string" || typeof item.sensitive !== "boolean" || typeof item.stale !== "boolean" || item.readOnly !== true) return null;
          calculated.push({ fieldKey: item.fieldKey, label: item.label, value: item.value, sensitive: item.sensitive, stale: item.stale, readOnly: true, ...(typeof item.error === "string" ? { error: item.error } : {}) });
        }
      }
      cards.push({ id: row.id, name: row.name, state: row.state, version: row.version, canMove: row.canMove, values: row.values as Record<string, unknown>, ...(calculated.length ? { calculated } : {}) });
    }
    columns.push({ key: column.key, kind: column.kind, value: column.kind === "choice" ? column.value as string : null, label: column.label, acceptsCards: column.acceptsCards, cards, nextCursor: column.nextCursor ?? null });
  }
  return { schemaVersion: record.schemaVersion, groupLabel: record.groupLabel, fields, columns };
}

export default function RecordBoard({
  board,
  busy,
  onOpen,
  onMove,
  onLoadMore,
  selectedIds,
  onToggleSelect,
}: {
  board: BoardModel;
  busy: boolean;
  onOpen: (id: string) => void;
  onMove: (card: BoardCard, column: BoardColumnModel) => void;
  onLoadMore: (column: BoardColumnModel) => void;
  selectedIds?: string[];
  onToggleSelect?: (id: string) => void;
}) {
  const cards = board.columns.flatMap((column) => column.cards);
  return (
    <section aria-label="Record board" className="record-board-screen">
      <h2>Grouped by {board.groupLabel}</h2>
      <p>Columns are the current choices. Calculated values stay read-only. A move uses the same record update rules as editing the field.</p>
      <div className="record-board">
        {board.columns.map((column) => (
          <section
            key={column.key}
            aria-label={column.label}
            className="record-board-column"
            onDragOver={(event) => { if (column.acceptsCards) event.preventDefault(); }}
            onDrop={(event) => {
              event.preventDefault();
              if (!column.acceptsCards || busy) return;
              const raw = event.dataTransfer.getData("application/x-holy-sheet-card");
              if (!raw) return;
              try {
                const parsed = JSON.parse(raw) as { recordId?: string; version?: number };
                const card = cards.find((item) => item.id === parsed.recordId && item.version === parsed.version);
                if (card?.canMove) onMove(card, column);
              } catch { /* malformed drag data is ignored */ }
            }}
          >
            <h3>{column.label}</h3>
            <ul>
              {column.cards.map((card) => (
                <li key={card.id}>
                  <article
                    draggable={card.canMove && !busy}
                    onDragStart={(event) => {
                      if (!card.canMove) return;
                      event.dataTransfer.setData("text/plain", card.name);
                      event.dataTransfer.setData("application/x-holy-sheet-card", JSON.stringify({ recordId: card.id, version: card.version }));
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
                      {board.fields.filter((field) => field.key !== "name").map((field) => (
                        <div key={field.key}>
                          <dt>{field.label}</dt>
                          <dd>{fieldText(field, card.values[field.key])}</dd>
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
                    {card.canMove && (
                      <label>
                        Move {card.name}{" "}
                        <select
                          aria-label={`Move ${card.name}`}
                          value=""
                          disabled={busy}
                          onChange={(event) => {
                            const next = board.columns.find((item) => item.key === event.target.value);
                            event.target.value = "";
                            if (next) onMove(card, next);
                          }}
                        >
                          <option value="">Choose column</option>
                          {board.columns.filter((item) => item.acceptsCards && item.key !== column.key).map((item) => (
                            <option key={item.key} value={item.key}>{item.label}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    <button type="button" disabled={busy} onClick={() => onOpen(card.id)}>Open</button>
                  </article>
                </li>
              ))}
            </ul>
            {column.nextCursor && <button type="button" disabled={busy} onClick={() => onLoadMore(column)}>Load more in {column.label}</button>}
          </section>
        ))}
      </div>
    </section>
  );
}
