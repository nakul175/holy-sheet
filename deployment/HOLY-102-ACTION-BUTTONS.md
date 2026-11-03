# HOLY-102 reusable action buttons

Scope is HS N61. This change implements AC1 through AC6 for reusable action buttons. Bug Off is Not Run, and local tests are not a Passed result. It does not implement parent epic HOLY-81, and it does not merge, deploy, or change BTF.

## What shipped

A workspace admin, or a delegated action-button manager, can define a button label, inputs and defaults, an eligible record or page context, and an allowlisted action target. The action ids are `hs.record.set-field`, `hs.record.clear-field`, and `hs.record.append-note`. Follow-up links are `hs.record.open`, `suite.record.open`, and `hs.page.open`. A button cannot store a script or an arbitrary URL. New buttons are drafts. Activation, pause, version change, and rollback each need the management right and an impact review. This change does not activate a button or a schedule in any environment.

A click on a mutation previews the impact. Confirming is the only write. The server checks the current user's record, field, and action rights and the required inputs at preview and again at confirm. The same operation id returns the first receipt. Action success is stored separately from a follow-up link failure, and the receipt can be read again. Retrying the link does not repeat the saved action.

Disabled, stale, and deprecated targets do not run. Draft and paused buttons do not run. Core dialog actions are buttons, at least 44px, and the action-button entry sits in Page options so the export row can wrap. Audit records the actor, source `action-button`, IST time, action id, revision, and operation id.

Tenant, record, field, and action checks apply to the catalogue, search, preview, download, history, and receipt. A sensitive field the caller cannot view is omitted. A hidden record is omitted. Granting button configuration does not grant a page, record, collection, or field. Seeing a button or belonging to the workspace does not grant the action. Accounts still require an Organisation.

Configuration is versioned. A different body for the same operation id is rejected. A stale save leaves the recoverable draft in place. An active button returns to paused when its definition changes.

## Migration

`db/128_action_buttons.sql` adds the action button, revision, draft, preview, receipt, event, manager, and operation tables. Inserting a button as active is rejected. Re-running it is safe. It does not update `hs_data_periodic_review_schedules`, `parent_organisation_id`, or `release.py`. Existing schedules stay paused. No schedule is installed.

## Staging QA

Bug Off folder, status Not Run until an isolated signed-in run: `HOLY-102 — Reusable action buttons (HS N61)`.

| Case | AC | Local evidence | Staging |
| --- | --- | --- | --- |
| N61-01 | Managers define label, inputs, context, and an allowlisted action target | Draft definition; script, URL, and deprecated contract rejected | Not Run |
| N61-02 | Impact preview, then confirm; current rights and required inputs | Preview writes nothing; missing input rejected; creator without edit cannot run | Not Run |
| N61-03 | Idempotent operation id and a receipt that separates link failure | One append for a repeated operation; link retry does not append again | Not Run |
| N61-04 | Disabled, stale, and deprecated targets; audit action, source, and revision | Deprecated field and legacy contract refused; stale record refused; audit has `action-button` | Not Run |
| N61-05 | Tenant, record, field, and action checks on catalogue, search, preview, download, and history | Hidden record and sensitive value omitted; manager grant adds no record grant | Not Run |
| N61-06 | Versions, drafts, and keyboard or phone actions | Conflict keeps the draft; dialog actions stay off the export row and are at least 44px | Not Run |

## Local checks

`npx vitest run lib/action-button-plan.test.ts lib/action-button.test.ts lib/action-button-route.test.ts lib/action-button-dialog.test.ts`
