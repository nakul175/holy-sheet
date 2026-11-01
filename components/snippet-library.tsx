"use client";
import { useEffect, useState } from "react";
import { requestJson } from "./editor/use-document-session";

type Space = { id: string; name: string; tier: string; canManage: boolean; canApprove: boolean };
type Version = { id: string; number: number; state: string; note: string | null; approvedBy: string | null; approvedByName: string | null; approvedAtIst: string | null; contentText: string | null };
type Item = { id: string; title: string; spaceId: string; state: string; retired: boolean; deleted: boolean; restoreOpen: boolean; canManage: boolean; canApprove: boolean; versions: Version[] };
type Library = { canGrant: boolean; spaces: Space[]; snippets: Item[] };
type Usage = { placements: { pageId: string; pageTitle: string; pageOwnerId: string; pageOwnerName: string; versionMode: string; versionNumber: number }[] };
type Preview = { titles: string[]; hiddenCount: number; confirm: string };

const paragraph = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

export default function SnippetLibrary({ workspaceId, initialSnippetId }: { workspaceId: string; initialSnippetId?: string }) {
  const base = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/snippets`;
  const [library, setLibrary] = useState<Library | null>(null);
  const [selected, setSelected] = useState(initialSnippetId ?? "");
  const [detail, setDetail] = useState<Item | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [spaceId, setSpaceId] = useState("");
  const [note, setNote] = useState("");
  const [armed, setArmed] = useState(false);
  const [nextBody, setNextBody] = useState("");
  const [grantUser, setGrantUser] = useState("");
  const [grantRole, setGrantRole] = useState<"manager" | "approver" | "reviewer">("approver");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadList() {
    const data = await requestJson<Library>(base);
    setLibrary(data);
    setSpaceId(current => current || data.spaces.find(space => space.canManage)?.id || data.spaces[0]?.id || "");
    return data;
  }
  async function loadDetail(id: string) {
    const data = await requestJson<Item>(`${base}/${encodeURIComponent(id)}`);
    setDetail(data);
    setUsage(null);
    setPreview(null);
    setArmed(false);
    return data;
  }
  useEffect(() => {
    let live = true;
    setError("");
    void loadList().then(data => {
      if (!live) return;
      const id = initialSnippetId && data.snippets.some(item => item.id === initialSnippetId) ? initialSnippetId : data.snippets[0]?.id ?? "";
      setSelected(id);
      if (id) return loadDetail(id);
    }).catch(reason => { if (live) setError(reason instanceof Error ? reason.message : "Snippets are unavailable"); });
    return () => { live = false; };
  }, [base, initialSnippetId]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try { await work(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Snippet is restricted or unavailable"); } finally { setBusy(false); }
  }
  function post(url: string, payload: unknown) {
    return requestJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  }

  const manageable = library?.spaces.filter(space => space.canManage) ?? [];
  return <main className="snippet-library">
    <p><a href="/">Holy Sheet</a></p>
    <h1>Snippet library</h1>
    <p>Approved wording can be inserted into pages. Drafts stay in this library until an approver accepts them.</p>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {manageable.length > 0 && <form onSubmit={event => { event.preventDefault(); void run(async () => { await post(base, { action: "create", operationId: crypto.randomUUID(), spaceId, title, content: paragraph(body) }); setTitle(""); setBody(""); await loadList(); setNotice("Draft snippet created."); }); }}>
      <h2>New snippet</h2>
      <label>Space<select aria-label="Snippet space" value={spaceId} onChange={event => setSpaceId(event.target.value)}>{manageable.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}</select></label>
      <label>Title<input aria-label="Snippet title" value={title} onChange={event => setTitle(event.target.value)} required maxLength={120} /></label>
      <label>Text<textarea aria-label="Snippet text" value={body} onChange={event => setBody(event.target.value)} required /></label>
      <button disabled={busy}>Create draft</button>
    </form>}
    <h2>Library</h2>
    {!library && !error && <p role="status">Loading snippets…</p>}
    {library && !library.snippets.length && <p>No snippets are available in the spaces you can read.</p>}
    {!!library?.snippets.length && <ul aria-label="Snippets">{library.snippets.map(item => <li key={item.id}><button type="button" aria-current={item.id === selected ? "true" : undefined} onClick={() => { setSelected(item.id); void run(() => loadDetail(item.id).then(() => undefined)); }}>{item.title}</button> <span>{item.state}{item.deleted ? " · deleted" : ""}</span></li>)}</ul>}
    {detail && <section aria-labelledby="snippet-detail-title">
      <h2 id="snippet-detail-title">{detail.title}</h2>
      <p>State: {detail.state}{detail.deleted ? detail.restoreOpen ? ". Snippet deleted. Restore is open for 30 days." : ". The 30-day restore window has ended." : ""}</p>
      <div className="snippet-versions">{detail.versions.map(version => <article key={version.id}><h3>v{version.number} · {version.state}</h3>{version.contentText && <p>{version.contentText}</p>}{version.approvedAtIst && <p>Approved by {version.approvedByName ?? "approver"} <time>{version.approvedAtIst}</time></p>}{version.note && <p>Note: {version.note}</p>}{detail.canManage && version.state === "draft" && <button type="button" disabled={busy} onClick={() => void run(async () => { await post(`${base}/${detail.id}`, { action: "submit", operationId: crypto.randomUUID(), versionNumber: version.number }); await loadDetail(detail.id); setNotice("Submitted for review."); })}>Submit for review</button>}</article>)}</div>
      {detail.canApprove && detail.versions.some(version => version.state === "in review") && <form onSubmit={event => { event.preventDefault(); const version = detail.versions.find(item => item.state === "in review"); if (!version) return; void run(async () => { await post(`${base}/${detail.id}`, { action: "approve", operationId: crypto.randomUUID(), versionNumber: version.number, note }); setNote(""); setArmed(false); await loadList(); await loadDetail(detail.id); setNotice("Approved."); }); }}>
        <h3>Review</h3>
        <label>Approval note<textarea aria-label="Approval note" value={note} onChange={event => { setNote(event.target.value); setArmed(false); }} required maxLength={500} /></label>
        {!armed ? <button type="button" disabled={busy} onClick={() => setArmed(true)}>Approve</button> : <button disabled={busy}>Confirm approval</button>}
      </form>}
      {detail.canManage && !detail.retired && !detail.deleted && detail.versions.every(version => version.state === "approved") && <form onSubmit={event => { event.preventDefault(); void run(async () => { await post(`${base}/${detail.id}`, { action: "draft-version", operationId: crypto.randomUUID(), content: paragraph(nextBody) }); setNextBody(""); await loadDetail(detail.id); setNotice("Draft version created."); }); }}>
        <h3>New version</h3>
        <label>Text<textarea aria-label="New version text" value={nextBody} onChange={event => setNextBody(event.target.value)} required /></label>
        <button disabled={busy}>Save draft version</button>
      </form>}
      {detail.canManage && !detail.retired && <div className="actions">{!preview ? <button type="button" disabled={busy} onClick={() => void run(async () => setPreview(await requestJson<Preview>(`${base}/${detail.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "retire-preview" }) })))}>Retire snippet</button> : <form onSubmit={event => { event.preventDefault(); void run(async () => { await post(`${base}/${detail.id}`, { action: "retire", operationId: crypto.randomUUID(), titles: preview.titles, hiddenCount: preview.hiddenCount }); setPreview(null); await loadList(); await loadDetail(detail.id); setNotice("Snippet retired."); }); }}><p>{preview.confirm}</p><button disabled={busy}>Confirm retire</button><button type="button" onClick={() => setPreview(null)}>Cancel</button></form>}</div>}
      {detail.canManage && !detail.deleted && <button type="button" disabled={busy} onClick={() => void run(async () => { await post(`${base}/${detail.id}`, { action: "delete", operationId: crypto.randomUUID() }); await loadDetail(detail.id); setNotice("Snippet deleted. Placements keep the last approved text for 30 days."); })}>Delete snippet</button>}
      {detail.canManage && detail.restoreOpen && <button type="button" disabled={busy} onClick={() => void run(async () => { await post(`${base}/${detail.id}`, { action: "restore", operationId: crypto.randomUUID() }); await loadDetail(detail.id); setNotice("Snippet restored."); })}>Restore snippet</button>}
      {detail.canManage && <>
        <h3>Usage</h3>
        <div className="actions"><button type="button" disabled={busy} onClick={() => void run(async () => setUsage(await requestJson<Usage>(`${base}/${detail.id}/usage`)))}>Show usage</button><a href={`${base}/${detail.id}/usage?format=csv`}>Export CSV</a></div>
        {usage && <table><caption>Placements you can read</caption><thead><tr><th>Page</th><th>Owner</th><th>Version</th></tr></thead><tbody>{usage.placements.map(row => <tr key={row.pageId}><td>{row.pageTitle}</td><td>{row.pageOwnerName || row.pageOwnerId}</td><td>{row.versionMode === "latest" ? "Follow latest" : "Pinned"} v{row.versionNumber}</td></tr>)}{!usage.placements.length && <tr><td colSpan={3}>No readable placements.</td></tr>}</tbody></table>}
      </>}
    </section>}
    {library?.canGrant && <form onSubmit={event => { event.preventDefault(); const intent = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value"); void run(async () => { await post(base, { action: intent === "revoke" ? "revoke" : "grant", operationId: crypto.randomUUID(), spaceId, userId: grantUser, role: grantRole }); setNotice(intent === "revoke" ? "Role removed." : "Role granted."); }); }}>
      <h2>Snippet roles</h2>
      <label>Space<select aria-label="Role space" value={spaceId} onChange={event => setSpaceId(event.target.value)}>{library.spaces.map(space => <option key={space.id} value={space.id}>{space.name}</option>)}</select></label>
      <label>Person<input aria-label="Role person" value={grantUser} onChange={event => setGrantUser(event.target.value)} required /></label>
      <label>Role<select aria-label="Snippet role" value={grantRole} onChange={event => setGrantRole(event.target.value as typeof grantRole)}><option value="manager">Snippet manager</option><option value="approver">Approver</option><option value="reviewer">Reviewer</option></select></label>
      <button value="grant" disabled={busy}>Grant</button>
      <button value="revoke" disabled={busy}>Revoke</button>
    </form>}
  </main>;
}
