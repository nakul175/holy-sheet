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
