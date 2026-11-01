"use client";
import { FormEvent, useRef, useState } from "react";
import { acceptedProfilePreview, type ImportProfilePreview, type ImportProfileScope, type PositionalImportMapping } from "../lib/import-mapping-profile";

type ListedProfile = {
  id: string;
  name: string;
  scope: ImportProfileScope;
  mode: "create" | "update";
  version: number;
  compatibility: "compatible" | "incompatible";
  restricted: boolean;
  canManage: boolean;
  canUse: boolean;
};
type ListedDraft = { id: string; profileId: string; name: string; scope: ImportProfileScope; mode: "create" | "update"; version: number };
type HistoryVersion = { version: number; name: string; mode: string; actorId: string; source: string; atIst: string; operationId: string; restricted: boolean };

export default function ImportMappingProfiles({
  workspaceId,
  tenantId,
  collection,
  jobId,
  mapping,
  canManageShared,
  disabled,
  onUseMapping,
}: {
  workspaceId: string;
  tenantId: string;
  collection: string;
  jobId: string;
  mapping: Record<string, unknown> | null;
  canManageShared: boolean;
  disabled: boolean;
  onUseMapping: (mapping: PositionalImportMapping) => void;
}) {
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/import-profiles`;
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<ListedProfile[]>([]);
  const [drafts, setDrafts] = useState<ListedDraft[]>([]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ImportProfileScope>("personal");
  const [preview, setPreview] = useState<ImportProfilePreview | null>(null);
  const [history, setHistory] = useState<HistoryVersion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const profileId = useRef("");
  const saveIntent = useRef<{ key: string; operationId: string } | null>(null);
  const selected = profiles.find((profile) => profile.id === selectedId) ?? null;

  async function load(search = query) {
    const response = await fetch(`${root}?collection=${encodeURIComponent(collection)}&q=${encodeURIComponent(search)}`, { credentials: "same-origin", cache: "no-store" });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "Import profiles could not be loaded.");
    const nextProfiles = Array.isArray(body?.profiles) ? (body.profiles as unknown[]).flatMap(acceptedProfile) : [];
    const nextDrafts = Array.isArray(body?.drafts) ? (body.drafts as unknown[]).flatMap(acceptedDraft) : [];
    setProfiles(nextProfiles);
    setDrafts(nextDrafts);
    return { profiles: nextProfiles, drafts: nextDrafts };
  }
  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) return;
    setBusy(true);
    setError("");
    try {
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Import profiles could not be loaded.");
    } finally {
      setBusy(false);
    }
  }
  async function search(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await load(query);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Import profiles could not be loaded.");
    } finally {
      setBusy(false);
    }
  }
  function choose(id: string) {
    setSelectedId(id);
    setPreview(null);
    setHistory(null);
    const profile = profiles.find((item) => item.id === id);
    if (!profile) return;
    profileId.current = profile.id;
    setName(profile.name);
    setScope(profile.scope);
  }
  async function submit(kind: "save" | "draft", event: FormEvent) {
    event.preventDefault();
    if (!mapping || busy) return;
    const id = selected?.id ?? (profileId.current || (profileId.current = crypto.randomUUID()));
    const draftRow = drafts.find((item) => item.profileId === id);
    const body = {
      kind,
      id,
      ...(kind === "draft" ? { draftId: draftRow?.id ?? crypto.randomUUID() } : {}),
      jobId,
      collection,
      scope,
      name: name.trim(),
      expectedVersion: kind === "draft" ? draftRow?.version ?? 0 : selected?.version ?? 0,
      mapping,
    };
    const key = JSON.stringify(body);
    if (!saveIntent.current || saveIntent.current.key !== key) saveIntent.current = { key, operationId: crypto.randomUUID() };
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(root, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, operationId: saveIntent.current.operationId }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "The import profile was not saved.");
      saveIntent.current = null;
      const listed = await load("");
      if (kind === "save" && typeof payload?.id === "string") {
        setSelectedId(payload.id);
        const saved = listed.profiles.find((item) => item.id === payload.id);
        if (saved) {
          setName(saved.name);
          setScope(saved.scope);
        }
      }
      setNotice(kind === "draft" ? "Draft kept on this profile. The saved profile and the staged import are unchanged." : "Profile saved. It does not import rows or create fields.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The import profile was not saved.");
    } finally {
      setBusy(false);
    }
  }
  async function apply(useDraft: boolean) {
    const id = useDraft ? drafts.find((item) => !selectedId || item.profileId === selectedId)?.profileId : selected?.id;
    if (!id || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setPreview(null);
    try {
      const response = await fetch(root, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "apply", id, operationId: crypto.randomUUID(), jobId, ...(useDraft ? { draft: true } : {}) }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "The profile could not be applied.");
      const next = acceptedProfilePreview(payload);
      if (!next) throw new Error("The profile preview was incomplete.");
      setPreview(next);
      setNotice(next.repairRequired ? "Repair the ambiguous or missing required columns before using this mapping. No rows were imported." : "Preview ready. Using it only fills the mapping draft. Save the mapping before review or commit.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The profile could not be applied.");
    } finally {
      setBusy(false);
    }
  }
  async function loadHistory() {
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${root}/${encodeURIComponent(selected.id)}/history`, { credentials: "same-origin", cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "Profile history is unavailable.");
      setHistory(Array.isArray(payload?.versions) ? (payload.versions as unknown[]).flatMap(acceptedHistory) : []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Profile history is unavailable.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="import-profiles" aria-label="Import mapping profiles">
      <h3>Import mapping profiles</h3>
      <p>Save a named column-to-field mapping for this collection. A profile stores headers and field ids only. It does not import rows, create fields, or keep uploaded cell values.</p>
      <button type="button" aria-expanded={open} aria-controls="import-profile-panel" onClick={() => void toggle()}>{open ? "Hide import profiles" : "Import mapping profiles"}</button>
      {open && (
        <div id="import-profile-panel">
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          <form aria-label="Search import profiles" onSubmit={search}>
            <label>Search profiles <input value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} /></label>
            <button type="submit" disabled={busy}>Search</button>
          </form>
          <label>
            Saved profile{" "}
            <select aria-label="Saved import profile" value={selectedId} onChange={(event) => choose(event.target.value)}>
              <option value="">New profile</option>
              {profiles.filter((profile) => profile.scope === "personal").map((profile) => <option key={profile.id} value={profile.id}>Personal · {profile.name} · {profile.mode}{profile.compatibility === "incompatible" ? " · incompatible" : ""}</option>)}
              {profiles.filter((profile) => profile.scope === "shared").map((profile) => <option key={profile.id} value={profile.id}>Shared · {profile.name} · {profile.mode}{profile.compatibility === "incompatible" ? " · incompatible" : ""}</option>)}
            </select>
          </label>
          {selected?.restricted && <p>This profile includes a field you cannot use. Its mapping stays hidden.</p>}
          {selected && !selected.restricted && selected.compatibility === "incompatible" && <p>Schema, choice, or key changes made this profile incompatible. Repair it and save a new version. Field changes stay in the schema workflow.</p>}
          <form aria-label="Save import profile" onSubmit={(event) => void submit("save", event)}>
            <label>Profile name <input required minLength={1} maxLength={100} value={name} disabled={busy || (!!selected && !selected.canManage)} onChange={(event) => setName(event.target.value)} /></label>
            <fieldset>
              <legend>Audience</legend>
              <label className="record-check"><input type="radio" name="import-profile-audience" value="personal" checked={scope === "personal"} disabled={busy || !!selected} onChange={() => setScope("personal")} /> Personal</label>
              <label className="record-check"><input type="radio" name="import-profile-audience" value="shared" checked={scope === "shared"} disabled={busy || !!selected || !canManageShared} onChange={() => setScope("shared")} /> Shared</label>
              {!canManageShared && <p>Shared profiles need the manage-import-profiles capability. Assignment does not grant record access.</p>}
              {selected && <p>Audience stays fixed. Save a new profile to share a personal mapping.</p>}
            </fieldset>
            <p>Mode comes from the import mapping above: {mapping && mapping.mode === "update" ? "update" : mapping ? "create" : "choose a valid mapping first"}.</p>
            <button type="submit" disabled={busy || disabled || !mapping || !name.trim() || (!!selected && !selected.canManage)}>Save profile</button>
            <button type="button" disabled={busy || disabled || !mapping || !name.trim()} onClick={(event) => void submit("draft", event)}>Keep draft</button>
          </form>
          {!!drafts.length && <button type="button" disabled={busy} onClick={() => void apply(true)}>Recover draft</button>}
          <button type="button" disabled={busy || !selected?.canUse} onClick={() => void apply(false)}>Apply profile</button>
          {selected?.canUse && <a href={`${root}/${encodeURIComponent(selected.id)}/download`}>Download mapping</a>}
          {preview && (
            <div aria-live="polite">
              <p>{preview.restricted ? "This profile is restricted." : preview.compatibility === "incompatible" ? "Incompatible with the current schema." : "Compatible with the current schema."} {preview.repairRequired ? "Repair is required." : "No repair is required."}</p>
              {!!preview.headerDiffs.length && (
                <table aria-label="Header differences">
                  <caption>Header match against this staged file. Sample values are not stored.</caption>
                  <thead><tr><th scope="col">Header</th><th scope="col">Status</th></tr></thead>
                  <tbody>{preview.headerDiffs.map((diff) => <tr key={`${diff.status}-${diff.header}`}><td>{diff.header}</td><td>{diff.status}</td></tr>)}</tbody>
                </table>
              )}
              {!!preview.typeDiffs.length && (
                <table aria-label="Type differences">
                  <caption>Observed sample kinds compared with the field type. Cell values are not shown.</caption>
                  <thead><tr><th scope="col">Header</th><th scope="col">Expected</th><th scope="col">Observed</th><th scope="col">Difference</th></tr></thead>
                  <tbody>{preview.typeDiffs.map((diff) => <tr key={diff.header}><td>{diff.header}</td><td>{diff.expectedKind}</td><td>{diff.observedKind}</td><td>{diff.difference ? "Review" : "Matches"}{diff.choiceMismatch ? " · choice" : ""}</td></tr>)}</tbody>
                </table>
              )}
              {preview.repairRequired && <p role="status">Ambiguous or missing required columns must be repaired in the mapping above. This profile will not fill the mapping until then.</p>}
              <button type="button" disabled={busy || disabled || preview.repairRequired || !preview.mapping} onClick={() => preview.mapping && onUseMapping(preview.mapping)}>Use this mapping draft</button>
            </div>
          )}
          {selected && (
            <details onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open && !history) void loadHistory(); }}>
              <summary>Profile history</summary>
              {history && (
                <ul>
                  {history.map((version) => <li key={version.version}>Version {version.version} · {version.mode} · {version.source} · {version.atIst} · {version.operationId}{version.restricted ? " · mapping hidden" : ""}</li>)}
                </ul>
              )}
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function acceptedProfile(value: unknown): ListedProfile[] {
  if (!value || typeof value !== "object") return [];
  const item = value as Partial<ListedProfile>;
  if (typeof item.id !== "string" || typeof item.name !== "string" || (item.scope !== "personal" && item.scope !== "shared")) return [];
  if (item.mode !== "create" && item.mode !== "update") return [];
  if (typeof item.version !== "number" || (item.compatibility !== "compatible" && item.compatibility !== "incompatible")) return [];
  return [{ id: item.id, name: item.name, scope: item.scope, mode: item.mode, version: item.version, compatibility: item.compatibility, restricted: item.restricted === true, canManage: item.canManage === true, canUse: item.canUse === true }];
}

function acceptedDraft(value: unknown): ListedDraft[] {
  if (!value || typeof value !== "object") return [];
  const item = value as Partial<ListedDraft>;
  if (typeof item.id !== "string" || typeof item.profileId !== "string" || typeof item.name !== "string" || typeof item.version !== "number") return [];
  if (item.scope !== "personal" && item.scope !== "shared") return [];
  if (item.mode !== "create" && item.mode !== "update") return [];
  return [{ id: item.id, profileId: item.profileId, name: item.name, scope: item.scope, mode: item.mode, version: item.version }];
}

function acceptedHistory(value: unknown): HistoryVersion[] {
  if (!value || typeof value !== "object") return [];
  const item = value as Partial<HistoryVersion>;
  if (typeof item.version !== "number" || typeof item.name !== "string" || typeof item.mode !== "string" || typeof item.actorId !== "string" || typeof item.source !== "string" || typeof item.atIst !== "string" || typeof item.operationId !== "string") return [];
  return [{ version: item.version, name: item.name, mode: item.mode, actorId: item.actorId, source: item.source, atIst: item.atIst, operationId: item.operationId, restricted: item.restricted === true }];
}
