import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError, documentBlocks, plainText, stableStringify, validateDocument, type RichNode } from "./document";
import type { Repository } from "./repository";
import { resolveRecordPageRefs, type ResolveRecordInput } from "./record-page-ref-store";
import { previewTrashRestore, restoreTrashBatch } from "./trash";
import {
  NOT_LATEST_BANNER,
  PUBLISHED_NOT_FOUND,
  formatPublishedAt,
  isPublishedSlug,
  parsePublishedPath,
  publishedBanner,
  suggestSlug,
  textDiff,
  valuesAsOf,
  type DiffLine,
  type DraftPublication,
  type PublishedField,
  type PublishedRecord,
  type PublishedResolution,
  type PublishedVersionSummary,
} from "./published-page-shared";

export {
  NOT_LATEST_BANNER,
  PUBLISHED_NOT_FOUND,
  PUBLISHED_NOT_FOUND_TITLE,
  TRASH_MESSAGE,
  UNPUBLISHED_CHANGES,
  UNPUBLISHED_MESSAGE,
  formatPublishedAt,
  parsePublishedPath,
  publishedBanner,
  publishedDocumentMetadata,
  suggestSlug,
  textDiff,
  valuesAsOf,
} from "./published-page-shared";
export type { DiffLine, DraftPublication, PublishedField, PublishedRecord, PublishedResolution, PublishedVersionSummary } from "./published-page-shared";

/** Snapshots point at hs_revisions. HOLY-63 keeps its own review body on /pages/{id}. */
const note = z.string().trim().min(1).max(500);
const operationId = z.string().uuid();
export const publishedCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("publish"), operationId, slug: z.string().trim().min(1).max(80), note, freezeValues: z.boolean() }).strict(),
  z.object({ action: z.literal("republish"), operationId, note, freezeValues: z.boolean() }).strict(),
  z.object({ action: z.literal("unpublish"), operationId, reason: note }).strict(),
  z.object({ action: z.literal("rename"), operationId, slug: z.string().trim().min(1).max(80) }).strict(),
]);
export type PublishedCommand = z.infer<typeof publishedCommand>;

const slugInvalid = () => new DocumentError("Use 3–80 lowercase letters, numbers, and hyphens.", "slug_invalid", 422);
const slugTaken = () => new DocumentError("That address is already used in this space.", "slug_taken", 422);
const ownerRequired = () => new DocumentError("Only the page owner can publish this page.", "stable_url_owner_required", 403);
const conflict = () => new DocumentError("Publishing state changed. Refresh and review before retrying.", "stable_url_conflict", 409);
const hash = (value: unknown) => stableStringify(value);

export function publishedNotFoundResponse() {
  return Response.json(PUBLISHED_NOT_FOUND, { status: 404, headers: { "Cache-Control": "no-store", Vary: "Cookie, Authorization", "X-Robots-Tag": "noindex" } });
}

export function publishedRedirectResponse(request: Request, location: string) {
  const destination = new URL(location, request.url);
  const workspace = new URL(request.url).searchParams.get("workspace");
  if (workspace && !destination.searchParams.has("workspace")) destination.searchParams.set("workspace", workspace);
  return new Response(null, { status: 301, headers: { Location: destination.toString(), "Cache-Control": "no-store", Vary: "Cookie, Authorization" } });
}

type VersionRow = { id: string; version_no: number; revision_id: string; revision_version: number; published_by: string; publisher: string; note: string; freeze_values: unknown; created_at: string | Date };
type FreezeFile = { at: string; blocks: { blockId: string; recordId: string; fields: Record<string, string> }[] };

function revisionKey(pageId: string, version: number) {
  return `${pageId}:${version}`;
}

function asFreeze(value: unknown): FreezeFile | null {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  if (!parsed || typeof parsed !== "object") return null;
  const file = parsed as FreezeFile;
  if (typeof file.at !== "string" || !Array.isArray(file.blocks)) return null;
  return file;
}

function safeJson(value: string) {
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function recordCards(document: RichNode): { blockId: string; input: ResolveRecordInput }[] {
  return documentBlocks(document).flatMap(block => {
    if (block.type !== "recordRef") return [];
    const fields = Array.isArray(block.node.attrs?.fields) ? block.node.attrs.fields.map(String) : [];
    return [{ blockId: block.id, input: { recordId: String(block.node.attrs?.recordId ?? ""), collectionId: String(block.node.attrs?.collectionId ?? ""), fields } }];
  });
}

export function presentRecordCards(cards: { blockId: string; input: ResolveRecordInput }[], resolved: { records: unknown[] }, freeze: FreezeFile | null): PublishedRecord[] {
  return cards.map((card, index) => {
    const row = resolved.records[index] as { status?: string; title?: string; fields?: { key: string; label: string; access: string; value?: string }[] } | undefined;
    const frozen = freeze?.blocks.find(block => block.blockId === card.blockId && block.recordId === card.input.recordId);
    const note = freeze ? valuesAsOf(freeze.at) : null;
    if (!row || row.status !== "visible") return { blockId: card.blockId, status: "restricted", title: null, fields: [], valuesAsOf: null };
    const fields: PublishedField[] = (row.fields ?? []).map(field => {
      if (field.access !== "visible") return { key: field.key, label: field.label, access: "hidden" };
      if (!freeze) return { key: field.key, label: field.label, access: "visible", value: field.value ?? "" };
      if (!frozen || !Object.prototype.hasOwnProperty.call(frozen.fields, field.key)) return { key: field.key, label: field.label, access: "hidden" };
      return { key: field.key, label: field.label, access: "visible", value: frozen.fields[field.key] ?? "" };
    });
    return { blockId: card.blockId, status: "visible", title: row.title ?? "", fields, valuesAsOf: note };
  });
}

async function captureFreeze(tx: Sql, actor: Actor, workspaceId: string, document: RichNode): Promise<FreezeFile> {
  const cards = recordCards(document);
  const resolved = cards.length ? await resolveRecordPageRefs(tx, actor, workspaceId, { records: cards.map(card => card.input), views: [] }) : { records: [] };
  return {
    at: new Date().toISOString(),
    blocks: cards.map((card, index) => {
      const row = resolved.records[index] as { status?: string; fields?: { key: string; access: string; value?: string }[] } | undefined;
      const fields: Record<string, string> = {};
      if (row?.status === "visible") for (const field of row.fields ?? []) if (field.access === "visible") fields[field.key] = field.value ?? "";
      return { blockId: card.blockId, recordId: card.input.recordId, fields };
    }),
  };
}

async function memberWorkspaces(tx: Sql, actorId: string) {
  const rows = await tx.query<{ workspace_id: string }>("SELECT workspace_id FROM hs_members WHERE user_id=$1 AND active=true ORDER BY workspace_id", [actorId]);
  return rows.rows.map(row => row.workspace_id);
}

async function workspaceFor(tx: Sql, actor: Actor, requested: string | null, spaceSlug: string, pageSlug: string) {
  const memberships = await memberWorkspaces(tx, actor.id);
  if (requested) return memberships.includes(requested) ? requested : null;
  if (memberships.length === 1) return memberships[0];
  if (!memberships.length) return null;
  const matches = await tx.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM (
       SELECT s.workspace_id FROM hs_spaces s WHERE s.slug=$1 AND s.workspace_id=ANY($3::text[])
       UNION SELECT r.workspace_id FROM hs_slug_redirects r WHERE r.space_slug=$1 AND r.page_slug=$2 AND r.workspace_id=ANY($3::text[])
     ) hits`,
    [spaceSlug, pageSlug, memberships],
  );
  return matches.rows.length === 1 ? matches.rows[0].workspace_id : null;
}

async function lookupPage(tx: Sql, workspaceId: string, spaceSlug: string, pageSlug: string) {
  const active = await tx.query<{ page_id: string }>(
    `SELECT g.page_id FROM hs_spaces s JOIN hs_page_slugs g ON g.space_id=s.id AND g.slug=$3 AND g.active=true
     WHERE s.workspace_id=$1 AND s.slug=$2`,
    [workspaceId, spaceSlug, pageSlug],
  );
  if (active.rows[0]) return active.rows[0].page_id;
  const redirect = await tx.query<{ page_id: string }>(
    "SELECT page_id FROM hs_slug_redirects WHERE workspace_id=$1 AND space_slug=$2 AND page_slug=$3",
    [workspaceId, spaceSlug, pageSlug],
  );
  return redirect.rows[0]?.page_id ?? null;
}

async function canonical(tx: Sql, pageId: string) {
  const row = await tx.query<{ space_slug: string; page_slug: string; deleted_at: string | null; owner_id: string; workspace_id: string; live: boolean }>(
    `SELECT s.slug AS space_slug, g.slug AS page_slug, p.deleted_at, p.owner_id, p.workspace_id, st.live
     FROM hs_page_slugs g JOIN hs_spaces s ON s.id=g.space_id JOIN hs_pages p ON p.id=g.page_id
     JOIN hs_page_publication_state st ON st.page_id=p.id
     WHERE g.page_id=$1 AND g.active=true`,
    [pageId],
  );
  return row.rows[0] ?? null;
}

async function versions(tx: Sql, pageId: string) {
  const rows = await tx.query<VersionRow>(
    `SELECT v.id, v.version_no, v.revision_id, v.revision_version, v.published_by, u.name AS publisher, v.note, v.freeze_values, v.created_at
     FROM hs_published_versions v JOIN hs_users u ON u.id=v.published_by WHERE v.page_id=$1 ORDER BY v.version_no`,
    [pageId],
  );
  return rows.rows;
}

function summaries(rows: VersionRow[]): PublishedVersionSummary[] {
  return rows.map(row => ({ versionNo: row.version_no, publishedAt: new Date(row.created_at).toISOString(), publishedAtIst: formatPublishedAt(row.created_at), publisher: row.publisher, note: row.note }));
}

async function readable(r: Repository, tx: Sql, pageId: string, actor: Actor) {
  try {
    const page = await r.access(tx, pageId, actor);
    return page.role === "owner" ? "owner" as const : "reader" as const;
  } catch (error) {
    if (error instanceof DocumentError && error.status === 404) return "none" as const;
    throw error;
  }
}

export async function resolvePublishedPage(r: Repository, actor: Actor, input: { workspaceId: string | null; spaceSlug: string; pageSlug: string }): Promise<PublishedResolution> {
  const parsed = parsePublishedPath(input.spaceSlug, input.pageSlug);
  if (!parsed) return { kind: "missing" };
  return r.db.transaction(async tx => {
    const workspaceId = await workspaceFor(tx, actor, input.workspaceId, parsed.spaceSlug, parsed.pageSlug);
    if (!workspaceId) return { kind: "missing" };
    const pageId = await lookupPage(tx, workspaceId, parsed.spaceSlug, parsed.pageSlug);
    if (!pageId) return { kind: "missing" };
    const place = await canonical(tx, pageId);
    if (!place || place.workspace_id !== workspaceId || !place.space_slug) return { kind: "missing" };
    const stablePath = `/s/${place.space_slug}/${place.page_slug}`;
    const pinned = parsed.version ? `${stablePath}@v${parsed.version}` : stablePath;
    const pathDiffers = parsed.spaceSlug !== place.space_slug || parsed.pageSlug !== place.page_slug;
    if (place.deleted_at) {
      if (place.owner_id !== actor.id) return { kind: "missing" };
      if (pathDiffers) return { kind: "redirect", location: pinned };
      return { kind: "trashed", pageId, canonicalPath: `/p/${encodeURIComponent(pageId)}` };
    }
    const access = await readable(r, tx, pageId, actor);
    if (access === "none") return { kind: "missing" };
    if (pathDiffers) return { kind: "redirect", location: pinned };
    if (!place.live) return { kind: "unpublished", pageId, canonicalPath: `/p/${encodeURIComponent(pageId)}`, stablePath };
    const rows = await versions(tx, pageId);
    const latest = rows.at(-1);
    if (!latest) return { kind: "missing" };
    const selected = parsed.version ? rows.find(row => row.version_no === parsed.version) : latest;
    if (!selected) return { kind: "missing" };
    const revision = await tx.query<{ title: string; document: RichNode | string }>("SELECT title, document FROM hs_revisions WHERE page_id=$1 AND version=$2", [pageId, selected.revision_version]);
    if (!revision.rows[0] || selected.revision_id !== revisionKey(pageId, selected.revision_version)) return { kind: "missing" };
    const document = validateDocument(typeof revision.rows[0].document === "string" ? JSON.parse(revision.rows[0].document) : revision.rows[0].document);
    const cards = recordCards(document);
    const freeze = asFreeze(selected.freeze_values);
    let resolved = { records: [] as unknown[] };
    if (cards.length) {
      try { resolved = await resolveRecordPageRefs(tx, actor, workspaceId, { records: cards.map(card => card.input), views: [] }); }
      catch (error) { if (!(error instanceof DocumentError)) throw error; resolved = { records: cards.map(() => ({ status: "restricted" })) }; }
    }
    const latestPath = stablePath;
    return {
      kind: "published",
      pageId,
      title: revision.rows[0].title,
      text: plainText(document),
      versionNo: selected.version_no,
      revisionId: selected.revision_id,
      banner: publishedBanner(selected.created_at, selected.publisher),
      stablePath,
      canonicalPath: `/p/${encodeURIComponent(pageId)}`,
      latest: selected.version_no === latest.version_no,
      notLatestBanner: selected.version_no === latest.version_no ? null : NOT_LATEST_BANNER,
      latestPath,
      versions: summaries(rows),
      records: presentRecordCards(cards, resolved, freeze),
    };
  });
}

export async function draftPublication(r: Repository, actor: Actor, pageId: string): Promise<DraftPublication> {
  return r.db.transaction(async tx => {
    const page = await r.access(tx, pageId, actor);
    const place = await canonical(tx, pageId);
    const rows = place ? await versions(tx, pageId) : [];
    const latest = rows.at(-1);
    const current = await tx.query<{ title: string; document: RichNode | string }>("SELECT title, document FROM hs_revisions WHERE page_id=$1 AND version=$2", [pageId, page.version]);
    const reason = await tx.query<{ unpublish_reason: string | null }>("SELECT unpublish_reason FROM hs_page_publication_state WHERE page_id=$1", [pageId]);
    let publishedText = "";
    if (latest) {
      const revision = await tx.query<{ title: string; document: RichNode | string }>("SELECT title, document FROM hs_revisions WHERE page_id=$1 AND version=$2", [pageId, latest.revision_version]);
      if (revision.rows[0]) {
        const document = validateDocument(typeof revision.rows[0].document === "string" ? JSON.parse(revision.rows[0].document) : revision.rows[0].document);
        publishedText = `${revision.rows[0].title}\n${plainText(document)}`;
      }
    }
    const draftDocument = current.rows[0] ? validateDocument(typeof current.rows[0].document === "string" ? JSON.parse(current.rows[0].document) : current.rows[0].document) : null;
    const draftText = draftDocument ? `${current.rows[0].title}\n${plainText(draftDocument)}` : "";
    const canSeeDraft = page.role === "owner" || page.role === "editor";
    const diff = canSeeDraft && latest && place?.live ? textDiff(publishedText, draftText) : { changed: false, lines: [] as DiffLine[] };
    const stablePath = place?.space_slug ? `/s/${place.space_slug}/${place.page_slug}` : null;
    return {
      canPublish: page.role === "owner",
      suggestedSlug: page.role === "owner" ? suggestSlug(current.rows[0]?.title ?? page.title) : "",
      slug: place?.page_slug ?? null,
      spaceSlug: place?.space_slug ?? null,
      stablePath,
      canonicalPath: `/p/${encodeURIComponent(pageId)}`,
      live: !!place?.live,
      unpublished: !!place && !place.live,
      unpublishReason: page.role === "owner" ? reason.rows[0]?.unpublish_reason ?? null : null,
      versionNo: latest?.version_no ?? null,
      banner: latest && place?.live ? publishedBanner(latest.created_at, latest.publisher) : null,
      unpublishedChanges: canSeeDraft && !!place?.live && diff.changed,
      diff,
      versions: place && (place.live || canSeeDraft) ? summaries(rows) : [],
    };
  });
}

async function requireOwner(r: Repository, tx: Sql, pageId: string, actor: Actor) {
  const page = await r.access(tx, pageId, actor, true, true);
  if (page.role !== "owner") throw ownerRequired();
  return page;
}

async function remember(tx: Sql, pageId: string, actor: Actor, operation: string, requestHash: string) {
  const prior = await tx.query<{ actor_id: string; request_hash: string; result: Record<string, unknown> }>("SELECT actor_id, request_hash, result FROM hs_published_page_operations WHERE page_id=$1 AND operation_id=$2", [pageId, operation]);
  if (!prior.rows[0]) return null;
  if (prior.rows[0].actor_id !== actor.id || prior.rows[0].request_hash !== requestHash) throw new DocumentError("Publication operation was reused with different fields.", "operation_mismatch", 409);
  return { ...prior.rows[0].result, replayed: true };
}

async function finish(tx: Sql, actor: Actor, pageId: string, operation: string, requestHash: string, action: string, result: Record<string, unknown>) {
  await tx.query("INSERT INTO hs_published_page_operations(page_id,operation_id,actor_id,request_hash,result) VALUES($1,$2,$3,$4,$5::jsonb)", [pageId, operation, actor.id, requestHash, JSON.stringify(result)]);
  await tx.query("INSERT INTO hs_audit(id,actor_id,action,page_id,after_value,correlation_id) VALUES($1,$2,$3,$4,$5::jsonb,$6)", [randomUUID(), actor.id, action, pageId, JSON.stringify(result), operation]);
  return { ...result, replayed: false };
}

async function spaceAddress(tx: Sql, spaceId: string) {
  const row = await tx.query<{ id: string; workspace_id: string; slug: string | null }>("SELECT id, workspace_id, slug FROM hs_spaces WHERE id=$1 FOR UPDATE", [spaceId]);
  return row.rows[0] ?? null;
}

function assertSlug(slug: string) {
  if (!isPublishedSlug(slug)) throw slugInvalid();
  return slug;
}

async function claimSlug(tx: Sql, spaceId: string, slug: string, pageId: string) {
  const taken = await tx.query("SELECT page_id FROM hs_page_slugs WHERE space_id=$1 AND slug=$2 AND page_id<>$3", [spaceId, slug, pageId]);
  if (taken.rows.length) throw slugTaken();
  const current = await tx.query<{ space_id: string; slug: string }>("SELECT space_id, slug FROM hs_page_slugs WHERE page_id=$1 AND active=true FOR UPDATE", [pageId]);
  return current.rows[0] ?? null;
}

async function writeSlug(tx: Sql, workspaceId: string, spaceId: string, spaceSlug: string, pageId: string, slug: string, previous: { space_id: string; slug: string } | null) {
  if (previous && previous.space_id === spaceId && previous.slug === slug) return;
  if (previous) {
    const previousSpace = await tx.query<{ slug: string | null }>("SELECT slug FROM hs_spaces WHERE id=$1", [previous.space_id]);
    const previousSpaceSlug = previousSpace.rows[0]?.slug;
    if (previousSpaceSlug) await tx.query("INSERT INTO hs_slug_redirects(workspace_id,space_slug,page_slug,page_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [workspaceId, previousSpaceSlug, previous.slug, pageId]);
    await tx.query("UPDATE hs_page_slugs SET active=false WHERE page_id=$1 AND active=true", [pageId]);
  }
  await tx.query("INSERT INTO hs_page_slugs(space_id,slug,page_id,active) VALUES($1,$2,$3,true) ON CONFLICT(space_id,slug) DO UPDATE SET page_id=EXCLUDED.page_id, active=true WHERE hs_page_slugs.page_id=EXCLUDED.page_id", [spaceId, slug, pageId]);
}

async function insertVersion(tx: Sql, pageId: string, versionNo: number, revisionVersion: number, actorId: string, changeNote: string, freeze: FreezeFile | null, createdAt: string) {
  const id = randomUUID();
  await tx.query(
    "INSERT INTO hs_published_versions(id,page_id,version_no,revision_id,revision_version,published_by,note,freeze_values,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)",
    [id, pageId, versionNo, revisionKey(pageId, revisionVersion), revisionVersion, actorId, changeNote, freeze ? JSON.stringify(freeze) : null, createdAt],
  );
  return { id, revisionId: revisionKey(pageId, revisionVersion), versionNo };
}

export async function changePublishedPage(r: Repository, actor: Actor, pageId: string, input: unknown) {
  const parsed = publishedCommand.safeParse(input);
  if (!parsed.success) throw new DocumentError("Review the publication details and try again.", "stable_url_validation", 422);
  const command = parsed.data;
  const requestHash = hash(command);
  return r.db.transaction(async tx => {
    const page = await requireOwner(r, tx, pageId, actor);
    const replay = await remember(tx, pageId, actor, command.operationId, requestHash);
    if (replay) return replay;
    const space = await spaceAddress(tx, page.space_id);
    if (!space?.slug) throw new DocumentError("Set a space address before publishing.", "space_slug_required", 422);
    const state = await tx.query<{ live: boolean }>("SELECT live FROM hs_page_publication_state WHERE page_id=$1 FOR UPDATE", [pageId]);
    const count = Number((await tx.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM hs_published_versions WHERE page_id=$1", [pageId])).rows[0]?.n ?? 0);
    const revision = await tx.query<{ version: number; document: RichNode | string }>("SELECT version, document FROM hs_revisions WHERE page_id=$1 AND version=$2", [pageId, page.version]);
    if (!revision.rows[0]) throw conflict();
    const document = validateDocument(typeof revision.rows[0].document === "string" ? JSON.parse(revision.rows[0].document) : revision.rows[0].document);
    if (command.action === "unpublish") {
      if (!state.rows[0]?.live) throw conflict();
      await tx.query("UPDATE hs_page_publication_state SET live=false, unpublished_at=clock_timestamp(), unpublish_reason=$2, updated_at=clock_timestamp() WHERE page_id=$1", [pageId, command.reason]);
      return finish(tx, actor, pageId, command.operationId, requestHash, "published-page.unpublish", { pageId, versionNo: count, slug: (await canonical(tx, pageId))?.page_slug ?? null, spaceId: space.id });
    }
    if (command.action === "rename") {
      const slug = assertSlug(command.slug);
      const previous = await claimSlug(tx, space.id, slug, pageId);
      if (!previous) throw conflict();
      await writeSlug(tx, space.workspace_id, space.id, space.slug, pageId, slug, previous);
      return finish(tx, actor, pageId, command.operationId, requestHash, "published-page.rename", { pageId, slug, spaceId: space.id, versionNo: count });
    }
    const stamp = new Date().toISOString();
    const freeze = command.freezeValues ? { ...await captureFreeze(tx, actor, page.workspace_id, document), at: stamp } : null;
    if (command.action === "publish") {
      if (state.rows.length) throw new DocumentError("This page already has a published address. Republish to update it.", "stable_url_exists", 409);
      const slug = assertSlug(command.slug);
      await claimSlug(tx, space.id, slug, pageId);
      const version = await insertVersion(tx, pageId, 1, revision.rows[0].version, actor.id, command.note, freeze, stamp);
      await writeSlug(tx, space.workspace_id, space.id, space.slug, pageId, slug, null);
      await tx.query("INSERT INTO hs_page_publication_state(page_id,live) VALUES($1,true)", [pageId]);
      return finish(tx, actor, pageId, command.operationId, requestHash, "published-page.publish", { pageId, versionNo: version.versionNo, revisionId: version.revisionId, slug, spaceId: space.id, freeze: command.freezeValues });
    }
    if (!state.rows.length) throw conflict();
    const previous = await claimSlug(tx, space.id, (await canonical(tx, pageId))?.page_slug ?? "", pageId);
    if (!previous) throw conflict();
    const version = await insertVersion(tx, pageId, count + 1, revision.rows[0].version, actor.id, command.note, freeze, stamp);
    await tx.query("UPDATE hs_page_publication_state SET live=true, unpublished_at=NULL, unpublish_reason=NULL, updated_at=clock_timestamp() WHERE page_id=$1", [pageId]);
    return finish(tx, actor, pageId, command.operationId, requestHash, "published-page.republish", { pageId, versionNo: version.versionNo, revisionId: version.revisionId, slug: previous.slug, spaceId: space.id, freeze: command.freezeValues });
  });
}

export async function assignSpaceSlug(r: Repository, actor: Actor, spaceId: string, slugInput: string) {
  const slug = assertSlug(slugInput.trim());
  return r.db.transaction(async tx => {
    const space = await tx.query<{ workspace_id: string; slug: string | null }>("SELECT s.workspace_id, s.slug FROM hs_spaces s JOIN hs_members m ON m.workspace_id=s.workspace_id AND m.user_id=$2 AND m.active=true AND m.role<>'observer' WHERE s.id=$1 FOR UPDATE OF s", [spaceId, actor.id]);
    if (!space.rows[0]) throw new DocumentError("Space is restricted or unavailable.", "not_found", 404);
    const workspaceId = space.rows[0].workspace_id;
    if (space.rows[0].slug === slug) return { spaceId, slug, replayed: true };
    const collision = await tx.query("SELECT id FROM hs_spaces WHERE workspace_id=$1 AND slug=$2 AND id<>$3", [workspaceId, slug, spaceId]);
    if (collision.rows.length) throw slugTaken();
    if (space.rows[0].slug) {
      const pages = await tx.query<{ page_id: string; slug: string }>("SELECT g.page_id, g.slug FROM hs_page_slugs g WHERE g.space_id=$1 AND g.active=true", [spaceId]);
      for (const page of pages.rows) await tx.query("INSERT INTO hs_slug_redirects(workspace_id,space_slug,page_slug,page_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [workspaceId, space.rows[0].slug, page.slug, page.page_id]);
    }
    await tx.query("UPDATE hs_spaces SET slug=$2 WHERE id=$1", [spaceId, slug]);
    await tx.query("INSERT INTO hs_audit(id,actor_id,action,page_id,after_value,correlation_id) VALUES($1,$2,'published-page.space-slug',NULL,$3::jsonb,$4)", [randomUUID(), actor.id, JSON.stringify({ spaceId, slug }), randomUUID()]);
    return { spaceId, slug, replayed: false };
  });
}

export async function retargetPublishedPages(tx: Sql, actor: Actor, pageIds: string[], toSpaceId: string, operationId: string) {
  const destination = await tx.query<{ workspace_id: string; slug: string | null }>("SELECT workspace_id, slug FROM hs_spaces WHERE id=$1 FOR UPDATE", [toSpaceId]);
  if (!destination.rows[0]) return;
  let moved = 0;
  for (const pageId of pageIds) {
    const active = await tx.query<{ space_id: string; slug: string; space_slug: string | null; workspace_id: string }>(
      `SELECT g.space_id, g.slug, s.slug AS space_slug, s.workspace_id FROM hs_page_slugs g JOIN hs_spaces s ON s.id=g.space_id WHERE g.page_id=$1 AND g.active=true FOR UPDATE OF g`,
      [pageId],
    );
    const row = active.rows[0];
    if (!row || row.space_id === toSpaceId) continue;
    if (!destination.rows[0].slug) throw new DocumentError("Set a space address before moving a published page.", "space_slug_required", 422);
    if (destination.rows[0].workspace_id !== row.workspace_id) throw conflict();
    const taken = await tx.query("SELECT page_id FROM hs_page_slugs WHERE space_id=$1 AND slug=$2 AND page_id<>$3", [toSpaceId, row.slug, pageId]);
    if (taken.rows.length) throw slugTaken();
    if (row.space_slug) await tx.query("INSERT INTO hs_slug_redirects(workspace_id,space_slug,page_slug,page_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [row.workspace_id, row.space_slug, row.slug, pageId]);
    await tx.query("UPDATE hs_page_slugs SET active=false WHERE page_id=$1 AND active=true", [pageId]);
    await tx.query("INSERT INTO hs_page_slugs(space_id,slug,page_id,active) VALUES($1,$2,$3,true)", [toSpaceId, row.slug, pageId]);
    moved += 1;
  }
  if (moved) await tx.query("INSERT INTO hs_audit(id,actor_id,action,page_id,after_value,correlation_id) VALUES($1,$2,'published-page.move',$3,$4::jsonb,$5)", [randomUUID(), actor.id, pageIds[0] ?? null, JSON.stringify({ pageIds, spaceId: toSpaceId }), operationId]);
}

export async function restorePublishedPage(r: Repository, actor: Actor, pageId: string, operationId: string) {
  const located = await r.db.transaction(async tx => {
    const row = await tx.query<{ workspace_id: string; space_id: string; parent_id: string | null; deletion_batch_id: string | null }>("SELECT workspace_id, space_id, parent_id, deletion_batch_id FROM hs_pages WHERE id=$1 AND owner_id=$2 AND deleted_at IS NOT NULL", [pageId, actor.id]);
    return row.rows[0] ?? null;
  });
  if (!located?.deletion_batch_id) throw new DocumentError("Page not found", "not_found", 404);
  const preview = await previewTrashRestore(r, actor, located.workspace_id, located.deletion_batch_id, { spaceId: located.space_id, parentId: located.parent_id });
  return restoreTrashBatch(r, actor, located.workspace_id, located.deletion_batch_id, { spaceId: located.space_id, parentId: located.parent_id, operationId, expectedTreeVersion: preview.treeVersion, previewDigest: preview.digest, reviewed: true });
}
