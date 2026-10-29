# HOLY-44 Product acceptance review — 28 October 2026

Engineer 2 reported HOLY-44 complete and deployed at `dccc981fbeb0d2a53947f5aca03105d0465bba25` through PR 118. Product has not accepted story completion or assigned the next story.

## Evidence reviewed

- Live BTF: <https://backlogtothefuture.aplyd.org/aplyd/issue/HOLY-44>. State was **Backlog** at review. Comment 10673 records source/image, CI, backup, migration, rollback and anonymous probes, and claims “live end to end.”
- BTF AC1–6 require actual rollup correctness, current record/field permissions, invalidation/freshness, bounded fan-out and failure behavior, versioned/retry-safe configuration, recoverable drafts, audits, keyboard and phone workflows.
- BTF maps F01–F06 respectively to Bug Off cases 1914–1919.
- Live case F01: <https://bugoff.aplyd.org/en-US/projects/repository/3/1914>. Draft manual case; **No test results found for this test case** at review. Its script requires authorized count/sum behavior and mixed-currency refusal in isolated staging, then persisted-view/audit checks.
- Engineer 2's report and latest BTF comment show anonymous root/UI 200 and protected API 401. These establish reachability and anonymous denial; they do not establish signed-in functional acceptance.
- Local audit did not locate an authenticated HOLY-44 acceptance matrix/results for the deployed revision. This absence does not invalidate external build/deployment receipts; those must be linked separately.

## Required next action

Engineer 2 remains on HOLY-44 only. Product requested an AC1–6 matrix with exact candidate, synthetic tenant/workspace/actor mappings, authenticated staging observations and mapped Bug Off run/results. If unexecuted, correct the completion wording and keep acceptance open. Required service tests skipped in a default local run need separate service evidence.

No new deployment, access change, test result, tracker state transition or next-story assignment was made by this review. A missing live fixture or authority contract must be reported with its exact owner and evidence path.

## Engineer 2 correction and follow-up

Engineer 2 acknowledged the acceptance gap and reports BTF now **In Progress**. The durable matrix is `outputs/HOLY-44-ACCEPTANCE-MATRIX.md`; all six mapped manual cases remain Draft/Not Run. Product requested correction of the AC5/AC6 mapping to the saved requirements.

The missing PostgreSQL test design exposed a concrete defect: more than 100 linked records were silently truncated. Engineer 2 prepared a safe `record_rollup_limit` failure and audit-source change in `lib/shared-record-rollups.ts`, plus repository/service coverage in `lib/postgres.integration.test.ts`. Focused tests and typecheck pass; the new PostgreSQL case has not run locally because no PostgreSQL runtime is available. The follow-up is not yet qualified or deployed.

Engineer 2 reports automatic approval review rejected upload of this changed follow-up because the earlier human approval covered a frozen eight-file payload. Product requested a final, locally validated two-file manifest before seeking approval. No alternative upload route is authorized to bypass that rejection.

Product asked Engineer 1 for a read-only current central-authority and synthetic fixture handoff. Historical “prepared, not deployed” documentation alone is insufficient evidence of today's endpoint status. No central activation, tenant mapping, role/grant or credential change was authorized by this request.

## Allocation policy

The user's current rule is to finish the current story through all required acceptance/release gates, then stop and return to Product. Future assignments are independent vertical slices selected after dependency, ownership, fixture and release-path checks. Numerical sequence and former range allocations do not authorize automatic next-story work. Schedules and heartbeats remain paused.
