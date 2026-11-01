import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CANNOT_ASSIGN_REASON, acknowledgementBannerCopy, acknowledgementCsv, LOST_ACCESS_LABEL } from "./acknowledgement-copy";
import { verifyAcknowledgementChain } from "./acknowledgement-chain";
import { createDatabase, type Database } from "./database";
import { ensureIds } from "./document";
import { changePublishing, publishingState } from "./document-publishing";
import { acknowledgementExport, acknowledgementView, changeAcknowledgement, dueAtFromInput, ipCountryFromHeader, runAcknowledgementReminders } from "./document-acknowledgements";
import { readNotification } from "./notifications";
import { localActor } from "./auth";
import { Repository } from "./repository";
let db: Database;
let r: Repository;
const owner = localActor;
const reviewer = { id: "ack-reviewer" };
const viewer = { id: "ack-viewer" };
const blocked = { id: "ack-blocked" };
const spaceReader = { id: "ack-space-reader" };
const spaceBlocked = { id: "ack-space-blocked" };
const observer = { id: "ack-observer" };
const outsider = { id: "ack-outsider" };
const otherTenant = { id: "ack-other-tenant" };
const workspace = "ws-aplyd";

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  await r.seedLocal();
  for (const actor of [reviewer, viewer, blocked, spaceReader, spaceBlocked, observer, outsider, otherTenant]) {
    await db.query("INSERT INTO hs_users(id,name) VALUES($1,$1)", [actor.id]);
  }
  for (const actor of [reviewer, viewer, blocked, spaceReader, spaceBlocked, observer, outsider]) {
    await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES($1,$2,'member')", [workspace, actor.id]);
  }
  await db.query("UPDATE hs_members SET role='observer' WHERE user_id=$1", [observer.id]);
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES('ws-b','Bolt Logistics')");
  await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES('ws-b',$1,'member')", [otherTenant.id]);
  await db.query("INSERT INTO hs_workspace_groups(id,workspace_id,name) VALUES('group-ops',$1,'Ops team'),('group-foreign','ws-b','Foreign team')", [workspace]);
  await db.query("INSERT INTO hs_workspace_group_members(group_id,user_id) VALUES('group-ops',$1),('group-ops',$2)", [viewer.id, blocked.id]);
  await db.query("INSERT INTO hs_space_members(space_id,user_id,role,granted_by) VALUES('space-product',$1,'viewer',$3),('space-product',$2,'editor',$3),('space-product',$4,'viewer',$3)", [viewer.id, spaceReader.id, owner.id, spaceBlocked.id]);
});
afterAll(async () => db.close());

async function command(pageId: string, fields: Record<string, unknown>, actor = owner) {
  return changePublishing(r, actor, pageId, { operationId: crypto.randomUUID(), expectedVersion: (await publishingState(r, actor, pageId)).version, ...fields });
}
async function fixture(title = "Policy fixture") {
  const page = await r.create(owner, title, "space-product");
  for (const [actor, role] of [[reviewer, "editor"], [viewer, "viewer"], [spaceReader, "viewer"], [observer, "viewer"]] as const) {
    await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,$3)", [page.id, actor.id, role]);
  }
  await command(page.id, { action: "configure", reviewers: [reviewer.id] });
  return page;
}
async function publish(pageId: string, bump?: "major" | "minor") {
  const page = await r.get(pageId, owner);
  const submitted = (await command(pageId, { action: "submit", sourceVersion: page.version })).applied as { reviewId: string; snapshotHash: string };
  const review = { reviewId: submitted.reviewId, snapshotHash: submitted.snapshotHash };
  await command(pageId, { action: "approve", ...review, reason: "Reviewed exact snapshot" }, reviewer);
  await command(pageId, { action: "publish", ...review, ...(bump ? { bump } : {}) });
  return review;
}
async function save(pageId: string, text: string) {
  const page = await r.get(pageId, owner);
  return r.save(pageId, owner, { operationId: crypto.randomUUID(), baseVersion: page.version, title: page.title, document: ensureIds({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }) });
}
const audience = [
  { kind: "group" as const, id: "group-ops" },
  { kind: "user" as const, id: spaceReader.id },
  { kind: "user" as const, id: otherTenant.id },
  { kind: "role" as const, id: "space:viewer" as const },
  { kind: "role" as const, id: "workspace:observer" as const },
  { kind: "space" as const, id: "space-product" },
];

function statements(sql: string) {
  const parts: string[] = [];
  let current = "";
  let dollar = false;
  for (const line of sql.split("\n")) {
    current += `${line}\n`;
    if ((line.split("$$").length - 1) % 2 === 1) dollar = !dollar;
    if (!dollar && line.trim().endsWith(";")) {
      const statement = current.trim();
      if (statement.replace(/^\s*--.*$/gm, "").trim()) parts.push(statement);
      current = "";
    }
  }
  return parts;
}

it("replays the acknowledgement migration and keeps evidence append-only for the app role", async () => {
  const sql = await readFile("db/099_published_acknowledgements.sql", "utf8");
  expect(sql).toContain("REVOKE ALL ON TABLE hs_ack_records FROM hs_app");
  expect(sql).toContain("GRANT SELECT, INSERT ON TABLE hs_ack_records TO hs_app");
  expect(sql).not.toContain("GRANT UPDATE");
  expect(sql).not.toContain("GRANT DELETE");
  const replay = statements(sql);
  for (const statement of replay) await db.query(statement);
  for (const statement of replay) await db.query(statement);
  const columns = await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name='hs_ack_records' AND column_name LIKE '%ip%'");
  expect(columns.rows.map(row => row.column_name)).toEqual(["ip_country"]);
});

it("resolves group, role, space and user audiences and only notifies people who can already read", async () => {
  const page = await fixture("Audience policy");
  await save(page.id, "Visible policy text");
  await publish(page.id);
  const input = { action: "request" as const, operationId: crypto.randomUUID(), dueOn: "2026-11-07", audience };
  const created = await changeAcknowledgement(r, owner, page.id, input);
  const again = await changeAcknowledgement(r, owner, page.id, input);
  expect(again).toMatchObject({ replayed: true, campaignId: created.campaignId });
  expect(created.versionLabel).toBe("v1");
  expect((created.assigned ?? []).map(person => person.userId).sort()).toEqual([observer.id, spaceReader.id, viewer.id].sort());
  expect(created.excluded).toEqual(expect.arrayContaining([
    { userId: blocked.id, name: blocked.id, reason: CANNOT_ASSIGN_REASON },
    { userId: spaceBlocked.id, name: spaceBlocked.id, reason: CANNOT_ASSIGN_REASON },
    { userId: otherTenant.id, name: null, reason: CANNOT_ASSIGN_REASON },
  ]));
  expect(JSON.stringify(created.excluded)).not.toContain("Foreign team");
  const due = await db.query<{ due_at: string }>("SELECT due_at FROM hs_ack_campaigns WHERE id=$1", [created.campaignId]);
  expect(new Date(due.rows[0].due_at).toISOString()).toBe(dueAtFromInput("2026-11-07").toISOString());
  for (const actor of [viewer, spaceReader, observer]) {
    expect((await db.query("SELECT kind,summary FROM hs_notifications WHERE recipient_id=$1 AND kind='acknowledgement'", [actor.id])).rows[0].summary).toBe(acknowledgementBannerCopy("v1"));
    expect((await db.query("SELECT kind FROM hs_ack_email_outbox WHERE recipient_id=$1 AND kind='assigned'", [actor.id])).rows).toHaveLength(1);
  }
  for (const actor of [blocked, spaceBlocked, otherTenant, reviewer]) {
    expect((await db.query("SELECT id FROM hs_notifications WHERE recipient_id=$1 AND page_id=$2 AND kind<>'discussion'", [actor.id, page.id])).rows).toHaveLength(0);
    expect((await db.query("SELECT id FROM hs_ack_email_outbox WHERE recipient_id=$1", [actor.id])).rows).toHaveLength(0);
  }
  expect((await db.query("SELECT subject FROM hs_grants WHERE page_id=$1 AND subject=$2", [page.id, blocked.id])).rows).toHaveLength(0);
  const foreignAudience = await fixture("Foreign audience");
  await publish(foreignAudience.id);
  await expect(changeAcknowledgement(r, owner, foreignAudience.id, { action: "request", operationId: crypto.randomUUID(), dueOn: "2026-11-07", audience: [{ kind: "group", id: "group-foreign" }] })).rejects.toMatchObject({ code: "acknowledgement_audience", status: 422 });
  const audit = JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE correlation_id=$1", [input.operationId])).rows);
  expect(audit).toContain(created.campaignId);
  expect(audit).toContain("IST");
  expect(audit).not.toContain("Visible policy text");
  expect(audit).not.toContain("Audience policy");
});

it("stores a chained acknowledgement with the published content hash and country only", async () => {
  const page = await fixture("Evidence policy");
  await save(page.id, "Accepted policy sentence");
  await publish(page.id);
  const requested = await changeAcknowledgement(r, owner, page.id, { action: "request", operationId: crypto.randomUUID(), dueOn: "2026-11-07", audience: [{ kind: "user", id: viewer.id }, { kind: "user", id: spaceReader.id }] });
  expect(ipCountryFromHeader("203.0.113.10")).toBeNull();
  expect(ipCountryFromHeader("in")).toBe("IN");
  const publication = await db.query<{ id: string; snapshot_hash: string }>("SELECT id,snapshot_hash FROM hs_document_publications WHERE page_id=$1", [page.id]);
  const first = await changeAcknowledgement(r, viewer, page.id, { action: "acknowledge", operationId: crypto.randomUUID(), versionId: publication.rows[0].id, confirm: true, reachedEnd: true }, { ipCountry: "IN" });
  const second = await changeAcknowledgement(r, spaceReader, page.id, { action: "acknowledge", operationId: crypto.randomUUID(), versionId: publication.rows[0].id, confirm: true, reachedEnd: true }, { ipCountry: "203.0.113.10" });
  expect(first.contentHash).toBe(publication.rows[0].snapshot_hash);
  expect(second.ipCountry).toBeNull();
  const evidence = JSON.parse((await acknowledgementExport(r, owner, page.id, "evidence", null)).body) as { chainValid: boolean; records: { ipCountry: string | null; contentHash: string; userId: string; hash: string; prevHash: string }[] };
  expect(evidence.chainValid).toBe(true);
  expect(evidence.records.map(record => record.userId).sort()).toEqual([spaceReader.id, viewer.id].sort());
  expect(evidence.records.find(record => record.userId === viewer.id)?.ipCountry).toBe("IN");
  expect(JSON.stringify(evidence)).not.toContain("203.0.113.10");
  expect(JSON.stringify(evidence)).not.toContain("Accepted policy sentence");
  const broken = verifyAcknowledgementChain(evidence.records.map(record => ({ ...record, hash: "f".repeat(64) })) as never);
  expect(broken.ok).toBe(false);
  const directory = await mkdtemp(join(tmpdir(), "holy64-chain-"));
  const file = join(directory, "evidence.json");
  await writeFile(file, JSON.stringify(evidence));
  const verified = spawnSync(process.execPath, ["scripts/verify-acknowledgement-chain.mjs", file], { encoding: "utf8" });
  expect(verified.stdout.trim()).toBe("chain-ok");
  const tampered = { ...evidence, records: evidence.records.map((record, index) => index === 0 ? { ...record, hash: "a".repeat(64) } : record) };
  await writeFile(file, JSON.stringify(tampered));
  const failed = spawnSync(process.execPath, ["scripts/verify-acknowledgement-chain.mjs", file], { encoding: "utf8" });
  expect(failed.status).toBe(1);
  expect(failed.stdout).toContain("chain-broken");
  await expect(db.query("UPDATE hs_ack_records SET ip_country='US' WHERE campaign_id=$1", [requested.campaignId])).rejects.toThrow("append-only");
  await expect(db.query("DELETE FROM hs_ack_records WHERE campaign_id=$1", [requested.campaignId])).rejects.toThrow("append-only");
});

it("rejects acknowledgement without the confirm gate or the end of a long document", async () => {
  const page = await fixture("Long policy");
  await save(page.id, "A".repeat(1300));
  await publish(page.id);
  const versionId = (await db.query<{ id: string }>("SELECT id FROM hs_document_publications WHERE page_id=$1", [page.id])).rows[0].id;
  await changeAcknowledgement(r, owner, page.id, { action: "request", operationId: crypto.randomUUID(), dueOn: "2026-11-07", audience: [{ kind: "user", id: viewer.id }] });
  await expect(changeAcknowledgement(r, viewer, page.id, { action: "acknowledge", operationId: crypto.randomUUID(), versionId, confirm: false, reachedEnd: true })).rejects.toMatchObject({ code: "acknowledgement_confirm" });
  await expect(changeAcknowledgement(r, viewer, page.id, { action: "acknowledge", operationId: crypto.randomUUID(), versionId, confirm: true, reachedEnd: false, waitedSeconds: 30 })).rejects.toMatchObject({ code: "acknowledgement_unread" });
  const short = await fixture("Short policy");
  await publish(short.id);
  const shortVersion = (await db.query<{ id: string }>("SELECT id FROM hs_document_publications WHERE page_id=$1", [short.id])).rows[0].id;
  await changeAcknowledgement(r, owner, short.id, { action: "request", operationId: crypto.randomUUID(), dueOn: "2026-11-07", audience: [{ kind: "user", id: viewer.id }] });
  const banner = await acknowledgementView(r, viewer, short.id);
  expect(banner).toMatchObject({ scope: "reader", banner: { copy: acknowledgementBannerCopy("v1"), shortDocument: true, status: "pending" } });
  await changeAcknowledgement(r, viewer, short.id, { action: "acknowledge", operationId: crypto.randomUUID(), versionId: shortVersion, confirm: true, reachedEnd: false, waitedSeconds: 30 });
  expect((await acknowledgementView(r, viewer, short.id)).banner?.status).toBe("acknowledged");
});

it("returns the same generic not-found for a non-assignee, a revoked reader, a trashed page and another tenant", async () => {
  const page = await fixture("Guarded policy");
  await save(page.id, "Guarded policy body");
  await publish(page.id);
  const versionId = (await db.query<{ id: string }>("SELECT id FROM hs_document_publications WHERE page_id=$1", [page.id])).rows[0].id;
  const requested = await changeAcknowledgement(r, owner, page.id, { action: "request", operationId: crypto.randomUUID(), dueOn: "2020-01-01", audience: [{ kind: "user", id: viewer.id }] });
  const missingPage = crypto.randomUUID();
  const denied = await changeAcknowledgement(r, outsider, page.id, { action: "acknowledge", operationId: crypto.randomUUID(), versionId, confirm: true, reachedEnd: true }).catch(error => error);
  const unassigned = await changeAcknowledgement(r, reviewer, page.id, { action: "acknowledge", operationId: crypto.randomUUID(), versionId, confirm: true, reachedEnd: true }).catch(error => error);
  const missing = await changeAcknowledgement(r, outsider, missingPage, { action: "acknowledge", operationId: crypto.randomUUID(), versionId, confirm: true, reachedEnd: true }).catch(error => error);
  for (const error of [denied, unassigned, missing]) expect(error).toMatchObject({ status: 404, code: "not_found", message: "Page is restricted or unavailable" });
  expect((await db.query("SELECT id FROM hs_ack_records WHERE campaign_id=$1", [requested.campaignId])).rows).toHaveLength(0);
  await db.query("DELETE FROM hs_grants WHERE page_id=$1 AND subject=$2", [page.id, viewer.id]);
  await expect(changeAcknowledgement(r, viewer, page.id, { action: "acknowledge", operationId: crypto.randomUUID(), versionId, confirm: true, reachedEnd: true })).rejects.toMatchObject({ status: 404, code: "not_found", message: "Page is restricted or unavailable" });
  const ownerDashboard = await acknowledgementView(r, owner, page.id);
  if (ownerDashboard.scope !== "owner") throw new Error("owner dashboard required");
  expect(ownerDashboard.assignments).toEqual([expect.objectContaining({ userId: viewer.id, status: "lost_access", statusLabel: LOST_ACCESS_LABEL })]);
  await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'viewer')", [page.id, viewer.id]);
  await changeAcknowledgement(r, viewer, page.id, { action: "acknowledge", operationId: crypto.randomUUID(), versionId, confirm: true, reachedEnd: true });
  const foreign = await changeAcknowledgement(r, otherTenant, page.id, { action: "acknowledge", operationId: crypto.randomUUID(), versionId, confirm: true, reachedEnd: true }).catch(error => error);
  expect(foreign).toMatchObject({ status: 404, code: "not_found", message: missing.message });
  expect((await db.query("SELECT id FROM hs_ack_records WHERE campaign_id=$1", [requested.campaignId])).rows).toHaveLength(1);
  const note = (await db.query<{ id: string }>("SELECT id FROM hs_notifications WHERE recipient_id=$1 AND page_id=$2 AND kind='acknowledgement'", [viewer.id, page.id])).rows[0];
  await db.query("UPDATE hs_pages SET deleted_at=clock_timestamp() WHERE id=$1", [page.id]);
  expect((await db.query<{ status: string }>("SELECT status FROM hs_ack_campaigns WHERE id=$1", [requested.campaignId])).rows[0].status).toBe("paused");
  const trashed = await readNotification(r, viewer, note.id).catch(error => error);
  const unknownNote = await readNotification(r, viewer, crypto.randomUUID()).catch(error => error);
  expect(trashed).toMatchObject({ status: 404, code: "not_found", message: "Notification unavailable" });
  expect(unknownNote).toMatchObject({ status: 404, code: "not_found", message: trashed.message });
  expect((await db.query("SELECT id FROM hs_ack_records WHERE page_id=$1", [page.id])).rows).toHaveLength(1);
  await db.query("UPDATE hs_pages SET deleted_at=NULL WHERE id=$1", [page.id]);
  expect((await db.query<{ status: string }>("SELECT status FROM hs_ack_campaigns WHERE id=$1", [requested.campaignId])).rows[0].status).toBe("active");
  const resumed = await acknowledgementView(r, viewer, page.id);
  expect(resumed.banner?.status).toBe("acknowledged");
});

it("sends one overdue reminder per IST day and stops after acknowledgement", async () => {
  await db.query("UPDATE hs_ack_campaigns SET status='superseded' WHERE status='active'");
  const page = await fixture("Reminder policy");
  await publish(page.id);
  const versionId = (await db.query<{ id: string }>("SELECT id FROM hs_document_publications WHERE page_id=$1", [page.id])).rows[0].id;
  await changeAcknowledgement(r, owner, page.id, { action: "request", operationId: crypto.randomUUID(), dueOn: "2020-01-01", audience: [{ kind: "user", id: viewer.id }, { kind: "user", id: spaceReader.id }] });
  const now = new Date("2026-11-08T04:30:00.000Z");
  const first = await runAcknowledgementReminders(r, now);
  const second = await runAcknowledgementReminders(r, now);
  expect(first.assigneeReminders).toBe(2);
  expect(first.ownerSummaries).toBe(1);
  expect(second).toMatchObject({ assigneeReminders: 0, ownerSummaries: 0 });
  expect(second.skippedDuplicates).toBeGreaterThan(0);
  expect((await db.query("SELECT id FROM hs_ack_reminders WHERE recipient_id=$1", [viewer.id])).rows).toHaveLength(1);
  expect((await db.query("SELECT summary FROM hs_notifications WHERE recipient_id=$1 AND kind='acknowledgement-overdue'", [owner.id])).rows.at(-1)?.summary).toBe("Overdue acknowledgements: 2");
  const acknowledged = await changeAcknowledgement(r, viewer, page.id, { action: "acknowledge", operationId: crypto.randomUUID(), versionId, confirm: true, reachedEnd: true });
  const nextDay = await runAcknowledgementReminders(r, new Date("2026-11-09T04:30:00.000Z"));
  expect(nextDay.assigneeReminders).toBe(1);
  expect((await db.query("SELECT id FROM hs_ack_reminders WHERE recipient_id=$1 AND campaign_id=(SELECT id FROM hs_ack_campaigns WHERE page_id=$2 AND status='active')", [viewer.id, page.id])).rows).toHaveLength(1);
  const csv = await acknowledgementExport(r, owner, page.id, "csv", "acknowledged");
  expect(csv.body).toContain("name,status,version,acknowledged_at_ist");
  expect(csv.body).toContain(acknowledged.acknowledgedAtIst);
  expect(csv.body).toContain("Acknowledged");
  const dashboard = await acknowledgementView(r, owner, page.id);
  expect(dashboard.scope).toBe("owner");
  if (dashboard.scope === "owner") expect(dashboard.campaign?.completion.label).toBe("1/2");
});

it("requires acknowledgement again for a major version and keeps it for a minor version", async () => {
  const page = await fixture("Versioned policy");
  await save(page.id, "Version one");
  await publish(page.id, "major");
  const firstVersion = (await db.query<{ id: string }>("SELECT id FROM hs_document_publications WHERE page_id=$1", [page.id])).rows[0].id;
  await changeAcknowledgement(r, owner, page.id, { action: "request", operationId: crypto.randomUUID(), dueOn: "2026-11-07", audience: [{ kind: "user", id: viewer.id }] });
  await changeAcknowledgement(r, viewer, page.id, { action: "acknowledge", operationId: crypto.randomUUID(), versionId: firstVersion, confirm: true, reachedEnd: true });
  await save(page.id, "Version four");
  await publish(page.id, "major");
  const reopened = await changeAcknowledgement(r, owner, page.id, { action: "require-reacknowledgement", operationId: crypto.randomUUID() });
  expect(reopened.versionLabel).toBe("v2");
  expect((await db.query("SELECT id FROM hs_ack_records WHERE page_id=$1", [page.id])).rows).toHaveLength(1);
  expect((await acknowledgementView(r, viewer, page.id)).banner).toMatchObject({ status: "pending", copy: acknowledgementBannerCopy("v2") });
  await changeAcknowledgement(r, viewer, page.id, { action: "acknowledge", operationId: crypto.randomUUID(), versionId: reopened.versionId, confirm: true, reachedEnd: true });
  await save(page.id, "Version five");
  await publish(page.id, "minor");
  await expect(changeAcknowledgement(r, owner, page.id, { action: "require-reacknowledgement", operationId: crypto.randomUUID() })).rejects.toMatchObject({ code: "acknowledgement_minor_keeps" });
  expect((await acknowledgementView(r, viewer, page.id)).banner?.status).toBe("acknowledged");
  expect((await db.query("SELECT id FROM hs_ack_records WHERE page_id=$1", [page.id])).rows).toHaveLength(2);
  const evidence = JSON.parse((await acknowledgementExport(r, owner, page.id, "evidence", null)).body) as { chainValid: boolean; records: unknown[] };
  expect(evidence.chainValid).toBe(true);
  expect(evidence.records).toHaveLength(2);
});
