# HOLY-99 shared classification and tagging

Scope is HS N54. This change implements AC1 through AC6 for a tenant-owned classification taxonomy. Bug Off F01–F09 are Not Run, and local tests are not a Passed result.

## What shipped

A taxonomy admin defines a tag with a stable id and code, a label, an optional parent, and the collections or documents it may classify. Codes do not change when the label changes. Workspace admins hold this authority. A delegated taxonomy admin can edit tags and does not receive a page, record, collection, or field grant.

An editor assigns or removes the tags they are allowed to use on a page or record. The membership is a multiselect. Hidden tags already stored on the target stay in place. Each add and remove is audited with the actor, source `classification`, IST time, and operation id.

Search and facets use the tag id. A renamed label still resolves by that id. Facet counts include only records and pages the caller can already see. A tag the caller cannot see is omitted, including its id and any zero count.

Deprecation removes a tag from new selection and leaves existing assignments in place. Removal and merge start from a preview of the references the caller can see. Confirming the preview remaps or clears every stored reference, including ones the preview does not name, in one transaction. A changed reference set or version does not write.

Tenant, record, field, and action checks apply to the catalogue, search, facets, preview, download, and history. A sensitive classification field hides assignments from someone who can still open the record. An explicit handling policy hides that tag from people who are not cleared. Clearing someone, assigning a tag, or naming a taxonomy admin does not grant access. No generative model is used.

Configuration and membership are versioned. The same operation id returns the first result. A different body is rejected. A stale save leaves the recoverable draft in place. Core dialog actions are buttons, at least 44px, and the classification action sits in Page options so the export row can wrap.

## Migration

`db/125_shared_classification.sql` adds the taxonomy, assignment, revision, draft, preview, field policy, and operation tables. Re-running it is safe. It does not alter `release.py`.

## Staging QA

Bug Off folder, status Not Run until an isolated signed-in FX-WIKI-20261031 run: `HOLY-99 — Shared classification and tagging (HS N54)`.

| Case | AC | Local evidence | Staging |
| --- | --- | --- | --- |
| F01 | AC1 Stable tag, label, hierarchy, and scope | Code stays put when the label changes; parent cycle rejected | Not Run |
| F02 | AC2 Assignment and audit | Multiselect add and remove; no grant rows change | Not Run |
| F03 | AC3 Search and facets | Tag id search; hidden record and page omitted from counts | Not Run |
| F04 | AC4 Deprecate, preview, remap | Deprecated tag stays on history; merge moves hidden rows too | Not Run |
| F05 | AC5 Permissions | Field policy, handling policy, cross-workspace 404, no access grant | Not Run |
| F06 | AC6 Versions and access | Conflict keeps the draft; audit actor, source, time, operation; dialog cancel | Not Run |
| F07 | Reserved | Not Run | Not Run |
| F08 | Reserved | Not Run | Not Run |
| F09 | Evidence | Traceability only. Do not mark Done from this table | Not Run |

## Local checks

`npx vitest run lib/classification-plan.test.ts lib/classification.test.ts lib/classification-route.test.ts lib/classification-dialog.test.ts`
