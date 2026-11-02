"use client";
import { useEffect, useState } from "react";
import { Dialog } from "./editor/dialog";

type Frequency = "daily" | "weekly";
type FollowState = { following: boolean; includeChildren: boolean; frequency: Frequency | null };
type FollowRow = { pageId: string; title: string | null; unavailable: boolean; includeChildren: boolean; frequency: Frequency };
type FollowList = { timezone: string; follows: FollowRow[] };

async function readJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json() as { error?: string };
  if (!response.ok) throw new Error(data.error || "Follow settings could not be saved");
  return data as T;
}

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export default function PageFollow({ pageId }: { pageId: string }) {
  const [state, setState] = useState<FollowState | null>(null);
  const [settings, setSettings] = useState<FollowList | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setState(null);
    setError("");
    readJson<FollowState>(`/api/v1/pages/${encodeURIComponent(pageId)}/follow`, { signal: controller.signal })
      .then(next => { if (!controller.signal.aborted) setState(next); })
      .catch(() => { if (!controller.signal.aborted) setError("Following is unavailable"); });
    return () => controller.abort();
  }, [pageId]);

  async function send(body: unknown) {
    setBusy(true);
    setError("");
    try { setState(await readJson<FollowState>(`/api/v1/pages/${encodeURIComponent(pageId)}/follow`, post(body))); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Following is unavailable"); }
    finally { setBusy(false); }
  }

  async function loadSettings() {
    setOpen(true);
    setError("");
    try { setSettings(await readJson<FollowList>("/api/v1/follows")); }
    catch (cause) { setSettings(null); setError(cause instanceof Error ? cause.message : "Following is unavailable"); }
  }

  async function saveSettings(body: unknown) {
    setBusy(true);
    setError("");
    try {
      setSettings(await readJson<FollowList>("/api/v1/follows", post(body)));
      setState(await readJson<FollowState>(`/api/v1/pages/${encodeURIComponent(pageId)}/follow`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Following is unavailable");
    } finally { setBusy(false); }
  }

  const following = !!state?.following;
  const label = following ? "Following" : "Follow";
  return <div className="page-follow-actions">
    <details className="page-tools">
      <summary aria-label={label} aria-pressed={following}>{label}</summary>
      <div className="page-tools-menu">
        <span className="menu-label">Page follow</span>
        {!following && <button type="button" disabled={busy || !state} onClick={() => void send({ action: "follow", operationId: crypto.randomUUID(), includeChildren: false })}>Follow this page</button>}
        {!following && <button type="button" disabled={busy || !state} onClick={() => void send({ action: "follow", operationId: crypto.randomUUID(), includeChildren: true })}>Follow page and children</button>}
        {following && <button type="button" disabled={busy} aria-pressed={state?.frequency === "daily"} onClick={() => void send({ action: "frequency", operationId: crypto.randomUUID(), frequency: "daily" })}>Daily digest</button>}
        {following && <button type="button" disabled={busy} aria-pressed={state?.frequency === "weekly"} onClick={() => void send({ action: "frequency", operationId: crypto.randomUUID(), frequency: "weekly" })}>Weekly digest</button>}
        {following && <button type="button" disabled={busy} onClick={() => void send({ action: "unfollow", operationId: crypto.randomUUID() })}>Unfollow</button>}
        <button type="button" disabled={busy} onClick={() => void loadSettings()}>Pages you follow</button>
      </div>
    </details>
    {error && !open && <span role="alert">{error}</span>}
    {open && <Dialog title="Pages you follow" onClose={() => setOpen(false)}>
      {error && <p role="alert">{error}</p>}
      {!settings && !error && <p role="status">Loading pages you follow…</p>}
      {settings && <>
        <p>Digests arrive at 09:00 in your timezone. Change times in the digest are shown in IST.</p>
        <label>Timezone<input aria-label="Digest timezone" defaultValue={settings.timezone} disabled={busy} onBlur={event => { if (event.target.value !== settings.timezone) void saveSettings({ action: "timezone", operationId: crypto.randomUUID(), timezone: event.target.value }); }} /></label>
        {settings.follows.length ? <ul aria-label="Pages you follow">{settings.follows.map(row => <li key={row.pageId}>
          <span>{row.title ?? "A page you follow is unavailable"}</span>
          <span>{row.includeChildren ? "Page and children" : "Page"}</span>
          <button type="button" disabled={busy || row.frequency === "daily"} onClick={() => void saveSettings({ action: "frequency", operationId: crypto.randomUUID(), pageId: row.pageId, frequency: "daily" })}>Daily</button>
          <button type="button" disabled={busy || row.frequency === "weekly"} onClick={() => void saveSettings({ action: "frequency", operationId: crypto.randomUUID(), pageId: row.pageId, frequency: "weekly" })}>Weekly</button>
          <button type="button" disabled={busy} onClick={() => void saveSettings({ action: "unfollow", operationId: crypto.randomUUID(), pageId: row.pageId })}>Unfollow</button>
        </li>)}</ul> : <p>You are not following any pages.</p>}
      </>}
    </Dialog>}
  </div>;
}
