import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { localActor as owner } from "./auth";
import { createDatabase, type Database } from "./database";
import { unrelatedMetadataRule } from "./dependency-impact-plan";
import {
  acknowledgeDependency,
  dependencyHistory,
  downloadDependencyImpact,
  grantDependencyManager,
  listDependencyImpact,
  mergeDependencySource,
  noteDependencyMaterial,
  noteDependencyMetadata,
  previewDependencyImpact,
  readDependencyEdge,
  reassignDependencyReviewer,
  recordDependencyEdge,
  retireDependencySource,
  saveDependencyEdge,
  stashDependencyEdge,
  traverseDependencyImpact,
} from "./dependency-impact";
import { ensureIds, type RichNode } from "./document";
import { Repository } from "./repository";

let db: Database;
let r: Repository;
const editor = { id: "dep-editor", name: "Ed Editor" };
const observer = { id: "dep-observer", name: "Olivia Observer" };
const outsider = { id: "dep-outsider", name: "Bolt User" };
const workspace = "ws-aplyd";
const space = "space-product";
const text = (value: string): RichNode => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: value }] }] });

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  await r.seedLocal();
  await db.query("UPDATE hs_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [workspace, owner.id]);
  for (const actor of [editor, observer, outsider]) await db.query("INSERT INTO hs_users(id, name) VALUES($1,$2)", [actor.id, actor.name]);
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES($1,$2,'member'),($1,$3,'observer')", [workspace, editor.id, observer.id]);
  await db.query("INSERT INTO hs_workspaces(id, name) VALUES('ws-b','Bolt Logistics')");
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES('ws-b',$1,'admin')", [outsider.id]);
  await db.query("INSERT INTO hs_spaces(id, workspace_id, name) VALUES('space-secret',$1,'Secret space')", [workspace]);
  const tenant = randomUUID();
  await db.query("INSERT INTO hs_data_tenants(id, name) VALUES($1,'Acme')", [tenant]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id, tenant_id, review_reference) VALUES($1,$2,'synthetic')", [workspace, tenant]);
  await db.query("INSERT INTO hs_data_collections(tenant_id, id, name, core) VALUES($1,'contacts','Contacts',true)", [tenant]);
  await db.query("INSERT INTO hs_data_records(id, tenant_id, collection, name, field_values, created_by, updated_by) VALUES($1,$2,'contacts','Hidden clinic',$3::jsonb,$4,$4)", [randomUUID(), tenant, JSON.stringify({ "core:email": "dependency-secret-field@example.com" }), owner.id]);
});
afterAll(async () => db.close());

async function makePage(title: string, body: string | RichNode, readerId?: string) {
  const created = await r.create(owner, title, space);
  const saved = await r.save(created.id, owner, { operationId: randomUUID(), baseVersion: created.version, title, document: ensureIds(typeof body === "string" ? text(body) : body) });
  if (readerId) await db.query("INSERT INTO hs_grants(page_id, subject, role) VALUES($1,$2,'editor')", [saved.page.id, readerId]);
  return saved.page;
}

async function linkTo(sourceId: string, title: string, readerId?: string) {
  const created = await r.create(owner, title, space);
  const saved = await r.save(created.id, owner, {
    operationId: randomUUID(), baseVersion: created.version, title,
    document: ensureIds({ type: "doc", content: [{ type: "pageLink", attrs: { pageId: sourceId } }, { type: "paragraph", content: [{ type: "text", text: `${title} body` }] }] }),
  });
  if (readerId) await db.query("INSERT INTO hs_grants(page_id, subject, role) VALUES($1,$2,'editor')", [saved.page.id, readerId]);
  return saved.page;
}

async function edgeCount(edgeId: string) {
  return Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_dependency_edge_revisions WHERE edge_id=$1", [edgeId])).rows[0].n);
}

it("records explicit link, template, snippet, and synced-source edges without copying bodies or granting access", async () => {
  const source = await makePage("Policy source", "policy-body-sentence", editor.id);
  const dependent = await linkTo(source.id, "Ward page", editor.id);
  const operationId = randomUUID();
  const input = { operationId, kind: "link" as const, sourceId: source.id, sourceRevision: source.version, dependentPageId: dependent.id, reviewerId: editor.id, note: "Ward link" };
  const created = await recordDependencyEdge(r, owner, workspace, input);
  const again = await recordDependencyEdge(r, owner, workspace, input);
  expect(again.replayed).toBe(true);
  expect(again.id).toBe(created.id);
  expect(created).toMatchObject({ kind: "link", sourceId: source.id, sourceRevision: source.version, dependentPageId: dependent.id, reviewerId: editor.id, reviewState: "current" });
  expect(await edgeCount(created.id)).toBe(1);
  const audit = (await db.query<{ actor_id: string; after_value: { source?: string; atIst?: string; operationId?: string } | string }>("SELECT actor_id, after_value FROM hs_audit WHERE action='dependency-impact.record' AND correlation_id=$1", [operationId])).rows;
  const after = typeof audit[0].after_value === "string" ? JSON.parse(audit[0].after_value) as { source: string; atIst: string; operationId: string } : audit[0].after_value;
  expect(audit[0].actor_id).toBe(owner.id);
  expect(after).toMatchObject({ source: "dependency-impact", operationId });
  expect(after.atIst).toMatch(/IST$/);
  const plain = await linkTo(source.id, "Unlinked name");
  await db.query("DELETE FROM hs_blocks WHERE page_id=$1 AND type='pageLink'", [plain.id]);
  await expect(recordDependencyEdge(r, owner, workspace, { ...input, operationId: randomUUID(), dependentPageId: plain.id })).rejects.toMatchObject({ code: "provenance_required" });
  await expect(recordDependencyEdge(r, owner, workspace, { ...input, operationId, note: "Changed" })).rejects.toMatchObject({ code: "operation_mismatch" });
  expect(await edgeCount(created.id)).toBe(1);
  const grantsBefore = (await db.query("SELECT page_id, subject, role FROM hs_grants ORDER BY page_id, subject")).rows;
  await expect(recordDependencyEdge(r, editor, workspace, { ...input, operationId: randomUUID(), note: "Nope" })).rejects.toMatchObject({ code: "management_required" });
  await grantDependencyManager(r, owner, workspace, { operationId: randomUUID(), userId: editor.id });
  expect((await db.query("SELECT page_id, subject, role FROM hs_grants ORDER BY page_id, subject")).rows).toEqual(grantsBefore);
  const hidden = await makePage("zzdependencyhiddentitle", "hidden-body-sentence");
  await expect(r.get(hidden.id, editor)).rejects.toMatchObject({ status: 404 });
  const templateId = randomUUID();
  await db.query("INSERT INTO hs_templates(id, workspace_id, owner_id, name, draft) VALUES($1,$2,$3,'zztemplatetitle',$4::jsonb)", [templateId, workspace, owner.id, JSON.stringify(text("template-body-sentence"))]);
  await db.query("INSERT INTO hs_template_revisions(template_id, version, name, description, document, actor_id) VALUES($1,1,'zztemplatetitle','',$2::jsonb,$3)", [templateId, JSON.stringify(text("template-body-sentence")), owner.id]);
  await db.query("INSERT INTO hs_page_template_sources(page_id, template_id, template_revision) VALUES($1,$2,1)", [dependent.id, templateId]);
  const templateEdge = await recordDependencyEdge(r, owner, workspace, { operationId: randomUUID(), kind: "template", sourceId: templateId, sourceRevision: 1, dependentPageId: dependent.id, reviewerId: owner.id });
  expect(templateEdge.kind).toBe("template");
  const snippetId = "snippet-dep-1";
  const syncedForSnippet = "synced-snippet-dep-1";
  await db.query("INSERT INTO hs_synced_blocks(id, workspace_id, source_page_id, content, version, updated_by, kind) VALUES($1,$2,$3,$4::jsonb,1,$5,'snippet')", [syncedForSnippet, workspace, source.id, JSON.stringify(text("snippet-body-sentence")), owner.id]);
  await db.query("INSERT INTO hs_snippets(id, workspace_id, space_id, title, synced_id, created_by) VALUES($1,$2,'space-secret','zzsnippettitle',$3,$4)", [snippetId, workspace, syncedForSnippet, owner.id]);
  await db.query("INSERT INTO hs_snippet_versions(id, snippet_id, version_number, state, content, created_by) VALUES($1,$2,1,'approved',$3::jsonb,$4)", [randomUUID(), snippetId, JSON.stringify(text("snippet-body-sentence")), owner.id]);
  await db.query("INSERT INTO hs_snippet_placements(page_id, block_id, snippet_id, created_by) VALUES($1,'block-snippet',$2,$3)", [dependent.id, snippetId, owner.id]);
  const snippetEdge = await recordDependencyEdge(r, owner, workspace, { operationId: randomUUID(), kind: "snippet", sourceId: snippetId, sourceRevision: 1, dependentPageId: dependent.id, reviewerId: owner.id });
  expect(snippetEdge.kindLabel).toBe("Snippet");
  const syncedId = "synced-source-dep-1";
  await db.query("INSERT INTO hs_synced_blocks(id, workspace_id, source_page_id, content, version, updated_by) VALUES($1,$2,$3,$4::jsonb,1,$5)", [syncedId, workspace, hidden.id, JSON.stringify(text("synced-body-sentence")), owner.id]);
  await db.query("INSERT INTO hs_synced_placements(page_id, block_id, synced_id) VALUES($1,'block-sync',$2)", [dependent.id, syncedId]);
  const syncedEdge = await recordDependencyEdge(r, owner, workspace, { operationId: randomUUID(), kind: "synced-source", sourceId: syncedId, sourceRevision: 1, dependentPageId: dependent.id, reviewerId: owner.id });
  expect(syncedEdge.kind).toBe("synced-source");
  const seen = await listDependencyImpact(r, editor, workspace, "zz");
  expect(JSON.stringify(seen)).not.toContain("zztemplatetitle");
  expect(JSON.stringify(seen)).not.toContain("zzsnippettitle");
  expect(JSON.stringify(seen)).not.toContain(templateId);
  expect(JSON.stringify(seen)).not.toContain(snippetId);
  expect(JSON.stringify(seen)).not.toContain("template-body-sentence");
  expect(JSON.stringify(seen)).not.toContain("dependency-secret-field@example.com");
  await expect(recordDependencyEdge(r, observer, workspace, { ...input, operationId: randomUUID() })).rejects.toMatchObject({ status: 403, code: "read_only" });
  await expect(recordDependencyEdge(r, outsider, workspace, { ...input, operationId: randomUUID() })).rejects.toMatchObject({ status: 404 });
});

it("marks permitted dependents Needs review only when source material changes", async () => {
  const source = await makePage("Material source", "material-alpha", editor.id);
  const visible = await linkTo(source.id, "Visible dependent", editor.id);
  const hidden = await linkTo(source.id, "zzmaterialhidden");
  const visibleEdge = await recordDependencyEdge(r, owner, workspace, { operationId: randomUUID(), kind: "link", sourceId: source.id, sourceRevision: source.version, dependentPageId: visible.id, reviewerId: editor.id });
  const hiddenEdge = await recordDependencyEdge(r, owner, workspace, { operationId: randomUUID(), kind: "link", sourceId: source.id, sourceRevision: source.version, dependentPageId: hidden.id, reviewerId: editor.id });
  const current = await r.get(source.id, owner);
  const renamed = await r.save(source.id, owner, { operationId: randomUUID(), baseVersion: current.version, title: "Renamed material source", document: current.document });
  const metadata = await noteDependencyMaterial(r, editor, workspace, { operationId: randomUUID(), kind: "link", sourceId: source.id, sourceRevision: renamed.page.version, expectedVersion: visibleEdge.sourceVersion });
  expect(metadata).toMatchObject({ marksReview: false, rule: unrelatedMetadataRule });
  expect((await readDependencyEdge(r, owner, workspace, visibleEdge.id)).reviewState).toBe("current");
  const noted = await noteDependencyMetadata(r, owner, workspace, { operationId: randomUUID(), kind: "link", sourceId: source.id, note: "Catalogued for the ward", expectedVersion: metadata.version });
  expect(noted).toMatchObject({ marksReview: false, rule: unrelatedMetadataRule });
  expect((await readDependencyEdge(r, owner, workspace, visibleEdge.id)).reviewState).toBe("current");
  const changed = await r.save(source.id, owner, { operationId: randomUUID(), baseVersion: renamed.page.version, title: renamed.page.title, document: ensureIds(text("material-beta")) });
  const marked = await noteDependencyMaterial(r, editor, workspace, { operationId: randomUUID(), kind: "link", sourceId: source.id, sourceRevision: changed.page.version, expectedVersion: noted.version });
  expect(marked.marksReview).toBe(true);
  expect(marked.marked.map(item => item.id)).toEqual([visibleEdge.id]);
  expect(JSON.stringify(marked)).not.toContain(hidden.id);
  expect(JSON.stringify(marked)).not.toContain("zzmaterialhidden");
  expect(marked.marked[0].reviewReason).toContain(`revision ${changed.page.version}`);
  expect((await db.query<{ review_state: string }>("SELECT review_state FROM hs_dependency_edges WHERE id=$1", [hiddenEdge.id])).rows[0].review_state).toBe("needs_review");
  expect((await r.get(visible.id, owner)).document.content?.some(node => JSON.stringify(node).includes("material-beta"))).toBe(false);
  const replay = await noteDependencyMaterial(r, editor, workspace, { operationId: marked.marked.length ? (await db.query<{ correlation_id: string }>("SELECT correlation_id FROM hs_audit WHERE action='dependency-impact.material' AND subject_id=$1 ORDER BY created_at DESC LIMIT 1", [visibleEdge.id])).rows[0].correlation_id : randomUUID(), kind: "link", sourceId: source.id, sourceRevision: changed.page.version, expectedVersion: noted.version });
  expect(replay.replayed).toBe(true);
  expect(await edgeCount(visibleEdge.id)).toBe(2);
});

it("requires the exact revisions and reassignment when authority is missing", async () => {
  const source = await makePage("Review source", "review-alpha", editor.id);
  const dependent = await linkTo(source.id, "Review dependent", editor.id);
  const created = await recordDependencyEdge(r, owner, workspace, { operationId: randomUUID(), kind: "link", sourceId: source.id, sourceRevision: source.version, dependentPageId: dependent.id, reviewerId: editor.id });
  const changed = await r.save(source.id, owner, { operationId: randomUUID(), baseVersion: source.version, title: source.title, document: ensureIds(text("review-beta")) });
  const marked = await noteDependencyMaterial(r, owner, workspace, { operationId: randomUUID(), kind: "link", sourceId: source.id, sourceRevision: changed.page.version, expectedVersion: created.sourceVersion });
  const opened = await readDependencyEdge(r, editor, workspace, created.id);
  await expect(acknowledgeDependency(r, editor, workspace, created.id, { operationId: randomUUID(), expectedVersion: opened.version, sourceRevision: source.version, dependentRevision: opened.liveDependentRevision })).rejects.toMatchObject({ code: "review_stale" });
  expect(await edgeCount(created.id)).toBe(2);
  const acked = await acknowledgeDependency(r, editor, workspace, created.id, { operationId: randomUUID(), expectedVersion: opened.version, sourceRevision: opened.liveSourceRevision, dependentRevision: opened.liveDependentRevision });
  expect(acked.reviewState).toBe("acknowledged");
  const bumped = await r.save(dependent.id, owner, { operationId: randomUUID(), baseVersion: dependent.version, title: dependent.title, document: ensureIds(text("dependent-edited")) });
  expect((await readDependencyEdge(r, editor, workspace, created.id)).reviewState).toBe("stale");
  await expect(acknowledgeDependency(r, editor, workspace, created.id, { operationId: randomUUID(), expectedVersion: acked.version, sourceRevision: acked.liveSourceRevision, dependentRevision: opened.liveDependentRevision })).rejects.toMatchObject({ code: "review_stale" });
  const refreshed = await acknowledgeDependency(r, editor, workspace, created.id, { operationId: randomUUID(), expectedVersion: acked.version, sourceRevision: acked.liveSourceRevision, dependentRevision: bumped.page.version });
  expect(refreshed.reviewState).toBe("acknowledged");
  const grantsBefore = (await db.query("SELECT page_id, subject FROM hs_grants")).rows;
  await db.query("DELETE FROM hs_grants WHERE page_id=$1 AND subject=$2", [dependent.id, editor.id]);
  const grantsRevoked = (await db.query("SELECT page_id, subject FROM hs_grants")).rows;
  expect(grantsRevoked).not.toEqual(grantsBefore);
  await expect(acknowledgeDependency(r, editor, workspace, created.id, { operationId: randomUUID(), expectedVersion: refreshed.version, sourceRevision: refreshed.liveSourceRevision, dependentRevision: bumped.page.version })).rejects.toMatchObject({ status: 404 });
  expect((await readDependencyEdge(r, owner, workspace, created.id)).reviewerAuthority).toBe(false);
  const reassigned = await reassignDependencyReviewer(r, owner, workspace, created.id, { operationId: randomUUID(), expectedVersion: refreshed.version, reviewerId: owner.id });
  expect(reassigned.reviewerId).toBe(owner.id);
  expect((await db.query("SELECT page_id, subject FROM hs_grants")).rows).toEqual(grantsRevoked);
  await expect(r.get(dependent.id, editor)).rejects.toMatchObject({ status: 404 });
  const ownerAck = await acknowledgeDependency(r, owner, workspace, created.id, { operationId: randomUUID(), expectedVersion: reassigned.version, sourceRevision: reassigned.liveSourceRevision, dependentRevision: reassigned.liveDependentRevision });
  expect(ownerAck.reviewState).toBe("acknowledged");
  expect(marked.marksReview).toBe(true);
  await db.query("UPDATE hs_members SET role='observer' WHERE workspace_id=$1 AND user_id=$2", [workspace, editor.id]);
  const observerEdge = await recordDependencyEdge(r, owner, workspace, { operationId: randomUUID(), kind: "link", sourceId: source.id, sourceRevision: changed.page.version, dependentPageId: (await linkTo(source.id, "Observer dependent", editor.id)).id, reviewerId: owner.id });
  await db.query("UPDATE hs_dependency_edges SET reviewer_id=$2 WHERE id=$1", [observerEdge.id, editor.id]);
  await expect(acknowledgeDependency(r, editor, workspace, observerEdge.id, { operationId: randomUUID(), expectedVersion: observerEdge.version, sourceRevision: observerEdge.liveSourceRevision, dependentRevision: observerEdge.liveDependentRevision })).rejects.toMatchObject({ code: "review_authority" });
  await db.query("UPDATE hs_members SET role='member' WHERE workspace_id=$1 AND user_id=$2", [workspace, editor.id]);
});

it("traverses cycles, bounds, retired sources, and merged sources without rewriting dependents", async () => {
  const first = await makePage("Cycle A", "cycle-a-body");
  const second = await linkTo(first.id, "Cycle B");
  await r.save(first.id, owner, { operationId: randomUUID(), baseVersion: first.version, title: first.title, document: ensureIds({ type: "doc", content: [{ type: "pageLink", attrs: { pageId: second.id } }, { type: "paragraph", content: [{ type: "text", text: "cycle-a-body" }] }] }) });
  const savedFirst = await r.get(first.id, owner);
  await recordDependencyEdge(r, owner, workspace, { operationId: randomUUID(), kind: "link", sourceId: first.id, sourceRevision: savedFirst.version, dependentPageId: second.id, reviewerId: owner.id });
  await recordDependencyEdge(r, owner, workspace, { operationId: randomUUID(), kind: "link", sourceId: second.id, sourceRevision: second.version, dependentPageId: first.id, reviewerId: owner.id });
  const cycle = await traverseDependencyImpact(r, owner, workspace, { kind: "link", sourceId: first.id, limit: 50 });
  expect(cycle.pages.sort()).toEqual([first.id, second.id].sort());
  expect(cycle.edges.some(item => item.cycle)).toBe(true);
  expect(cycle.truncated).toBe(false);
  const bounded = await traverseDependencyImpact(r, owner, workspace, { kind: "link", sourceId: first.id, limit: 1 });
  expect(bounded.truncated).toBe(true);
  expect(bounded.pages).toHaveLength(1);
  const origin = await makePage("Retire origin", "retire-origin-body");
  const middle = await linkTo(origin.id, "Retire middle");
  const leaf = await linkTo(middle.id, "Retire leaf");
  const originEdge = await recordDependencyEdge(r, owner, workspace, { operationId: randomUUID(), kind: "link", sourceId: origin.id, sourceRevision: origin.version, dependentPageId: middle.id, reviewerId: owner.id });
  await recordDependencyEdge(r, owner, workspace, { operationId: randomUUID(), kind: "link", sourceId: middle.id, sourceRevision: middle.version, dependentPageId: leaf.id, reviewerId: owner.id });
  await retireDependencySource(r, owner, workspace, { operationId: randomUUID(), kind: "link", sourceId: origin.id, expectedVersion: originEdge.sourceVersion });
  const retired = await traverseDependencyImpact(r, owner, workspace, { kind: "link", sourceId: origin.id });
  expect(retired.pages).toEqual([middle.id]);
  expect(retired.edges[0].sourceState).toBe("retired");
  expect(retired.pages).not.toContain(leaf.id);
  const fromMerged = await linkTo(origin.id, "From merged");
  await recordDependencyEdge(r, owner, workspace, { operationId: randomUUID(), kind: "link", sourceId: origin.id, sourceRevision: origin.version, dependentPageId: fromMerged.id, reviewerId: owner.id });
  const survivor = await makePage("Merge survivor", "survivor-body");
  const fromSurvivor = await linkTo(survivor.id, "From survivor");
  await recordDependencyEdge(r, owner, workspace, { operationId: randomUUID(), kind: "link", sourceId: survivor.id, sourceRevision: survivor.version, dependentPageId: fromSurvivor.id, reviewerId: owner.id });
  const before = (await r.get(fromMerged.id, owner)).document;
  await mergeDependencySource(r, owner, workspace, { operationId: randomUUID(), kind: "link", sourceId: origin.id, mergedIntoId: survivor.id, expectedVersion: originEdge.sourceVersion + 1 });
  const merged = await traverseDependencyImpact(r, owner, workspace, { kind: "link", sourceId: origin.id });
  expect(merged.pages).toContain(fromMerged.id);
  expect(merged.pages).toContain(fromSurvivor.id);
  expect(await r.get(fromMerged.id, owner)).toMatchObject({ document: before });
  await db.query("UPDATE hs_pages SET deleted_at=clock_timestamp(), title='zzdeletedsecret' WHERE id=$1", [origin.id]);
  const trashed = await traverseDependencyImpact(r, owner, workspace, { kind: "link", sourceId: origin.id });
  expect(JSON.stringify(trashed)).not.toContain("zzdeletedsecret");
  expect(trashed.edges.every(item => item.sourceState === "retired" || item.sourceId === survivor.id)).toBe(true);
});

it("filters search, preview, download, and history and keeps drafts across a rejected save", async () => {
  const source = await makePage("Search source", "search-body-sentence", editor.id);
  const visible = await linkTo(source.id, "Search visible", editor.id);
  const hidden = await linkTo(source.id, "zzsearchhidden");
  const created = await recordDependencyEdge(r, owner, workspace, { operationId: randomUUID(), kind: "link", sourceId: source.id, sourceRevision: source.version, dependentPageId: visible.id, reviewerId: editor.id, note: "Visible note" });
  await recordDependencyEdge(r, owner, workspace, { operationId: randomUUID(), kind: "link", sourceId: source.id, sourceRevision: source.version, dependentPageId: hidden.id, reviewerId: owner.id, note: "Hidden note" });
  const found = await listDependencyImpact(r, editor, workspace, "Search visible");
  expect(found.edges.map(item => item.id)).toContain(created.id);
  const missed = await listDependencyImpact(r, editor, workspace, "zzsearchhidden");
  expect(missed.edges.map(item => item.id)).not.toContain(created.id);
  expect(JSON.stringify(missed)).not.toContain("zzsearchhidden");
  expect(JSON.stringify(missed)).not.toContain(hidden.id);
  const preview = await previewDependencyImpact(r, editor, workspace, { kind: "link", sourceId: source.id });
  expect(JSON.stringify(preview)).not.toContain(hidden.id);
  expect(JSON.stringify(preview)).not.toContain("search-body-sentence");
  expect(JSON.stringify(preview)).not.toContain("dependency-secret-field@example.com");
  const downloaded = await downloadDependencyImpact(r, editor, workspace, { operationId: randomUUID(), expectedVersion: created.sourceVersion, kind: "link", sourceId: source.id });
  expect(downloaded.body).toContain("Search visible");
  expect(downloaded.body).not.toContain("zzsearchhidden");
  expect(downloaded.body).not.toContain("search-body-sentence");
  expect(downloaded.body).not.toContain("dependency-secret-field@example.com");
  const history = await dependencyHistory(r, editor, workspace, created.id);
  expect(history.events[0]).toMatchObject({ actorId: owner.id, source: "dependency-impact" });
  expect(history.events[0].atIst).toMatch(/IST$/);
  expect(JSON.stringify(history)).not.toContain(hidden.id);
  await expect(readDependencyEdge(r, editor, workspace, randomUUID())).rejects.toMatchObject({ status: 404, message: "Dependency unavailable" });
  await expect(readDependencyEdge(r, outsider, "ws-b", created.id)).rejects.toMatchObject({ status: 404, message: "Dependency unavailable" });
  const operationId = randomUUID();
  const stashed = await stashDependencyEdge(r, owner, workspace, created.id, { operationId, expectedVersion: created.version, note: "Recover this note", reviewerId: owner.id });
  expect(stashed.recoverableDraft?.note).toBe("Recover this note");
  expect((await stashDependencyEdge(r, owner, workspace, created.id, { operationId, expectedVersion: created.version, note: "Recover this note", reviewerId: owner.id })).replayed).toBe(true);
  const before = await edgeCount(created.id);
  await expect(saveDependencyEdge(r, owner, workspace, created.id, { operationId: randomUUID(), expectedVersion: created.version + 9, note: "Nope", reviewerId: owner.id })).rejects.toMatchObject({ code: "dependency_conflict" });
  expect(await edgeCount(created.id)).toBe(before);
  expect((await readDependencyEdge(r, owner, workspace, created.id)).recoverableDraft?.note).toBe("Recover this note");
  const saveId = randomUUID();
  const saved = await saveDependencyEdge(r, owner, workspace, created.id, { operationId: saveId, expectedVersion: created.version, note: "Saved note", reviewerId: editor.id });
  expect(saved.version).toBe(created.version + 1);
  expect(saved.reviewState).not.toBe("needs_review");
  expect(saved.recoverableDraft).toBeNull();
  expect((await saveDependencyEdge(r, owner, workspace, created.id, { operationId: saveId, expectedVersion: created.version, note: "Saved note", reviewerId: editor.id })).replayed).toBe(true);
  expect(await edgeCount(created.id)).toBe(before + 1);
  await expect(saveDependencyEdge(r, owner, workspace, created.id, { operationId: saveId, expectedVersion: created.version, note: "Different", reviewerId: editor.id })).rejects.toMatchObject({ code: "operation_mismatch" });
  expect((await r.get(visible.id, owner)).title).toBe("Search visible");
  await db.query("INSERT INTO hs_grants(page_id, subject, role) VALUES($1,$2,'viewer'),($3,$2,'viewer')", [source.id, observer.id, visible.id]);
  await expect(saveDependencyEdge(r, observer, workspace, created.id, { operationId: randomUUID(), expectedVersion: saved.version, note: "Observer", reviewerId: owner.id })).rejects.toMatchObject({ status: 403 });
});
