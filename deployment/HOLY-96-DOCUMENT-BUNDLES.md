# HOLY-96 reusable document bundles

Scope is HS N51. This change implements AC1 through AC6 for a tenant-owned document bundle. Bug Off F01–F09 are Not Run, and local tests are not a Passed result.

## What shipped

A bundle manager creates a workspace bundle with a 1–100 character name, a description, an owner, and an ordered list of document references. Each reference is live (latest published revision) or pinned to a published revision. The bundle does not copy page bodies, grants, or record values.

Readers see only documents they can already read. A hidden document's title, identifier, and count are omitted. Sharing the bundle or assigning an owner writes a bundle grant or owner field only. It does not write `hs_grants` and does not make a private page readable.

Publishing a bundle freezes the resolved published revisions in `hs_document_bundle_publications`. That snapshot cannot be updated or deleted. Later drafts and later page publications leave the snapshot in place. A draft reference can still follow the latest published revision or stay on its pin.

Package preview and download check export policy, attachment readiness, record retention holds, and the 90-day revision retention window. A member that fails those checks is withheld. Removing a member or archiving the bundle does not delete the page.

Search matches bundle name and description, and a document title only when that reader can read the document. History, preview, and download use the same filter. Configuration is versioned. The same operation id returns the first result. A mismatched retry or a stale version does not add a revision. A recoverable draft survives a rejected save. Audit rows record the actor, source `document-bundle`, IST time, and operation id. The dialog uses labelled buttons with a 44px target, a confirm step before publish, and Cancel does not save.

## Migration

`db/122_document_bundles.sql` adds the bundle, revision, publication, grant, draft, manager, and operation tables. Re-running it is safe. It does not alter `release.py`.

## Staging QA

Bug Off folder, status Not Run until an isolated signed-in FX-WIKI-20261031 run: `HOLY-96 — Reusable document bundles  (HS N51)`.

| Case | AC | Local evidence | Staging |
| --- | --- | --- | --- |
| F01 | AC1 Named bundle | Name, description, owner, order, no copied body | Not Run |
| F02 | AC2 Per-reader access | Hidden title and id omitted; share writes no page grant | Not Run |
| F03 | AC3 Live, pin, snapshot | Live moves, pin stays, package snapshot immutable | Not Run |
| F04 | AC4 Export and removal | Export right, asset, retention; page remains after removal | Not Run |
| F05 | AC5 Permissions | Search, history, download, and cross-workspace 404 | Not Run |
| F06 | AC6 Versions and access | Conflict and replay add no extra revision; dialog confirm and cancel | Not Run |
| F07 | Reserved | Not Run | Not Run |
| F08 | Reserved | Not Run | Not Run |
| F09 | Evidence | Traceability only. Do not mark Done from this table | Not Run |

## Local checks

`npx vitest run lib/document-bundle-plan.test.ts lib/document-bundles.test.ts lib/document-bundle-route.test.ts lib/document-bundle-dialog.test.ts`
