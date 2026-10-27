# HOLY-3 controlled staging rollout

This is preparation, not a completed deployment or product acceptance. The merged
editor/package/recovery batch is main `dbc5066`. The prepared candidate also
incorporates merged picker PR32 at `9aa0556`, including one additive migration
relative to staging `99a6327`; Compose service definitions remain unchanged.
Record the final reviewed release SHA, image ID and previous deployment in a
private operator receipt. Do not deploy an unreviewed branch or moving branch name.

## Before switching

- Finish or checkpoint the current QA sessions and preserve their evidence. Do
  not change revision during a fresh-token/logout/revocation measurement.
- Confirm the constrained wrapper's current source/image, expected origin and
  flags. Preview remains 0; OIDC/editor retain their qualified settings. Preserve
  private configuration, provider registration and grants.
- Confirm disk/memory capacity for the selected method before build or image
  import. Do not prune shared Docker state, volumes, private objects or another
  suite service to make room. Low free space requires an explicit headroom check,
  including image layers/archive, temporary build space and the current backup.
- Take a fresh database backup and verify its operator receipt. Keep the recovery
  master-key backup separately protected; never return it in logs/chat. No key
  rotation or provisioning is part of this rollout. Migration
  `011_page_creation_intents.sql` creates only the actor/operation creation ledger,
  with a nullable page reference retaining tombstones after page purge. It does
  not backfill document data or change memberships/grants. Initialization runs
  ordered additive migrations under the existing PostgreSQL lock/transaction.
  Rollback retains this table; do not reverse it or discard its idempotency data.
- Require successful application CI and the container-qualification job on the
  exact candidate. The latter builds the actual Dockerfile on an isolated runner,
  checks read-only/non-root deployment boundaries with editor 0 and 1, and retains
  the exact image archive, checksum and image ID. These are anonymous checks,
  not authenticated edit, scanner, performance or SHO acceptance.
- Application CI also dumps/restores its disposable PostgreSQL database and
  verifies all HS table counts/digests plus reopened synthetic document views.
  This qualifies SQL restoration only; cloud objects and separately protected
  recovery-key restoration still need their own evidence.

## Switch and immediate checks

Use the host's existing constrained revision wrapper. Prefer a prebuilt qualified
image if the operator has an approved, source-bound import path; otherwise assess
the existing build path's headroom first. Do not introduce an arbitrary root or
Docker shell. Preserve the healthy PostgreSQL/scanner services and their approved
host-side socket/memory overrides. Check service creation times afterward to
identify any unexpected recreation.

Record deployed source/image, flag values and app/database/scanner health. Check
TLS and suite neighbours. Run:

```sh
node scripts/verify-rollout-boundaries.mjs https://staging.holysheet.aplyd.org --oidc --require-framing --picker
```

The script prints statuses/timings only, never cookies or tokens. It checks public
shells, protected APIs, forged headers, mutation origins, private-file denial,
OIDC transaction-cookie flags and the reviewed standalone/embed framing policy.
Canonical main now allows only the official SHO origin and the separate
`https://sho-qa.aplyd.org` origin approved with PR32, alongside self. The former
`.com` proposal is cross-site with HS SameSite=Lax cookies. Confirm the actual
QA host's identity callback/client and source before paired qualification; this
document does not create or authorize infrastructure changes or deployment of
historical SHO main.

## Authenticated qualification after the switch

Use normal suite login and dedicated synthetic fixtures. Repeat fresh-token suite
logout/second-tab lock; owner/editor/viewer/unshared boundaries; save then reload;
upload/download/rejected replacement; draft isolation and queued-save revocation;
third-writer conflict discard; actual paired SHO behavior when its host is ready.
Controlled storage/clock/service faults belong on a disposable environment.
Record each result in BugOff without promoting an incomplete umbrella case.

## Abort / rollback

Stop qualification for an unexpected revision/image/flag, degraded neighbour,
authorization leak, content loss, false Saved state or unavailable key/storage
dependency. If necessary use the existing constrained editor-disable operation
while preserving local recovery and server data. Application rollback uses the
recorded previous revision/image, not a database restore or reverse migration.

Do not assume a moving rollback pointer still names the original source: re-read
status immediately beforehand. After rollback recheck source/image, flags, suite
health, anonymous boundaries and a synthetic authorized saved-document read.
Rich documents, media and encrypted drafts are retained; this candidate does not
change their transport/schema or key format. Record failures and leave HOLY-3
open until the required live/device/performance/recovery gates are evidenced.
