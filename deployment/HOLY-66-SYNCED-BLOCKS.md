# HOLY-66 synced content blocks

Scope HS-SF-N28-r0-20261031 is still draft. This change implements HS-AC-N28-01 through HS-AC-N28-10 for Holy Sheet pages. HS-AC-N28-11 stays open: Bug Off has not been executed on staging, and local tests are not a Passed result.

Synced blocks extend the HOLY-3 page document, HOLY-4 effective access, and the HOLY-17 conservative merge. They do not add a second editor or page stack. HOLY-65 can reuse `hs_synced_blocks` (`kind` stays `sync` in this change), `hs_synced_placements`, and the resolve path. Snippet approval, versioning, governance, and the snippet library are not in this change.

## What shipped

- An editor selects blocks and chooses **Turn into synced block**. The blocks sit in one container with a coloured border and a **Synced** label. **Copy synced block** copies a placement payload. One undo restores the selection.
- Pasting that payload on another page in the same workspace adds a placement. An edit is stored on `hs_synced_blocks` with an optimistic version. A later save from the same base merges when the blocks differ in different places. Overlapping edits return `synced_conflict` with both versions and leave the stored body unchanged.
- Other open placements poll every 2 seconds (`SYNCED_POLL_MS`), inside the 5-second bound. Both pages record history as `Synced block edited from <origin title>`. The label reads **Synced to N pages** and lists only titles the caller can read.
- **Unsync** copies the current body onto that page and leaves the other placements linked.
- **Delete from this page** removes one placement. **Delete all copies** asks for confirmation that names readable pages and, when needed, `N other pages you can't see`. The block stays as a tombstone for 30 days and can be undone until `purge_after`.
- Edit rights follow the source page, plus explicit editor grants. A person who can edit the placement page but not the block sees the body read-only with **Edit in source**.
- Hidden, deleted, and unknown sync ids resolve to the same `{ state: "restricted", label: "Restricted content" }` with no body in the page JSON. Revoking source access uses that shape on the next read and the editor drops cached text. A trashed source page shows **Synced block unavailable** to readers and **Source in trash — Restore** to an owner who can restore. Restore makes the placements readable again. A foreign or unknown id is rejected with `Synced block is restricted or unavailable` and nothing is stored.

## Migration

`db/100_synced_blocks.sql` adds `hs_synced_blocks`, `hs_synced_placements`, `hs_synced_grants`, `hs_synced_operations`, and `hs_synced_events`. It replaces `hs_search_text` so a placement page does not index synced body text. Re-running it is safe (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`).

The body lives in `hs_synced_blocks.content`. Page rows, revisions, search projections, and `hs_audit.after_value` store ids, versions, and an IST timestamp. They do not store the body.

No new environment variable is required. Do not invent a database password or a service URL. Existing `DATABASE_URL` is the app database. If it is unset outside production, the local PGlite file is used, as before.

## Rollback

Deploy the previous application build. Leave the new tables in place. The previous build ignores `syncedBlock` nodes it does not understand and will not serve the synced-block routes. Dropping the tables is a separate migration-role decision and deletes the shared bodies. Do not delete `hs_audit` rows.

## Deferred

Cross-workspace sync, syncing part of a block, and the HOLY-65 snippet library, approval workflow, and snippet versions are out of scope. Bug Off F01–F11 are Not Run until an isolated signed-in staging run. Do not mark HOLY-66 Done from local Vitest.

## Staging QA

Bug Off folder to create, status Not Run: `HOLY-66 — Synced content blocks`.

| Case | AC | Local evidence | Staging |
| --- | --- | --- | --- |
| F01 | HS-AC-N28-01 | Selection wraps in one synced container; one undo restores it | Not Run |
| F02 | HS-AC-N28-02 | Edit on the second page is visible on the first; both histories use the origin title; label lists readable pages | Not Run |
| F03 | HS-AC-N28-03 | Disjoint edits merge; overlapping edits return both versions and do not overwrite | Not Run |
| F04 | HS-AC-N28-04 | Unsync copies one page and leaves the other placements linked | Not Run |
| F05 | HS-AC-N28-05 | Delete one placement; delete-all confirms readable titles plus the hidden count; 30-day undo | Not Run |
| F06 | HS-AC-N28-06 | Placement editors without source edit rights stay read-only until an explicit editor grant | Not Run |
| F07 | HS-AC-N28-07 | Hidden, deleted, and unknown ids share one restricted shape and the body is absent | Not Run |
| F08 | HS-AC-N28-08 | Revoking source read switches the next read to that shape and clears cached text | Not Run |
| F09 | HS-AC-N28-09 | Trashed source is unavailable to readers; an owner can restore it and the placements | Not Run |
| F10 | HS-AC-N28-10 | Foreign and unknown ids return the same generic not-found and write no placement | Not Run |
| F11 | HS-AC-N28-11 | Traceability only. Do not mark Done from this table | Not Run |

Reset the isolated staging workspace. Sign in as the actor in each Given clause. Record the candidate SHA, environment, and an IST timestamp. Keep screenshots and sanitized responses. Do not infer Passed from this repository's Vitest run.

## Local checks

`npx vitest run lib/synced-blocks.test.ts lib/synced-block-editor.test.ts` covers propagation, merge and conflict, unsync, delete-one, delete-all, the 30-day tombstone, edit rights, the restricted leak oracle, revoke, trash and restore, and cross-tenant rejection. `npx tsc --noEmit` covers the TypeScript build.
