# HOLY-126 Bug Off acceptance map

The external Bug Off scenario/case/script IDs are assigned when these prepared
cases are created in the Holy Sheet repository. A local passing test is recorded
as local evidence, not as a staging or production result.

## F01 — Guard every real release entry point and filesystem (AC1)

**Scenario:** Inspect staging and production release entry points, enumerate every
affected source/build/backup/restore/rollback/Docker path, and verify the reviewed
guard runs before the first heavy or switching action.

**Script:**

1. Read the installed staging and production wrapper revisions and their exact
   guard integration without printing configuration values.
2. Run read-only preflight with an approved budget; compare every reported path,
   resolved ancestor, mount and available byte count with `findmnt`/`df -B1`.
3. Inspect wrapper flow and receipts to prove lock acquisition and capacity check
   precede source copy/import, build/pull, backup, migration and switch.

**Expected:** Both wrappers use the exact reviewed guard and the same lock inode;
all effective filesystems are reported; no heavy phase occurs first.

**Current result:** In Progress. Entry points and current mounts are inspected;
live wrapper integration remains gated on authorized installation.

## F02 — Explicit peak budget and exact 2 GiB boundary (AC2)

**Scenario:** Missing, malformed, stale, failed or insufficient measurements fail
closed; exact `available = peak + 2,147,483,648` passes and one byte less fails.

**Executable script:** `npm run test:release-guard`, capacity test group.

**Expected:** Nonzero sanitized rejection for every invalid/failing boundary and
pass only at or above the exact reserve.

**Current result:** Passed locally at `d0949c8`; live budget is not yet approved.

## F03 — One atomic HS lock and safe lifecycle (AC3)

**Scenario:** Staging and production contend on the same kernel lock; stale text
never steals a live lock; normal, exception, SIGTERM and crash paths release it.

**Executable script:** `npm run test:release-guard`, lock test group.

**Expected:** Second owner rejects before mutation, current owner remains intact,
stale metadata is replaced only after kernel acquisition, and post-exit probe is
available. Missing/symlink/unsafe installation rejects.

**Current result:** Passed locally at `d0949c8`; cross-wrapper host proof pending.

## F04 — Revalidate before every material phase (AC4)

**Scenario:** Capacity is consumed between phases and the next phase rejects
before its operation callback, leaving the healthy service and recovery material
unchanged.

**Script:**

1. In a disposable local fixture, pass preflight at an approved simulated value.
2. Reduce the injected measurement below `peak + reserve` before the next phase.
3. Verify the operation sentinel was not written and existing fixture artifacts
   remain byte-identical.

**Expected:** Phase rejects before mutation and names the filesystem/required
bytes without secrets. Document unrelated-host-consumption residual risk.

**Current result:** Passed locally at `d0949c8`; wrapper phase integration pending.

## F05 — Read-only sanitized preflight (AC5)

**Scenario:** CLI reports exact source/environment/time/path/filesystem/available,
budget/reserve/result/lock state and performs no privileged or service mutation.

**Script:** Run CLI against a temporary missing descendant and missing lock path;
compare directory entries before/after and scan JSON for unexpected values.

**Expected:** Same directory entries, no lock created, no command execution,
sanitized JSON only. Wrapper-written receipts use mode `0600`.

**Current result:** Passed locally at `d0949c8`.

## F06 — Filesystem, concurrency and fault qualification (AC6)

**Scenario:** Exercise actual local statvfs/flock behavior plus threshold, input,
path, stat failure, concurrent process, crash and signal faults without filling
the shared server.

**Executable script:** `npm run test:release-guard` and
`PYTHONPYCACHEPREFIX=/tmp/holy126-pycache python3 -m py_compile
scripts/hs_release_guard.py scripts/test_hs_release_guard.py`.

**Expected:** All focused tests and compilation pass; no shared-host write occurs.

**Current result:** 11/11 passed locally at `d0949c8`; compilation passed.

## F07 — Staging then production install and rollback (AC7)

**Scenario:** Install the exact reviewed guard through existing authorized
mechanisms in one serialized slot per environment, prove pass/reject/contender
behavior, and rehearse restoration without deleting existing artifacts.

**Script:**

1. Record wrapper/guard hashes and current services; verify approved peak budget.
2. Install staging integration, run read-only pass plus simulated-input rejection
   and contender rejection without a heavy phase; restore old wrapper and verify
   it, then reinstall guarded wrapper and verify it.
3. Repeat through the production root-controlled mechanism; verify both wrappers
   target the same lock and healthy services are unchanged.

**Expected:** Exact hashes/receipts and rollback/roll-forward evidence; no cleanup,
container/image/database/volume/backup loss or unrelated feature release.

**Current result:** Not Run — requires Product slot and authorized wrapper path.

## F08 — Evidence and truthful closure (AC8)

**Scenario:** Every AC has a mapped case/script/result with exact revision,
environment and sanitized evidence; incomplete live gates remain open.

**Script:** Compare AC1–AC8 against F01–F08, PR/CI revision, staging/production
receipts, installed hashes and rollback evidence; then update BTF and Bug Off.

**Expected:** No Passed result is inferred from local-only evidence, and HOLY-126
closes only after both live entry points enforce the guard.

**Current result:** In Progress.
