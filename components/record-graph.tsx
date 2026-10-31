"use client";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { acceptedRecordGraph, type RecordGraph, type RecordGraphEdge, type RecordGraphNode } from "../lib/record-graph-contract";

const kindLabel: Record<string, string> = {
  "contact-account": "Contact account",
  "employee-account": "Employee account",
  "contract-legal-party": "Legal organisation",
  "contract-account": "Covered account",
  "parent-organisation": "Parent organisation",
  "record-field": "Record field",
  document: "Linked document",
};

export default function RecordGraph({
  workspaceId,
  tenantId,
  recordId,
  version,
  onOpenRecord,
}: {
  workspaceId: string;
  tenantId: string;
  recordId: string;
  version: number;
  onOpenRecord?: (recordId: string) => void;
}) {
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/records/${encodeURIComponent(recordId)}/graph`;
  const [open, setOpen] = useState(false);
  const [graph, setGraph] = useState<RecordGraph | null>(null);
  const [active, setActive] = useState("");
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const openButton = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);

  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setBusy(true);
    setDenied(false);
    setError("");
    void (async () => {
      try {
        const response = await fetch(root, { credentials: "same-origin", cache: "no-store", signal: abort.signal });
        const payload = await response.json();
        if (abort.signal.aborted) return;
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          setDenied(true);
          setGraph(null);
          return;
        }
        const next = acceptedRecordGraph(payload);
        if (!response.ok || !next) {
          setError("The relationship graph is temporarily unavailable.");
          return;
        }
        setNotice(graph ? "Relationship graph updated." : "");
        setGraph(next);
        setActive((current) => (next.nodes.some((node) => node.id === current) ? current : next.focalId));
      } catch {
        if (!abort.signal.aborted) setError("The relationship graph is temporarily unavailable.");
      } finally {
        if (!abort.signal.aborted) setBusy(false);
      }
    })();
    return () => abort.abort();
  }, [open, reload, root, version]);

  useEffect(() => {
    if (!moveFocus.current || !active) return;
    moveFocus.current = false;
    document.getElementById(`graph-node-${active}`)?.focus();
  }, [active, graph]);

  function show() {
    moveFocus.current = true;
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setGraph(null);
    setNotice("");
    requestAnimationFrame(() => openButton.current?.focus());
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!graph) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    const index = Math.max(0, graph.nodes.findIndex((node) => node.id === active));
    const last = graph.nodes.length - 1;
    let next = index;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else return;
    event.preventDefault();
    moveFocus.current = true;
    setActive(graph.nodes[next].id);
  }

  const selected = graph?.nodes.find((node) => node.id === active) ?? null;
  const connections = graph && selected ? graph.edges.filter((edge) => edge.fromId === selected.id || edge.toId === selected.id) : [];

  return (
    <section aria-label="Relationship graph" className="record-graph">
      <h3>Relationship graph</h3>
      <p>Records, fields and documents you can view. Hidden records are left out of this graph. Archived records stay visible. Trash removes a record and its edges.</p>
      {!open ? (
        <button ref={openButton} type="button" onClick={show}>Open relationship graph</button>
      ) : (
        <div className="record-graph-toolbar">
          <button ref={openButton} type="button" disabled={busy} onClick={() => setReload((value) => value + 1)}>Refresh graph</button>
          <button type="button" onClick={close}>Close graph</button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {denied && <p role="alert">This relationship graph is not available with your current access.</p>}
      {graph && (
        <>
          {graph.limited && <p>Showing the first set of relationships you can view.</p>}
          <div role="listbox" aria-label="Relationship graph nodes" aria-activedescendant={active ? `graph-node-${active}` : undefined} onKeyDown={onKeyDown}>
            {graph.nodes.map((node) => (
              <button key={node.id} id={`graph-node-${node.id}`} type="button" role="option" aria-selected={node.id === active} tabIndex={node.id === active ? 0 : -1} onClick={() => { moveFocus.current = true; setActive(node.id); }}>
                {nodeText(node)}
              </button>
            ))}
          </div>
          {selected && (
            <div aria-live="polite" aria-label="Connections for the selected record">
              <h4>{selected.label}</h4>
              {connections.length ? (
                <ul>
                  {connections.map((edge) => (
                    <li key={edge.id}>{connectionText(edge, graph, selected.id)}</li>
                  ))}
                </ul>
              ) : (
                <p>No visible relationships.</p>
              )}
              {selected.kind === "record" && selected.id !== graph.focalId && onOpenRecord && (
                <button type="button" onClick={() => onOpenRecord(selected.id)}>Open record</button>
              )}
              {selected.kind === "document" && selected.pageId && <a href={`/pages/${encodeURIComponent(selected.pageId)}`}>Open document</a>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function nodeText(node: RecordGraphNode) {
  const kind = node.kind === "document" ? "Document" : node.collection;
  const archived = node.state === "archived" ? ", archived" : "";
  return `${node.label}${kind ? `, ${kind}` : ""}${archived}`;
}

function connectionText(edge: RecordGraphEdge, graph: RecordGraph, activeId: string) {
  const otherId = edge.fromId === activeId ? edge.toId : edge.fromId;
  const other = graph.nodes.find((node) => node.id === otherId);
  const name = other?.label ?? "Related record";
  const direction = edge.fromId === activeId ? `Links to ${name}` : `${name} links here`;
  const parts = [direction, kindLabel[edge.kind] ?? "Relationship"];
  if (edge.fieldLabel) parts.push(edge.fieldLabel);
  if (edge.role) parts.push(edge.role);
  if (edge.primary) parts.push("primary");
  if (edge.status) parts.push(edge.status);
  if (other?.state === "archived") parts.push("archived");
  return parts.join(", ");
}
