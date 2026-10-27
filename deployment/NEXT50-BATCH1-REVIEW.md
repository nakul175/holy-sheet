# Native access and discussion delivery batch

This batch adds native workspace membership inspection and administration, and refreshes open discussion/notification panels. It does not mark the complete HOLY-5 or HOLY-6 stories accepted.

## Behavior

Existing active native administrators can read/edit private workspace content without taking page ownership. Existing memberships remain ordinary members after the additive migration. Suite claims never promote a member. The Workspace access dialog shows ordinary members only their own membership; administrators can review a member's before/after role or activation state before confirming.

Changes serialize with document commits using the workspace lock. They require the current access version and matching preview digest, deduplicate operation IDs and record a membership audit event. Removing the last active administrator is refused. Deactivation is refused while the target still owns pages; an explicit future ownership-transfer workflow is required. Scope-only deactivation preserves direct grants and other workspaces. Global account/app deactivation is a separate capability.

Open visible discussion/notification panels refresh every four seconds, suspend interval requests while hidden and discard out-of-order reads. A newer access denial cannot be overwritten by an older successful notification response. This is normal application UI refresh, with no external or scheduled automation.

## Migration and rollback

Migrations 012/013 add the native role, access version, operation ledger and audit table without changing existing roles or grants. App rollback retains additive tables and membership state; do not drop the schema or replay an old database dump over legitimate later work. Old versions do not implement administrative implicit content access, so rollback intentionally withdraws that capability.

## Open story scope

HOLY-5 still needs reviewed central identity/app-entitlement writer integration, invitations, space roles, ownership transfer, legacy inventory/parity and full integrated acceptance. HOLY-6 still needs its full multi-actor live/manual acceptance matrix. This batch does not enable central writers, create users, promote real accounts, change provider credentials or install schedules.

## Validation

Native repository and dialog regressions cover permission checks, preview/commit separation, stale versions, altered operation replay, uncertainty retry identity, last admin, ownership preservation, scope isolation and own-access inspection. Real PostgreSQL coverage races two final-admin demotions and verifies one active administrator remains. Notification tests cover visible refresh and stale-success suppression after denial. The required full CI also runs database restore, packaged container boundaries and Chromium accessibility.
