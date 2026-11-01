"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog } from "./editor/dialog";
import { ApiError, requestJson } from "./editor/use-document-session";
import { languageChoices } from "../lib/document-variant-copy";
import type { VariantView } from "../lib/document-variants";

type Placement = "document" | "sidebar";

export function VariantSwitcher({ items, onOpen }: { items?: VariantView["switcher"] | null; onOpen: (pageId: string) => void }) {
  const languages = items ?? [];
  if (!languages.length) return null;
  return <nav className="variant-switcher" aria-label="Document language">{languages.map((item, index) => <span key={item.pageId}>{index > 0 && <span aria-hidden="true"> | </span>}{item.current ? <span aria-current="true">{item.label}</span> : <a className="variant-switcher-link" href={`/pages/${encodeURIComponent(item.pageId)}`} onClick={event => { event.preventDefault(); onOpen(item.pageId); }}>{item.label}</a>}</span>)}</nav>;
}

export function VariantChrome({ view, placement, onOpen, onChoose, onMark, onDiff }: {
  view: VariantView;
  placement: Placement;
  onOpen: (pageId: string) => void;
  onChoose?: (choice: string) => void;
  onMark?: () => void;
  onDiff?: () => void;
}) {
  if (placement === "sidebar") return <VariantSwitcher items={view.switcher} onOpen={onOpen} />;
  return <div className="document-variants">
    <VariantSwitcher items={view.switcher} onOpen={onOpen} />
    {view.banner && <div className="variant-offer" role="status"><p>{view.banner.message}</p><p className="variant-actions"><a className="variant-switcher-link" href={`/pages/${encodeURIComponent(view.banner.pageId)}`} onClick={event => { event.preventDefault(); onChoose?.(view.banner!.language); onOpen(view.banner!.pageId); }}>{`Open ${view.banner.label}`}</a><button type="button" onClick={() => onChoose?.("source")}>{view.banner.stayLabel}</button></p></div>}
    {view.stale && <p className="variant-stale-badge" role="status">{view.stale.badge}{view.stale.diffHref && <> <a className="variant-diff-link" href={view.stale.diffHref} onClick={event => { event.preventDefault(); onDiff?.(); }}>Compare source</a></>}</p>}
    {view.canMarkSynced && view.stale && <p className="variant-actions"><button type="button" onClick={() => onMark?.()}>{`Mark up to date with v${view.stale.sourceVersion}`}</button></p>}
    {(view.trashNotes ?? []).map(note => <p key={note.label} className="variant-trash-note" role="status">{`${note.label} ${note.message}`}</p>)}
  </div>;
}

export function VariantHost({ pageId, workspaceId, placement, onOpen }: { pageId: string; workspaceId: string; placement: Placement; onOpen: (pageId: string) => void }) {
  const [view, setView] = useState<VariantView | null>(null);
  const [open, setOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffText, setDiffText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pages, setPages] = useState<{ id: string; title: string; workspaceId: string }[]>([]);
  const [sourceLanguage, setSourceLanguage] = useState("en");
  const [variantLanguage, setVariantLanguage] = useState("hi");
  const [variantPageId, setVariantPageId] = useState("");
  const pending = useRef<{ id: string; body: string } | null>(null);
  const redirected = useRef("");
  const load = async () => {
    const data = await requestJson<VariantView>(`/api/v1/pages/${encodeURIComponent(pageId)}/variants`);
    setView(data);
    setError("");
    return data;
  };
  useEffect(() => {
    let alive = true;
    const refresh = () => { void requestJson<VariantView>(`/api/v1/pages/${encodeURIComponent(pageId)}/variants`).then(data => { if (alive) setView(data); }).catch((reason: unknown) => { if (!alive) return; if (reason instanceof ApiError && reason.status === 404) setView(null); }); };
    refresh();
    const timer = window.setInterval(refresh, 4000);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [pageId]);
  useEffect(() => {
    if (placement !== "document" || !view?.redirectTo) return;
    const key = `${pageId}:${view.redirectTo.pageId}`;
    if (redirected.current === key) return;
    redirected.current = key;
    onOpen(view.redirectTo.pageId);
    if (!view.redirectTo.remember) return;
    void requestJson(`/api/v1/pages/${encodeURIComponent(pageId)}/variants`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "choose", choice: view.redirectTo.language, operationId: crypto.randomUUID() }) }).catch(() => undefined);
  }, [placement, pageId, view, onOpen]);
  function operationId(body: string) {
    if (pending.current?.body === body) return pending.current.id;
    const id = crypto.randomUUID();
    pending.current = { id, body };
    return id;
  }
  async function post(url: string, fields: Record<string, unknown>, close = false) {
    const payload = JSON.stringify(fields);
    setBusy(true);
    setError("");
    try {
      await requestJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...fields, operationId: operationId(payload) }) });
      pending.current = null;
      await load();
      if (close) setOpen(false);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Language variants are unavailable.");
    } finally {
      setBusy(false);
    }
  }
  async function openDialog() {
    setError("");
    setOpen(true);
    try {
      const data = await requestJson<{ pages: { id: string; title: string; workspaceId: string }[] }>("/api/pages");
      const choices = data.pages.filter(item => item.workspaceId === workspaceId && item.id !== pageId).sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
      setPages(choices);
      setVariantPageId(current => current || choices[0]?.id || "");
    } catch (reason) {
      setPages([]);
      setError(reason instanceof ApiError ? reason.message : "Pages are restricted or unavailable.");
    }
  }
  async function openDiff() {
    if (!view?.stale?.diffHref) return;
    const match = /variantDiff=(\d+)-(\d+)/.exec(view.stale.diffHref);
    if (!match) return;
    setDiffOpen(true);
    setDiffText("Comparing published versions…");
    try {
      const data = await requestJson<{ added: string[]; removedCount: number }>(`/api/v1/pages/${encodeURIComponent(pageId)}/variants/diff?from=${match[1]}&to=${match[2]}`);
      setDiffText(data.added.length ? data.added.join("\n") : data.removedCount ? "Published text was removed between these versions." : "No published text changes between these versions.");
    } catch (reason) {
      setDiffText(reason instanceof ApiError ? reason.message : "Comparison is unavailable.");
    }
  }
  if (placement === "sidebar") return view ? <VariantChrome view={view} placement="sidebar" onOpen={onOpen} /> : null;
  if (!view) return null;
  const grouped = view.sourceLanguage != null;
  return <>
    <VariantChrome view={view} placement="document" onOpen={onOpen} onChoose={choice => void post(`/api/v1/pages/${encodeURIComponent(pageId)}/variants`, { action: "choose", choice })} onMark={() => void post(`/api/v1/pages/${encodeURIComponent(pageId)}/variants`, { action: "mark-synced" })} onDiff={() => void openDiff()} />
    {grouped && <p className="variant-actions"><label>Reading language <select aria-label="Reading language" value={view.profileLanguage ?? ""} onChange={event => void post("/api/v1/profile/language", { language: event.target.value || null })}><option value="">No preference</option>{languageChoices.map(language => <option key={language.tag} value={language.tag}>{language.name}</option>)}</select></label></p>}
    {(view.canLink || view.canSetRouting) && <p className="variant-actions"><button type="button" onClick={() => void openDialog()}>Language variants</button></p>}
    {open && <Dialog title="Language variants" onClose={() => { if (!busy) setOpen(false); }}><form className="variant-dialog" onSubmit={event => { event.preventDefault(); void post(`/api/v1/pages/${encodeURIComponent(pageId)}/variants`, { action: "link", variantPageId, variantLanguage, ...(view.sourceLanguage ? {} : { sourceLanguage }) }, true); }}>
      <p>Link another page as a language variant of this document. Each language is a separate page. Machine translation is not part of this step.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {view.canSetRouting && <label>Reader routing <select aria-label="Reader language routing" value={view.routing} onChange={event => void post(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/variant-routing`, { routing: event.target.value })}><option value="banner">Offer a banner</option><option value="auto">Open their language</option></select></label>}
      {view.canLink && <>
        <label>Source language <input aria-label="Source language" list="variant-language-codes" value={view.sourceLanguage ?? sourceLanguage} disabled={Boolean(view.sourceLanguage)} onChange={event => setSourceLanguage(event.target.value)} required /></label>
        <label>Variant page <select aria-label="Variant page" value={variantPageId} onChange={event => setVariantPageId(event.target.value)} required><option value="">Choose a page</option>{pages.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        <label>Variant language <input aria-label="Variant language" list="variant-language-codes" value={variantLanguage} onChange={event => setVariantLanguage(event.target.value)} required /></label>
        <datalist id="variant-language-codes">{languageChoices.map(language => <option key={language.tag} value={language.tag}>{language.name}</option>)}</datalist>
        <button type="submit" disabled={busy || !variantPageId}>Link variant</button>
      </>}
    </form></Dialog>}
    {diffOpen && <Dialog title="Published source changes" onClose={() => setDiffOpen(false)}><p className="variant-diff">{diffText}</p></Dialog>}
  </>;
}
