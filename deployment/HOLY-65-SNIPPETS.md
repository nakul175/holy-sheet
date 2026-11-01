# HOLY-65 approved reusable content snippets

Scope HS-SF-N27-r0-20261031 is still draft. This change implements HS-AC-N27-01 through HS-AC-N27-10 for Holy Sheet pages. HS-AC-N27-11 stays open: Bug Off has not been executed on staging, and local tests are not a Passed result.

Snippets reuse the HOLY-66 synced-block node, placement shell, and restricted placeholder. They do not add a second page renderer. Approval, versions, and the library are new. Translation of snippets remains HOLY-68.

## What shipped

- A snippet manager creates a library item in a space. It starts as **draft**, moves to **in review** on submit, and becomes **approved** only when someone who still holds the approver role confirms, with the approver, an IST timestamp, and a note stored on the version. The insert picker lists approved versions only.
- An editor inserts **Follow latest** or **Pin vN**. A later approval updates follow-latest placements. A pin keeps its version and shows **Newer approved version available — Update**. Update moves that placement to the newest approved version.
- Placement text is read-only. **Edit snippet** is shown to snippet managers. **Detach as text** copies the current approved version onto the page as ordinary blocks and writes an audit row that does not contain the body. A save that types inside the placement does not store that text.
- Readers of a placement see the latest approved text (or the pinned approved text). A draft version is returned only to snippet managers, approvers, and reviewers in the library.
- Retire asks for confirmation that names pages the manager can read and, when needed, `N other pages without titles`. Placements keep the last approved text. Editors see a **Retired** badge. Readers do not. The snippet leaves the picker.
- Usage lists placements on pages the manager can read, with follow-latest or pinned version and the page owner. CSV export uses that same list.
- Soft delete keeps the last approved text on placements for 30 days. Editors see **Snippet deleted**. Restore within 30 days clears the deletion. After that, placements use the same **Restricted content** placeholder as a hidden or unknown snippet.
- Insert, save, and approval check access at commit. An unreadable snippet, a foreign-workspace snippet, and an unknown id return the same `Snippet is restricted or unavailable` / `not_found` response and store nothing. Removing the approver role before Approve leaves the version in review.

Roles are explicit on `hs_snippet_roles`: `manager`, `approver`, and `reviewer`. Workspace owner or admin can grant and revoke them. Workspace admin is not itself an approver, so revoking the approver role is enough to fail the next approval.

## Migration

`db/101_content_snippets.sql` adds `hs_snippet_roles`, `hs_snippets`, `hs_snippet_versions`, `hs_snippet_placements`, and `hs_snippet_operations`. It also allows `hs_synced_blocks.source_page_id` to be null so a snippet anchor (`kind = 'snippet'`) does not pretend to be a page. Re-running it is safe (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP NOT NULL`).

Approved and draft bodies live in `hs_snippet_versions`. The latest approved body is also copied onto the snippet's `hs_synced_blocks` row. Page blocks, revisions, search text, and `hs_audit.after_value` store ids, version numbers, and an IST timestamp. They do not store the body or the approval note.

No new environment variable is required. Do not invent a database password or a service URL. Existing `DATABASE_URL` is the app database. If it is unset outside production, the local PGlite file is used, as before.

## Rollback

Deploy the previous application build. Leave the new tables in place. The previous build ignores `snippetId` on a synced block and will not serve the snippet routes. Placements already saved stay as empty synced-block shells until this build is restored. Dropping the tables is a separate migration-role decision and deletes the approved wording. Do not delete `hs_audit` rows.

## Deferred

Snippet translation is HOLY-68. Bug Off F01–F11 are Not Run until an isolated signed-in staging run. Do not mark HOLY-65 Done from local Vitest.

## Staging QA

Bug Off folder to create, status Not Run: `HOLY-65 — Approved reusable content snippets`.

| Case | AC | Local evidence | Staging |
| --- | --- | --- | --- |
| F01 | HS-AC-N27-01 | Draft, in review, and approved are recorded with approver, IST time, and note. The picker gains the snippet only after approval | Not Run |
| F02 | HS-AC-N27-02 | Follow latest shows v2. Pin v1 shows v1 and the update banner, then Update shows v2 | Not Run |
| F03 | HS-AC-N27-03 | Typing inside a placement is discarded. Detach copies the approved text and the audit row has no body | Not Run |
| F04 | HS-AC-N27-04 | Readers and the editor library see v1. Managers and reviewers see the draft | Not Run |
| F05 | HS-AC-N27-05 | Retire confirms readable titles plus the hidden count. Editors see Retired. Readers do not. The picker omits it | Not Run |
| F06 | HS-AC-N27-06 | Usage and CSV list readable placements with owner and pin or latest, and omit hidden titles and bodies | Not Run |
| F07 | HS-AC-N27-07 | An unreadable insert matches an unknown id and stores nothing | Not Run |
| F08 | HS-AC-N27-08 | Approval after the approver role is removed matches an unknown id. The version stays in review | Not Run |
| F09 | HS-AC-N27-09 | Soft delete keeps the text for 30 days with an editor-only badge. Restore works. After the window the placeholder is restricted | Not Run |
| F10 | HS-AC-N27-10 | A foreign snippet id on save matches an unknown id and stores nothing | Not Run |
| F11 | HS-AC-N27-11 | Traceability only. Do not mark Done from this table | Not Run |

Reset the isolated staging workspace with FX-WIKI-20261031. Sign in as the actor in each Given clause. Record the candidate SHA, environment, and an IST timestamp. Keep screenshots and sanitized responses. Adverse cases must run signed-in on staging, including the leak-oracle comparison. Do not infer Passed from this repository's Vitest run.

## Local checks

`npx vitest run lib/snippets.test.ts lib/snippet-routes.test.ts lib/snippet-editor.test.ts lib/synced-blocks.test.ts` covers the lifecycle, follow and pin, read-only placements, drafts, retire, usage, and the four adverse cases, and checks that synced blocks still resolve. `npx tsc --noEmit` covers the TypeScript build.
