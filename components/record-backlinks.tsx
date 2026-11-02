"use client";
import { useCallback, useEffect, useId, useRef, useState, type MouseEvent } from "react";
import {
  RECORD_BACKLINK_POLL_MS,
  acceptedMentionList,
  acceptedViewMentionList,
  type MentionList,
  type MentionSort,
  type ViewMentionList,
} from "../lib/record-backlink-client";
import styles from "./record-backlinks.module.css";

type Props = { workspaceId: string; tenantId: string; recordId: string; onNavigate?: (href: string) => void };

function mentionUrl(recordId: string, workspaceId: string, tenantId: string, options: { sort: MentionSort; order: "asc" | "desc"; spaceId: string; cursor: string; includeTrash: boolean; section?: "views"; open?: string }) {
  const params = new URLSearchParams({ workspaceId, tenantId, sort: options.sort, order: options.order });
  if (options.spaceId) params.set("space", options.spaceId);
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.includeTrash) params.set("includeTrash", "1");
  if (options.section) params.set("section", options.section);
  if (options.open) params.set("open", options.open);
  return `/api/records/${encodeURIComponent(recordId)}/backlinks?${params}`;
}

export default function RecordBacklinks({ workspaceId, tenantId, recordId, onNavigate }: Props) {
  const headingId = useId();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [sort, setSort] = useState<MentionSort>("edited");
  const [spaceId, setSpaceId] = useState("");
  const [cursor, setCursor] = useState("");
  const [includeTrash, setIncludeTrash] = useState(false);
  const [list, setList] = useState<MentionList | null>(null);
  const [views, setViews] = useState<ViewMentionList | null>(null);
  const [viewsOpen, setViewsOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const alive = useRef(true);
  const pending = useRef(false);
  const generation = useRef(0);
  const query = useRef({ sort, spaceId, cursor, includeTrash, viewsOpen });
  query.current = { sort, spaceId, cursor, includeTrash, viewsOpen };
  const order = sort === "title" ? "asc" : "desc";

  const load = useCallback(async (background = false) => {
    if (background && pending.current) return;
    const token = generation.current;
    const current = query.current;
    pending.current = true;
    try {
      const response = await fetch(mentionUrl(recordId, workspaceId, tenantId, { sort: current.sort, order: current.sort === "title" ? "asc" : "desc", spaceId: current.spaceId, cursor: current.cursor, includeTrash: current.includeTrash }), { credentials: "same-origin", cache: "no-store" });
      const payload: unknown = await response.json().catch(() => null);
      if (!alive.current || token !== generation.current) return;
      if (response.status === 404) {
        setList(null);
        setError("Record is restricted or unavailable.");
        return;
      }
      const accepted = acceptedMentionList(payload);
      if (!response.ok || !accepted) {
        if (!background) setError("Mentions are temporarily unavailable.");
        return;
      }
      setError("");
      setList(accepted);
      if (current.viewsOpen) {
        const viewResponse = await fetch(mentionUrl(recordId, workspaceId, tenantId, { sort: current.sort, order: current.sort === "title" ? "asc" : "desc", spaceId: "", cursor: "", includeTrash: false, section: "views" }), { credentials: "same-origin", cache: "no-store" });
        const viewPayload: unknown = await viewResponse.json().catch(() => null);
        if (alive.current && token === generation.current) setViews(acceptedViewMentionList(viewPayload));
      }
    } catch {
      if (alive.current && !background) setError("Mentions are temporarily unavailable.");
    } finally {
      pending.current = false;
    }
  }, [recordId, tenantId, workspaceId]);

  useEffect(() => {
    alive.current = true;
    generation.current += 1;
    if (!open) return;
    const media = typeof matchMedia === "function" ? matchMedia("(max-width: 480px)") : null;
    const applySheet = () => setSheet(Boolean(media?.matches));
    applySheet();
    media?.addEventListener?.("change", applySheet);
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(true); }, RECORD_BACKLINK_POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void load(true); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      media?.removeEventListener?.("change", applySheet);
    };
  }, [load, open, sort, spaceId, cursor, includeTrash]);

  async function openViews() {
    const next = !viewsOpen;
    setViewsOpen(next);
    if (!next) return;
    const response = await fetch(mentionUrl(recordId, workspaceId, tenantId, { sort, order, spaceId: "", cursor: "", includeTrash: false, section: "views" }), { credentials: "same-origin", cache: "no-store" });
    const payload: unknown = await response.json().catch(() => null);
    if (alive.current) setViews(acceptedViewMentionList(payload));
  }

  async function openItem(event: MouseEvent<HTMLAnchorElement>, pageId: string) {
    event.preventDefault();
    const response = await fetch(mentionUrl(recordId, workspaceId, tenantId, { sort, order, spaceId, cursor: "", includeTrash, open: pageId }), { credentials: "same-origin", cache: "no-store" });
    const payload = await response.json().catch(() => null) as { href?: string; error?: string } | null;
    if (!alive.current) return;
    if (!response.ok || !payload?.href) {
      setNotice(payload?.error || "Page is restricted or unavailable.");
      void load(true);
      return;
    }
    setNotice("");
    if (onNavigate) onNavigate(payload.href);
    else window.location.assign(payload.href);
  }

  const heading = list?.heading ?? "Mentioned in pages";
  if (!open) return <button type="button" aria-expanded={false} aria-controls={panelId} onClick={() => setOpen(true)}>Mentioned in pages</button>;
  return (
    <section id={panelId} className={styles.panel} data-layout={sheet ? "sheet" : "panel"} data-record-backlinks="" aria-labelledby={headingId}>
      <h2 id={headingId}>{heading}</h2>
      <div className={styles.controls}>
        <label>Sort
          <select aria-label="Sort mentions" value={sort} onChange={event => { setCursor(""); setSort(event.target.value === "title" ? "title" : "edited"); }}>
            <option value="edited">Last edited</option>
            <option value="title">Title</option>
          </select>
        </label>
        <label>Space
          <select aria-label="Filter by space" value={spaceId} onChange={event => { setCursor(""); setSpaceId(event.target.value); }}>
            <option value="">All spaces</option>
            {(list?.spaces ?? []).map(space => <option key={space.id} value={space.id}>{space.name}</option>)}
          </select>
        </label>
        {list?.canIncludeTrash && <label><input type="checkbox" checked={includeTrash} onChange={event => { setCursor(""); setIncludeTrash(event.target.checked); }} /> Include trash</label>}
      </div>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="alert">{notice}</p>}
      <ul className={styles.list}>
        {(list?.items ?? []).map(item => (
          <li key={item.pageId}>
            <a className={styles.item} href={item.href} onClick={event => void openItem(event, item.pageId)}>
              {item.referenceTypes.map(type => <span key={type} aria-hidden="true">{type === "chip" ? "▣" : type === "card" ? "▤" : "↗"} {type === "chip" ? "Chip" : type === "card" ? "Card" : "Link"}</span>)}
              <strong>{item.title}</strong>
              <span>{item.spaceName}</span>
              <span>{item.breadcrumb}</span>
              <p className={styles.snippet}>{item.snippet}</p>
              <time dateTime={item.editedAt}>{item.editedAtIst}</time>
              {item.trashLabel && <span>{item.trashLabel}</span>}
            </a>
          </li>
        ))}
      </ul>
      {list && !list.items.length && <p>No pages you can see mention this record.</p>}
      {list?.nextCursor && <button type="button" onClick={() => setCursor(list.nextCursor!)}>Next 20 pages</button>}
      {cursor && <button type="button" onClick={() => setCursor("")}>First page</button>}
      <button type="button" aria-expanded={viewsOpen} onClick={() => void openViews()}>Appears in view blocks</button>
      {viewsOpen && <ul aria-label="Appears in view blocks">
        {(views?.items ?? []).map(item => <li key={`${item.pageId}:${item.blockId}`}><a href={item.href}>{item.title}<span>{item.viewName}</span></a></li>)}
        {views && !views.items.length && <li>No view blocks you can see include this record.</li>}
      </ul>}
    </section>
  );
}
