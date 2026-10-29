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
