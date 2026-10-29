# HOLY-126 Product review

Candidate: PR128, head `6ddb730dc3c504ec140886d235a79ee5683f5d1e`.

Initial disposition: **CHANGES REQUIRED; no merge/install clearance** on6ddb730. Product independently verified all six manifest SHA-256 values against the clean candidate worktree and GitHub's four successful checks on that exact head. Green CI did not cover the reproduced gaps below.

Re-review: exact updated head `ab27756e536a6e075e929a6db71156284a1307ac` closes R1/R2/R3 in the inspected diff. Product independently ran14/14 guard tests successfully and matched updated guard/test/docs SHA-256 values2732a41/6a7d3a6/ad953e1. Source guard acceptable for merge only after all required exact-head CI succeeds and current-main compatibility is verified. No live installation clearance: wrapper/source/operator/budget/rollback gates below remain. Engineer2 notified; HOLY127 owns next shared-stage preparation window.

## R1 — P1: preflight reports success when lock unavailable

`main` accepts `probe_lock` output with state `held`, prints `gate:passed` and exits0. Product reproduced this with the CLI's probe seam, without touching a real release. `probe_lock` also returns available/filePresentfalse for a missing strict preinstalled lock. Both can incorrectly clear operational preflight. Strict CLI must reject held/missing/invalid installation with nonzero sanitized failure, and distinguish an instantaneous availability probe from an acquired reservation. Add CLI and library red/green cases.

## R2 — P1: mandatory reserve can be lowered

`check_capacity(['/fixture'],1,reserve_bytes=1,probe=fixture_available_2)` succeeds. The same configurable reserve is exposed in CLI and ReleaseGuard. Enforce reserve at least2,147,483,648 bytes at every public boundary, permit only a higher conservative reserve, and reject bool/float/noninteger budgets rather than coercing them. Product probe is synthetic capacity evidence, not a disk-fill test.

## R3 — P1: phase operation can run without owning lock

`ReleaseGuard(...lock_path='/nonexistent/review.lock',probe=safe_fixture).run_phase('build',callback)` executes callback before entering the context. `check` also fabricates a held-lock receipt in this state. Require the currently acquired live lock context for checks/operations; reject before entry, after exit and unsafe reentry, before callbacks execute. Add explicit side-effect assertions. Context-manager usage in a sample is not sufficient to make the public guard fail closed.

## Installation remains a separate exact review

The six-file candidate defines a contract, not an integrated staging/production wrapper patch. Need exact current wrapper source/hashes, reviewed immutable installed guard, hardened shared lock inode/group access for existing identities, per-phase integration, bounded conservative operation peak, serialized slot, preflight and rollback/forward receipts before live authorization/acceptance. Normal deploy SSH cannot read the staging wrapper source or edit root-controlled wrappers. Do not exploit constrained entry points or reuse the BTF-key-only root-console scope for this work.

Engineer2 notified with all three reproductions. Continue its assigned story: fix/retest/freeze a new exact candidate; prepare readable production wrapper patch and bounded operator packet. No independent-feature prerequisite has emerged. HOLY44 stays parked; BugOff2371–2378 live gates remain unpassed.
