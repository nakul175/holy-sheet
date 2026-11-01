# HOLY-62 bulk relationship management

Scope for HS N34 is still draft. This change implements AC1–AC6 for the relationship kinds the current record model already stores. Bug Off has not been executed. Local tests are not a Passed result.

## What shipped

Authorised users can preview and apply an explicit add, remove, or replace across up to 1000 source records.

- Kinds reuse `hs_data_relationships`: contact-account, employee-account, contract-account, and contract-legal-party. Account parent stays on `hs_data_records.parent_organisation_id`.
- Preview is a snapshot. Execute applies that snapshot or refuses the batch when the impact moved. Each source row is its own success, skipped, or error. A cardinality failure on one record does not roll back the others.
- Unchanged links are skipped. The same operation id returns the saved batch and does not insert a second link.
- Account one-parent is unchanged: add is refused when a parent exists, remove is refused, replace moves the single parent and does not rewrite contract legal parties.
- A contract cannot be left without a legal organisation. Replace of other many-to-many links removes only the other links of that kind, and only when every affected end can still be linked.
- A contact still has at most one primary account relationship.
- Preview, search, history, and CSV download enforce the current tenant, record, and action rights. A missing view is the same not-found response as a missing record. Collection or record grants are required; creating a link does not write `hs_data_record_grants`.
- Connected application references and deletion constraints are shown before confirm. Record history stores the batch id. `hs_audit` stores the batch summary and each row’s before/after link change, actor, source, and operation id. Field values are not copied into that audit.
- Drafts are versioned. A retried save does not overwrite a newer draft. Discard is recoverable as an explicit action and does not change links.
- The Records screen shows the batch only when the collection grant includes view, edit, link, and bulk. Controls are labelled, keyboard reachable, and at least 44px on a phone.

## Migration

`db/098_bulk_relationships.sql` adds batch, batch-row, draft, and draft-operation tables. It does not copy or rewrite existing links. Re-running it is safe.

## Deferred

Live activation of paused schedules, user and role changes, production data migration, external notifications, and purge jobs are out of scope. Bug Off is Not Run until an isolated signed-in staging tenant is used. Do not mark HOLY-62 Done from local Vitest.

## Staging QA

Use an isolated synthetic tenant and users. Reset that tenant before the pass. Record the candidate SHA, environment, and an IST timestamp. Keep screenshots and sanitized responses.

| Case | AC | Local evidence | Staging |
| --- | --- | --- | --- |
| Select up to 1000 records, kind, target, and add/remove/replace, then preview | AC1 | Preview token and per-row plan | Not Run |
| Type, tenant, cardinality, and link/edit/bulk rights on every end | AC2 | Permission and cardinality tests | Not Run |
| Per-record success, skipped, and error; retry does not duplicate | AC3 | Mixed legal-party batch and operation replay | Not Run |
| References, deletion constraints, batch id, and per-row audit | AC4 | Reparent preview and `hs_audit` | Not Run |
| Permissions on preview, search, download, and history | AC5 | Hidden rows and target search | Not Run |
| Versioned drafts, no silent overwrite, keyboard and phone controls | AC6 | Draft conflict and the bulk panel | Not Run |
| Bug Off | Release gate | Not a local pass | Not Run |

## Local checks

`npx vitest run lib/bulk-relationships.test.ts lib/bulk-relationships-route.test.ts lib/bulk-relationships-ui.test.ts`

`npx tsc --noEmit`
