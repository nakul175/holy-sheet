# HOLY-95 document working copies and reconciliation

Scope is HS N50. This change implements AC1 through AC6 for a private working copy of a page. Bug Off F01–F09 are Not Run, and local tests are not a Passed result.

## What shipped

An authorised member who can read a page creates a working copy from the page. The copy is a new private page owned by that member. Page ids and block ids are new. The row records the original page, the base revision, and the canonical page version at copy time. Grants are not copied. Workspace owner or administrator role does not reveal another member's copy.

The copy stores only content that member may see. An unreadable record block becomes the text `Restricted content` and does not keep the record id. A sensitive field key is removed unless that member has field view. Attachments that are not ready are left out of the copy. Synced and snippet ids are not copied, so the copy does not register a live placement.

Reconcile compares the stored base, the current original the member can read, and the saved copy. A block or title edited on both sides, or an order change on both sides, is a conflict. Apply writes the original only after every conflict has an explicit original-or-copy choice, the member still has edit access, and the original version still matches. The save is one transaction. It does not publish and does not approve a review. An unchanged merge does not add a revision. A failed apply leaves the copy open and does not add a revision. The same operation id returns the first result.

Abandon and archive change only the copy's state. The original body and version stay put. A later apply of a closed copy is rejected.

Search, page tree, backlinks, history, export, and compliance pack use the copy owner's access. Another member, including a workspace administrator, gets the same not-found response as a missing page. Sharing and publishing the copy are rejected. Keyboard focus stays in the dialog. Conflict choices are radio buttons with a 44px target.

## Migration

`db/121_working_copies.sql` adds `hs_working_copies` and `hs_working_copy_operations`. Re-running it is safe. It does not alter `release.py`.

## Staging QA

Bug Off folder, status Not Run until an isolated signed-in FX-WIKI-20261031 run: `HOLY-95 — Document working copies and reconciliation  (HS N50)`.

| Case | AC | Local evidence | Staging |
| --- | --- | --- | --- |
| F01 | AC1 Create a private working copy | Fresh ids, provenance, no grants, retry returns the same copy | Not Run |
| F02 | AC2 Three-way reconciliation | Conflict preview of base, original, and copy | Not Run |
| F03 | AC3 Apply without skipping review | One new draft revision, publication id unchanged, choice required | Not Run |
| F04 | AC4 Abandon or archive | Original version unchanged, one audit, closed copy cannot apply | Not Run |
| F05 | AC5 Permission enforcement | Admin and source owner 404, search and export omit the copy, sensitive field and secret record omitted | Not Run |
| F06 | AC6 Versions, retries, and access | Failed apply adds no revision, replay adds no second revision, dialog radios | Not Run |
| F07 | Reserved | Not Run | Not Run |
| F08 | Reserved | Not Run | Not Run |
| F09 | Evidence | Traceability only. Do not mark Done from this table | Not Run |

## Local checks

`npx vitest run lib/working-copy-plan.test.ts lib/working-copies.test.ts lib/working-copy-route.test.ts lib/working-copy-dialog.test.ts`
