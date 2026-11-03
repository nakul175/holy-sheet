import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { localActor as owner } from "./auth";
import { createDatabase, type Database } from "./database";
import {
  activateGuestPortal,
  addGuestComment,
  citeGuestFile,
  downloadGuestPortal,
  grantGuestPortalManager,
  guestPortalCatalogue,
  guestPortalHistory,
  linkGuestIdentity,
  openGuestPortal,
  pauseGuestPortal,
  previewGuestPortal,
  revokeGuestPortal,
  saveGuestPortal,
  searchGuestPortals,
  setGuestPortalActions,
  submitGuestForm,
} from "./guest-portal";
import { Repository } from "./repository";

let db: Database;
let r: Repository;
const guest = { id: "portal-guest", name: "Gina Guest" };
const assigned = { id: "portal-assigned", name: "Avery Assigned" };
const editor = { id: "portal-editor", name: "Eve Editor" };
const outsider = { id: "portal-outsider", name: "Bolt User" };
const workspace = "ws-aplyd";
const visibleRecord = "00000000-0000-4000-8000-00000000f101";
const secretRecord = "00000000-0000-4000-8000-00000000f102";
const organisationRecord = "00000000-0000-4000-8000-00000000f105";
const accountRecord = "00000000-0000-4000-8000-00000000f104";
const scheduleId = "00000000-0000-4000-8000-00000000f106";
let tenant = "";
let secretField = "";
let clinic = "";
type Shown = {
  id: string;
  version: number;
  cacheGeneration: number;
  status: string;
  sharing: string;
  accessGranted: boolean;
  invitationSent: boolean;
  credentialsStored: boolean;
  liveActivation: boolean;
  guestPreview: boolean;
  expiry: { hours: number };
  guestPreviewView: { screens: { name: string }[]; scope: { recordIds: string[] }; fields: { key: string }[]; actions: string[]; edge: { public: boolean } };
  identityConfigured: boolean;
  audience: string;
  admitted: boolean;
  records: { id: string; values: Record<string, string> }[];
  body: string;
  replayed: boolean;
  cache: string;
};
function shown(value: object) { return value as Shown; }

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  await r.seedLocal();
  await db.query("UPDATE hs_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [workspace, owner.id]);
  for (const actor of [guest, assigned, editor, outsider]) await db.query("INSERT INTO hs_users(id, name) VALUES($1,$2)", [actor.id, actor.name]);
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES($1,$2,'member'),($1,$3,'member'),($1,$4,'member')", [workspace, guest.id, assigned.id, editor.id]);
  await db.query("INSERT INTO hs_workspaces(id, name) VALUES('ws-b','Bolt Logistics')");
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES('ws-b',$1,'admin')", [outsider.id]);
  tenant = randomUUID();
  const other = randomUUID();
  await db.query("INSERT INTO hs_data_tenants(id, name) VALUES($1,'Synthetic Clinic'),($2,'Bolt')", [tenant, other]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id, tenant_id, review_reference) VALUES($1,$2,'synthetic'),('ws-b',$3,'synthetic')", [workspace, tenant, other]);
  await db.query("INSERT INTO hs_data_collections(tenant_id, id, name, core) VALUES($1,'organisations','Organisations',true),($1,'accounts','Accounts',true)", [tenant]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id, user_id, collection, capabilities) VALUES($1,$2,'organisations',$3),($1,$2,'accounts',$3)", [tenant, owner.id, ["view", "edit", "export", "history"]]);
  await db.query("INSERT INTO hs_data_records(id, tenant_id, collection, name, field_values, created_by, updated_by) VALUES($1,$2,'organisations','Visible clinic',$3,$4,$4),($5,$2,'organisations','zzsecretrecord','{}',$4,$4),($6,$2,'organisations','Northwind','{}',$4,$4)", [visibleRecord, tenant, JSON.stringify({ "core:notes": "Visible note" }), owner.id, secretRecord, organisationRecord]);
  await db.query("INSERT INTO hs_data_records(id, tenant_id, collection, name, parent_organisation_id, created_by, updated_by) VALUES($1,$2,'accounts','Northwind account',$3,$4,$4)", [accountRecord, tenant, organisationRecord, owner.id]);
  secretField = randomUUID();
  await db.query("INSERT INTO hs_data_fields(tenant_id, collection, field_key, label, kind, sensitive, created_by) VALUES($1,'organisations',$2,'Private salary','text',true,$3)", [tenant, secretField, owner.id]);
  await db.query("INSERT INTO hs_data_field_permissions(tenant_id, collection, field_key, user_id, can_view, can_write, can_history) VALUES($1,'organisations',$2,$3,true,true,true)", [tenant, secretField, owner.id]);
  await db.query("UPDATE hs_data_records SET field_values=$2::jsonb WHERE id=$1", [visibleRecord, JSON.stringify({ "core:notes": "Visible note", [secretField]: "hidden-salary-value" })]);
  await db.query("INSERT INTO hs_data_periodic_review_schedules(id, tenant_id, collection, name, definition, created_by) VALUES($1,$2,'organisations','Existing cadence',$3,$4)", [scheduleId, tenant, JSON.stringify({ paused: true }), owner.id]);
});
afterAll(async () => db.close());

function portalDefinition(recordId = visibleRecord, hours = 24) {
  return {
    screens: [{ id: "clinic", name: "Clinic", fields: ["core:notes", secretField], actions: ["view", "form", "comment", "file", "export", "history"] }],
    scope: { collection: "organisations", recordIds: [recordId] },
    fields: [{ key: "core:notes", mode: "edit" }, { key: secretField, mode: "view" }],
    actions: ["view", "form", "comment", "file", "export", "history"],
    expiry: { hours },
    edge: { cache: "no-store", residency: "tenant", public: false },
    guestPreview: true,
    domain: "partner.example",
  };
}
async function footprint() {
  const [records, collections, pages, parents, schedules, invitations, portalGrants, users] = await Promise.all([
    db.query("SELECT record_id::text, user_id, capabilities FROM hs_data_record_grants ORDER BY 1,2"),
    db.query("SELECT collection, user_id, capabilities FROM hs_data_collection_grants ORDER BY 1,2"),
    db.query("SELECT page_id, subject, role FROM hs_grants ORDER BY 1,2"),
    db.query("SELECT id::text, parent_organisation_id::text FROM hs_data_records WHERE parent_organisation_id IS NOT NULL"),
    db.query("SELECT id::text, definition FROM hs_data_periodic_review_schedules ORDER BY 1"),
    db.query("SELECT count(*)::int AS n FROM hs_access_invitations"),
    db.query("SELECT count(*)::int AS n FROM hs_guest_portal_grants"),
    db.query("SELECT count(*)::int AS n FROM hs_users"),
  ]);
  return JSON.stringify({ records: records.rows, collections: collections.rows, pages: pages.rows, parents: parents.rows, schedules: schedules.rows, invitations: invitations.rows[0].n, portalGrants: portalGrants.rows[0].n, users: users.rows[0].n });
}
function statements(sql: string) {
  const parts: string[] = [];
  let current = "";
  let dollar = false;
  for (const line of sql.split("\n")) {
    current += `${line}\n`;
    if ((line.split("$$").length - 1) % 2 === 1) dollar = !dollar;
    if (!dollar && line.trim().endsWith(";")) {
      if (current.replace(/^\s*--.*$/gm, "").trim()) parts.push(current.trim());
      current = "";
    }
  }
  return parts;
}
async function valueOf(recordId: string, key: string) {
  const row = await db.query<{ field_values: Record<string, string> | string }>("SELECT field_values FROM hs_data_records WHERE id=$1", [recordId]);
  const values = typeof row.rows[0].field_values === "string" ? JSON.parse(row.rows[0].field_values) : row.rows[0].field_values;
  return values[key];
}

it("lets an administrator configure screens, scope, fields, actions, guest preview, and expiry", async () => {
  const before = await footprint();
  const saved = shown(await saveGuestPortal(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, name: "Clinic portal", definition: portalDefinition() }));
  clinic = saved.id;
  expect(saved).toMatchObject({ sharing: "off", accessGranted: false, invitationSent: false, credentialsStored: false, liveActivation: false, status: "draft", guestPreview: true, expiry: { hours: 24 } });
  expect(saved.guestPreviewView.screens.map(screen => screen.name)).toEqual(["Clinic"]);
  expect(saved.guestPreviewView.scope.recordIds).toEqual([visibleRecord]);
  expect(saved.guestPreviewView.fields.map(field => field.key)).toEqual(["core:notes", secretField]);
  expect(saved.guestPreviewView.actions).toEqual(expect.arrayContaining(["view", "form", "comment", "file", "export", "history"]));
  expect(saved.guestPreviewView.edge.public).toBe(false);
  await expect(saveGuestPortal(r, guest, workspace, { operationId: randomUUID(), expectedVersion: 0, name: "Other portal", definition: portalDefinition() })).rejects.toMatchObject({ code: "not_found" });
  await expect(saveGuestPortal(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, name: "Public portal", definition: { ...portalDefinition(), edge: { cache: "public", residency: "tenant", public: true } } })).rejects.toMatchObject({ code: "guest_portal_edge" });
  expect(await footprint()).toBe(before);
  const fixture = JSON.parse(await readFile("fixtures/guest-portals/staging.json", "utf8"));
  expect(fixture).toMatchObject({ sharing: "off", accessGranted: false, invitationSent: false, liveActivation: false });
});

it("requires a current grant and eligible authentication, and ignores URL, domain, and assignment", async () => {
  const before = await footprint();
  const users = num((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_users")).rows[0].n);
  await expect(linkGuestIdentity(r, owner, workspace, { operationId: randomUUID(), portalId: clinic, expectedVersion: 1, suiteSubject: "missing-suite-subject" })).rejects.toMatchObject({ code: "not_found" });
  expect(num((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_users")).rows[0].n)).toBe(users);
  const linked = shown(await linkGuestIdentity(r, owner, workspace, { operationId: randomUUID(), portalId: clinic, expectedVersion: 1, suiteSubject: guest.id }));
  expect(linked).toMatchObject({ identityConfigured: false, accessGranted: false, invitationSent: false, credentialsStored: false, sharing: "off" });
  const identity = await db.query<{ credentials_stored: boolean; invitation_sent: boolean; access_granted: boolean }>("SELECT credentials_stored, invitation_sent, access_granted FROM hs_guest_portal_identities WHERE portal_id=$1 AND suite_subject=$2", [clinic, guest.id]);
  expect(identity.rows[0]).toEqual({ credentials_stored: false, invitation_sent: false, access_granted: false });
  expect(await footprint()).toBe(before);
  const claim = { urlToken: clinic, domain: "partner.example" };
  await expect(openGuestPortal(r, guest, workspace, clinic, claim)).rejects.toMatchObject({ code: "not_found" });
  await expect(openGuestPortal(r, assigned, workspace, clinic, claim)).rejects.toMatchObject({ code: "not_found" });
  await db.query("INSERT INTO hs_guest_portal_grants(id, tenant_id, portal_id, suite_subject, state, starts_at, expires_at) VALUES($1,$2,$3,$4,'current',clock_timestamp(), clock_timestamp() + interval '2 days')", [randomUUID(), tenant, clinic, assigned.id]);
  await expect(openGuestPortal(r, assigned, workspace, clinic, claim)).rejects.toMatchObject({ code: "not_found" });
  await expect(openGuestPortal(r, guest, workspace, clinic, claim)).rejects.toMatchObject({ code: "not_found" });
  const version = linked.version;
  await db.query("INSERT INTO hs_guest_portal_grants(id, tenant_id, portal_id, suite_subject, state, starts_at, expires_at) VALUES($1,$2,$3,$4,'current',clock_timestamp(), clock_timestamp() + interval '2 days')", [randomUUID(), tenant, clinic, guest.id]);
  const withoutRecord = await openGuestPortal(r, guest, workspace, clinic, claim);
  expect(withoutRecord).toMatchObject({ admitted: true, reason: "grant-and-authentication", sharing: "off", accessGranted: false, records: [] });
  await db.query("INSERT INTO hs_data_record_grants(tenant_id, record_id, user_id, capabilities) VALUES($1,$2,$3,$4)", [tenant, visibleRecord, guest.id, ["view", "edit", "history"]]);
  const opened = await openGuestPortal(r, guest, workspace, clinic, claim);
  expect(opened.records.map(record => record.id)).toEqual([visibleRecord]);
  expect(opened.records[0].values["core:notes"]).toBe("Visible note");
  expect(JSON.stringify(opened)).not.toContain("hidden-salary-value");
  expect(JSON.stringify(opened)).not.toContain("zzsecretrecord");
  expect(opened.cache).toBe("no-store");
  const stale = randomUUID();
  await db.query("INSERT INTO hs_guest_portal_grants(id, tenant_id, portal_id, suite_subject, state, starts_at, expires_at) VALUES($1,$2,$3,$4,'current', clock_timestamp() - interval '48 hours', clock_timestamp() + interval '1 day')", [stale, tenant, clinic, guest.id]);
  await db.query("DELETE FROM hs_guest_portal_grants WHERE portal_id=$1 AND suite_subject=$2 AND id<>$3", [clinic, guest.id, stale]);
  await expect(openGuestPortal(r, guest, workspace, clinic, claim)).rejects.toMatchObject({ code: "not_found" });
  await db.query("DELETE FROM hs_guest_portal_grants WHERE id=$1", [stale]);
  await db.query("INSERT INTO hs_guest_portal_grants(id, tenant_id, portal_id, suite_subject, state, starts_at, expires_at) VALUES($1,$2,$3,$4,'current',clock_timestamp(), clock_timestamp() + interval '2 days')", [randomUUID(), tenant, clinic, guest.id]);
  expect((await openGuestPortal(r, guest, workspace, clinic, claim)).admitted).toBe(true);
  expect(version).toBeGreaterThan(0);
});

it("keeps guest forms, files, and comments inside field, action, link, edge, and expiry rules", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("portal must not fetch"));
  try {
    const beforeRecords = await valueOf(visibleRecord, "core:notes");
    const beforeParents = (await db.query("SELECT id::text, parent_organisation_id::text FROM hs_data_records WHERE parent_organisation_id IS NOT NULL")).rows;
    const version = num((await db.query<{ version: number }>("SELECT version FROM hs_guest_portals WHERE id=$1", [clinic])).rows[0].version);
    await expect(submitGuestForm(r, guest, workspace, { operationId: randomUUID(), portalId: clinic, recordId: visibleRecord, expectedVersion: version, recordVersion: 1, values: { [secretField]: "hidden-salary-value" }, urlToken: clinic, domain: "partner.example" })).rejects.toMatchObject({ code: "guest_portal_field" });
    await expect(submitGuestForm(r, guest, workspace, { operationId: randomUUID(), portalId: clinic, recordId: visibleRecord, expectedVersion: version, recordVersion: 1, values: { "core:notes": "javascript:alert(1)" } })).rejects.toMatchObject({ code: "guest_portal_link" });
    expect(JSON.stringify((await db.query("SELECT payload FROM hs_guest_portal_drafts")).rows)).not.toContain("javascript:");
    expect(JSON.stringify((await db.query("SELECT payload FROM hs_guest_portal_drafts")).rows)).not.toContain("hidden-salary-value");
    const formId = randomUUID();
    const form = shown(await submitGuestForm(r, guest, workspace, { operationId: formId, portalId: clinic, recordId: visibleRecord, expectedVersion: version, recordVersion: 1, values: { "core:notes": "Partner note https://partner.example/hours" } }));
    const replay = await submitGuestForm(r, guest, workspace, { operationId: formId, portalId: clinic, recordId: visibleRecord, expectedVersion: version, recordVersion: 1, values: { "core:notes": "Partner note https://partner.example/hours" } });
    expect(replay).toMatchObject({ replayed: true, id: form.id, accessGranted: false });
    expect(num((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_guest_portal_submissions WHERE portal_id=$1", [clinic])).rows[0].n)).toBe(1);
    expect(await valueOf(visibleRecord, "core:notes")).toBe(beforeRecords);
    expect(await valueOf(visibleRecord, secretField)).toBe("hidden-salary-value");
    await expect(addGuestComment(r, guest, workspace, { operationId: randomUUID(), portalId: clinic, recordId: visibleRecord, expectedVersion: version, body: "javascript:alert(1)" })).rejects.toMatchObject({ code: "guest_portal_link" });
    const comment = shown(await addGuestComment(r, guest, workspace, { operationId: randomUUID(), portalId: clinic, recordId: visibleRecord, expectedVersion: version, body: "See https://partner.example/hours" }));
    expect(comment.body).toContain("https://partner.example/hours");
    expect(comment.accessGranted).toBe(false);
    const file = await citeGuestFile(r, guest, workspace, { operationId: randomUUID(), portalId: clinic, recordId: visibleRecord, expectedVersion: version, name: "Partner brief.pdf" });
    expect(file).toMatchObject({ fetched: false, name: "Partner brief.pdf" });
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(citeGuestFile(r, guest, workspace, { operationId: randomUUID(), portalId: clinic, recordId: visibleRecord, expectedVersion: version, name: "https://partner.example/file.pdf" })).rejects.toMatchObject({ code: "guest_portal_link" });
    await expect(downloadGuestPortal(r, guest, workspace, { operationId: randomUUID(), portalId: clinic, expectedVersion: version, urlToken: clinic, domain: "partner.example" })).rejects.toMatchObject({ code: "action_forbidden" });
    await db.query("UPDATE hs_data_record_grants SET capabilities=$3 WHERE tenant_id=$1 AND record_id=$2 AND user_id=$4", [tenant, visibleRecord, ["view", "edit", "export", "history"], guest.id]);
    const downloaded = shown(await downloadGuestPortal(r, guest, workspace, { operationId: randomUUID(), portalId: clinic, expectedVersion: version }));
    expect(downloaded.body).toContain("Sharing: off");
    expect(downloaded.body).toContain("Cache: no-store");
    expect(downloaded.body).toContain("Visible note");
    expect(downloaded.body).not.toContain("hidden-salary-value");
    expect(downloaded.accessGranted).toBe(false);
    expect((await db.query("SELECT id::text, parent_organisation_id::text FROM hs_data_records WHERE parent_organisation_id IS NOT NULL")).rows).toEqual(beforeParents);
    const expiredPortal = shown(await saveGuestPortal(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, name: "Expired portal", definition: portalDefinition(visibleRecord, 1) }));
    await linkGuestIdentity(r, owner, workspace, { operationId: randomUUID(), portalId: expiredPortal.id, expectedVersion: 1, suiteSubject: guest.id });
    await db.query("INSERT INTO hs_guest_portal_grants(id, tenant_id, portal_id, suite_subject, state, starts_at, expires_at) VALUES($1,$2,$3,$4,'current', clock_timestamp() - interval '48 hours', clock_timestamp() + interval '1 day')", [randomUUID(), tenant, expiredPortal.id, guest.id]);
    await expect(submitGuestForm(r, guest, workspace, { operationId: randomUUID(), portalId: expiredPortal.id, recordId: visibleRecord, expectedVersion: 2, recordVersion: 1, values: { "core:notes": "Too late" } })).rejects.toMatchObject({ code: "not_found" });
  } finally { fetchSpy.mockRestore(); }
});

it("previews, pauses, and revokes with audit and cache invalidation while sharing stays off", async () => {
  const before = await footprint();
  const version = num((await db.query<{ version: number }>("SELECT version FROM hs_guest_portals WHERE id=$1", [clinic])).rows[0].version);
  const generation = num((await db.query<{ cache_generation: number }>("SELECT cache_generation FROM hs_guest_portals WHERE id=$1", [clinic])).rows[0].cache_generation);
  const previewId = randomUUID();
  const preview = shown(await previewGuestPortal(r, owner, workspace, { operationId: previewId, portalId: clinic, expectedVersion: version }));
  const previewAgain = await previewGuestPortal(r, owner, workspace, { operationId: previewId, portalId: clinic, expectedVersion: version });
  expect(previewAgain).toMatchObject({ replayed: true, id: preview.id, cacheGeneration: preview.cacheGeneration, sharing: "off", accessGranted: false, admitted: false });
  expect(preview.cacheGeneration).toBe(generation + 1);
  expect(preview.audience).toBe("admin-preview");
  expect(JSON.stringify(preview.records)).toContain("Visible note");
  const pauseId = randomUUID();
  const paused = shown(await pauseGuestPortal(r, owner, workspace, { operationId: pauseId, portalId: clinic, expectedVersion: preview.version }));
  expect(paused).toMatchObject({ status: "paused", sharing: "off", accessGranted: false });
  expect(paused.cacheGeneration).toBe(preview.cacheGeneration + 1);
  await expect(openGuestPortal(r, guest, workspace, clinic, { urlToken: clinic, domain: "partner.example" })).rejects.toMatchObject({ code: "not_found" });
  const revoked = shown(await revokeGuestPortal(r, owner, workspace, { operationId: randomUUID(), portalId: clinic, expectedVersion: paused.version }));
  expect(revoked).toMatchObject({ status: "revoked", sharing: "off" });
  expect(revoked.cacheGeneration).toBe(paused.cacheGeneration + 1);
  await expect(openGuestPortal(r, guest, workspace, clinic)).rejects.toMatchObject({ code: "not_found" });
  await expect(activateGuestPortal(r, owner, workspace, { operationId: randomUUID(), portalId: clinic, expectedVersion: revoked.version })).rejects.toMatchObject({ code: "guest_portal_sharing" });
  const row = await db.query<{ status: string; sharing: string; version: number; cache_generation: number }>("SELECT status, sharing, version, cache_generation FROM hs_guest_portals WHERE id=$1", [clinic]);
  expect(row.rows[0]).toMatchObject({ status: "revoked", sharing: "off", version: revoked.version, cache_generation: revoked.cacheGeneration });
  const audit = await db.query<{ action: string; actor_id: string; after_value: { source?: string; atIst?: string; operationId?: string; cacheGeneration?: number } }>("SELECT action, actor_id, after_value FROM hs_audit WHERE subject_id=$1 AND action LIKE 'guest-portal.%' ORDER BY created_at", [clinic]);
  const actions = audit.rows.map(item => item.action);
  expect(actions).toEqual(expect.arrayContaining(["guest-portal.preview", "guest-portal.pause", "guest-portal.revoke", "guest-portal.activate-refused"]));
  for (const item of audit.rows.filter(entry => ["guest-portal.preview", "guest-portal.pause", "guest-portal.revoke"].includes(entry.action))) {
    const after = typeof item.after_value === "string" ? JSON.parse(item.after_value) : item.after_value;
    expect(item.actor_id).toBe(owner.id);
    expect(after.source).toBe("guest-portal");
    expect(after.atIst).toMatch(/IST$/);
    expect(after.operationId).toBeTruthy();
    expect(after.accessGranted).toBe(false);
  }
  expect(await footprint()).toBe(before);
});

it("enforces tenant, record, field, and action checks without turning configuration into access", async () => {
  const before = await footprint();
  await grantGuestPortalManager(r, owner, workspace, { operationId: randomUUID(), userId: editor.id });
  await setGuestPortalActions(r, owner, workspace, { operationId: randomUUID(), userId: editor.id, expectedVersion: 0, actions: ["search"] });
  expect(await footprint()).toBe(before);
  await db.query("INSERT INTO hs_data_record_grants(tenant_id, record_id, user_id, capabilities) VALUES($1,$2,$3,$4)", [tenant, visibleRecord, editor.id, ["view"]]);
  const found = await searchGuestPortals(r, editor, workspace, "visible note");
  expect(found.results.map(result => result.name)).toContain("Clinic portal");
  expect(JSON.stringify(await searchGuestPortals(r, editor, workspace, "hidden-salary"))).not.toContain("hidden-salary");
  expect(JSON.stringify(await searchGuestPortals(r, editor, workspace, "zzsecret"))).not.toContain("zzsecretrecord");
  await expect(downloadGuestPortal(r, editor, workspace, { operationId: randomUUID(), portalId: clinic, expectedVersion: num((await db.query<{ version: number }>("SELECT version FROM hs_guest_portals WHERE id=$1", [clinic])).rows[0].version) })).rejects.toMatchObject({ code: "action_forbidden" });
  await expect(guestPortalHistory(r, editor, workspace, clinic)).rejects.toMatchObject({ code: "action_forbidden" });
  await expect(searchGuestPortals(r, outsider, workspace, "clinic")).rejects.toMatchObject({ code: "not_found" });
  expect((await searchGuestPortals(r, outsider, "ws-b", "clinic")).results).toEqual([]);
  await expect(openGuestPortal(r, editor, workspace, clinic)).rejects.toMatchObject({ code: "not_found" });
  const grantsAfter = await footprint();
  expect(grantsAfter).not.toBe(before);
  const recordGrants = JSON.parse(grantsAfter).records as { user_id: string }[];
  expect(recordGrants.filter(grant => grant.user_id === editor.id)).toHaveLength(1);
  expect(JSON.parse(grantsAfter).portalGrants).toBe(JSON.parse(before).portalGrants);
  expect(JSON.parse(grantsAfter).invitations).toBe(0);
});

it("versions configuration, keeps recoverable drafts, and audits actor, source, time, and operation", async () => {
  const before = await footprint();
  const operationId = randomUUID();
  const saved = shown(await saveGuestPortal(r, owner, workspace, { operationId, expectedVersion: 0, name: "Audited portal", definition: portalDefinition() }));
  const replayed = await saveGuestPortal(r, owner, workspace, { operationId, expectedVersion: 0, name: "Audited portal", definition: portalDefinition() });
  expect(replayed).toMatchObject({ replayed: true, id: saved.id, version: saved.version });
  expect(num((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_guest_portals WHERE id=$1", [saved.id])).rows[0].n)).toBe(1);
  await expect(saveGuestPortal(r, owner, workspace, { operationId, expectedVersion: 1, name: "Audited portal", definition: portalDefinition() })).rejects.toMatchObject({ code: "operation_mismatch" });
  await expect(saveGuestPortal(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, name: "Stale portal", definition: portalDefinition() })).resolves.toMatchObject({ version: 1 });
  await expect(saveGuestPortal(r, owner, workspace, { operationId: randomUUID(), portalId: saved.id, expectedVersion: 0, name: "Audited portal renamed", definition: portalDefinition() })).rejects.toMatchObject({ code: "guest_portal_conflict" });
  const catalogue = await guestPortalCatalogue(r, owner, workspace);
  expect(catalogue.drafts.some(draft => draft.portalKey === saved.id && draft.kind === "configure")).toBe(true);
  expect(catalogue.sharing).toBe("off");
  expect(catalogue.recoverable).toContain("draft");
  const history = await guestPortalHistory(r, owner, workspace, saved.id);
  expect(history.events.some(event => event.action === "configure" && event.source === "guest-portal" && event.actorId === owner.id && /IST$/.test(event.atIst))).toBe(true);
  const audit = await db.query<{ actor_id: string; after_value: { source?: string; operationId?: string; atIst?: string } }>("SELECT actor_id, after_value FROM hs_audit WHERE action='guest-portal.configure' AND subject_id=$1", [saved.id]);
  const after = typeof audit.rows[0].after_value === "string" ? JSON.parse(audit.rows[0].after_value) : audit.rows[0].after_value;
  expect(audit.rows[0].actor_id).toBe(owner.id);
  expect(after).toMatchObject({ source: "guest-portal", accessGranted: false, sharing: "off" });
  expect(after.atIst).toMatch(/IST$/);
  expect(after.operationId).toBe(operationId);
  await expect(db.query("UPDATE hs_guest_portal_revisions SET name='rewritten' WHERE portal_id=$1", [saved.id])).rejects.toThrow(/immutable/i);
  const sql = await readFile("db/132_guest_portals.sql", "utf8");
  const executable = sql.replace(/--.*$/gm, "");
  expect(executable).not.toMatch(/hs_data_periodic_review_schedules/);
  expect(executable).not.toMatch(/parent_organisation_id/);
  expect(executable).not.toMatch(/release\.py/);
  for (const statement of statements(sql)) await db.query(statement);
  expect((await db.query<{ definition: { paused?: boolean } }>("SELECT definition FROM hs_data_periodic_review_schedules WHERE id=$1", [scheduleId])).rows[0].definition).toMatchObject({ paused: true });
  expect((await db.query<{ parent_organisation_id: string }>("SELECT parent_organisation_id::text FROM hs_data_records WHERE id=$1", [accountRecord])).rows[0].parent_organisation_id).toBe(organisationRecord);
  expect(JSON.parse(await footprint()).schedules).toEqual(JSON.parse(before).schedules);
});

function num(value: number | string) { return Number(value); }
