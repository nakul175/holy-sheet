# HOLY-44 large-rollup candidate review — 28 October 2026

Frozen candidate: `7b06848ac6f754cd3d1867fb6b27d1a7bbc2e0ce`.
Tree: `6563bb41a9ba3d902c55003ebcafa01fea5834fe`.
Base: `de68a4c826b3e3a2bee06b11983ef59568f6e24e`.
Worktree: `/Users/athena/.codex/worktrees/holy44-large-rollups/Holy Sheet`.
Product verified all eleven SHA-256/byte entries in the source freeze.
No tests/runtime operations were performed by the independent core reviewer.

## P1: stored or terminal responses bypass current validity

In `lib/shared-record-rollups.ts` line17, stored command responses and the
completed-job branch return before `validJob`. Cancellation at line19 has
the same issue. Complete a job, revoke an included record or sensitive
field grant, then replay the final resume operation: the old aggregate
remains available, even after get marks the job stale. Ledger replay also
bypasses workspace binding. Recheck actual job scope, actor, current
authority, revision/permission validity and terminal state before every
result-bearing response, including exact retry receipts. Idempotence must
not resurrect a stale, cancelled or otherwise unavailable value.

## P1: expiry does not prevent result delivery

Migration `db/038_record_rollup_jobs.sql` line31 stops permission policy
revision increments once jobs expire. `validJob` at line15 never checks
expiry. With no other unexpired jobs, allow a completed job to exceed
24 hours, revoke a related-record grant, then get the job: policy revision
can remain unchanged and the old aggregate is returned. Enforce expiry
before all result/progress/resume/replay paths; expired receipts cannot
restore access.

## Required acceptance evidence

The new PostgreSQL case currently covers only all-visible 10,001-record
COUNT, twenty-one resumes and same-command replay. It is authored but NOT
RUN. The ten focused tests and typecheck are preliminary evidence only.
Missing meaningful coverage includes actual aborted transaction/acknowledgment
failure and retry, grant/field/authority/data/schema invalidation, stale
exact receipts, cancel, actor/tenant/workspace boundaries, restart/readback,
large SUM, page-boundary aggregate semantics, concurrent resumes and
hidden-total suppression in responses/audit. Source immutability must use
ID + values + version, not an unkeyed array of version numbers alone.

The source hold was lifted for one bounded batch combining these two P1
fixes with targeted red/green regressions and the missing acceptance tests.
Freeze a new exact candidate for re-review before service qualification.
Keep AC4 and case1917 unchanged. No publishing, release, authority activation
or access grants follow from this review.

## Local runtime boundary

Read-only Docker check: 4,095,040 KiB free (about 3.9 GiB), five running
containers including Engineer3's owned acceptance DB. No resources removed
or changed. The heavy PostgreSQL slot remains held pending corrected code
and test readiness. Preserve the 2 GiB reserve; do not reuse or remove another
engineer's database or bypass the separately denied cleanup.

## Corrected checkpoints / slot release

At d397414, the original current-scope/replay and expiry findings were
addressed, but a remaining P1 exposed the old COUNT through
visibleProcessedCount/processedPages after stale/expired invalidation.
The absence of value alone was insufficient.

Focused re-review closes that metadata finding at
`f80149f06e63c74246f8208b1fde2bee15f12552`, tree
`fc772c6ba5f836e8a76843ff841988a102e6249c`. Invalid terminal projections
omit all three fields, and cached start/resume/cancel receipts revalidate
the scoped job and current terminal state. No remaining same bypass found.
This is static review, not PostgreSQL acceptance.

Product verified all twelve freeze manifest entries, clean exact tree,
self manifest SHA-256
`cc636880d3f51b70cbd1b5b8896a3faf5cdc603cb8fec08573e9e02c6827ea71`
(3,772 bytes), and focused report nineteen passes / four files.

Fresh Docker free space: 4,095,036 KiB. Product released ONE exclusive
local real-PostgreSQL slot to Engineer2 for this candidate's bounded
10,001-record COUNT/SUM and fault/revocation/replay tests, then stable
required gates as capacity permits. Maintain a 2 GiB reserve, use only
his own loopback private synthetic DB, preserve all other resources,
record full failures/counts/space and return a terminal slot-release
receipt. Other engineers' heavy-service hold remains. No cleanup,
publishing, live authority, grants, merge or deployment authorized.
