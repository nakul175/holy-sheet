# HOLY-103 role interfaces

Scope is HS N62. This change implements AC1 through AC6 for a custom role-specific interface builder. Bug Off is Not Run, and local tests are not a Passed result. It does not implement parent epic HOLY-81, and it does not merge, deploy, or change BTF.

## What shipped

An interface manager can name navigation and screens, bind them to a collection, saved view, and fields, and move the interface through draft, preview, and published versions. Screens compose record lists, details, forms, charts, and existing action buttons. A new interface is a private draft. Publishing needs an impact review and a separate confirmation. This change does not activate a schedule.

Role labels are presentation only. Assigning a workspace role to an interface does not grant collection browse, a record, a field, or an action. Each component checks the current viewer's record, field, and action rights. A person who can open the interface and nothing else sees an empty screen.

Form edits are previewed, then confirmed. The write uses the shared record validation and record version. Calculated fields, rollup-owned fields, and organisation ownership cannot be written. A record that is waiting for approval cannot be changed from the interface.

A deprecated field, a missing view, or a missing button marks that component broken. The other components still render. Interfaces stay private. There is no public share.

Search, preview, download, history, and render use the same tenant, record, field, and action checks. Configuration and role assignment do not add grants.

Configuration is versioned. The same operation id returns the first result, and a different body is rejected. A stale save leaves the recoverable draft in place. A published interface returns to draft when its definition changes, so the new screen is not silently left published. Audit records the actor, source `role-interface`, IST time, and operation id. Core dialog actions are buttons, at least 44px, and the interface entry sits in Page options so the export row can wrap.

## Migration

`db/129_role_interfaces.sql` adds the interface, revision, draft, preview, role, submission, event, manager, and operation tables, plus an interface dependency column. Inserting an interface as published or public is rejected. Re-running it is safe. It does not update `hs_data_periodic_review_schedules`, `parent_organisation_id`, or `release.py`. Existing schedules stay paused. No schedule is installed.

## Staging QA

Bug Off folder, status Not Run until an isolated signed-in run: `HOLY-103 — Role interfaces (HS N62)`.

| Case | AC | Local evidence | Staging |
| --- | --- | --- | --- |
| N62-01 | Managers design named navigation and screens, with draft, preview, and published versions | Draft definition; script, public share, calculated field, and owned field rejected; preview then publish | Not Run |
| N62-02 | Components use the viewer's permissions; interface access does not grant collection browse | Reader with the role sees no records; editor sees only granted records; grants unchanged | Not Run |
| N62-03 | Edits use central validation; calculated, owned, and approval paths stay closed | Preview writes nothing; bad value, formula, organisation, and pending approval rejected; one replayed save | Not Run |
| N62-04 | Schema changes report a broken component and leave the others usable; no public share | Deprecated field breaks one component; detail still opens; public insert rejected | Not Run |
| N62-05 | Tenant, record, field, and action checks on search, preview, download, and history | Hidden record and salary omitted; manager grant adds no record grant; other tenant is not found | Not Run |
| N62-06 | Versions, recoverable drafts, and keyboard or phone actions | Conflict keeps the draft; audit has `role-interface`; dialog actions stay off the export row and are at least 44px | Not Run |

## Local checks

`npx vitest run lib/role-interface-plan.test.ts lib/role-interface.test.ts lib/role-interface-route.test.ts lib/role-interface-dialog.test.ts`
