"use client";
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useEffect, useId, useState } from "react";
import { Dialog } from "./dialog";
import { publishFindLabel } from "./extensions";
import { requestJson } from "./use-document-session";
import { planRecordRefBatches, purgeRecordRefKeys, recordReferenceSupported } from "../../lib/record-page-refs";

type FieldCell = { key: string; label: string; access: "visible"; value: string } | { key: string; label: string; access: "hidden" };
type RecordState = { status: "loading" } | { status: "error" } | { status: "restricted" } | { status: "archived" } | { status: "unsupported" } | { status: "visible"; title: string; collectionName: string; icon: string; href: string; updatedAt: string; fields: FieldCell[] };
type ViewState = { status: "loading" } | { status: "error" } | { status: "restricted" } | { status: "unsupported" } | { status: "visible"; collectionName: string; href: string; viewAllLabel: string; layout: "table" | "list"; columns: { key: string; label: string; access: "visible" | "hidden" }[]; rows: { id: string; href: string; name: string; cells: ({ access: "visible"; value: string } | { access: "hidden" })[] }[]; countLabel: string; emptyLabel: string | null; chips: string[]; updatedAt: string };
type Spec = { kind: "record"; blockId: string; recordId: string; collectionId: string; fields: string[] } | { kind: "view"; blockId: string; viewId: string; collectionId: string; layout: "table" | "list"; columns: string[]; limit: number };
type Listener = (state: RecordState | ViewState) => void;

const buses = new Map<string, { specs: Map<string, { spec: Spec; listener: Listener }>; cursor: string; accessRevision: string; timer: number | null; scheduled: number | null; stop?: () => void }>();

function purgeStoredValues() {
  const keys: string[] = [];
  try { for (let i = 0; i < sessionStorage.length; i++) { const key = sessionStorage.key(i); if (key) keys.push(key); } } catch { /* storage may be blocked */ }
  try { for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key) keys.push(key); } } catch { /* storage may be blocked */ }
  for (const key of purgeRecordRefKeys(keys)) {
    try { sessionStorage.removeItem(key); } catch { /* ignore */ }
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
  try { indexedDB.deleteDatabase("hs-record-ref"); } catch { /* ignore */ }
}

function busFor(pageId: string) {
  let bus = buses.get(pageId);
  if (!bus) {
    bus = { specs: new Map(), cursor: "0", accessRevision: "", timer: null, scheduled: null };
    buses.set(pageId, bus);
  }
  return bus;
}
function schedule(pageId: string) {
  const bus = busFor(pageId);
  if (bus.scheduled !== null) return;
  bus.scheduled = window.setTimeout(() => { bus.scheduled = null; void flush(pageId); }, 20);
}

async function post<T>(url: string, body: unknown) {
  return requestJson<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function flush(pageId: string) {
  const bus = buses.get(pageId);
  if (!bus) return;
  const specs = [...bus.specs.values()].map(item => item.spec);
  const records = specs.filter(item => item.kind === "record");
  const views = specs.filter(item => item.kind === "view");
  const plan = planRecordRefBatches(records.length, views.length);
  if (!plan.requests) return;
  const recordSpan = plan.recordSpan || records.length;
  const viewSpan = plan.viewSpan || views.length;
  for (let index = 0; index < plan.requests; index++) {
    const recordSlice = records.slice(index * recordSpan, (index + 1) * recordSpan);
    const viewSlice = views.slice(index * viewSpan, (index + 1) * viewSpan);
    if (!recordSlice.length && !viewSlice.length) continue;
    try {
      const data = await post<{ records: RecordState[]; views: ViewState[] }>(`/api/v1/pages/${encodeURIComponent(pageId)}/record-refs/resolve`, {
        records: recordSlice.map(item => ({ recordId: item.recordId, collectionId: item.collectionId, fields: item.fields })),
        views: viewSlice.map(item => ({ viewId: item.viewId, collectionId: item.collectionId, layout: item.layout, columns: item.columns, limit: item.limit })),
      });
      recordSlice.forEach((item, itemIndex) => deliver(pageId, item.blockId, data.records[itemIndex] ?? { status: "error" }));
      viewSlice.forEach((item, itemIndex) => deliver(pageId, item.blockId, data.views[itemIndex] ?? { status: "error" }));
    } catch (error) {
      const status = error instanceof Error && "status" in error && (error as { status: number }).status === 404 ? "restricted" : "error";
      if (status === "restricted") purgeStoredValues();
      for (const item of [...recordSlice, ...viewSlice]) deliver(pageId, item.blockId, { status });
    }
  }
  for (const item of [...records.slice(plan.requests * recordSpan), ...views.slice(plan.requests * viewSpan)]) deliver(pageId, item.blockId, { status: "error" });
}

function deliver(pageId: string, blockId: string, state: RecordState | ViewState) {
  const listener = buses.get(pageId)?.specs.get(blockId);
  if (state.status === "restricted") purgeStoredValues();
  listener?.listener(state);
}

async function watch(pageId: string) {
  const bus = buses.get(pageId);
  if (!bus || bus.specs.size === 0) return;
  const specs = [...bus.specs.values()].map(item => item.spec);
  try {
    const data = await post<{ cursor: string; changed: boolean; accessRevision: string }>(`/api/v1/pages/${encodeURIComponent(pageId)}/record-refs/changes`, {
      recordIds: [...new Set(specs.flatMap(item => item.kind === "record" ? [item.recordId] : []))],
      viewIds: [...new Set(specs.flatMap(item => item.kind === "view" ? [item.viewId] : []))],
      cursor: bus.cursor,
    });
    const revisionChanged = bus.accessRevision !== "" && data.accessRevision !== bus.accessRevision;
    const cursor = bus.cursor;
    bus.cursor = data.cursor;
    bus.accessRevision = data.accessRevision;
    if (data.changed || revisionChanged) {
      if (revisionChanged) purgeStoredValues();
      if (cursor !== "0" || data.changed) await flush(pageId);
    }
  } catch { /* The next focus or retry resolves again. */ }
}

function subscribe(pageId: string, spec: Spec, listener: Listener) {
  const bus = busFor(pageId);
  bus.specs.set(spec.blockId, { spec, listener });
  if (bus.timer === null) {
    const refresh = () => { if (document.visibilityState === "hidden") return; schedule(pageId); };
    bus.timer = window.setInterval(() => { void watch(pageId); }, 4000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("holy-sheet:sharing-changed", refresh);
    bus.stop = () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); window.removeEventListener("holy-sheet:sharing-changed", refresh); if (bus.timer !== null) window.clearInterval(bus.timer); };
  }
  schedule(pageId);
  return () => {
    bus.specs.delete(spec.blockId);
    if (!bus.specs.size) { bus.stop?.(); buses.delete(pageId); }
  };
}

function fresh(updatedAt: string) {
  const time = new Date(updatedAt).getTime();
  return Number.isFinite(time) && Date.now() - time < 60_000;
}

function masked(label: string) {
  return <span title="You don't have access to this field" aria-label={`${label}: You don't have access to this field`}>—</span>;
}

export function RecordRefBody({ state, display = "chip", notice = "", onRetry, onRequest, onRestore }: { state: RecordState; display?: "chip" | "card"; notice?: string; onRetry: () => void; onRequest: () => void; onRestore: () => void }) {
  if (state.status === "loading") return <p className="record-ref-placeholder" role="status" aria-busy="true">Loading record…</p>;
  if (state.status === "error") return <p className="record-ref-placeholder" role="alert">Couldn't load records — <button type="button" onClick={onRetry}>Retry</button></p>;
  if (state.status === "unsupported") return <p className="record-ref-placeholder">This block needs a newer Holy Sheet.</p>;
  if (state.status === "restricted") return <div className="record-ref-placeholder"><p>Restricted record</p><button type="button" onClick={onRequest}>Request access</button>{notice && <p role="status">{notice}</p>}</div>;
  if (state.status === "archived") return <div className="record-ref-placeholder"><p>Archived record — <button type="button" onClick={onRestore}>Restore</button></p></div>;
  if (display === "chip") return <a className="record-ref-chip" href={state.href}><span aria-hidden="true">{state.icon}</span> {state.title}</a>;
  return <article className="record-ref-card"><a href={state.href}><span aria-hidden="true">{state.icon}</span> {state.title}</a><dl>{state.fields.map(field => <div key={field.key}><dt>{field.label}</dt><dd>{field.access === "hidden" ? masked(field.label) : field.value || "—"}</dd></div>)}</dl>{fresh(state.updatedAt) && <p>Updated just now</p>}{notice && <p role="status">{notice}</p>}</article>;
}

export function RecordViewBody({ state, onRetry }: { state: ViewState; onRetry: () => void }) {
  if (state.status === "loading") return <p className="record-ref-placeholder" role="status" aria-busy="true">Loading record…</p>;
  if (state.status === "error") return <p className="record-ref-placeholder" role="alert">Couldn't load records — <button type="button" onClick={onRetry}>Retry</button></p>;
  if (state.status === "unsupported") return <p className="record-ref-placeholder">This block needs a newer Holy Sheet.</p>;
  if (state.status === "restricted") return <div className="record-ref-placeholder"><p>Restricted record</p></div>;
  const head = <tr>{state.columns.map(column => <th key={column.key} scope="col">{column.label}</th>)}</tr>;
  const body = state.rows.map(row => <tr key={row.id}>{row.cells.map((cell, index) => <td key={state.columns[index]?.key ?? index}>{cell.access === "hidden" ? masked(state.columns[index]?.label ?? "Field") : cell.value || "—"}</td>)}</tr>);
  return <section className="record-ref-view" aria-label={state.collectionName}>{!!state.chips.length && <ul aria-label="View filters and sorting">{state.chips.map(chip => <li key={chip}>{chip}</li>)}</ul>}{state.layout === "list" ? <ul>{state.rows.map(row => <li key={row.id}><a href={row.href}>{row.name}</a></li>)}</ul> : <div className="record-ref-scroll"><table><thead>{head}</thead><tbody>{body}</tbody></table></div>}{state.emptyLabel && <p>{state.emptyLabel}</p>}<p>{state.countLabel}</p><a href={state.href}>{state.viewAllLabel}</a>{fresh(state.updatedAt) && <p>Updated just now</p>}</section>;
}

function useLive<T extends RecordState | ViewState>(pageId: string, spec: Spec | null, empty: T) {
  const [state, setState] = useState<T>(empty);
  const key = spec ? JSON.stringify(spec) : "";
  useEffect(() => {
    if (!spec) return;
    setState({ status: "loading" } as T);
    return subscribe(pageId, spec, value => setState(value as T));
  }, [pageId, key]);
  return state;
}

function RecordRefView({ node, editor, extension }: NodeViewProps) {
  const pageId = String(extension.options.pageId ?? "");
  const supported = recordReferenceSupported(node.attrs.nodeVersion);
  const fields = Array.isArray(node.attrs.fields) ? node.attrs.fields.map(String) : [];
  const spec: Spec | null = supported ? { kind: "record", blockId: String(node.attrs.id), recordId: String(node.attrs.recordId ?? ""), collectionId: String(node.attrs.collectionId ?? ""), fields } : null;
  const state = useLive<RecordState>(pageId, spec, supported ? { status: "loading" } : { status: "unsupported" });
  const [notice, setNotice] = useState("");
  useEffect(() => { publishFindLabel(editor, node.attrs.id, state.status === "visible" ? state.title : ""); }, [editor, node.attrs.id, state]);
  async function requestAccess() {
    if (!spec || spec.kind !== "record") return;
    const result = await post<{ requestedAt: string }>(`/api/v1/pages/${encodeURIComponent(pageId)}/record-refs/access-requests`, { operationId: crypto.randomUUID(), recordId: spec.recordId });
    const when = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(result.requestedAt));
    setNotice(`Request sent · ${when} IST`);
  }
  async function restore() {
    if (!spec || spec.kind !== "record") return;
    await post(`/api/v1/pages/${encodeURIComponent(pageId)}/record-refs/restore`, { operationId: crypto.randomUUID(), recordId: spec.recordId });
    await flush(pageId);
  }
  return <NodeViewWrapper className="record-ref-block" contentEditable={false}><RecordRefBody state={supported ? state : { status: "unsupported" }} display={node.attrs.display === "card" ? "card" : "chip"} notice={notice} onRetry={() => { void flush(pageId); }} onRequest={() => { void requestAccess(); }} onRestore={() => { void restore(); }} /></NodeViewWrapper>;
}

function RecordViewNode({ node, editor, extension }: NodeViewProps) {
  const pageId = String(extension.options.pageId ?? "");
  const supported = recordReferenceSupported(node.attrs.nodeVersion);
  const columns = Array.isArray(node.attrs.columns) ? node.attrs.columns.map(String) : ["name"];
  const spec: Spec | null = supported ? { kind: "view", blockId: String(node.attrs.id), viewId: String(node.attrs.viewId ?? ""), collectionId: String(node.attrs.collectionId ?? ""), layout: node.attrs.layout === "list" ? "list" : "table", columns, limit: Number(node.attrs.limit ?? 10) } : null;
  const state = useLive<ViewState>(pageId, spec, supported ? { status: "loading" } : { status: "unsupported" });
  useEffect(() => { publishFindLabel(editor, node.attrs.id, state.status === "visible" ? state.collectionName : ""); }, [editor, node.attrs.id, state]);
  return <NodeViewWrapper className="record-ref-block" contentEditable={false}><RecordViewBody state={supported ? state : { status: "unsupported" }} onRetry={() => { void flush(pageId); }} /></NodeViewWrapper>;
}

export const RecordRef = Node.create({ name: "recordRef", addOptions() { return { pageId: "" }; }, group: "block", atom: true, draggable: true, addAttributes() { return { nodeVersion: { default: 1 }, recordId: { default: null }, collectionId: { default: null }, display: { default: "chip" }, fields: { default: [] } }; }, parseHTML: () => [{ tag: "div[data-hs-record-ref]" }], renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-hs-record-ref": "" })], addNodeView: () => ReactNodeViewRenderer(RecordRefView) });
export const RecordViewBlock = Node.create({ name: "recordView", addOptions() { return { pageId: "" }; }, group: "block", atom: true, draggable: true, addAttributes() { return { nodeVersion: { default: 1 }, viewId: { default: null }, collectionId: { default: null }, layout: { default: "table" }, columns: { default: ["name"] }, limit: { default: 10 } }; }, parseHTML: () => [{ tag: "div[data-hs-record-view]" }], renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, { "data-hs-record-view": "" })], addNodeView: () => ReactNodeViewRenderer(RecordViewNode) });

type Pick = { id: string; title: string; collectionId: string; collectionName: string; fields: { label: string; value: string }[]; catalogue: { key: string; label: string }[] };

export function RecordPickerDialog({ pageId, onClose, onInsert }: { pageId: string; onClose: () => void; onInsert: (node: { type: "recordRef"; attrs: Record<string, unknown> }) => void }) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [collection, setCollection] = useState("");
  const [collections, setCollections] = useState<{ id: string; name: string }[]>([]);
  const [results, setResults] = useState<Pick[]>([]);
  const [active, setActive] = useState(0);
  const [chosen, setChosen] = useState<Pick | null>(null);
  const [display, setDisplay] = useState<"chip" | "card">("chip");
  const [fields, setFields] = useState<string[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const handle = window.setTimeout(() => {
      const url = `/api/v1/pages/${encodeURIComponent(pageId)}/record-refs/picker?q=${encodeURIComponent(query)}${collection ? `&collection=${encodeURIComponent(collection)}` : ""}`;
      requestJson<{ collections: { id: string; name: string }[]; results: Pick[] }>(url).then(data => { setCollections(data.collections); setResults(data.results); setActive(0); setError(""); }).catch(() => setError("Records could not be loaded. Retry by changing the search."));
    }, 150);
    return () => window.clearTimeout(handle);
  }, [pageId, query, collection]);
  function choose(item: Pick) { setChosen(item); setFields(item.catalogue.slice(0, 3).map(field => field.key)); }
  function insert() {
    if (!chosen) return;
    onInsert({ type: "recordRef", attrs: { id: crypto.randomUUID(), nodeVersion: 1, recordId: chosen.id, collectionId: chosen.collectionId, display, fields: display === "card" ? fields : [] } });
  }
  return <Dialog title="Insert a record" onClose={onClose}><div className="record-picker"><label>Collection<select aria-label="Filter by collection" value={collection} onChange={event => { setCollection(event.target.value); setChosen(null); }}><option value="">All collections</option>{collections.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><input className="command-input" role="combobox" aria-label="Search records" aria-autocomplete="list" aria-expanded={results.length > 0} aria-controls={listId} aria-activedescendant={results[active] ? `${listId}-${results[active].id}` : undefined} value={query} onChange={event => { setQuery(event.target.value); setChosen(null); }} onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setActive(index => Math.min(results.length - 1, index + 1)); } if (event.key === "ArrowUp") { event.preventDefault(); setActive(index => Math.max(0, index - 1)); } if (event.key === "Enter" && results[active]) { event.preventDefault(); choose(results[active]); } }} placeholder="Search records" />{error && <p role="alert">{error}</p>}<div id={listId} role="listbox" aria-label="Records" className="insert-results">{results.map((item, index) => <button id={`${listId}-${item.id}`} role="option" aria-selected={index === active} key={item.id} onMouseEnter={() => setActive(index)} onClick={() => choose(item)}><strong>{item.title}</strong><small>{item.collectionName}{item.fields.map(field => ` · ${field.label}: ${field.value}`).join("")}</small></button>)}{query.trim().length >= 2 && !results.length && !error && <p>No records you can access match this search.</p>}</div>{chosen && <fieldset><legend>Display</legend><label><input type="radio" name="record-display" checked={display === "chip"} onChange={() => setDisplay("chip")} /> Inline chip</label><label><input type="radio" name="record-display" checked={display === "card"} onChange={() => setDisplay("card")} /> Card</label>{display === "card" && <div>{chosen.catalogue.map(field => <label key={field.key}><input type="checkbox" checked={fields.includes(field.key)} onChange={event => setFields(current => event.target.checked ? [...current, field.key].slice(0, 12) : current.filter(key => key !== field.key))} /> {field.label}</label>)}</div>}<button type="button" className="primary" onClick={insert}>Insert record</button></fieldset>}</div></Dialog>;
}

export function RecordViewPickerDialog({ pageId, onClose, onInsert }: { pageId: string; onClose: () => void; onInsert: (node: { type: "recordView"; attrs: Record<string, unknown> }) => void }) {
  const [views, setViews] = useState<{ id: string; name: string; collection: string; collection_name: string }[]>([]);
  const [viewId, setViewId] = useState("");
  const [layout, setLayout] = useState<"table" | "list">("table");
  const [columns, setColumns] = useState<string[]>(["name"]);
  const [limit, setLimit] = useState(10);
  const [catalogue, setCatalogue] = useState<{ key: string; label: string }[]>([{ key: "name", label: "Name" }]);
  const [error, setError] = useState("");
  useEffect(() => { requestJson<{ views: { id: string; name: string; collection: string; collection_name: string }[] }>(`/api/v1/pages/${encodeURIComponent(pageId)}/record-refs/picker?views=1`).then(data => setViews(data.views)).catch(() => setError("Saved views could not be loaded.")); }, [pageId]);
  const selected = views.find(view => view.id === viewId);
  useEffect(() => {
    if (!selected) return;
    requestJson<{ results: Pick[] }>(`/api/v1/pages/${encodeURIComponent(pageId)}/record-refs/picker?q=${encodeURIComponent(selected.name)}&collection=${encodeURIComponent(selected.collection)}`).then(data => { const fields = data.results.find(item => item.collectionId === selected.collection)?.catalogue ?? []; setCatalogue([{ key: "name", label: "Name" }, ...fields.filter(field => field.key !== "name")]); }).catch(() => setCatalogue([{ key: "name", label: "Name" }]));
  }, [pageId, selected?.id]);
  function insert() {
    if (!selected) return;
    onInsert({ type: "recordView", attrs: { id: crypto.randomUUID(), nodeVersion: 1, viewId: selected.id, collectionId: selected.collection, layout, columns: columns.length ? columns : ["name"], limit } });
  }
  return <Dialog title="Insert a records view" onClose={onClose}><div className="record-picker">{error && <p role="alert">{error}</p>}<label>Saved view<select aria-label="Saved view" value={viewId} onChange={event => setViewId(event.target.value)}><option value="">Choose a view</option>{views.map(view => <option key={view.id} value={view.id}>{view.name}</option>)}</select></label><label>Layout<select aria-label="View layout" value={layout} onChange={event => setLayout(event.target.value === "list" ? "list" : "table")}><option value="table">Table</option><option value="list">List</option></select></label><fieldset><legend>Columns</legend>{catalogue.map(field => <label key={field.key}><input type="checkbox" checked={columns.includes(field.key)} onChange={event => setColumns(current => event.target.checked ? [...current, field.key].slice(0, 12) : current.filter(key => key !== field.key))} /> {field.label}</label>)}</fieldset><label>Limit<input aria-label="Row limit" type="number" min={1} max={25} value={limit} onChange={event => setLimit(Math.min(25, Math.max(1, Number(event.target.value) || 1)))} /></label><button type="button" className="primary" disabled={!selected} onClick={insert}>Insert view</button></div></Dialog>;
}
