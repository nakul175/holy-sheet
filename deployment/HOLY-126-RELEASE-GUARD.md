# HOLY-126 guarded release integration

This story replaces snapshot-only disk checks and environment-specific locks with
one fail-closed Holy Sheet release guard. It does not clean disk, grant release
access, run arbitrary privileged commands, or deploy an application feature.

## Reviewed entry points and affected filesystems

Read-only inspection on 29 October 2026 found:

- staging entry point: `sudo -u hs-staging /opt/holy-sheet-staging/deploy.sh`;
- production entry point: `sudo /usr/local/sbin/hs-prod-release <40-hex-sha>`,
  which invokes `/usr/local/lib/holy-sheet-release/release.py`;
- staging checkout/build paths under `/opt/holy-sheet-staging`;
- production release artifacts under `/var/lib/holy-sheet-release`, the source
  inbox under `/home/deploy/hs-release-inbox`, and Docker storage under
  `/var/lib/docker`;
- all inspected paths currently resolve to `/dev/vda1`, mounted at `/`.

Production currently uses `/run/hs-prod-release.lock`, which does not serialize
staging, and a fixed `free > 3 GiB` assertion that does not subtract an explicit
operation peak. The staging wrapper is separately constrained and must be
integrated through its existing `hs-staging` release mechanism.

## Integration contract

Install the reviewed `scripts/hs_release_guard.py` root-owned and non-writable by
the release identities. Both entry points must:

1. require an operator-supplied positive integer `peak_budget_bytes` based on the
   selected build/image, backup, restore and rollback method;
2. acquire `/run/lock/holy-sheet-release/release.lock` before copying/importing source,
   building/pulling images, creating backups, migrating or switching containers;
3. hold that file descriptor for the complete release and fail immediately when
   another HS staging or production release owns it;
4. create one `ReleaseGuard` with every affected path and call `check` immediately
   before `source`, `build_or_pull`, `backup`, `migration`, `switch`,
   `rollback_rehearsal` and `finalize` as applicable;
5. write each returned receipt as mode `0600` beside the existing private release
   receipt, without environment values, archive contents, credentials or tokens;
6. preserve the healthy service and all existing images, containers, databases,
   volumes and backups when any check rejects the next phase.

The reserve is exactly 2,147,483,648 bytes. The whole declared incremental peak
is conservatively required for every affected path and its effective filesystem.
Measurements are immediate. A path that does not exist is measured
at its closest existing ancestor. Missing/invalid budgets, resolution/statvfs
errors, stale injected measurements and insufficient capacity reject the phase.

Installation creates `/run/lock/holy-sheet-release` as root-owned, group
`docker`, mode `2750`, and `release.lock` as root:`docker`, mode `0660`. This
uses the staging identity's existing Docker group and grants no new privilege.
Runtime code requires that preinstalled regular file, opens it with `O_NOFOLLOW`
and rejects a non-root-owned, group/world-writable directory or a lock file whose
owner/mode is not exactly root/`0660`. It never trusts a caller-created path in
the sticky `/run/lock` directory.

The kernel `flock` is the authority. Metadata in the lock file is diagnostic
only: stale metadata is replaced after successful lock acquisition and can never
authorize stealing a live lock. Normal exit, exceptions, signals and process
death release the kernel lock. This serializes HS staging and production only;
unrelated host operators can still consume disk after a check, so every material
phase is revalidated and residual host contention remains an operational risk.

## Read-only preflight

The CLI performs no mutation: it does not create a missing lock file or write a
receipt, and it cannot execute a supplied command:

```sh
python3 scripts/hs_release_guard.py \
  --environment staging \
  --source <reviewed-40-hex-revision> \
  --phase preflight \
  --peak-budget-bytes <explicit-conservative-bytes> \
  --path /opt/holy-sheet-staging \
  --path /var/lib/docker \
  --lock-file /run/lock/holy-sheet-release/release.lock
```

The JSON reports source, target environment, UTC timestamp, phase, resolved
filesystem, available bytes, peak budget, reserve, gate result and lock state.
It prints no secrets and performs no cleanup, service action, credential change,
permission change or scheduling.

## Qualification and rollout gates

- Run `python3 -m unittest -v scripts/test_hs_release_guard.py` locally.
- Run threshold, invalid-input, measurement failure, path resolution, concurrent
  contender, stale metadata, crash and signal tests on disposable local paths.
- Capture a normal read-only host preflight only after Product supplies the
  bounded operation budget. Never simulate low space by filling the shared host.
- Install the exact reviewed guard and wrapper integrations on staging first in
  an explicit serialized slot. Verify read-only pass, insufficient-budget
  rejection, and competing HS release rejection without starting a heavy phase.
- Exercise wrapper rollback/restoration with the current service kept healthy,
  then install the same guard on production through the existing constrained
  root wrapper mechanism and repeat enforcement checks.
- Record exact revision, installed file hashes, wrapper hashes, budgets, receipts,
  results and rollback evidence in Bug Off and BTF. Do not close HOLY-126 until
  both entry points enforce the gate.
