"use client";
import { FormEvent, useEffect, useState } from "react";

type Summary = {
  id: string;
  name: string;
  collection: string;
  state: string;
  version: number;
  values: Record<string, unknown>;
};
type Link = {
  id: string;
  kind: string;
  role: string;
  primary: boolean;
  status: string;
  target: { id: string; name: string; collection: string };
};
type Detail = Summary & {
  schemaVersion: number;
  capabilities: string[];
  parentOrganisation: { id: string; name?: string } | { unavailable: true } | null;
  documents: { id: string; pageId: string; title: string }[];
  related: Link[];
};
type ReparentPreview = {
  previewToken: string;
  expectedVersion: number;
  newOrganisationId: string;
  newOrganisation: { id: string; name: string };
  affectedContracts: { id: string; name: string }[];
  contextReferences: {
    source_app: string;
    source_type: string;
    source_id: string;
  }[];
  legalPartiesWillChange: false;
};
const collections = ["organisations", "accounts", "contacts", "employees", "contracts"] as const;
const relationshipKind = (collection: string) => (collection === "contacts" ? "contact-account" : collection === "employees" ? "employee-account" : collection === "contracts" ? "contract-account" : null);
const ids = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export default function RecordBrowser({ workspaceId, tenantId }: { workspaceId: string; tenantId: string }) {
  const base = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/records`,
    [collection, setCollection] = useState<(typeof collections)[number]>("organisations"),
    [query, setQuery] = useState(""),
    [items, setItems] = useState<Summary[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [selected, setSelected] = useState<Detail | null>(null),
    [createName, setCreateName] = useState(""),
    [createParent, setCreateParent] = useState(""),
    [createLegal, setCreateLegal] = useState(""),
    [createAccounts, setCreateAccounts] = useState(""),
    [editName, setEditName] = useState(""),
    [schemaVersion, setSchemaVersion] = useState(1),
    [targetId, setTargetId] = useState(""),
    [role, setRole] = useState(""),
    [primary, setPrimary] = useState(false),
    [relationStatus, setRelationStatus] = useState<"active" | "inactive">("active"),
    [contractRelationKind, setContractRelationKind] = useState<"contract-account" | "contract-legal-party">("contract-account"),
    [newParent, setNewParent] = useState(""),
    [preview, setPreview] = useState<ReparentPreview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function json(url: string, init?: RequestInit) {
    const response = await fetch(url, {
        credentials: "same-origin",
        cache: "no-store",
        ...init,
      }),
      body = await response.json();
    if (!response.ok) throw Error(body.error ?? "Record request failed.");
    return body;
  }
  async function load(reset = true) {
    setBusy(true);
    setError("");
    try {
      const p = new URLSearchParams({ collection, query });
      if (!reset && cursor) p.set("cursor", cursor);
      const data = await json(`${base}?${p}`);
      setSchemaVersion(data.schemaVersion);
      setItems((old) => (reset ? data.results : [...old, ...data.results]));
      setCursor(data.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load records.");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    setSelected(null);
    setPreview(null);
    void load(true);
  }, [collection]);
  async function open(id: string) {
    setBusy(true);
    setError("");
    try {
      const record = await json(`${base}/${encodeURIComponent(id)}`);
      setSelected(record);
      setEditName(record.name);
      setPreview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to open this record.");
    } finally {
      setBusy(false);
    }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const relationships =
        collection === "accounts"
          ? { parentOrganisationId: createParent.trim() }
          : collection === "contracts"
            ? {
                legalOrganisationIds: ids(createLegal),
                accountIds: ids(createAccounts),
              }
            : {};
      const data = await json(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "create",
          operationId: crypto.randomUUID(),
          collection,
          name: createName,
          schemaVersion,
          values: {},
          ...relationships,
        }),
      });
      setCreateName("");
      setCreateParent("");
      setCreateLegal("");
      setCreateAccounts("");
      setNotice("Record created and durably saved.");
      await load(true);
      await open(data.record.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to create this record.");
    } finally {
      setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await json(`${base}/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          expectedVersion: selected.version,
          schemaVersion: selected.schemaVersion,
          name: editName,
        }),
      });
      setSelected(data.record);
      setEditName(data.record.name);
      setNotice("Record changes saved.");
      await load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save this record.");
    } finally {
      setBusy(false);
    }
  }
  async function relationship(event: FormEvent, action: "upsert" | "remove" = "upsert", link?: Link) {
    event.preventDefault();
    if (!selected) return;
    const kind = link?.kind ?? (selected.collection === "contracts" ? contractRelationKind : relationshipKind(selected.collection));
    if (!kind) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await json(`${base}/${encodeURIComponent(selected.id)}/relationships`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          expectedVersion: selected.version,
          kind,
          targetId: link?.target.id ?? targetId.trim(),
          action,
          role: link?.role ?? role,
          primary: link?.primary ?? primary,
          status: link?.status ?? relationStatus,
        }),
      });
      setSelected(data.record);
      setTargetId("");
      setRole("");
      setPrimary(false);
      setNotice(action === "remove" ? "Relationship removed." : "Relationship saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to change this relationship.");
    } finally {
      setBusy(false);
    }
  }
  async function previewReparent(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setPreview(
        await json(`${base}/${encodeURIComponent(selected.id)}/reparent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "preview",
            newOrganisationId: newParent.trim(),
          }),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to preview this move.");
    } finally {
      setBusy(false);
    }
  }
  async function applyReparent() {
    if (!selected || !preview) return;
    setBusy(true);
    setError("");
    try {
      const data = await json(`${base}/${encodeURIComponent(selected.id)}/reparent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "apply",
          operationId: crypto.randomUUID(),
          expectedVersion: preview.expectedVersion,
          newOrganisationId: preview.newOrganisationId,
          previewToken: preview.previewToken,
          confirmed: true,
        }),
      });
      setSelected(data.record);
      setPreview(null);
      setNewParent("");
      setNotice("Account moved. Contract legal parties were not changed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to move this account.");
    } finally {
      setBusy(false);
    }
  }
  const canRelate = !!selected && selected.capabilities.includes("edit") && selected.capabilities.includes("link") && !!relationshipKind(selected.collection);
  return (
    <main className="record-browser">
      <header>
        <p>Holy Sheet · shared data</p>
        <h1>Records</h1>
        <p>Tenant-owned structured data. Opening or relating a record never grants access.</p>
      </header>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="record-browser-grid">
        <section aria-label="Record list">
          <label>
            Collection{" "}
            <select value={collection} onChange={(event) => setCollection(event.target.value as typeof collection)}>
              {collections.map((value) => (
                <option key={value} value={value}>
                  {value[0].toUpperCase() + value.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void load(true);
            }}
          >
            <label>
              Find records <input value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <button disabled={busy}>Search</button>
          </form>
          <ul>
            {items.map((item) => (
              <li key={item.id}>
                <button onClick={() => void open(item.id)} aria-current={selected?.id === item.id ? "true" : undefined}>
                  {item.name}
                </button>
              </li>
            ))}
          </ul>
          {cursor && (
            <button disabled={busy} onClick={() => void load(false)}>
              Load 50 more
            </button>
          )}
        </section>
        <section aria-label="Record editor">
          <h2>{selected ? "Record details" : "Create record"}</h2>
          {selected ? (
            <>
              <form onSubmit={save}>
                <label>
                  Name <input required minLength={1} maxLength={200} value={editName} onChange={(event) => setEditName(event.target.value)} />
                </label>
                <button disabled={busy || !selected.capabilities.includes("edit")}>Save changes</button>
              </form>
              <dl>
                <dt>Immutable ID</dt>
                <dd>{selected.id}</dd>
                <dt>Version</dt>
                <dd>{selected.version}</dd>
              </dl>
              <h3>Linked documents</h3>
              {selected.documents.length ? (
                <ul>
                  {selected.documents.map((document) => (
                    <li key={document.id}>
                      <a href={`/pages/${document.pageId}`}>{document.title}</a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No documents you can access are linked.</p>
              )}
              <h3>Related records</h3>
              {selected.related.length ? (
                <ul>
                  {selected.related.map((link) => (
                    <li key={link.id}>
                      {link.kind}: {link.target.name}
                      {link.role ? ` · ${link.role}` : ""}
                      {link.primary ? " · primary" : ""}
                      {canRelate && (
                        <button disabled={busy} onClick={(event) => void relationship(event, "remove", link)}>
                          Remove
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No visible relationships.</p>
              )}
              {canRelate && (
                <form aria-label="Add relationship" onSubmit={relationship}>
                  {selected.collection === "contracts" && (
                    <label>
                      Relationship type{" "}
                      <select value={contractRelationKind} onChange={(event) => setContractRelationKind(event.target.value as "contract-account" | "contract-legal-party")}>
                        <option value="contract-account">Covered account</option>
                        <option value="contract-legal-party">Legal organisation</option>
                      </select>
                    </label>
                  )}
                  <label>
                    Target record ID <input required value={targetId} onChange={(event) => setTargetId(event.target.value)} />
                  </label>
                  <label>
                    Role <input maxLength={100} value={role} onChange={(event) => setRole(event.target.value)} />
                  </label>
                  {selected.collection === "contacts" && (
                    <label>
                      <input type="checkbox" checked={primary} onChange={(event) => setPrimary(event.target.checked)} /> Primary account
                    </label>
                  )}
                  <label>
                    Status{" "}
                    <select value={relationStatus} onChange={(event) => setRelationStatus(event.target.value as "active" | "inactive")}>
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </label>
                  <button disabled={busy}>Add relationship</button>
                </form>
              )}
              {selected.collection === "accounts" && selected.capabilities.includes("edit") && selected.capabilities.includes("link") && (
                <form aria-label="Move account" onSubmit={previewReparent}>
                  <label>
                    New parent organisation ID <input required value={newParent} onChange={(event) => setNewParent(event.target.value)} />
                  </label>
                  <button disabled={busy}>Preview move</button>
                  {preview && (
                    <section aria-label="Move impact">
                      <p>
                        {preview.affectedContracts.length} contract context(s) and {preview.contextReferences.length} external context reference(s) are affected.
                      </p>
                      <p>Legal parties will not change.</p>
                      <button type="button" disabled={busy} onClick={() => void applyReparent()}>
                        Confirm account move
                      </button>
                    </section>
                  )}
                </form>
              )}
            </>
          ) : (
            <form onSubmit={create}>
              <label>
                Name <input required minLength={1} maxLength={200} value={createName} onChange={(event) => setCreateName(event.target.value)} />
              </label>
              {collection === "accounts" && (
                <label>
                  Parent organisation ID <input required value={createParent} onChange={(event) => setCreateParent(event.target.value)} />
                </label>
              )}
              {collection === "contracts" && (
                <>
                  <label>
                    Legal organisation IDs <input required value={createLegal} onChange={(event) => setCreateLegal(event.target.value)} placeholder="Comma separated" />
                  </label>
                  <label>
                    Covered account IDs <input value={createAccounts} onChange={(event) => setCreateAccounts(event.target.value)} placeholder="Optional, comma separated" />
                  </label>
                </>
              )}
              <button disabled={busy || !createName.trim()}>Create record</button>
            </form>
          )}
        </section>
      </div>
    </main>
  );
}
