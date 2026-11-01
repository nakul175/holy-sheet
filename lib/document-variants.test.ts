import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { localActor as owner } from "./auth";
import { createDatabase, type Database } from "./database";
import { ensureIds } from "./document";
import { changePublishing, publishingState } from "./document-publishing";
import { canonicalLanguage, languageLabel, publicationLineDiff, staleBadge, variantRoute } from "./document-variant-copy";
import { changeProfileLanguage, changeVariantRouting, changeVariants, notePublishedSourceVersion, variantPublicationDiff, variantView } from "./document-variants";
import { PAGE_HIDDEN } from "./document-variant-copy";
import { Repository } from "./repository";
import { workspaceSearch } from "./workspace-search";

let db: Database;
let r: Repository;
const reviewer = { id: "variant-reviewer" };
const viewer = { id: "variant-viewer" };
const editor = { id: "variant-editor" };
const outsider = { id: "variant-outsider" };

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  await r.seedLocal();
  for (const actor of [reviewer, viewer, editor, outsider]) await db.query("INSERT INTO hs_users(id,name) VALUES($1,$1)", [actor.id]);
  for (const actor of [reviewer, viewer, editor]) await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES('ws-aplyd',$1,'member')", [actor.id]);
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES('ws-b','Bolt Logistics')");
  await db.query("INSERT INTO hs_spaces(id,workspace_id,name) VALUES('space-bolt','ws-b','Ops')");
  await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES('ws-b',$1,'member')", [outsider.id]);
});
afterAll(async () => db.close());

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

async function page(title: string, actor = owner, space = "space-product") {
  return r.create(actor, title, space);
}

async function grant(id: string, subject: string, role: "viewer" | "editor") {
  await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,$3)", [id, subject, role]);
}

it("canonicalises BCP-47 tags and builds the stale badge", () => {
  expect(canonicalLanguage("HI")).toBe("hi");
  expect(canonicalLanguage("en-us")).toBe("en-US");
  expect(canonicalLanguage("not a language")).toBeNull();
  expect(languageLabel("en")).toBe("EN");
  expect(languageLabel("hi")).toBe("हिन्दी");
  expect(staleBadge("en", 3, 4)).toBe("Behind English source (v3 → v4)");
  expect(variantRoute({ routing: "banner", profileLanguage: "hi", remembered: null, currentLanguage: "en", options: [{ language: "hi", pageId: "p-110" }] })).toEqual({ redirectTo: null, bannerLanguage: "hi" });
  expect(variantRoute({ routing: "auto", profileLanguage: "hi", remembered: null, currentLanguage: "en", options: [{ language: "hi", pageId: "p-110" }] }).redirectTo).toEqual({ pageId: "p-110", language: "hi", remember: true });
  expect(variantRoute({ routing: "banner", profileLanguage: "hi", remembered: "source", currentLanguage: "en", options: [{ language: "hi", pageId: "p-110" }] })).toEqual({ redirectTo: null, bannerLanguage: null });
  expect(variantRoute({ routing: "banner", profileLanguage: "fr", remembered: null, currentLanguage: "en", options: [{ language: "hi", pageId: "p-110" }] })).toEqual({ redirectTo: null, bannerLanguage: null });
  expect(publicationLineDiff("kept", "kept\nSource v4 body").added).toEqual(["Source v4 body"]);
});

it("replays the variant migration", async () => {
  const sql = await readFile("db/103_document_variants.sql", "utf8");
  expect(sql).toContain("hs_variant_groups");
  expect(sql).toContain("hs_variant_members");
  expect(sql).toContain("synced_source_version");
  expect(sql).toContain("variant-stale");
  const replay = statements(sql);
  for (const statement of replay) await db.query(statement);
  for (const statement of replay) await db.query(statement);
});

it("links a Hindi variant and shows EN | हिन्दी on both pages", async () => {
  const source = await page("SECRET_SOURCE_TITLE");
  const variant = await page("SECRET_VARIANT_TITLE");
  await grant(source.id, viewer.id, "viewer");
  await grant(variant.id, viewer.id, "viewer");
  const input = { action: "link" as const, operationId: crypto.randomUUID(), variantPageId: variant.id, variantLanguage: "HI", sourceLanguage: "EN" };
  const linked = await changeVariants(r, owner, source.id, input);
  expect(linked).toMatchObject({ sourceLanguage: "en", variantLanguage: "hi", replayed: false });
  expect((await changeVariants(r, owner, source.id, input)).replayed).toBe(true);
  const stored = await db.query<{ lang: string; is_source: boolean }>("SELECT lang, is_source FROM hs_variant_members WHERE group_id = $1 ORDER BY is_source DESC, lang", [linked.groupId]);
  expect(stored.rows).toEqual([{ lang: "en", is_source: true }, { lang: "hi", is_source: false }]);
  for (const id of [source.id, variant.id]) {
    const view = await variantView(r, viewer, id);
    expect(view.switcher.map(item => item.label).join(" | ")).toBe("EN | हिन्दी");
    expect(view.switcher.map(item => item.language)).toEqual(["en", "hi"]);
  }
  const audit = JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE correlation_id = $1", [input.operationId])).rows);
  expect(audit).toContain("IST");
  expect(audit).toContain("\"hi\"");
  expect(audit).not.toContain("SECRET_SOURCE_TITLE");
  expect(audit).not.toContain("SECRET_VARIANT_TITLE");
  expect((await db.query("SELECT id FROM hs_audit WHERE correlation_id = $1", [input.operationId])).rows).toHaveLength(1);
  await expect(changeVariants(r, viewer, source.id, { ...input, operationId: crypto.randomUUID() })).rejects.toMatchObject({ message: "Not allowed", status: 403 });
});

it("offers a banner or auto-routes from the reader profile and remembers the choice", async () => {
  const source = await page("Preference source");
  const variant = await page("Preference Hindi");
  await grant(source.id, viewer.id, "viewer");
  await grant(variant.id, viewer.id, "viewer");
  await changeVariants(r, owner, source.id, { action: "link", operationId: crypto.randomUUID(), variantPageId: variant.id, variantLanguage: "hi", sourceLanguage: "en" });
  await changeProfileLanguage(r, viewer, { operationId: crypto.randomUUID(), language: "hi" });
  const banner = await variantView(r, viewer, source.id);
  expect(banner.routing).toBe("banner");
  expect(banner.redirectTo).toBeNull();
  expect(banner.banner).toMatchObject({ pageId: variant.id, language: "hi", label: "हिन्दी" });
  expect(banner.banner?.message).toContain("हिन्दी");
  await db.query("UPDATE hs_members SET role = 'owner' WHERE workspace_id = 'ws-aplyd' AND user_id = $1", [owner.id]);
  const routing = { operationId: crypto.randomUUID(), routing: "auto" as const };
  expect((await changeVariantRouting(r, owner, "ws-aplyd", routing)).routing).toBe("auto");
  expect((await changeVariantRouting(r, owner, "ws-aplyd", routing)).replayed).toBe(true);
  const routed = await variantView(r, viewer, source.id);
  expect(routed.banner).toBeNull();
  expect(routed.redirectTo).toEqual({ pageId: variant.id, language: "hi", remember: true });
  await changeVariants(r, viewer, source.id, { action: "choose", operationId: crypto.randomUUID(), choice: "source" });
  const stayed = await variantView(r, viewer, source.id);
  expect(stayed.redirectTo).toBeNull();
  expect(stayed.banner).toBeNull();
  await changeProfileLanguage(r, viewer, { operationId: crypto.randomUUID(), language: "fr" });
  await changeVariants(r, viewer, source.id, { action: "choose", operationId: crypto.randomUUID(), choice: "source" });
  await db.query("DELETE FROM hs_reader_variant_choices WHERE user_id = $1", [viewer.id]);
  const fallback = await variantView(r, viewer, source.id);
  expect(fallback.redirectTo).toBeNull();
  expect(fallback.banner).toBeNull();
  await changeVariantRouting(r, owner, "ws-aplyd", { operationId: crypto.randomUUID(), routing: "banner" });
  await changeProfileLanguage(r, viewer, { operationId: crypto.randomUUID(), language: null });
});

it("flags a variant behind the published source, notifies the owner, and clears the badge when marked", async () => {
  const source = await page("Stale source");
  const variant = await page("Stale Hindi");
  await grant(source.id, reviewer.id, "editor");
  await grant(source.id, viewer.id, "viewer");
  await grant(source.id, editor.id, "editor");
  await grant(variant.id, reviewer.id, "editor");
  await grant(variant.id, viewer.id, "viewer");
  await grant(variant.id, editor.id, "editor");
  await changePublishing(r, owner, source.id, { action: "configure", operationId: crypto.randomUUID(), expectedVersion: (await publishingState(r, owner, source.id)).version, reviewers: [reviewer.id] });
  for (let version = 0; version < 3; version += 1) await publish(source.id);
  await changeVariants(r, owner, source.id, { action: "link", operationId: crypto.randomUUID(), variantPageId: variant.id, variantLanguage: "hi", sourceLanguage: "en" });
  const saved = await r.get(source.id, owner);
  await r.save(source.id, owner, { operationId: crypto.randomUUID(), baseVersion: saved.version, title: "Source v4 body", document: ensureIds({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Source v4 body" }] }] }) });
  const published = await publish(source.id);
  expect(published.applied).toMatchObject({ versionNumber: 4 });
  const reader = await variantView(r, viewer, variant.id);
  expect(reader.stale?.badge).toBe("Behind English source (v3 → v4)");
  expect(reader.stale?.diffHref).toBeNull();
  expect(reader.canMarkSynced).toBe(false);
  const editing = await variantView(r, editor, variant.id);
  expect(editing.stale?.diffHref).toContain("variantDiff=3-4");
  expect(editing.canMarkSynced).toBe(true);
  const notes = await db.query<{ summary: string }>("SELECT summary FROM hs_notifications WHERE page_id = $1 AND kind = 'variant-stale'", [variant.id]);
  expect(notes.rows.map(row => row.summary)).toContain("Behind English source (v3 → v4)");
  const diff = await variantPublicationDiff(r, editor, variant.id, 3, 4);
  expect(diff.added).toContain("Source v4 body");
  await expect(variantPublicationDiff(r, viewer, variant.id, 3, 4)).rejects.toMatchObject({ message: "Not allowed", status: 403 });
  const mark = { action: "mark-synced" as const, operationId: crypto.randomUUID() };
  const marked = await changeVariants(r, editor, variant.id, mark);
  expect(marked).toMatchObject({ sourceVersion: 4, replayed: false });
  expect((await changeVariants(r, editor, variant.id, mark)).replayed).toBe(true);
  expect((await variantView(r, viewer, variant.id)).stale).toBeNull();
  const audit = JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE correlation_id = $1", [mark.operationId])).rows);
  expect(audit).toContain("\"sourceVersion\":4");
  expect(audit).toContain("IST");
  expect(audit).not.toContain("Source v4 body");
  expect((await db.query("SELECT id FROM hs_audit WHERE correlation_id = $1", [mark.operationId])).rows).toHaveLength(1);
});

async function publish(id: string) {
  const current = await r.get(id, owner);
  const submitted = await changePublishing(r, owner, id, { action: "submit", operationId: crypto.randomUUID(), expectedVersion: (await publishingState(r, owner, id)).version, sourceVersion: current.version });
  const review = submitted.applied as { reviewId: string; snapshotHash: string };
  await changePublishing(r, reviewer, id, { action: "approve", operationId: crypto.randomUUID(), expectedVersion: (await publishingState(r, reviewer, id)).version, reviewId: review.reviewId, snapshotHash: review.snapshotHash, reason: "Independent language review" });
  return changePublishing(r, owner, id, { action: "publish", operationId: crypto.randomUUID(), expectedVersion: (await publishingState(r, owner, id)).version, reviewId: review.reviewId, snapshotHash: review.snapshotHash });
}

it("filters search to Hindi variants and tags the result", async () => {
  const source = await page("English langfacet note");
  const variant = await page("Hindi langfacet note");
  await changeVariants(r, owner, source.id, { action: "link", operationId: crypto.randomUUID(), variantPageId: variant.id, variantLanguage: "hi", sourceLanguage: "en" });
  const filtered = await workspaceSearch(r, owner, { query: "langfacet", workspaceId: "ws-aplyd", language: "hi" });
  expect(filtered.results.map(result => result.id)).toEqual([variant.id]);
  expect(filtered.results[0].language).toBe("hi");
  const both = await workspaceSearch(r, owner, { query: "langfacet", workspaceId: "ws-aplyd" });
  expect(both.results.map(result => result.id).sort()).toEqual([source.id, variant.id].sort());
  expect(both.results.find(result => result.id === variant.id)?.language).toBe("hi");
});

it("omits an unreadable variant from the switcher", async () => {
  const source = await page("Visible source");
  const variant = await page("Private Hindi");
  await grant(source.id, viewer.id, "viewer");
  await changeVariants(r, owner, source.id, { action: "link", operationId: crypto.randomUUID(), variantPageId: variant.id, variantLanguage: "hi", sourceLanguage: "en" });
  const hidden = await variantView(r, viewer, source.id);
  const raw = JSON.stringify(hidden);
  expect(hidden.switcher.map(item => item.language)).toEqual(["en"]);
  expect(raw).not.toContain(variant.id);
  expect(raw).not.toContain("\"hi\"");
  expect(raw).not.toContain("हिन्दी");
  const ownerView = await variantView(r, owner, source.id);
  expect(ownerView.switcher.map(item => item.label).join(" | ")).toBe("EN | हिन्दी");
});

it("drops a trashed variant for readers and tells the owner it is in trash", async () => {
  const source = await page("Trash source");
  const variant = await page("Trash Hindi");
  await grant(source.id, viewer.id, "viewer");
  await grant(variant.id, viewer.id, "viewer");
  await changeVariants(r, owner, source.id, { action: "link", operationId: crypto.randomUUID(), variantPageId: variant.id, variantLanguage: "hi", sourceLanguage: "en" });
  await db.query("UPDATE hs_pages SET deleted_at = clock_timestamp() WHERE id = $1", [variant.id]);
  const reader = await variantView(r, viewer, source.id);
  expect(reader.switcher.map(item => item.language)).toEqual(["en"]);
  expect(reader.trashNotes).toEqual([]);
  expect(JSON.stringify(reader)).not.toContain(variant.id);
  expect(JSON.stringify(reader)).not.toContain("variant in trash");
  const ownerView = await variantView(r, owner, source.id);
  expect(ownerView.switcher.map(item => item.language)).toEqual(["en"]);
  expect(ownerView.trashNotes).toEqual([{ label: "हिन्दी", message: "variant in trash" }]);
});

it("rejects a cross-tenant variant link with the same not-found as a missing page", async () => {
  const source = await page("Tenant source");
  const bolt = await page("Bolt page", outsider, "space-bolt");
  const before = (await db.query<{ page_id: string }>("SELECT page_id FROM hs_variant_members ORDER BY page_id")).rows;
  const input = { action: "link" as const, operationId: crypto.randomUUID(), variantPageId: source.id, variantLanguage: "hi", sourceLanguage: "en" };
  const foreign = await changeVariants(r, outsider, bolt.id, input).then(() => null, error => error);
  const missing = await changeVariants(r, outsider, crypto.randomUUID(), { ...input, operationId: crypto.randomUUID() }).then(() => null, error => error);
  const swapped = await changeVariants(r, owner, source.id, { ...input, operationId: crypto.randomUUID(), variantPageId: bolt.id }).then(() => null, error => error);
  expect(foreign).toMatchObject({ message: PAGE_HIDDEN, code: "not_found", status: 404 });
  expect(missing).toMatchObject({ message: foreign.message, code: foreign.code, status: foreign.status });
  expect(swapped).toMatchObject({ message: foreign.message, code: foreign.code, status: foreign.status });
  expect((await db.query<{ page_id: string }>("SELECT page_id FROM hs_variant_members ORDER BY page_id")).rows).toEqual(before);
  await expect(variantView(r, outsider, source.id)).rejects.toMatchObject({ message: PAGE_HIDDEN, status: 404 });
});

it("clears a revoked reader's variant view with the same not-found as a missing page", async () => {
  const source = await page("Revoke source");
  await grant(source.id, viewer.id, "viewer");
  expect((await variantView(r, viewer, source.id)).pageId).toBe(source.id);
  await db.query("DELETE FROM hs_grants WHERE page_id = $1 AND subject = $2", [source.id, viewer.id]);
  const revoked = await variantView(r, viewer, source.id).then(() => null, error => error);
  const missing = await variantView(r, viewer, crypto.randomUUID()).then(() => null, error => error);
  expect(revoked).toMatchObject({ message: missing.message, code: missing.code, status: missing.status });
});

it("notifies on publish only for variants behind the new source version", async () => {
  const source = await page("Notice source");
  const variant = await page("Notice Hindi");
  await db.query("INSERT INTO hs_variant_groups(id, workspace_id, created_by) VALUES('00000000-0000-4000-8000-000000000068','ws-aplyd',$1)", [owner.id]);
  await db.query("INSERT INTO hs_variant_members(page_id, group_id, lang, is_source) VALUES($1,'00000000-0000-4000-8000-000000000068','en',true)", [source.id]);
  await db.query("INSERT INTO hs_variant_members(page_id, group_id, lang, is_source, synced_source_version) VALUES($1,'00000000-0000-4000-8000-000000000068','hi',false,3)", [variant.id]);
  await db.transaction(async tx => notePublishedSourceVersion(tx, source.id, 4));
  await db.transaction(async tx => notePublishedSourceVersion(tx, source.id, 4));
  const notes = await db.query("SELECT id FROM hs_notifications WHERE page_id = $1 AND kind = 'variant-stale'", [variant.id]);
  expect(notes.rows).toHaveLength(1);
  expect(JSON.stringify((await db.query("SELECT summary FROM hs_notifications WHERE page_id = $1", [variant.id])).rows)).toContain("Behind English source (v3 → v4)");
});
