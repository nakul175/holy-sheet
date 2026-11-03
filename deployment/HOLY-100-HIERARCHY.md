# HOLY-100 hierarchical custom collections

Scope is HS N55. This change implements AC1 through AC6 for optional same-collection hierarchy. Bug Off is Not Run, and local tests are not a Passed result. It does not implement parent epic HOLY-80, and it does not merge or deploy.

## What shipped

A workspace admin, or a delegated hierarchy manager, can enable hierarchy on a custom collection. Each record has at most one parent in that same collection. The depth limit is at most 20. A record may have no parent when the hierarchy schema allows roots. Accounts still require an Organisation through `parent_organisation_id`. Enabling hierarchy or choosing a parent does not grant a page, record, collection, or field.

Self, descendant, and cross-tenant parents are rejected. Moves lock the tenant and the collection’s parent rows, then check the tree again, so two racing moves cannot close a cycle. A direct database update is rejected by the same checks.

Tree and list views return 50 visible siblings at a time. Ancestors and children the caller cannot view are omitted. The response does not include a hidden count. Search, preview, download, and history use the same visibility rules.

Reparent, archive, and delete start from a preview of the visible subtree and the app references on those records. Confirming changes only the chosen record. Descendants keep their state and their own grants. References are left in place.

Configuration and placement are versioned. The same operation id returns the first result. A different body is rejected. A stale save leaves the recoverable draft in place. Audit records the actor, source `collection-hierarchy`, IST time, and operation id. Core dialog actions are buttons, at least 44px, and the hierarchy action sits in Page options so the export row can wrap.

## Migration

`db/126_collection_hierarchy.sql` adds the hierarchy configuration, parent link, revision, draft, preview, field policy, and operation tables. Re-running it is safe. It does not alter `parent_organisation_id` or `release.py`.

## Staging QA

Bug Off folder, status Not Run until an isolated signed-in run: `HOLY-100 — Hierarchical custom collections (HS N55)`.

| Case | AC | Local evidence | Staging |
| --- | --- | --- | --- |
| N55-01 | Admin configures one parent, depth 20, and roots where the schema allows | Custom collection hierarchy; accounts stay on Organisation | Not Run |
| N55-02 | Reject self, descendant, and cross-tenant parents, including races | Cycle and foreign parent rejected; one of two raced moves remains | Not Run |
| N55-03 | Page 50 visible siblings; no hidden ancestry or counts | Reader page omits the secret child and its parent id | Not Run |
| N55-04 | Preview subtree and app references; no inheritance or cascade | Archive and delete leave children and grants unchanged | Not Run |
| N55-05 | Tenant, record, field, and action checks | Sensitive field hides the parent; manager grant adds no record grant | Not Run |
| N55-06 | Versions, drafts, audit, keyboard and phone | Conflict keeps the draft; dialog actions stay off the export row | Not Run |

## Local checks

`npx vitest run lib/collection-hierarchy-plan.test.ts lib/collection-hierarchy.test.ts lib/collection-hierarchy-route.test.ts lib/collection-hierarchy-dialog.test.ts`
