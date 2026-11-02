"use client";
import { useEffect, useState } from "react";
import { Dialog } from "./editor/dialog";
import { ApiError, requestJson } from "./editor/use-document-session";
import { enqueuePageRead } from "../lib/page-read-queue";
import { NOT_LATEST_BANNER, TRASH_MESSAGE, UNPUBLISHED_CHANGES, UNPUBLISHED_MESSAGE, type DiffLine, type DraftPublication, type PublishedRecord, type PublishedResolution, type PublishedVersionSummary } from "../lib/published-page-shared";
import styles from "./published-page.module.css";

export function PublishedNotFound() {
  return <main className={styles.missing}><h1>Page not found</h1></main>;
}

export function PublishedBanner({ banner }: { banner: string }) {
  return <p className={styles.banner} role="status">{banner}</p>;
}

export function NotLatestBanner({ href }: { href: string }) {
  return <p className={styles.notice} role="status">{NOT_LATEST_BANNER} <a href={href}>Latest version</a></p>;
}

export function UnpublishedNotice() {
  return <p className={styles.notice} role="status">{UNPUBLISHED_MESSAGE}</p>;
}

export function TrashedNotice({ onRestore }: { onRestore: () => void }) {
  return <div className={styles.notice} role="status"><p>{TRASH_MESSAGE}</p><button type="button" onClick={onRestore}>Restore</button></div>;
}

export function UnpublishedChanges({ lines }: { lines: DiffLine[] }) {
  return <div className={styles.stack}>
    <p className={styles.badge}>{UNPUBLISHED_CHANGES}</p>
    <ul className={styles.diff} aria-label="Changes since the published version">
      {lines.filter(line => line.kind !== "same").map((line, index) => <li key={`${line.kind}-${index}`}>{line.kind === "added" ? "Added: " : "Removed: "}{line.text}</li>)}
    </ul>
  </div>;
}

export function VersionList({ versions }: { versions: PublishedVersionSummary[] }) {
  return <ol className={styles.versions} aria-label="Published versions">
    {versions.map(version => <li key={version.versionNo}>v{version.versionNo} · {version.publishedAtIst} · {version.publisher} · {version.note}</li>)}
  </ol>;
}

export function RecordCards({ records }: { records: PublishedRecord[] }) {
  return <ul className={styles.records} aria-label="Record cards">
    {records.map(record => <li key={record.blockId}>
      {record.status === "visible" ? <article>
        <h2>{record.title}</h2>
        {record.valuesAsOf && <p>{record.valuesAsOf}</p>}
        <ul>{record.fields.map(field => <li key={field.key}>{field.label}: {field.access === "visible" ? field.value : "Hidden"}</li>)}</ul>
      </article> : <p>Record unavailable</p>}
    </li>)}
  </ul>;
}

export async function copyStableLink(path: string) {
  const url = new URL(path, window.location.origin).toString();
  await navigator.clipboard.writeText(url);
  return url;
}

function CopyLink({ path }: { path: string }) {
  const [notice, setNotice] = useState("");
  return <div className={styles.actions}><button type="button" onClick={() => { void copyStableLink(path).then(() => setNotice("Link copied."), () => setNotice("Clipboard unavailable. Copy this page URL from the browser.")); }}>Copy link</button>{notice && <span role="status">{notice}</span>}</div>;
}

export function PublishForm({ pageId, state, onClose, onPublished }: { pageId: string; state: DraftPublication; onClose: () => void; onPublished: () => void }) {
  const [slug, setSlug] = useState(state.slug || state.suggestedSlug);
  const [note, setNote] = useState("");
  const [freezeValues, setFreezeValues] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [busy, setBusy] = useState(false);
  const republish = state.versionNo !== null;
  async function submit(action: "publish" | "republish" | "unpublish" | "rename") {
    setBusy(true);
    setError("");
    const operationId = crypto.randomUUID();
    const body = action === "unpublish" ? { action, operationId, reason } : action === "rename" ? { action, operationId, slug } : { action, operationId, note, freezeValues, ...(action === "publish" ? { slug } : {}) };
    try {
      await requestJson(`/api/v1/pages/${encodeURIComponent(pageId)}/stable-url`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      onPublished();
      if (action !== "unpublish") setCopied(`/s/${state.spaceSlug}/${action === "republish" ? state.slug : slug}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Publishing could not be saved.");
    } finally { setBusy(false); }
  }
  return <Dialog title={republish ? "Republish page" : "Publish page"} onClose={onClose}>
    <form className={styles.form} onSubmit={event => { event.preventDefault(); void submit(republish ? "republish" : "publish"); }}>
      {!republish && <label>Address<input name="slug" value={slug} onChange={event => setSlug(event.target.value)} autoComplete="off" required />{state.suggestedSlug && <span>Suggested: {state.suggestedSlug}</span>}</label>}
      <label>Change note<textarea name="note" value={note} onChange={event => setNote(event.target.value)} required /></label>
      <label className={styles.check}><input type="checkbox" checked={freezeValues} onChange={event => setFreezeValues(event.target.checked)} />Freeze record values at publish</label>
      {error && <p className={styles.alert} role="alert">{error}</p>}
      <div className={styles.actions}><button className={styles.primary} type="submit" disabled={busy}>{republish ? "Republish" : "Publish"}</button>{republish && <button type="button" disabled={busy} onClick={() => void submit("rename")}>Rename address</button>}</div>
      {copied && <CopyLink path={copied} />}
    </form>
    {republish && state.live && <form className={styles.form} onSubmit={event => { event.preventDefault(); void submit("unpublish"); }}>
      <label>Reason to unpublish<textarea name="reason" value={reason} onChange={event => setReason(event.target.value)} required /></label>
      <button type="submit" disabled={busy}>Unpublish</button>
    </form>}
  </Dialog>;
}

export function PublishedPageHost({ pageId, role, open, onOpenChange }: { pageId: string; role: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [state, setState] = useState<DraftPublication | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const load = () => enqueuePageRead(() => requestJson<DraftPublication>(`/api/v1/pages/${encodeURIComponent(pageId)}/stable-url`).then(setState).catch(() => setState(null)));
  useEffect(() => { load(); }, [pageId]);
  if (!state) return null;
  return <div className={styles.stack} data-published-page="">
    {state.banner && <PublishedBanner banner={state.banner} />}
    {state.unpublishedChanges && <UnpublishedChanges lines={state.diff.lines} />}
    {state.unpublished && <UnpublishedNotice />}
    {state.stablePath && <CopyLink path={state.stablePath} />}
    {!!state.versions.length && <button type="button" aria-expanded={versionsOpen} onClick={() => setVersionsOpen(value => !value)}>Versions</button>}
    {versionsOpen && <VersionList versions={state.versions} />}
    {open && role === "owner" && state.canPublish && <PublishForm pageId={pageId} state={state} onClose={() => onOpenChange(false)} onPublished={load} />}
  </div>;
}

export function StablePublishedView({ result, onRestore }: { result: Exclude<PublishedResolution, { kind: "missing" } | { kind: "redirect" }>; onRestore?: () => void }) {
  const [versionsOpen, setVersionsOpen] = useState(false);
  if (result.kind === "trashed") return <TrashedNotice onRestore={() => onRestore?.()} />;
  if (result.kind === "unpublished") return <div className={styles.stack}><UnpublishedNotice />{result.canonicalPath && <a href={result.canonicalPath}>Open the page</a>}</div>;
  return <article className={styles.stack}>
    <h1>{result.title}</h1>
    <PublishedBanner banner={result.banner} />
    {result.notLatestBanner && <NotLatestBanner href={result.latestPath} />}
    <CopyLink path={result.stablePath} />
    <a href={result.canonicalPath}>Canonical page</a>
    <p className={styles.text}>{result.text}</p>
    {!!result.records.length && <RecordCards records={result.records} />}
    <button type="button" aria-expanded={versionsOpen} onClick={() => setVersionsOpen(value => !value)}>Versions</button>
    {versionsOpen && <VersionList versions={result.versions} />}
  </article>;
}

export function StablePublishedPage({ initial, space, slug, workspaceId }: { initial: PublishedResolution; space: string; slug: string; workspaceId: string }) {
  const [result, setResult] = useState(initial);
  useEffect(() => {
    const refresh = () => enqueuePageRead(async () => {
      const query = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : "";
      try {
        const next = await requestJson<PublishedResolution>(`/api/v1/published/${encodeURIComponent(space)}/${encodeURIComponent(slug)}${query}`);
        setResult(next);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) setResult({ kind: "missing" });
      }
    });
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => { window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
  }, [space, slug, workspaceId]);
  if (result.kind === "missing" || result.kind === "redirect") return <PublishedNotFound />;
  return <main className={styles.page}><StablePublishedView result={result} onRestore={() => {
    const operationId = crypto.randomUUID();
    const query = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : "";
    void requestJson<PublishedResolution>(`/api/v1/published/${encodeURIComponent(space)}/${encodeURIComponent(slug)}${query}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "restore", operationId }) }).then(setResult).catch(error => { if (error instanceof ApiError && error.status === 404) setResult({ kind: "missing" }); });
  }} /></main>;
}

export default StablePublishedPage;
