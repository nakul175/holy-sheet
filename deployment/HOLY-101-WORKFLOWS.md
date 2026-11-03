# HOLY-101 workflow automation builder

Scope is HS N60. This change implements AC1 through AC6 for a deterministic workflow builder. Bug Off is Not Run, and local tests are not a Passed result. It does not implement parent epic HOLY-81, and it does not merge, deploy, or change BTF.

## What shipped

A workspace admin, or a delegated workflow manager, can author a workflow as an event, typed conditions, and an allowlisted action. The actions are set field, clear field, and append note. There is no AI agent. New workflows are drafts. Activation, pause, version change, rollback, and replay each need the management right and an impact review. This change does not activate a workflow or a schedule in any environment.

The run uses the workflow's delegated user or service identity and that identity's current record and field rights. It does not reuse the creator's permissions. Event and step keys are idempotent. A failed step waits 1s, then 4s, then becomes a dead letter. A cascade stops after depth 10. Replay of a dead letter is explicit. Run history stores the revision and the outcome.

Tenant, record, field, and action checks apply to the builder, search, dry-run, download, and history. A sensitive field the caller cannot view is omitted. Granting workflow configuration does not grant a page, record, collection, or field. Accounts still require an Organisation.

Configuration is versioned. The same operation id returns the first result. A different body is rejected. A stale save leaves the recoverable draft in place. Audit records the actor, source `workflow-automation`, IST time, and operation id. Core dialog actions are buttons, at least 44px, and the workflow action sits in Page options so the export row can wrap.

## Migration

`db/127_workflow_automation.sql` adds the workflow, revision, draft, preview, run, step, event, manager, and operation tables. Inserting a workflow as active is rejected. Re-running it is safe. It does not update `hs_data_periodic_review_schedules`, `parent_organisation_id`, or `release.py`. Existing schedules stay paused. No schedule is installed.

## Staging QA

Bug Off folder, status Not Run until an isolated signed-in run: `HOLY-101 — Workflow automation builder (HS N60)`.

| Case | AC | Local evidence | Staging |
| --- | --- | --- | --- |
| N60-01 | Managers author a versioned event, typed conditions, and allowlisted actions, with dry-run and field checks | Draft definition, dry-run, rejected unknown field | Not Run |
| N60-02 | Runtime identity is explicit and rights are current | Creator edit does not run a step the identity cannot write | Not Run |
| N60-03 | Idempotent keys, bounded retry, depth 10, replay, dead letter | One append for a repeated event; third failure is dead letter; depth 11 stops | Not Run |
| N60-04 | Activate, pause, version change, and rollback need management and impact review | Draft ingest is refused; active version change returns to paused; history stores revision and outcome | Not Run |
| N60-05 | Tenant, record, field, and action checks | Hidden record and sensitive value omitted; manager grant adds no record grant | Not Run |
| N60-06 | Versions, drafts, audit, keyboard and phone | Conflict keeps the draft; dialog actions stay off the export row | Not Run |

## Local checks

`npx vitest run lib/workflow-automation-plan.test.ts lib/workflow-automation.test.ts lib/workflow-automation-route.test.ts lib/workflow-automation-dialog.test.ts`
