# HOLY-1 — Engineer 3 delivery checkpoint, 28 October 2026

Status: In Progress, not accepted or deployed. Finish HOLY-1 before HOLY-2. Engineer 3 owns HOLY-1–3 and HOLY-78/79/87–95 only. User-authorized ownership update: HOLY-86 belongs exclusively to Engineer 4; do not implement or modify it. The active goal follows this newer scope correction. Schedules remain paused.

## Audit

BTF HOLY-1 has nine acceptance criteria. Its initial Backlog status did not match the existing implementation; moved to In Progress and posted audit comment 10659. Production direct Aplyd sign-in opened the standalone Welcome page. New page displayed existing-space and new-space fields. This was a read-only smoke audit: no production document, membership or permission was mutated, and the deployed revision is unverified.

Bug Off Holy Sheet project 3 already contains TC-HOLY-1-001–008, cases 1477–1484, covering independent creation, create-space/title preservation, unauthorized creation, block round trip, stable IDs, failed-save recovery, nesting/order and SHO unlink preservation. All were Draft; case 1478 had no result history. Preconditions require isolated staging and synthetic owner/editor/viewer/outsider actors, two workspaces and Marketing/Finance spaces. Production smoke and local tests do not satisfy those preconditions.

Code audit found no native workspace-create endpoint or workspace selector. Empty-workspace home lacks the new-space option. Repository.create/createSpace currently check active membership without the role restrictions described by space-administration capabilities; observer/viewer creation authority needs Engineer 1/HOLY-5 reconciliation. Coordinated these dependencies with Product - Holy Sheet; do not take over Engineer 1's authority scope.

## Bounded implementation

Extracted the existing CreatePage dialog into components/create-page-dialog.tsx. It now preserves an exact page-creation operation ID and request body after uncertain failure, reuses an acknowledged newly created space on page retry, disables editing of an unresolved request and prevents same-tick duplicate submits. Closing an unconfirmed attempt warns the user to check their pages before creating another. The server's existing creation-intent replay mechanism remains unchanged.

Limitations: this is mounted-dialog recovery, not persistence across browser termination; an uncertain response from space creation itself still needs an idempotent space operation; empty-workspace home creation remains outside this bounded patch. These must not be represented as full HOLY-1 completion.

Base revision: dc518504c62f3e633fb6b682b7ce1bc6737e84e0. Other engineers' shared-worktree changes are preserved and excluded from the proposed patch.

## Validation

- Focused: 3 UI fault/concurrency tests and 4 repository creation-replay tests pass.
- Combined shared-worktree regression: 125 files passed, 2 files skipped; 997 tests passed, 44 skipped. The opt-in PostgreSQL/scanner tests were not executed locally. No Docker, pg_ctl or clamd executable was available on PATH.
- Typecheck and production build passed. git diff --check passed.
- Full logs: artifacts/holy1/focused.log, regression.log, typecheck.log, build.log (ignored local evidence).

This shared-worktree run includes uncommitted Engineer 2 work and is not an immutable release qualification. Exact isolated-commit CI must qualify the proposed patch separately, including real PostgreSQL/scanner, security/runtime and rollback gates. No staging acceptance, rollback test or production deployment is claimed.

## Remaining gates

1. Resolve workspace create/manage authority and add the workspace selection/create flow plus first-page new-space creation.
2. Reconcile read-only creation roles with Engineer 1 and verify O/E/V/X server and UI boundaries.
3. Finish creation-intent coverage across first-page, space and interrupted-dialog paths.
4. Qualify all eight mapped scripts at the exact deployed staging revision with dedicated fixtures, including failure recovery and paired SHO unlink/same-document behavior.
5. Obtain serialized release-owner staging/prod revision and deployment/rollback handoff; verify rollback, then deploy and verify the accepted production candidate.
6. Record actual results in BTF/Bug Off before any Done transition. HOLY-2 has not started.

## Active allocation supersedes original goal scope

User-authorized Product updates: HOLY-86 and HOLY-2 belong exclusively to Engineer 4. Engineer 3 must finish HOLY-1 only, then stop and report to Product for reassignment. Do not automatically start HOLY-2, HOLY-3 or the former epic sequence. Schedules/heartbeats remain paused.

## Continuation: current-main workspace entry and creation intents

Base moved to current main 6f7e10964b719abb7b0d7ee9c609ef8ca5406f90 in /private/tmp/holy1-continuation. The shared worktree is unchanged. Latest allocation: HOLY-86 is Unassigned, HOLY-2 is Engineer 4's exclusive scope; Engineer 3 works only HOLY-1 and reports to Product when it completes.

Added membership-filtered /api/workspaces and /workspaces entry, including accessible workspaces with zero spaces/pages. The existing root entry still opens an existing page; its empty-workspace entry now uses the same CreatePage dialog as the document shell. The dialog can create a first space while retaining the entered page title, filters destinations to the selected workspace, and submits stable operation IDs for both space and page creation. Space creation and its intent commit in one database transaction through the ordinary Repository.createSpace authority path. No role policy is duplicated or broadened. Rejected validation/permission requests can be corrected; uncertain responses replay the same request. Sidebar content is scoped to the current workspace and Switch workspace preserves the existing document/discussion departure checks.

Focused continuation tests: 12 passed across workspace discovery/revocation, selected-workspace/first-page UI, space intent replay/scope/rollback and dialog uncertain-response/concurrency cases. Typecheck passed before the final navigation-only changes. Full current-candidate gates are pending.

Local browser preparation uses scripts/seed-holy1-acceptance.mts, guarded against production/external databases and requiring an explicit disposable data directory. An initial browser rehearsal created the first space/page in the empty workspace with its title preserved; this is local preview only. The copied installed editor package was discovered to be a physical stale snapshot: build:editor regenerated packages/editor/dist while the app still resolved node_modules/@aplyd/holy-sheet-editor. Corrected only the isolated dependency to the normal workspace symlink and rebuilt. Browser re-verification exposed a repeated development refresh/Checking document access state with Turbopack; Webpack mode is being used to diagnose it. Do not claim the new editor-shell UI is accepted from the stale-package rehearsal.

Still open: native workspace-create authority/implementation; Engineer 1 creation-role reconciliation; exact-candidate full service/security gates; staging fixtures and release path; all live mapped acceptance, rollback and production verification.

The current-package Webpack browser check subsequently completed: sidebar showed only the selected workspace; Switch workspace opened /workspaces; selecting the fixture workspace and reopening the first page retained URL fb9c2544-3662-4ca5-a220-03f70372a157, title, Saved state and paragraph content. This is local-only. Screenshots remain under artifacts/holy1/continuation/.

The first full continuation run exposed one regression in lib/import-workspace-navigation.test.ts (984 passed, 44 skipped, 1 failed): the redesigned first-page form removed an existing unsaved-title/import protection contract, and its fixture lacked the new workspace response. Kept that assertion and restored the root inline form using the shared creation implementation, with dirty-title checks before opening an imported page or switching workspace. Updated only the fixture response to include the new API. Focused 13 passed, intermediate full 985 passed/44 skipped; final combined-candidate gates remain pending after minor close/replay guards and integration with current main. Original failure log retained.

Product confirmed that neither app entitlement nor existing Owner/Admin scope establishes workspace-creation authority. Product is resolving that product policy and central handoff; do not grant new privileges or assume allow-all. A direct product-policy question is pending. Product will reserve staging after exact-candidate CI; no staging window is assigned yet.

## Combined candidate gate

Candidate 58621819fb3d91d7a0f03d56e3737b684e0ad135 combines the HOLY-1 changes with main dccc981fbeb0d2a53947f5aca03105d0465bba25 (including HOLY-10 and HOLY-44 changes, without modifying their scope). Its isolated full regression passed: 994 tests, 44 opt-in service skips, 128 files passed/2 skipped. Logs: artifacts/holy1/continuation/combined-5862181-regression.log. Authenticated CLI push successfully triggered required PR CI; container and collaboration checks passed while validate/accessibility were still running at the first snapshot.

Added explicit opt-in real PostgreSQL tests for concurrent first-space/first-page replay, migration replay, atomic space+intent rollback and revoked-membership replay refusal. These require the dedicated loopback holy_sheet_acceptance database; they do not run against arbitrary production/staging databases. Local focused result: 11 passed, 2 PostgreSQL checks skipped. Those two checks remain unqualified until CI executes them. The security smoke and rollout scripts now cover the workspace chooser shell, authenticated workspace metadata and forged actor headers. No application source changed after candidate 5862181 in this test-only follow-up. Full real-service/container/CI evidence, staging window and product workspace-create policy remain open.

## Rollback-compatible creation capability

Review found a concrete compatibility defect: the old /api/spaces route strips an unknown operation ID and would perform a fresh write on each retry. Restored that legacy endpoint unchanged and moved new intent creation to POST /api/v1/space-creations, requiring an explicit workspace and operation ID. An older server returns 404 on that route before mutation. A first, definite capability rejection retains editable title fields without a legacy fallback. A previously uncertain intent remains locked with its original operation ID across rollback/404 and retries the same intent after restoration. Added two UI regression cases for both paths; focused creation/navigation/import suite: 13 passed. Updated signed-out/foreign-origin boundary probes for the dedicated route.

Product supplied the existing Docker path and official CI image pin. Created only holy1-acceptance-db, bound to 127.0.0.1:55499, with fresh credentials in the isolated clone's ignored mode0600 .holy-sheet/acceptance-db/holy1-postgres.env. Other engineers' databases were not touched. Existing shared scanner on 57310 may be used for ordinary synthetic scanner cases; its configuration/lifecycle must remain unchanged. Next gate is the stable candidate's full local suite with both real services, followed by typecheck/build and exact-head CI. No service skip is represented as a pass.

## User-approved Owner-only workspace factory

The user explicitly selected: "Existing HS workspace Owners only" may create a new workspace. This supersedes the previously missing creator policy; Product and Engineer1 were informed. Implemented a separate dedicated POST /api/v1/workspace-creations capability, with current active native Owner proof in the selected source workspace under workspace/member locks. Administrators, Members, Observers, outsiders and inactive Owners are denied. Only the creator becomes Owner of the new empty model-v2 workspace; source memberships and content are not copied or changed. Workspace, initial Owner, intent and creation audit commit atomically. The audit records source role/access version and correlation ID. Replay returns only a result visible through current target membership and never reactivates or repromotes a revoked/demoted creator.

The chooser offers creation only from a current Owner source, then selects the new empty workspace for its first space/page. Creation retains a stable operation through uncertain responses and rollback; a mismatched acknowledgement cannot confirm success. Root and the exact /workspaces chooser now have the standalone frame-ancestors none policy; unrelated record routes and dedicated embed policy are not changed. Guarded host-local fixtures can add a separate synthetic Owner source without promoting existing fixture memberships.

Focused host-memory creation/navigation/import tests:21 passed. Additional gated PostgreSQL tests cover concurrent workspace creation through first-page use and source-Owner revocation fencing. They have not run locally for this new batch because Product froze Docker-heavy runs after the capacity incident. Required full regression/typecheck/build and exact-head CI are pending for this new source; predecessor results do not qualify this added factory.

Predecessor c00cdad did pass1042 real-service local tests with zero skips and all4 CI jobs. Downloaded exact CI evidence verified both space-intent PostgreSQL cases executed, and synthetic backup/restore matched126 tables/42 page reads. The separate local restore failed Docker VM capacity and remains failed/unqualified; full status/evidence limitation is in artifacts/holy1/continuation/RUNTIME-CAPACITY-CHECKPOINT.md/JSON. Product confirmed scanner TCP PONG despite Docker unhealthy label; no scanner outage is inferred or service change made. No new Docker database/heavy fixture/restore work until Product reserves a slot.

Still open after the new factory: Engineer1/general role-policy reconciliation (including Observer create/ownership precedence), central authority and dedicated live QA handoff, Product staging reservation, all mapped live acceptance, staging rollback and production verification. No real-user grant/configuration change or Done transition has occurred.
