"use client";
import { useEffect, useId, useState } from "react";
import { requestJson } from "./editor/use-document-session";
import { enqueuePageRead, pageReadDepth } from "../lib/page-read-queue";
import {
  BREADCRUMB_MOBILE_QUERY,
  BREADCRUMB_REFRESH_MS,
  BREADCRUMB_SIBLING_LIMIT,
  BREADCRUMB_UNAVAILABLE,
  presentTrail,
  type BreadcrumbReadable,
  type BreadcrumbSegment,
  type BreadcrumbView,
} from "../lib/breadcrumb-model";
import UiIcon from "./ui-icon";

function mobileNow() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(BREADCRUMB_MOBILE_QUERY).matches;
}

function useMobile() {
  const [mobile, setMobile] = useState(mobileNow);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(BREADCRUMB_MOBILE_QUERY);
    const apply = () => setMobile(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
  return mobile;
}

function CrumbLink({ segment, onOpenPage, onOpenHref, children }: { segment: BreadcrumbReadable; onOpenPage?: (id: string) => void; onOpenHref?: (href: string) => void; children?: string }) {
  return <a className="breadcrumb-link" href={segment.href} onClick={event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    if (segment.kind === "page" && onOpenPage) { event.preventDefault(); onOpenPage(segment.id); return; }
    if (segment.kind === "space" && onOpenHref) { event.preventDefault(); onOpenHref(segment.href); }
  }}>{children ?? segment.title}</a>;
}

function SiblingMenu({ segment, open, onToggle, onOpenPage, onOpenHref, onShowAll }: { segment: BreadcrumbReadable; open: boolean; onToggle: () => void; onOpenPage?: (id: string) => void; onOpenHref?: (href: string) => void; onShowAll: () => void }) {
  const menuId = useId();
  if (!segment.siblings.length && !segment.siblingsTruncated) return null;
  const siblings = segment.siblings.slice(0, segment.siblingsTruncated ? BREADCRUMB_SIBLING_LIMIT : undefined);
  return <>
    <button type="button" className="breadcrumb-chevron" aria-label={`Show sibling pages for ${segment.title}`} aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={onToggle}>▾</button>
    {open && <ul className="breadcrumb-menu" id={menuId}>
      {siblings.map(sibling => <li key={sibling.id}><a href={sibling.href} onClick={event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        if (segment.kind === "space" && onOpenHref) { event.preventDefault(); onOpenHref(sibling.href); }
        if (segment.kind === "page" && onOpenPage) { event.preventDefault(); onOpenPage(sibling.id); }
      }}>{sibling.title}</a></li>)}
      {!siblings.length && <li><span className="breadcrumb-empty">No other pages</span></li>}
      {segment.siblingsTruncated && <li><button type="button" onClick={onShowAll}>Show all</button></li>}
    </ul>}
  </>;
}

export default function BreadcrumbNav({ workspaceId, pageId, onOpenPage, onOpenHref }: { workspaceId: string; pageId: string; onOpenPage?: (id: string) => void; onOpenHref?: (href: string) => void }) {
  const mobile = useMobile();
  const [view, setView] = useState<BreadcrumbView | null>(null);
  const [failed, setFailed] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const [expandedSibling, setExpandedSibling] = useState<string | null>(null);
  const collapseId = useId();
  useEffect(() => {
    let live = true;
    const params = new URLSearchParams();
    if (expandedSibling) { params.set("siblingsOf", expandedSibling); params.set("all", "1"); }
    const query = params.toString();
    const url = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/pages/${encodeURIComponent(pageId)}/ancestry${query ? `?${query}` : ""}`;
    const load = () => enqueuePageRead(async () => {
      try {
        const next = await requestJson<BreadcrumbView>(url);
        if (!live) return;
        setView(next);
        setFailed("");
      } catch (error) {
        if (!live) return;
        setView(null);
        setFailed(error instanceof Error && error.message ? error.message : BREADCRUMB_UNAVAILABLE);
      }
    });
    void load();
    const timer = setInterval(() => { if (document.visibilityState === "hidden" || pageReadDepth() > 0) return; void load(); }, BREADCRUMB_REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === "visible" && pageReadDepth() === 0) void load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { live = false; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [workspaceId, pageId, expandedSibling]);
  useEffect(() => { setMenu(null); }, [view?.state, view?.state === "ready" ? view.treeVersion : 0, mobile]);

  const presentation = view?.state === "ready" ? presentTrail(view.segments, mobile) : null;
  const toggle = (key: string) => setMenu(current => current === key ? null : key);
  const showAll = (id: string) => { setExpandedSibling(id); setMenu(`siblings:${id}`); };
  return <nav className="breadcrumbs" aria-label="Breadcrumb" data-layout={mobile ? "mobile" : "desktop"} aria-busy={view || failed ? undefined : true} onKeyDown={event => { if (event.key === "Escape" && menu) { event.preventDefault(); event.stopPropagation(); setMenu(null); } }}>
    <UiIcon name="folder"/>
    {failed && !view && <span className="breadcrumb-state" role="status">{failed}</span>}
    {!failed && !view && <span className="breadcrumb-state" role="status">Opening location…</span>}
    {view?.state === "trash" && <span className="breadcrumb-state" role="status">{view.message}</span>}
    {presentation?.layout === "back" && <Back parent={presentation.parent} onOpenPage={onOpenPage} onOpenHref={onOpenHref}/>}
    {presentation?.layout === "trail" && <ol className="breadcrumb-trail">
      {presentation.items.map((item, index) => {
        const separator = index > 0 ? <span className="breadcrumb-sep" aria-hidden="true">›</span> : null;
        if (item.type === "hidden") return <li key={`hidden-${index}`}>{separator}<span className="breadcrumb-hidden">…</span></li>;
        if (item.type === "collapsed") return <li key="collapsed">{separator}
          <button type="button" className="breadcrumb-collapse" aria-label="Show middle pages" aria-expanded={menu === "collapsed"} aria-controls={menu === "collapsed" ? collapseId : undefined} onClick={() => toggle("collapsed")}>…</button>
          {menu === "collapsed" && <ul className="breadcrumb-menu" id={collapseId}>
            {item.segments.map(segment => <li key={segment.id}><CrumbLink segment={segment} onOpenPage={onOpenPage} onOpenHref={onOpenHref}/></li>)}
            {!item.segments.length && <li><span className="breadcrumb-hidden">…</span></li>}
          </ul>}
        </li>;
        const segment = item.segment;
        return <li key={segment.id}>{separator}
          {segment.current ? <span className="breadcrumb-current" aria-current="page">{segment.title}</span> : <CrumbLink segment={segment} onOpenPage={onOpenPage} onOpenHref={onOpenHref}/>}
          <SiblingMenu segment={segment} open={menu === `siblings:${segment.id}`} onToggle={() => toggle(`siblings:${segment.id}`)} onOpenPage={onOpenPage} onOpenHref={onOpenHref} onShowAll={() => showAll(segment.id)}/>
        </li>;
      })}
    </ol>}
  </nav>;
}

function Back({ parent, onOpenPage, onOpenHref }: { parent: BreadcrumbSegment | null; onOpenPage?: (id: string) => void; onOpenHref?: (href: string) => void }) {
  if (!parent || !parent.readable) return <span className="breadcrumb-back">‹ <span className="breadcrumb-hidden">…</span></span>;
  return <a className="breadcrumb-back" href={parent.href} aria-label={`Back to ${parent.title}`} onClick={event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    if (parent.kind === "page" && onOpenPage) { event.preventDefault(); onOpenPage(parent.id); }
    if (parent.kind === "space" && onOpenHref) { event.preventDefault(); onOpenHref(parent.href); }
  }}>‹ {parent.title}</a>;
}

/** Open-page failure. Trash is shown only when this reader may know; every other failure keeps the caller's neutral message. */
export function PageUnavailable({ pageId, message, authRequired }: { pageId: string; message: string; authRequired?: boolean }) {
  const [text, setText] = useState(message);
  useEffect(() => {
    if (!message || authRequired) { setText(message); return; }
    let live = true;
    setText("");
    void requestJson<BreadcrumbView>(`/api/v1/pages/${encodeURIComponent(pageId)}/ancestry`).then(result => {
      if (!live) return;
      setText(result.state === "trash" ? result.message : message);
    }).catch(() => { if (live) setText(message); });
    return () => { live = false; };
  }, [pageId, message, authRequired]);
  if (!message) return <>Opening your page…</>;
  return <span className="breadcrumb-state" role="status">{text || "Opening your page…"}</span>;
}
