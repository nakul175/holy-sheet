# HOLY-44 bounded large-rollup design checkpoint

Date: 28 October 2026
Base: `de68a4c826b3e3a2bee06b11983ef59568f6e24e`
Scope: AC4 / Bug Off 1917 only; retain the existing 100/101 safety behavior and all other HOLY-44 semantics.

## Requirement lock

- BTF AC4: cycles/deep fan-out are bounded; large rollups remain paginated/asynchronous with safe failure.
- Bug Off 1917: reject a dependency cycle; execute a QA-owned `>10000` related-record fixture; interrupt work; expose truthful progress/retry; never mutate source records.
- The existing synchronous path remains for at most 100 currently visible targets. A hidden 101st target must not disclose total linked population. A permitted 101st target must stop synchronous evaluation with `record_rollup_limit`, never a partial value.
- Safe rejection above the synchronous cap remains a regression, but is not large-rollup completion evidence.

## Chosen execution model

Use a durable, request-driven PostgreSQL job. Next.js Route Handlers are public endpoints and may run in environments where long-running handlers are terminated and memory cannot be shared across requests. Therefore the job does not depend on in-memory queues, timers, WebSockets, `after()`, or work continuing after a response.

1. `start-large-evaluation` creates one private job bound to tenant, workspace, actor, owner record, rollup field/version, current schema/policy/data/authority revisions and an idempotent operation ID.
2. The start transaction snapshots the bounded relationship list into private job items in ordinal order. Maximum linked input is 100,000 IDs; larger input fails safely before a job is created. No source record is updated.
3. `resume-large-evaluation` claims one command ID and processes at most 500 items in one database transaction. Retrying the same command returns the same committed progress. A different command resumes from the durable cursor.
4. Every resume re-verifies tenant/workspace/actor authority, relationship-field visibility, value/filter-field visibility, rollup version, owner version, schema revision, policy revision, data revision and central authority revision. Any mismatch makes the job `stale` with no result.
5. Each page applies current collection/record permission filtering inside SQL. Only active, non-merged, same-tenant rows that are currently viewable are aggregated. Hidden IDs and the total linked population are never returned.
6. Aggregation state is persisted after each page. Responses expose state, processed page count, visible processed count and whether more work remains. They do not expose total linked count or a percentage to restricted viewers.
7. Completion writes a result only after the final page commits under the same revision checks. Before completion, `value` is always absent/null and state is never reported as completed.
8. `get-large-evaluation` re-verifies current authority and permissions before returning progress/result. If current revisions differ, it marks/returns the job stale rather than serving an old value.
9. `cancel-large-evaluation` is idempotent and leaves source records unchanged. Cancelled/stale/failed jobs never expose a completed value.

## Persistence

Migration `038_record_rollup_jobs.sql` adds:

- `hs_data_rollup_jobs`: immutable scope identity, revision locks, definition snapshot, aggregate accumulator, durable cursor, visible count, page count, state (`pending`, `running`, `completed`, `stale`, `cancelled`, `failed`), result, failure code and bounded expiry.
- `hs_data_rollup_job_items`: private ordered UUID snapshot, deleted with its job.
- `hs_data_rollup_job_commands`: idempotent start/resume/cancel operation ledger with request hash and result progress.
- identity/state constraints and indexes for actor lookup and operator cleanup.
- statement/row triggers that increment tenant `policy_version` when collection grants, record grants or sensitive-field permissions change, so in-flight and completed jobs fail closed after permission changes.

No schedule is installed. Expired-job cleanup remains an explicit bounded operator action and is not part of result correctness.

## Aggregate representation

- `count`: persisted integer count.
- number `sum`: persisted finite numeric accumulator.
- number/date `min`/`max`: persisted JSON scalar.
- currency: persisted integer minor units as a decimal string, preserving the configured ISO currency and scale.
- Null inputs remain excluded. A completed empty `count` is `0`; other completed empty aggregates are `null`.
- Filters are evaluated only from current permitted rows. Sensitive required fields must remain visible throughout the job.

## Cycle and bound behavior

- A rollup value/filter may never reference another rollup field. The compiler/repository will explicitly reject that dependency instead of treating it as an unavailable ordinary field.
- Repeated/self record IDs are deduplicated by the job-item primary key and do not recurse. Aggregation remains one-hop; no record traversal is used.
- Job start rejects more than 100,000 linked IDs, malformed IDs, or a definition/record/version mismatch.
- Synchronous evaluation keeps the existing 1,000 stored-ID guard and 100 visible-row guard. The client must explicitly start the large path after receiving the safe bounded response.

## Fault, retry and audit contract

- A resume page and its command receipt commit atomically. Interruption before commit changes nothing; retrying the same command processes that page once. Interruption after commit returns the stored receipt on retry.
- Start, page progress, completion, stale transition and cancellation write safe audit entries with job ID, owner record ID, rollup field/version, processed/visible counts, page number, state and source `holy-sheet`; never values, hidden IDs or unrestricted counts.
- Controlled tests inject a failure immediately before page commit and immediately after commit acknowledgment. Both must prove idempotent recovery and unchanged source record versions/values.
- Revocation/schema/data/authority changes between pages must produce `stale`, no completed value and a restart requirement.

## API surface

Extend the existing no-store rollup Route Handler discriminated command union:

- `{kind:'start-large-evaluation', recordId, fieldKey, operationId}`
- `{kind:'resume-large-evaluation', jobId, operationId, expectedVersion}`
- `{kind:'get-large-evaluation', jobId}`
- `{kind:'cancel-large-evaluation', jobId, operationId, expectedVersion}`

All commands use the existing `authenticateRecordAuthority`, same-origin mutation checks, generic restricted/not-found behavior and bounded JSON body. No server component calls the Route Handler.

## Required tests before publication review

- Pure accumulator tests for count, numeric/date/currency min/max/sum, filters, nulls and page combination.
- Route tests for strict schemas, same-origin, auth-before-data, no-store responses and safe errors.
- PostgreSQL tests for: 100/101 regressions; `>10000` completed count/sum; visible-only filtering with no hidden-total response; two tenants; field revocation; record grant revocation; data/schema/authority revision changes; cycle rejection; cancel; stale/failed no-value states; source rows unchanged; audit contents; restart/readback.
- PostgreSQL controlled interruption before commit and after commit acknowledgment, followed by same-command retry proving exactly-once progress/result.
- Typecheck, focused tests, full host suite, real PostgreSQL suite, backup/restore, both production builds and container checks.
- Authenticated staging Bug Off 1917 remains separate and requires the approved central-authority/five-session fixture and serialized data-heavy slot.

## Remaining external prerequisites

- Product review of this frozen design and later frozen source manifest.
- Release of the serialized local data-heavy PostgreSQL slot for the `>10000`/fault run.
- Two additional immutable synthetic subjects, current normal OIDC sessions, an enabled central-authority operator/revision, exact tenant/workspace mappings and independent record/field grants.
- Explicit staging reservation after current shared acceptance work ends; fresh source/image/rollback readback.
- Publication, merge, staging, production and tracker transitions remain separate approval/release boundaries.
