import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { localActor as owner } from "./auth";
import { createDatabase, type Database } from "./database";
import { ensureIds } from "./document";
import { changePublishing, publishingState } from "./document-publishing";
import { Repository } from "./repository";
import { workspaceSearch } from "./workspace-search";
import {
  EXPIRED_BANNER,
  NOT_ALLOWED,
  OWNER_NEEDED,
  PAGE_HIDDEN,
  SPACE_HIDDEN,
  addCalendarMonths,
  formatReviewDate,
  istCalendarDate,
  istHour,
  nextReviewHeader,
  parseCalendarDate,
  reminderPlan,
} from "./page-review-copy";
import { changePageReview, changeSpaceReviewPolicy, pageReviewView, runPageReviewReminders, runWorkspacePageReviewReminders, spaceReviewCsv, spaceReviewDashboard } from "./page-review";

let db: Database;
let r: Repository;
const reviewer = { id: "review-reviewer" };
const viewer = { id: "review-viewer" };
const editor = { id: "review-editor" };
const leader = { id: "review-leader" };
const departed = { id: "review-departed" };
const wsOwner = { id: "review-ws-owner" };
const outsider = { id: "review-outsider" };
const workspace = "ws-aplyd";

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  await r.seedLocal();
  for (const actor of [reviewer, viewer, editor, leader, departed, wsOwner, outsider]) await db.query("INSERT INTO hs_users(id,name) VALUES($1,$1)", [actor.id]);
  for (const actor of [reviewer, viewer, editor, leader, departed]) await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES($1,$2,'member')", [workspace, actor.id]);
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES('ws-review','Review Job'),('ws-b','Bolt Logistics')");
  await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES('ws-review',$1,'member'),('ws-review',$2,'owner'),('ws-b',$3,'member')", [owner.id, wsOwner.id, outsider.id]);
  await db.query("INSERT INTO hs_spaces(id,workspace_id,name) VALUES('space-review','ws-review','Controlled'),('space-controlled','ws-aplyd','Controlled docs')");
  await db.query("INSERT INTO hs_space_members(space_id,user_id,role,granted_by) VALUES('space-review',$1,'leader',$2)", [leader.id, owner.id]);
  await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES('ws-review',$1,'member')", [leader.id]);
  await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES('ws-review',$1,'member')", [departed.id]);
});
afterAll(async () => db.close());

function atIst(isoDate: string, hour: number, minute = 0) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour - 5, minute - 30));
}

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

async function page(title = "P-100", space = "space-product") {
  const created = await r.create(owner, title, space);
  await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'viewer'),($1,$3,'editor')", [created.id, viewer.id, editor.id]);
  return created;
}

it("adds calendar months in IST dates, including month ends", () => {
  expect(addCalendarMonths("2026-11-01", 6)).toBe("2027-05-01");
  expect(formatReviewDate("2027-05-01")).toBe("1 May 2027");
  expect(nextReviewHeader("2027-05-01")).toBe("Next review 1 May 2027");
  expect(addCalendarMonths("2026-01-31", 1)).toBe("2026-02-28");
  expect(addCalendarMonths("2024-01-31", 1)).toBe("2024-02-29");
  expect(addCalendarMonths("2026-03-31", 1)).toBe("2026-04-30");
  expect(addCalendarMonths("2026-08-31", 6)).toBe("2027-02-28");
  expect(addCalendarMonths("2025-12-31", 2)).toBe("2026-02-28");
  expect(parseCalendarDate("2026-02-31")).toBeNull();
  expect(istHour(atIst("2026-11-01", 10))).toBe(10);
  expect(istHour(atIst("2026-11-01", 9, 59))).toBe(9);
  expect(istCalendarDate(atIst("2026-11-01", 10))).toBe("2026-11-01");
  expect(reminderPlan("2027-04-17", "2027-05-01")?.summary).toBe("Review due in 14 days");
  expect(reminderPlan("2027-04-24", "2027-05-01")?.summary).toBe("Review due in 7 days");
  expect(reminderPlan("2027-04-30", "2027-05-01")?.summary).toBe("Review due in 1 day");
  expect(reminderPlan("2027-05-01", "2027-05-01")?.summary).toBe("Review due today");
  expect(reminderPlan("2027-04-18", "2027-05-01")).toBeNull();
  expect(reminderPlan("2027-05-08", "2027-05-01")?.summary).toBe("Review overdue");
  expect(reminderPlan("2027-05-09", "2027-05-01")).toBeNull();
  expect(reminderPlan("2027-05-15", "2027-05-01")?.summary).toBe("Review overdue");
});

it("replays the review migration", async () => {
  const sql = await readFile("db/102_page_review.sql", "utf8");
  expect(sql).toContain("hs_page_review");
  expect(sql).toContain("page-review-reminder");
  const replay = statements(sql);
  for (const statement of replay) await db.query(statement);
  for (const statement of replay) await db.query(statement);
});

it("stores a review cycle as IST calendar dates and audits the dates without the page body", async () => {
  const created = await page("Controlled SOP body should stay out");
  const input = { action: "set" as const, operationId: crypto.randomUUID(), cycleMonths: 6, startsOn: "2026-11-01", expiresOn: "2027-05-01" };
  const saved = await changePageReview(r, owner, created.id, input, atIst("2026-11-01", 10));
  expect(saved).toMatchObject({ nextReviewOn: "2027-05-01", header: "Next review 1 May 2027", replayed: false });
  expect((await changePageReview(r, owner, created.id, input, atIst("2026-11-01", 10))).replayed).toBe(true);
  const stored = await db.query<{ next_review_on: string; expires_on: string }>("SELECT next_review_on::text, expires_on::text FROM hs_page_review WHERE page_id=$1", [created.id]);
  expect(stored.rows[0]).toEqual({ next_review_on: "2027-05-01", expires_on: "2027-05-01" });
  const view = await pageReviewView(r, viewer, created.id, atIst("2026-11-01", 10));
  expect(view.header).toBe("Next review 1 May 2027");
  expect(view.canManage).toBe(false);
  expect(view.note).toBeNull();
  const audit = JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE correlation_id=$1", [input.operationId])).rows);
  expect(audit).toContain("2027-05-01");
  expect(audit).toContain("IST");
  expect(audit).not.toContain("Controlled SOP body should stay out");
  expect((await db.query("SELECT id FROM hs_audit WHERE correlation_id=$1", [input.operationId])).rows).toHaveLength(1);
  const monthEnd = await page("Month end SOP");
  expect((await changePageReview(r, owner, monthEnd.id, { action: "set", operationId: crypto.randomUUID(), cycleMonths: 1, startsOn: "2026-01-31", expiresOn: "2026-12-31" })).nextReviewOn).toBe("2026-02-28");
});

it("advances the next review by one cycle and shows a verified badge to readers", async () => {
  const created = await page("Reviewed SOP");
  await changePageReview(r, owner, created.id, { action: "set", operationId: crypto.randomUUID(), cycleMonths: 6, startsOn: "2026-05-01", expiresOn: "2028-05-01" });
  const note = "Needle review note 67";
  const marked = await changePageReview(r, owner, created.id, { action: "mark-reviewed", operationId: crypto.randomUUID(), note }, atIst("2026-11-01", 10));
  expect(marked).toMatchObject({ nextReviewOn: "2027-05-01", header: "Next review 1 May 2027", reviewedAtIst: "01 Nov 2026, 10:00 IST" });
  const reader = await pageReviewView(r, viewer, created.id, atIst("2026-11-01", 12));
  expect(reader.verified).toBe(true);
  expect(reader.reviewerName).toBe(owner.name);
  expect(reader.reviewedAtIst).toContain("IST");
  expect(reader.header).toBe("Next review 1 May 2027");
  expect(JSON.stringify(reader)).not.toContain(note);
  const ownerView = await pageReviewView(r, owner, created.id, atIst("2026-11-01", 12));
  expect(ownerView.note).toBe(note);
  const audit = JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE action='page-review.mark' AND page_id=$1", [created.id])).rows);
  expect(audit).not.toContain(note);
  expect(audit).toContain("2027-05-01");
});

it("denies review changes for readers and hides unreadable pages with the same not-found shape", async () => {
  const created = await page("Permission SOP");
  const input = { action: "set" as const, operationId: crypto.randomUUID(), cycleMonths: 6, startsOn: "2026-11-01", expiresOn: "2027-05-01" };
  await expect(changePageReview(r, viewer, created.id, input)).rejects.toMatchObject({ message: NOT_ALLOWED, code: "not_allowed", status: 403 });
  await expect(changePageReview(r, editor, created.id, { ...input, operationId: crypto.randomUUID() })).rejects.toMatchObject({ message: NOT_ALLOWED, status: 403 });
  const missingId = crypto.randomUUID();
  const outsiderError = await changePageReview(r, outsider, created.id, { ...input, operationId: crypto.randomUUID() }).then(() => null, error => error);
  const missingError = await changePageReview(r, outsider, missingId, { ...input, operationId: crypto.randomUUID() }).then(() => null, error => error);
  expect(outsiderError).toMatchObject({ message: PAGE_HIDDEN, code: "not_found", status: 404 });
  expect(missingError).toMatchObject({ message: outsiderError.message, code: outsiderError.code, status: outsiderError.status });
  await expect(pageReviewView(r, outsider, created.id)).rejects.toMatchObject({ message: PAGE_HIDDEN, status: 404 });
  await expect(pageReviewView(r, viewer, missingId)).rejects.toMatchObject({ message: PAGE_HIDDEN, status: 404 });
});

it("reminds on the 14, 7, 1 and due days, then daily for seven overdue days and weekly after", async () => {
  await db.query("DELETE FROM hs_page_review WHERE page_id IN (SELECT id FROM hs_pages WHERE workspace_id='ws-review')");
  const created = await r.create(owner, "Cadence SOP", "space-review");
  await changePageReview(r, owner, created.id, { action: "set", operationId: crypto.randomUUID(), cycleMonths: 6, startsOn: "2026-11-01", expiresOn: "2028-05-01" });
  const early = await runPageReviewReminders(r, atIst("2027-04-17", 9, 59), "ws-review");
  expect(early).toEqual({ sent: 0, deferred: true });
  expect((await db.query("SELECT id FROM hs_notifications WHERE page_id=$1 AND kind='page-review-reminder'", [created.id])).rows).toHaveLength(0);
  expect((await runPageReviewReminders(r, atIst("2027-04-17", 10), "ws-review")).sent).toBe(1);
  expect((await runPageReviewReminders(r, atIst("2027-04-17", 11), "ws-review")).sent).toBe(0);
  const days = ["2027-04-18", "2027-04-24", "2027-04-30", "2027-05-01", "2027-05-02", "2027-05-03", "2027-05-04", "2027-05-05", "2027-05-06", "2027-05-07", "2027-05-08", "2027-05-09", "2027-05-15"];
  for (const day of days) await runPageReviewReminders(r, atIst(day, 10), "ws-review");
  const summaries = (await db.query<{ summary: string }>("SELECT n.summary FROM hs_notifications n WHERE n.page_id=$1 AND n.kind='page-review-reminder' ORDER BY n.created_at", [created.id])).rows.map(row => row.summary);
  expect(summaries).toEqual([
    "Review due in 14 days",
    "Review due in 7 days",
    "Review due in 1 day",
    "Review due today",
    ...Array.from({ length: 7 }, () => "Review overdue"),
    "Review overdue",
  ]);
  const audit = JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE action='page-review.remind' AND page_id=$1", [created.id])).rows);
  expect(audit).toContain("IST");
  expect(audit).not.toContain("Cadence SOP");
});

it("routes reminders to the space leader when the owner leaves, and shows Owner needed", async () => {
  await db.query("DELETE FROM hs_page_review WHERE page_id IN (SELECT id FROM hs_pages WHERE workspace_id='ws-review')");
  const created = await r.create(owner, "Departed SOP", "space-review");
  await db.query("UPDATE hs_pages SET owner_id=$2 WHERE id=$1", [created.id, departed.id]);
  await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'viewer')", [created.id, leader.id]);
  await changePageReview(r, departed, created.id, { action: "set", operationId: crypto.randomUUID(), cycleMonths: 6, startsOn: "2026-11-01", expiresOn: "2028-05-01" });
  await db.query("UPDATE hs_members SET active=false WHERE workspace_id='ws-review' AND user_id=$1", [departed.id]);
  expect((await runPageReviewReminders(r, atIst("2027-04-17", 10), "ws-review")).sent).toBe(1);
  const recipients = (await db.query<{ recipient_id: string }>("SELECT recipient_id FROM hs_notifications WHERE page_id=$1 AND kind='page-review-reminder'", [created.id])).rows.map(row => row.recipient_id);
  expect(recipients).toEqual([leader.id]);
  const dashboard = await spaceReviewDashboard(r, leader, "ws-review", "space-review", "open", atIst("2027-04-17", 10));
  expect(dashboard.rows.map(row => row.pageId)).toContain(created.id);
  expect(dashboard.rows.find(row => row.pageId === created.id)?.ownerLabel).toBe(OWNER_NEEDED);
  await db.query("UPDATE hs_space_members SET active=false WHERE space_id='space-review' AND user_id=$1", [leader.id]);
  expect((await runPageReviewReminders(r, atIst("2027-04-24", 10), "ws-review")).sent).toBe(1);
  const fallback = (await db.query<{ recipient_id: string }>("SELECT recipient_id FROM hs_notifications WHERE page_id=$1 AND kind='page-review-reminder' AND summary='Review due in 7 days'", [created.id])).rows.map(row => row.recipient_id);
  expect(fallback).toEqual([wsOwner.id]);
  await db.query("UPDATE hs_space_members SET active=true WHERE space_id='space-review' AND user_id=$1", [leader.id]);
  await db.query("UPDATE hs_members SET active=true WHERE workspace_id='ws-review' AND user_id=$1", [departed.id]);
});

it("skips trashed pages and resumes reminders after restore", async () => {
  await db.query("DELETE FROM hs_page_review WHERE page_id IN (SELECT id FROM hs_pages WHERE workspace_id='ws-review')");
  const created = await r.create(owner, "Trashed SOP", "space-review");
  await changePageReview(r, owner, created.id, { action: "set", operationId: crypto.randomUUID(), cycleMonths: 6, startsOn: "2026-11-01", expiresOn: "2028-05-01" });
  await db.query("UPDATE hs_pages SET deleted_at=clock_timestamp() WHERE id=$1", [created.id]);
  expect((await runPageReviewReminders(r, atIst("2027-04-17", 10), "ws-review")).sent).toBe(0);
  expect((await spaceReviewDashboard(r, owner, "ws-review", "space-review", "all", atIst("2027-04-17", 10))).rows.some(row => row.pageId === created.id)).toBe(false);
  await db.query("UPDATE hs_pages SET deleted_at=NULL WHERE id=$1", [created.id]);
  expect((await runPageReviewReminders(r, atIst("2027-04-17", 10), "ws-review")).sent).toBe(1);
  expect((await spaceReviewDashboard(r, owner, "ws-review", "space-review", "open", atIst("2027-04-17", 10))).rows.some(row => row.pageId === created.id)).toBe(true);
});

it("lists due, overdue and expired pages, filters them, and exports CSV without review notes", async () => {
  const now = atIst("2026-11-01", 10);
  const groups = [
    ["due", "2026-11-08", "2027-11-01"],
    ["overdue", "2026-10-01", "2027-11-01"],
    ["expired", "2027-06-01", "2026-10-01"],
    ["scheduled", "2027-06-01", "2027-11-01"],
  ] as const;
  for (const [status, nextReviewOn, expiresOn] of groups) {
    for (let index = 0; index < 10; index += 1) {
      const id = `controlled-${status}-${index}`;
      await db.query("INSERT INTO hs_pages(id,workspace_id,space_id,owner_id,title) VALUES($1,$2,'space-controlled',$3,$4)", [id, workspace, owner.id, `${status} ${index}`]);
      await db.query("INSERT INTO hs_page_review(page_id,cycle_months,cycle_start_on,next_review_on,expires_on) VALUES($1,6,'2026-05-01',$2,$3)", [id, nextReviewOn, expiresOn]);
    }
  }
  await db.query("INSERT INTO hs_pages(id,workspace_id,space_id,owner_id,title,deleted_at) VALUES('controlled-trashed',$1,'space-controlled',$2,'trashed cycle',clock_timestamp())", [workspace, owner.id]);
  await db.query("INSERT INTO hs_page_review(page_id,cycle_months,cycle_start_on,next_review_on,expires_on,last_review_note) VALUES('controlled-trashed',6,'2026-05-01','2026-10-01','2027-11-01','secret-review-note')");
  const open = await spaceReviewDashboard(r, owner, workspace, "space-controlled", "open", now);
  expect(open.counts).toEqual({ due: 10, overdue: 10, expired: 10, scheduled: 10 });
  expect(open.rows).toHaveLength(30);
  expect(open.rows.some(row => row.pageId === "controlled-trashed")).toBe(false);
  expect((await spaceReviewDashboard(r, owner, workspace, "space-controlled", "due", now)).rows).toHaveLength(10);
  expect((await spaceReviewDashboard(r, owner, workspace, "space-controlled", "overdue", now)).rows).toHaveLength(10);
  expect((await spaceReviewDashboard(r, owner, workspace, "space-controlled", "expired", now)).rows).toHaveLength(10);
  expect((await spaceReviewDashboard(r, owner, workspace, "space-controlled", "all", now)).rows).toHaveLength(40);
  const csv = await spaceReviewCsv(r, owner, workspace, "space-controlled", "due", now);
  expect(csv.body.split("\n").filter(Boolean)).toHaveLength(11);
  expect(csv.body).toContain("controlled-due-0");
  expect(csv.body).not.toContain("secret-review-note");
  expect(csv.body).not.toContain("controlled-trashed");
});

it("returns the same not-found shape for a foreign review dashboard and a missing one", async () => {
  const foreign = await spaceReviewDashboard(r, outsider, workspace, "space-controlled", "open").then(() => null, error => error);
  const missing = await spaceReviewDashboard(r, outsider, crypto.randomUUID(), crypto.randomUUID(), "open").then(() => null, error => error);
  const unknownSpace = await spaceReviewDashboard(r, owner, workspace, crypto.randomUUID(), "open").then(() => null, error => error);
  expect(foreign).toMatchObject({ message: SPACE_HIDDEN, code: "not_found", status: 404 });
  expect(missing).toMatchObject({ message: foreign.message, code: foreign.code, status: foreign.status });
  expect(unknownSpace).toMatchObject({ message: foreign.message, code: foreign.code, status: foreign.status });
  await expect(changeSpaceReviewPolicy(r, viewer, workspace, "space-controlled", { action: "policy", operationId: crypto.randomUUID(), hideExpiredFromReaders: true })).rejects.toMatchObject({ message: NOT_ALLOWED, status: 403 });
  await expect(runWorkspacePageReviewReminders(r, owner, "ws-review", atIst("2026-11-01", 9, 59))).rejects.toMatchObject({ message: NOT_ALLOWED, status: 403 });
  const absentWorkspace = await runWorkspacePageReviewReminders(r, outsider, crypto.randomUUID(), atIst("2026-11-01", 10)).then(() => null, error => error);
  const otherWorkspace = await runWorkspacePageReviewReminders(r, outsider, workspace, atIst("2026-11-01", 10)).then(() => null, error => error);
  expect(otherWorkspace).toMatchObject({ message: absentWorkspace.message, code: absentWorkspace.code, status: 404 });
});

async function publish(pageId: string) {
  const command = async (actor: { id: string }, fields: Record<string, unknown>) => changePublishing(r, actor, pageId, { operationId: crypto.randomUUID(), expectedVersion: (await publishingState(r, actor, pageId)).version, ...fields });
  await command(owner, { action: "configure", reviewers: [reviewer.id] });
  const source = await r.get(pageId, owner);
  const submitted = await command(owner, { action: "submit", sourceVersion: source.version }) as { applied: { reviewId: string; snapshotHash: string } };
  await command(reviewer, { action: "approve", reviewId: submitted.applied.reviewId, snapshotHash: submitted.applied.snapshotHash, reason: "Reviewed exact snapshot" });
  await command(owner, { action: "publish", reviewId: submitted.applied.reviewId, snapshotHash: submitted.applied.snapshotHash });
}

it("badges expired pages in search and can hide them from readers without unpublishing", async () => {
  const created = await r.create(owner, "Expired SOP needle", "space-product");
  const current = await r.get(created.id, owner);
  await r.save(created.id, owner, { operationId: crypto.randomUUID(), baseVersion: current.version, title: "Expired SOP needle", document: ensureIds({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "expired sop needle" }] }] }) });
  await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'viewer'),($1,$3,'editor')", [created.id, viewer.id, reviewer.id]);
  await publish(created.id);
  await changePageReview(r, owner, created.id, { action: "set", operationId: crypto.randomUUID(), cycleMonths: 6, startsOn: "2020-01-01", expiresOn: "2020-07-01" });
  const publicationBefore = (await publishingState(r, owner, created.id)).publicationId;
  expect(publicationBefore).toBeTruthy();
  const reader = await pageReviewView(r, viewer, created.id, atIst("2026-11-01", 10));
  expect(reader.banner).toBe(EXPIRED_BANNER);
  expect(reader.coversPublishedVersion).toBe(true);
  expect((await publishingState(r, owner, created.id)).publicationId).toBe(publicationBefore);
  const visible = await workspaceSearch(r, viewer, { query: "expired sop", workspaceId: workspace });
  expect(visible.results.find(result => result.id === created.id)?.badge).toBe(EXPIRED_BANNER);
  await changeSpaceReviewPolicy(r, owner, workspace, "space-product", { action: "policy", operationId: crypto.randomUUID(), hideExpiredFromReaders: true });
  expect((await workspaceSearch(r, viewer, { query: "expired sop", workspaceId: workspace })).results.some(result => result.id === created.id)).toBe(false);
  const ownerHit = await workspaceSearch(r, owner, { query: "expired sop", workspaceId: workspace });
  expect(ownerHit.results.find(result => result.id === created.id)?.badge).toBe(EXPIRED_BANNER);
  expect((await db.query("SELECT publication_id FROM hs_document_workflows WHERE page_id=$1", [created.id])).rows[0].publication_id).toBe(publicationBefore);
});

it("rejects an invalid calendar date before writing a review", async () => {
  const created = await page("Invalid date SOP");
  await expect(changePageReview(r, owner, created.id, { action: "set", operationId: crypto.randomUUID(), cycleMonths: 6, startsOn: "2026-02-31", expiresOn: "2027-05-01" })).rejects.toMatchObject({ status: 400 });
  expect((await db.query("SELECT page_id FROM hs_page_review WHERE page_id=$1", [created.id])).rows).toHaveLength(0);
});
