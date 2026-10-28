# HOLY-127 review-only release packet

Status: **review only; no server write, backup, image transfer, switch or rollback is authorized by this packet.**

## Immutable candidate and rollback

- Merged source: `eecb3ee9e366c2e3bd7d7c62d7529f8d68f00923`.
- Qualified image: `sha256:1b1cfc4c3d4e0fd518434989a2f0b3a0d649975f34be50f780ec039d161e38bc`, reported size `310238422` bytes, OCI revision label equal to the merged source.
- CI archive: `holy-sheet-candidate.tar.gz`, `117155417` bytes, SHA-256 `7c183283bd5f641c0a50bbe1ed79fe2dde654596a5d14a52c27745d0ebce0c40`; uncompressed OCI tar `317839872` bytes.
- Current staging rollback target: source `073175bfcb034d207916b13ca6d9e07fb81cde4d`, image `sha256:e40ca5bfa0525decfebb851bb8ab0752ae1f0d4d0cbd7915e9623eff63d52b5d`.
- Preserve `HS_OIDC_ENABLED=1`, `HS_RICH_EDITOR_ENABLED=1`, `HS_LOCAL_PREVIEW=0`, the existing environment file, PostgreSQL volume, scanner/signature volume and private object store. No provisioning, key rotation, pruning or cleanup belongs to this operation.

## Proposed capped no-prune backup operation

The reviewed live `backup.sh` cannot be used: it has no size bound and deletes older dumps. A separately installed, hash-pinned operator action would invoke `scripts/holy127_backup_orchestrator.py` as the fixed `hs-staging` service account. It uses the inspected live application directory `/opt/holy-sheet-staging/app`, its relative `.env.staging` and `compose.staging.json`, and the fixed private backup directory `/opt/holy-sheet-staging/backups`. It accepts no command, path or cap arguments and enforces `167772160` bytes (160 MiB).

Required review corrections before operation approval:

- Run the complete action as the fixed `hs-staging` service account through one narrowly authorized helper, not an arbitrary root shell.
- The helper must own cleanup through traps and remove only its unique `.pending` files. It must never remove an older valid backup.
- Capture both `PIPESTATUS` values. An over-limit consumer closes the pipe, terminates the producer, removes the pending file and returns failure. A failed `pg_dump`, short/empty output, collision, write/fsync failure or checksum failure must leave no apparently valid `.dump`.
- Finalization is a same-filesystem rename of the same inode; no second dump copy is materialized. Receipt content is limited to timestamp, source/image IDs, byte count, SHA-256 and exit states—never environment values or database content.
- Verify the fresh dump with `pg_restore --list` and a bounded disposable restore before treating it as a rollback asset. That verification needs its own reviewed disk budget.
- The local orchestrator receipt says `toc-listed`, not `verified`: `pg_restore --list` proves that the archive catalogue can be read, not that a full restore succeeds. Cancellation of the real Compose/Docker exec process tree and database-side `pg_dump` on timeout/SIGTERM still requires isolated PostgreSQL integration evidence; local fake-process termination is not that proof.

The bounded-stream helper has local exact-limit, overflow cleanup, collision and invalid-limit tests. The fixed orchestrator additionally has local success/no-prune, producer-nonzero, limit/process-group termination, stalled-producer timeout, verification-failure and no-replace collision tests. Disk-full/short-write/fsync injection, receipt-write failure and concurrent whole-operation races remain required before approval.

## Conservative capacity budget

At the last read, free bytes were `3085180928`; the mandatory reserve is `2147483648`, leaving `937697280` bytes. Before any action these figures must be refreshed.

| Simultaneous item | Bytes |
| --- | ---: |
| compressed CI archive | 117155417 |
| full uncompressed OCI load scratch | 317839872 |
| full qualified image | 310238422 |
| metadata margin | 16777216 |
| capped pending/final backup inode | 167772160 |
| **planned peak** | **929783087** |

This leaves only `7914193` bytes above the reserve at the prior measurement and is therefore operationally too tight. The packet must not be approved against that stale capacity. A safe operation requires either materially more free space obtained without pruning protected/shared state, or a separately proven import method with a smaller measured peak. Backup restore verification needs additional headroom and is not included in this peak.

## Exact image import, switch and rollback design

The existing `deploy.sh` is not eligible because it calls the unsafe backup helper and builds from source. The reviewed operator path must be a new fixed, narrowly authorized helper with these phases:

1. Re-read the serialized HS release lock, free bytes, current source/image and flags. Reject drift from the recorded rollback target.
2. Receive only the fixed archive path under `/opt/holy-sheet-staging/incoming/holy-sheet-eecb3ee9e366c2e3bd7d7c62d7529f8d68f00923.tar.gz`; verify size and SHA-256 before decompression.
3. Load the archive without a source build. Verify loaded image ID, size and OCI revision label exactly, then tag it with an immutable local tag containing the full source SHA.
4. Use a fixed Compose override that sets `services.app.image` to that immutable tag. Invoke Compose with `--no-build`; reject any resolved configuration that retains an effective app build action or changes database/scanner images, volumes, ports, networks, environment or flags.
5. Take the capped, restore-verified no-prune backup only after a fresh capacity recheck. Record the current source/image as the rollback target.
6. Recreate only the app service. Require loopback HTTP readiness, expected source/image/flags, database/scanner health, TLS/suite-neighbour checks and the rollout-boundary script before committing `current-revision.txt` and the new image receipt.
7. On any failure, recreate only the app from the recorded rollback image/tag with the same preserved configuration. Do not restore the database for this additive, migration-free source delta. Re-run the same health and boundary checks.
8. Forward verification repeats the candidate switch from the same archive/image identity. Temporary incoming files may be removed only under a separate explicit approval after receipts are preserved; no Docker prune is allowed.

The operator implementation must make state-file updates atomic and last, reject symlinks/non-private files, avoid interpolating secrets, and emit a sanitized receipt containing phase, source, image, previous source/image, capacity measurements and health outcomes. It must not accept arbitrary command, path, revision, Compose file or environment arguments.

## Required review and approval sequence

1. Product/security review this packet, helper hash and fault-test evidence.
2. Obtain a precise NJ approval for the exact installed helper hashes and fixed operation; inspection approval does not transfer.
3. Obtain a fresh serialized staging slot and capacity/backup/rollback receipt.
4. Execute staging only, then authenticated editor/viewer acceptance and rollback/forward proof.
5. Prepare and separately approve the production operation using production-specific current/rollback receipts. No production access or mutation is implied here.

## Installation preflight refusal and installer candidate — 29 October 2026

The Product-issued disposable qualification slot was released unused after fresh server preflight. Capacity passed, but `/run/lock/holy-sheet-release/release.lock` was absent, the deploy account could not access Docker, and its sudo policy lacked the three exact qualifier entrypoints and any reviewed fixed installer. The only Holy Sheet privileges were the ineligible legacy `deploy.sh` and `backup.sh`. No installation, Docker resource, receipt directory, staging mutation or production action occurred.

The follow-up review candidate `scripts/holy127_qualifier_installer.sh` verifies the fourteen frozen manifest payload hashes and installs only the immutable bundle, the three no-argument entrypoints, the shared lock when absent, and the exact three-line sudo policy. It validates sudo syntax before commit and rolls back only paths created by its own attempt. It deliberately refuses an existing unsafe or incompatible lock, any occupied install target, a busy shared lock, and any unsafe ancestor instead of changing live ownership.

Current-host evidence shows `/opt/holy-sheet-staging` is owned by `hs-staging:hs-staging`, while the frozen run entrypoint requires every bundle ancestor to be root-owned. The installer therefore correctly refuses this host before mutation. Review must choose either a new root-owned qualification path with correspondingly refrozen entrypoints/hashes, or an explicitly justified safe ancestor policy. Changing ownership of the live staging application directory is not proposed.
