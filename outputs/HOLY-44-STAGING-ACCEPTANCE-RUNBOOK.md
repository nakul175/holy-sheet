# HOLY-44 authenticated staging acceptance runbook

Prepared: 28 October 2026

This runbook transcribes the live Bug Off cases 1914–1919 into an execution order for the deployed staging candidate. It is preparation only: every case remains **Draft / Not Run** until the authorised fixture exists and observations are attached to an actual Bug Off run.

## Release lock and preflight

- Expected staging revision: `de68a4c826b3e3a2bee06b11983ef59568f6e24e`.
- Expected staging image: `sha256:372f7c718fa7d932eda789357c2bc21b1ca74de8c2d1621b9c84ac56eb50b9fa`.
- Expected rollback revision: `b588a468961713a3c3dc9eeee9c30950248191a2`.
- `de68a4c` is two commits ahead of the qualified HOLY-44 merge and does not change the two hardened HOLY-44 files. Revalidate this ancestry/file invariant if staging advances again.
- Re-read staging status immediately before execution. Stop if source or image differs, another acceptance session owns the service, or PostgreSQL/scanner is not healthy.
- Confirm `HS_RECORDS_ENABLED=1`, a verified Holy Sheet subject/UID, confidential-client service authentication, and an enabled HTTPS `/internal/tenant/status` response bound to the exact subject, tenant, workspace and current 64-hex authority revision.
- Confirm approved normal-login synthetic Owner O, Editor E, Commenter C, Viewer V and outsider X; T1/T2 and W1/W2 mappings; current collection, record and sensitive-field grants; and QA-owned records/relationships. Existing identities, memberships, grants and credentials must not be changed merely to manufacture acceptance.
- Record exact revision/image, actor subject aliases (never credentials), tenant/workspace IDs, authority revision, current grant matrix, UTC start time and correlation IDs.
- Create or select one Bug Off test run containing cases 1914–1919. Do not mark any case Passed from automated or anonymous evidence alone.

## Ordered execution

### F01 / AC1 / case 1914

1. As an authorised operator, count active Gates contracts and calculate sum/min/max over same-currency amounts.
2. Attempt the same aggregate over mixed currencies and incompatible field types.
3. Reopen the affected HS/SHO view and inspect authorised server/audit state.
4. Pass only if the permitted count is exact, compatible totals are exact, incompatible/mixed-currency totals are split or rejected rather than silently combined, configuration persists, and audit evidence names the correct actor/source/time/operation.

### F02 / AC2 / case 1915

1. Capture the same rollup as the full-scope actor, restricted actor, hidden-field actor and outsider.
2. Revoke an approved synthetic grant, refresh authority, and repeat without changing rollup configuration.
3. Pass only if values include current authorised scope, scope is labelled truthfully, restricted names/values/counts cannot be inferred, and revocation takes effect without stale disclosure.

### F03 / AC3 / case 1916

1. Capture the baseline aggregate and freshness/revision state.
2. In separate observed steps, edit a source value, move a relationship, change status, archive a record, and merge approved synthetic duplicates.
3. After each step, reopen the view and compare the aggregate and revision/freshness state.
4. Pass only if confirmed relationships are counted once, archived/merged/inactive sources are handled correctly, and pending/error state is visible rather than represented as a fresh value.

### F04 / AC4 / case 1917

1. Attempt a rollup dependency cycle and verify rejection without source mutation.
2. Exercise the deployed 100/101 boundary with authorised and hidden targets, preserving request and audit evidence.
3. The live case also requires a QA-owned `>10000` related-record fixture, a paginated/asynchronous large-rollup path, truthful progress/retry behaviour and an interrupted job. Current code safely rejects above its synchronous cap; it does not implement or qualify this large-job path.
4. Do not execute a large fixture merely to observe `record_rollup_limit` and call the case passed. F04 remains blocked until Product either authorizes and accepts the missing bounded async implementation or explicitly revises the saved AC4/case.
5. Once that decision is implemented, pass only if work is bounded, no restricted population size leaks, no partial aggregate is returned as success, progress/retry is truthful, interruption is recoverable, and source data remains intact.

### F05 / AC5 / case 1918

1. Repeat the workflow as authorised operator, view-only actor, hidden-field actor and T2 outsider.
2. Revoke permission between preview and confirmation.
3. Probe approved direct IDs and inspect response/error bodies across UI/API/search/preview/download/history surfaces that expose this story.
4. Pass only if every content/action is explicitly permitted, cross-tenant and revoked mutation is denied without partial effect or restricted metadata/count inference, and configuring/publishing the rollup creates no access.

### F06 / AC6 / case 1919

1. Open two normal sessions at the same configuration revision and attempt conflicting updates.
2. With the approved staging fault method, interrupt after server commit but before response, then retry; separately cancel before commit.
3. Complete the primary workflow using keyboard only and at the approved narrow-phone viewport; verify labels, focus and error presentation.
4. Reopen configuration/draft state and inspect audit history.
5. Pass only if each intent has one confirmed effect, stale writes require review, cancellation/failure never produces false success, recoverable state persists, and audit actor/source/time/operation is correct.

## Evidence and result rules

- For every case preserve before/after screenshots, UTC timestamps, request status/body with restricted values redacted, page/record/configuration/operation IDs, correlation IDs, authority revision, current grant matrix and relevant audit rows.
- Reference `HOLY-44`, the AC/F identifier, scenario, case number and manual-script ID in each evidence bundle.
- Record **Blocked / Not Run** if the candidate, fixture, role session, central authority, approved fault method or required data size is absent. Record **Failed** for an observed requirement violation. Record **Passed** only after all steps and expected results for that case are evidenced.
- Clean only explicitly QA-owned disposable fixtures, and only after preserving evidence. Do not delete shared identities, memberships, grants, logs or backups.
- After all six cases pass, update the durable acceptance matrix and BTF with exact Bug Off run/result links. Production promotion remains a separate Product/user-authorised release transaction with fresh backup, health, rollback and post-switch verification.

## Current stop condition

Execution is not authorised yet. The current receipt proves membership rows and an empty isolated workspace, but not normal-login sessions, deployed central tenant authority, tenant/workspace mappings, current record/field grants, synthetic rollup data, or an approved controlled-fault method. No Bug Off result may be created from that incomplete fixture.
