import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError, plainText, stableStringify, type RichNode } from "./document";
import {
  NOT_ALLOWED,
  PAGE_HIDDEN,
  VARIANT_IN_TRASH,
  WORKSPACE_HIDDEN,
  canonicalLanguage,
  languageLabel,
  publicationLineDiff,
  staleBadge,
  variantBannerMessage,
  variantRoute,
  variantStayLabel,
  type VariantRouting,
} from "./document-variant-copy";
import { formatIst } from "./ist-label";
import type { Repository } from "./repository";
import { canEdit } from "./types";

const hidden = () => new DocumentError(PAGE_HIDDEN, "not_found", 404);
const workspaceHidden = () => new DocumentError(WORKSPACE_HIDDEN, "not_found", 404);
const notAllowed = () => new DocumentError(NOT_ALLOWED, "not_allowed", 403);
const mismatch = () => new DocumentError("This language variant attempt was reused with different fields.", "operation_mismatch", 409);
const invalid = () => new DocumentError("Invalid language variant operation", "invalid_variant", 400);
const languageField = z.string().min(2).max(35);
const pageCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("link"), operationId: z.string().uuid(), variantPageId: z.string().min(1).max(200), variantLanguage: languageField, sourceLanguage: languageField.optional() }).strict(),
  z.object({ action: z.literal("mark-synced"), operationId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("choose"), operationId: z.string().uuid(), choice: z.string().min(2).max(35) }).strict(),
]);
const routingCommand = z.object({ operationId: z.string().uuid(), routing: z.enum(["banner", "auto"]) }).strict();
const profileCommand = z.object({ operationId: z.string().uuid(), language: z.string().max(35).nullable() }).strict();

type PageRow = { id: string; workspace_id: string; owner_id: string; role: string; title: string };
type MemberRow = {
  page_id: string;
  group_id: string;
  lang: string;
  is_source: boolean;
  synced_source_version: number | null;
  trashed: boolean;
};

export type VariantSwitcherItem = { language: string; label: string; pageId: string; current: boolean };
export type VariantView = {
  pageId: string;
  canLink: boolean;
  canMarkSynced: boolean;
  canSetRouting: boolean;
  routing: VariantRouting;
  profileLanguage: string | null;
  sourceLanguage: string | null;
  currentLanguage: string | null;
  switcher: VariantSwitcherItem[];
  banner: { pageId: string; language: string; label: string; message: string; stayLabel: string } | null;
  redirectTo: { pageId: string; language: string; remember: boolean } | null;
  trashNotes: { label: string; message: typeof VARIANT_IN_TRASH }[];
  stale: { badge: string; syncedVersion: number | null; sourceVersion: number; diffHref: string | null } | null;
};

type VariantCommandResult = {
  replayed: boolean;
  pageId?: string;
  variantPageId?: string;
  groupId?: string;
  sourceLanguage?: string;
  variantLanguage?: string;
  syncedSourceVersion?: number | null;
  sourcePageId?: string;
  sourceVersion?: number;
  choice?: string;
  workspaceId?: string;
  routing?: "banner" | "auto";
  language?: string | null;
};

function asResult(value: Record<string, unknown> & { replayed: boolean }): VariantCommandResult {
  return value;
}

const hash = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex");

function storedResult(value: unknown) {
  return typeof value === "string" ? JSON.parse(value) as Record<string, unknown> : value as Record<string, unknown>;
}

function asNumber(value: number | string | null | undefined) {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function requireLanguage(value: string) {
  const canonical = canonicalLanguage(value);
  if (!canonical) throw new DocumentError("Enter a BCP-47 language code.", "variant_validation", 400);
  return canonical;
}

async function audit(tx: Sql, actorId: string, action: string, pageId: string | null, operationId: string, after: Record<string, unknown>) {
  await tx.query("INSERT INTO hs_audit(id,actor_id,action,page_id,after_value,correlation_id) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), actorId, action, pageId, JSON.stringify({ ...after, atIst: formatIst(new Date()) }), operationId]);
}

async function opened(r: Repository, tx: Sql, pageId: string, actor: Actor, edit = false, lock = false) {
  try {
    return await r.access(tx, pageId, actor, edit, lock) as PageRow;
  } catch (error) {
    if (error instanceof DocumentError && error.status === 404) throw error;
    if (error instanceof DocumentError && error.status === 403) throw notAllowed();
    throw error;
  }
}

async function members(tx: Sql, pageId: string) {
  return (await tx.query<MemberRow>(`SELECT m.page_id, m.group_id, m.lang, m.is_source, m.synced_source_version, p.deleted_at IS NOT NULL AS trashed
    FROM hs_variant_members m
    JOIN hs_pages p ON p.id = m.page_id
    WHERE m.group_id = (SELECT group_id FROM hs_variant_members WHERE page_id = $1)`, [pageId])).rows;
}

async function liveVersion(tx: Sql, pageId: string) {
  const rows = await tx.query<{ version_number: number | null }>(`SELECT pub.version_number
    FROM hs_document_workflows w
    JOIN hs_document_publications pub ON pub.id = w.publication_id AND pub.page_id = w.page_id
    WHERE w.page_id = $1`, [pageId]);
  return asNumber(rows.rows[0]?.version_number);
}

async function routingMode(tx: Sql, workspaceId: string): Promise<VariantRouting> {
  const rows = await tx.query<{ routing: VariantRouting }>("SELECT routing FROM hs_workspace_variant_settings WHERE workspace_id = $1", [workspaceId]);
  return rows.rows[0]?.routing === "auto" ? "auto" : "banner";
}

async function canManageRouting(tx: Sql, workspaceId: string, actor: Actor) {
  const rows = await tx.query<{ role: string }>("SELECT role FROM hs_members WHERE workspace_id = $1 AND user_id = $2 AND active = true", [workspaceId, actor.id]);
  return rows.rows[0]?.role === "owner" || rows.rows[0]?.role === "admin";
}

async function profileLanguage(tx: Sql, actorId: string) {
  const rows = await tx.query<{ preferred_language: string | null }>("SELECT preferred_language FROM hs_users WHERE id = $1", [actorId]);
  return rows.rows[0]?.preferred_language ?? null;
}

async function rememberedChoice(tx: Sql, actorId: string, groupId: string) {
  const rows = await tx.query<{ choice: string }>("SELECT choice FROM hs_reader_variant_choices WHERE user_id = $1 AND group_id = $2", [actorId, groupId]);
  return rows.rows[0]?.choice ?? null;
}

async function prior(tx: Sql, table: "hs_variant_operations" | "hs_workspace_variant_operations" | "hs_profile_language_operations", key: string, keyValue: string, operationId: string, actorId: string, requestHash: string) {
  const column = table === "hs_variant_operations" ? "page_id" : table === "hs_workspace_variant_operations" ? "workspace_id" : "user_id";
  const rows = await tx.query<{ actor_id: string; request_hash: string; result: unknown }>(`SELECT actor_id, request_hash, result FROM ${table} WHERE ${column} = $1 AND operation_id = $2`, [keyValue, operationId]);
  if (!rows.rows.length) return null;
  const previous = rows.rows[0];
  if (previous.actor_id !== actorId || previous.request_hash !== requestHash) throw mismatch();
  return asResult({ ...storedResult(previous.result), replayed: true });
}

export async function variantView(r: Repository, actor: Actor, pageId: string): Promise<VariantView> {
  return r.db.transaction(async tx => {
    const page = await opened(r, tx, pageId, actor);
    const group = await members(tx, pageId);
    const routing = await routingMode(tx, page.workspace_id);
    const preferred = await profileLanguage(tx, actor.id);
    const manageable = await canManageRouting(tx, page.workspace_id, actor);
    const empty: VariantView = {
      pageId: page.id,
      canLink: page.role === "owner",
      canMarkSynced: false,
      canSetRouting: manageable,
      routing,
      profileLanguage: preferred,
      sourceLanguage: null,
      currentLanguage: null,
      switcher: [],
      banner: null,
      redirectTo: null,
      trashNotes: [],
      stale: null,
    };
    if (!group.length) return empty;
    const source = group.find(member => member.is_source);
    const current = group.find(member => member.page_id === page.id);
    if (!source || !current) return empty;
    const switcher: VariantSwitcherItem[] = [];
    const trashNotes: VariantView["trashNotes"] = [];
    for (const member of [...group].sort((a, b) => Number(b.is_source) - Number(a.is_source) || a.lang.localeCompare(b.lang))) {
      if (member.trashed) {
        if (page.role === "owner") trashNotes.push({ label: languageLabel(member.lang), message: VARIANT_IN_TRASH });
        continue;
      }
      if (member.page_id === page.id) {
        switcher.push({ language: member.lang, label: languageLabel(member.lang), pageId: member.page_id, current: true });
        continue;
      }
      try {
        await r.access(tx, member.page_id, actor);
        switcher.push({ language: member.lang, label: languageLabel(member.lang), pageId: member.page_id, current: false });
      } catch (error) {
        if (error instanceof DocumentError && (error.status === 404 || error.status === 403)) continue;
        throw error;
      }
    }
    const remembered = await rememberedChoice(tx, actor.id, current.group_id);
    const route = variantRoute({
      routing,
      profileLanguage: preferred,
      remembered,
      currentLanguage: current.lang,
      options: switcher.map(item => ({ language: item.language, pageId: item.pageId })),
    });
    const bannerItem = route.bannerLanguage ? switcher.find(item => item.language === route.bannerLanguage) ?? null : null;
    let stale: VariantView["stale"] = null;
    if (!current.is_source) {
      const sourceVersion = await liveVersion(tx, source.page_id);
      const syncedVersion = asNumber(current.synced_source_version);
      if (sourceVersion != null && (syncedVersion == null || syncedVersion < sourceVersion)) {
        let sourceReadable = false;
        try {
          await r.access(tx, source.page_id, actor);
          sourceReadable = true;
        } catch (error) {
          if (!(error instanceof DocumentError) || (error.status !== 404 && error.status !== 403)) throw error;
        }
        stale = {
          badge: staleBadge(source.lang, syncedVersion, sourceVersion),
          syncedVersion,
          sourceVersion,
          diffHref: canEdit(page.role) && sourceReadable && syncedVersion != null ? `/pages/${encodeURIComponent(page.id)}?variantDiff=${syncedVersion}-${sourceVersion}` : null,
        };
      }
    }
    return {
      ...empty,
      canMarkSynced: Boolean(stale) && canEdit(page.role),
      sourceLanguage: source.lang,
      currentLanguage: current.lang,
      switcher,
      trashNotes,
      stale,
      redirectTo: route.redirectTo,
      banner: bannerItem ? {
        pageId: bannerItem.pageId,
        language: bannerItem.language,
        label: bannerItem.label,
        message: variantBannerMessage(bannerItem.label),
        stayLabel: variantStayLabel(source.lang),
      } : null,
    };
  });
}

async function record(tx: Sql, table: "hs_variant_operations" | "hs_workspace_variant_operations" | "hs_profile_language_operations", key: string, keyValue: string, operationId: string, actorId: string, requestHash: string, result: Record<string, unknown>) {
  const column = table === "hs_variant_operations" ? "page_id" : table === "hs_workspace_variant_operations" ? "workspace_id" : "user_id";
  await tx.query(`INSERT INTO ${table}(${column}, operation_id, actor_id, request_hash, result) VALUES($1,$2,$3,$4,$5)`, [keyValue, operationId, actorId, requestHash, JSON.stringify(result)]);
}

export async function changeVariants(r: Repository, actor: Actor, pageId: string, input: unknown): Promise<VariantCommandResult> {
  const parsed = pageCommand.safeParse(input);
  if (!parsed.success) throw invalid();
  const command = parsed.data;
  const requestHash = hash(command);
  return r.db.transaction(async tx => {
    const page = await opened(r, tx, pageId, actor, command.action !== "choose", true);
    const replay = await prior(tx, "hs_variant_operations", "page_id", pageId, command.operationId, actor.id, requestHash);
    if (replay) return replay;
    if (command.action === "link") {
      if (page.role !== "owner") throw notAllowed();
      if (command.variantPageId === pageId) throw new DocumentError("Choose a different page.", "variant_validation", 400);
      const variant = await opened(r, tx, command.variantPageId, actor, true, true);
      if (variant.workspace_id !== page.workspace_id) throw hidden();
      const variantLanguage = requireLanguage(command.variantLanguage);
      const existing = await members(tx, pageId);
      const variantGroup = await tx.query<{ group_id: string }>("SELECT group_id FROM hs_variant_members WHERE page_id = $1", [variant.id]);
      if (variantGroup.rows.length && (!existing.length || variantGroup.rows[0].group_id !== existing[0].group_id)) throw new DocumentError("This page is already linked to a document.", "variant_conflict", 409);
      let groupId = existing[0]?.group_id ?? "";
      let sourceLanguage: string;
      if (!existing.length) {
        if (!command.sourceLanguage) throw new DocumentError("Choose the source language.", "variant_validation", 400);
        sourceLanguage = requireLanguage(command.sourceLanguage);
        if (sourceLanguage === variantLanguage) throw new DocumentError("Choose a different language for the variant.", "variant_validation", 400);
        groupId = randomUUID();
        await tx.query("INSERT INTO hs_variant_groups(id, workspace_id, created_by) VALUES($1,$2,$3)", [groupId, page.workspace_id, actor.id]);
        await tx.query("INSERT INTO hs_variant_members(page_id, group_id, lang, is_source, synced_source_version) VALUES($1,$2,$3,true,NULL)", [page.id, groupId, sourceLanguage]);
      } else {
        const source = existing.find(member => member.is_source);
        if (!source || source.page_id !== page.id) throw new DocumentError("This page is already linked to a document.", "variant_conflict", 409);
        sourceLanguage = source.lang;
        if (command.sourceLanguage && requireLanguage(command.sourceLanguage) !== sourceLanguage) throw new DocumentError("The source language does not match this document.", "variant_conflict", 409);
        if (variantLanguage === sourceLanguage || existing.some(member => member.lang === variantLanguage)) throw new DocumentError("This language is already linked.", "variant_conflict", 409);
        if (existing.length >= 24) throw new DocumentError("This document already has its language variants.", "variant_limit", 422);
      }
      const syncedSourceVersion = await liveVersion(tx, page.id);
      try {
        await tx.query("INSERT INTO hs_variant_members(page_id, group_id, lang, is_source, synced_source_version) VALUES($1,$2,$3,false,$4)", [variant.id, groupId, variantLanguage, syncedSourceVersion]);
      } catch (error) {
        if ((error as { code?: string }).code === "23505") throw new DocumentError("This page is already linked to a document.", "variant_conflict", 409);
        throw error;
      }
      const result = { pageId: page.id, variantPageId: variant.id, groupId, sourceLanguage, variantLanguage, syncedSourceVersion, replayed: false };
      await record(tx, "hs_variant_operations", "page_id", pageId, command.operationId, actor.id, requestHash, result);
      await audit(tx, actor.id, "variant.link", page.id, command.operationId, { pageId: page.id, variantPageId: variant.id, groupId, sourceLanguage, variantLanguage, syncedSourceVersion });
      return result;
    }
    const group = await members(tx, pageId);
    const self = group.find(member => member.page_id === page.id);
    const source = group.find(member => member.is_source);
    if (!self || !source) throw new DocumentError("This page has no language variants.", "variant_missing", 422);
    if (command.action === "mark-synced") {
      if (!canEdit(page.role) || self.is_source) throw notAllowed();
      const sourceVersion = await liveVersion(tx, source.page_id);
      if (sourceVersion == null) throw new DocumentError("The source has no published version.", "variant_unpublished", 422);
      try { await r.access(tx, source.page_id, actor); } catch (error) {
        if (error instanceof DocumentError && (error.status === 404 || error.status === 403)) throw hidden();
        throw error;
      }
      await tx.query("UPDATE hs_variant_members SET synced_source_version = $2 WHERE page_id = $1", [page.id, sourceVersion]);
      const result = { pageId: page.id, sourcePageId: source.page_id, sourceVersion, replayed: false };
      await record(tx, "hs_variant_operations", "page_id", pageId, command.operationId, actor.id, requestHash, result);
      await audit(tx, actor.id, "variant.mark-synced", page.id, command.operationId, { pageId: page.id, sourcePageId: source.page_id, sourceVersion });
      return result;
    }
    const choice = command.choice === "source" ? "source" : requireLanguage(command.choice);
    if (choice !== "source") {
      const target = group.find(member => member.lang === choice && !member.trashed);
      if (!target) throw hidden();
      try { await r.access(tx, target.page_id, actor); } catch (error) {
        if (error instanceof DocumentError && (error.status === 404 || error.status === 403)) throw hidden();
        throw error;
      }
    }
    await tx.query(`INSERT INTO hs_reader_variant_choices(user_id, group_id, choice) VALUES($1,$2,$3)
      ON CONFLICT(user_id, group_id) DO UPDATE SET choice = EXCLUDED.choice, updated_at = clock_timestamp()`, [actor.id, self.group_id, choice]);
    const result = { pageId: page.id, choice, replayed: false };
    await record(tx, "hs_variant_operations", "page_id", pageId, command.operationId, actor.id, requestHash, result);
    await audit(tx, actor.id, "variant.choose", page.id, command.operationId, { pageId: page.id, groupId: self.group_id, choice });
    return result;
  });
}

export async function changeVariantRouting(r: Repository, actor: Actor, workspaceId: string, input: unknown): Promise<VariantCommandResult> {
  const parsed = routingCommand.safeParse(input);
  if (!parsed.success) throw invalid();
  const command = parsed.data;
  const requestHash = hash(command);
  return r.db.transaction(async tx => {
    const member = await tx.query<{ role: string }>("SELECT m.role FROM hs_workspaces w JOIN hs_members m ON m.workspace_id = w.id AND m.user_id = $2 AND m.active = true WHERE w.id = $1", [workspaceId, actor.id]);
    if (!member.rows.length) throw workspaceHidden();
    const replay = await prior(tx, "hs_workspace_variant_operations", "workspace_id", workspaceId, command.operationId, actor.id, requestHash);
    if (replay) return replay;
    if (member.rows[0].role !== "owner" && member.rows[0].role !== "admin") throw notAllowed();
    await tx.query(`INSERT INTO hs_workspace_variant_settings(workspace_id, routing, updated_by) VALUES($1,$2,$3)
      ON CONFLICT(workspace_id) DO UPDATE SET routing = EXCLUDED.routing, updated_by = EXCLUDED.updated_by, updated_at = clock_timestamp()`, [workspaceId, command.routing, actor.id]);
    const result = { workspaceId, routing: command.routing, replayed: false };
    await record(tx, "hs_workspace_variant_operations", "workspace_id", workspaceId, command.operationId, actor.id, requestHash, result);
    await audit(tx, actor.id, "variant.routing", null, command.operationId, { workspaceId, routing: command.routing });
    return result;
  });
}

export async function changeProfileLanguage(r: Repository, actor: Actor, input: unknown): Promise<VariantCommandResult> {
  const parsed = profileCommand.safeParse(input);
  if (!parsed.success) throw invalid();
  const command = parsed.data;
  const requestHash = hash(command);
  const language = command.language == null || command.language === "" ? null : requireLanguage(command.language);
  return r.db.transaction(async tx => {
    const user = await tx.query("SELECT id FROM hs_users WHERE id = $1", [actor.id]);
    if (!user.rows.length) throw hidden();
    const replay = await prior(tx, "hs_profile_language_operations", "user_id", actor.id, command.operationId, actor.id, requestHash);
    if (replay) return replay;
    await tx.query("UPDATE hs_users SET preferred_language = $2 WHERE id = $1", [actor.id, language]);
    const result = { language, replayed: false };
    await record(tx, "hs_profile_language_operations", "user_id", actor.id, command.operationId, actor.id, requestHash, result);
    await audit(tx, actor.id, "variant.profile-language", null, command.operationId, { language });
    return result;
  });
}

export async function variantPublicationDiff(r: Repository, actor: Actor, pageId: string, fromVersion: number, toVersion: number) {
  if (!Number.isInteger(fromVersion) || !Number.isInteger(toVersion) || fromVersion < 1 || toVersion < 1 || fromVersion > 100000 || toVersion > 100000) throw invalid();
  return r.db.transaction(async tx => {
    const page = await opened(r, tx, pageId, actor);
    if (!canEdit(page.role)) throw notAllowed();
    const group = await members(tx, pageId);
    const self = group.find(member => member.page_id === page.id);
    const source = group.find(member => member.is_source);
    if (!self || !source || self.is_source) throw hidden();
    try { await r.access(tx, source.page_id, actor); } catch (error) {
      if (error instanceof DocumentError && (error.status === 404 || error.status === 403)) throw hidden();
      throw error;
    }
    const rows = await tx.query<{ version_number: number; title: string; document: RichNode | string }>("SELECT version_number, title, document FROM hs_document_publications WHERE page_id = $1 AND version_number = ANY($2::int[])", [source.page_id, [fromVersion, toVersion]]);
    const before = rows.rows.find(row => Number(row.version_number) === fromVersion);
    const after = rows.rows.find(row => Number(row.version_number) === toVersion);
    if (!before || !after) throw hidden();
    const node = (value: RichNode | string) => typeof value === "string" ? JSON.parse(value) as RichNode : value;
    const diff = publicationLineDiff(plainText(node(before.document)), plainText(node(after.document)));
    return { fromVersion, toVersion, sourceLanguage: source.lang, added: diff.added, removedCount: diff.removedCount };
  });
}

export async function notePublishedSourceVersion(tx: Sql, pageId: string, versionNumber: number) {
  if (!Number.isInteger(versionNumber) || versionNumber < 1) return;
  const sources = await tx.query<{ group_id: string; lang: string; owner_id: string }>(`SELECT m.group_id, m.lang, p.owner_id
    FROM hs_variant_members m JOIN hs_pages p ON p.id = m.page_id
    WHERE m.page_id = $1 AND m.is_source AND p.deleted_at IS NULL`, [pageId]);
  const source = sources.rows[0];
  if (!source) return;
  const variants = await tx.query<{ page_id: string; synced_source_version: number | null; owner_id: string }>(`SELECT m.page_id, m.synced_source_version, p.owner_id
    FROM hs_variant_members m JOIN hs_pages p ON p.id = m.page_id
    WHERE m.group_id = $1 AND m.is_source = false AND p.deleted_at IS NULL
      AND (m.synced_source_version IS NULL OR m.synced_source_version < $2)`, [source.group_id, versionNumber]);
  for (const variant of variants.rows) {
    const notice = await tx.query("INSERT INTO hs_variant_stale_notices(page_id, source_version) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING page_id", [variant.page_id, versionNumber]);
    if (!notice.rows.length) continue;
    const summary = staleBadge(source.lang, asNumber(variant.synced_source_version), versionNumber);
    const recipients = new Set([variant.owner_id, source.owner_id]);
    for (const recipientId of recipients) {
      const target = recipientId === variant.owner_id ? variant.page_id : pageId;
      await tx.query("INSERT INTO hs_notifications(id, recipient_id, page_id, kind, summary) VALUES($1,$2,$3,'variant-stale',$4)", [randomUUID(), recipientId, target, summary]);
    }
  }
}
