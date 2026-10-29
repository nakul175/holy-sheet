# HOLY-44 acceptance matrix — deployed, functional acceptance pending

Date: 28 October 2026

## Candidate and release evidence

- Story: HOLY-44 — permission-aware relationship rollups.
- Pull request: https://github.com/nakul175/holy-sheet/pull/118 (merged).
- Production commit: `dccc981fbeb0d2a53947f5aca03105d0465bba25`.
- Production image: `sha256:13772c67b7da4da1e07d151df30dc3916342f1cd168a5e064b3af34327a4a93f`.
- Current staging commit: `de68a4c826b3e3a2bee06b11983ef59568f6e24e`.
- Current staging image: `sha256:372f7c718fa7d932eda789357c2bc21b1ca74de8c2d1621b9c84ac56eb50b9fa`.
- Current staging rollback revision: `b588a468961713a3c3dc9eeee9c30950248191a2`.
- Production release gates: backup and additive migrations passed; local/public health passed; rollback rehearsal passed; no auto-restore.
- Public probes: `/` and the rollup UI returned 200; the protected rollup API returned 401 anonymously. These prove reachability and anonymous denial only, not authenticated behavior.
- GitHub Actions run 40705463744 passed validate, container, accessibility and collaboration-experiment. Validate ran 1,018 tests successfully with 6 skipped; its isolated PostgreSQL file ran 38 tests. The seven HOLY-44 tests (three evaluator/compiler and four mocked route tests) passed, but the PostgreSQL suite contains no HOLY-44 repository/storage case.
- The earlier local default run reported 997 passed and 44 skipped. Those 44 remain classified as skipped, not passed.

### Acceptance-hardening follow-up (merged and deployed to staging)

- PR 119 merged first as `b4302fc880464236d41c48132564283e403efe20`. PR 121 was then retargeted to `main`, verified as the exact approved two-file diff, and merged as `b588a468961713a3c3dc9eeee9c30950248191a2`.
- Fresh push Actions 40721997955 qualified that exact merge revision: validate, accessibility, container and collaboration-experiment passed; 1,024 tests passed with 6 ClamAV-dependent skips across 126 suites; the real PostgreSQL acceptance suite executed 39/39, including the HOLY-44 storage case. Synthetic PostgreSQL backup/restore, typecheck and the 19/19-page production build passed.
- The constrained staging wrapper backed up the database before switching. Backup `holy_sheet-20261028-213923-b588a46.dump` has SHA-256 `4562ebb16c7443a221c4ee131cacf470f3d4737b57545154386af6c74a441b20`.
- That historical post-switch staging status reported exact current `b588a468961713a3c3dc9eeee9c30950248191a2`, previous `ec678a7da35c17140d04e21bc4b98849b99dd034`, image `sha256:feba10b66ddbd946910d69611b3439dce2a03ba7ecc9b70d5a59cfb39588d4ef`, running app, and healthy PostgreSQL and scanner. Public probes returned `/` 200, rollup UI 200, `/auth/session` 401, and protected rollup API 401 anonymously.
- The hardening proves persistence/readback, current permission filtering, tenant isolation, retry/concurrency, expiry/revocation rollback, freshness changes, audit, restart, 100 permitted targets, a hidden 101st target without count disclosure, and a permitted 101st target returning `record_rollup_limit` without a partial value. Synthetic PostgreSQL backup/restore, TypeScript and the production build also passed.
- These results strengthen service and anonymous staging evidence only. They do not replace authenticated staging observations or Bug Off execution. Production remains on the earlier `dccc981` release until separately authorized.
- Staging subsequently advanced through the shared serialized release path to combined main `de68a4c826b3e3a2bee06b11983ef59568f6e24e`, image `sha256:372f7c718fa7d932eda789357c2bc21b1ca74de8c2d1621b9c84ac56eb50b9fa`, with `b588a468961713a3c3dc9eeee9c30950248191a2` retained as rollback. A GitHub compare reports `de68a4c` is two commits ahead of `b588a468`, with no changes to `lib/shared-record-rollups.ts` or `lib/postgres.integration.test.ts`; the qualified HOLY-44 hardening is therefore retained. PostgreSQL and scanner were healthy at the status readback. This provenance update does not qualify the later commits for HOLY-44 functional acceptance by itself.

## Acceptance status

| AC / Bug Off | Required live observation | Automated evidence on exact candidate | Authenticated staging / Bug Off result | Status and missing prerequisite |
| --- | --- | --- | --- | --- |
| AC1 / F01 / 1914 | Authorized count/sum behavior, mixed-currency refusal, persisted view and audit evidence | Typed count/sum/min/max compilation and evaluation tests pass; invalid type/currency tests pass; reviewed publish and audit writes are implemented | Case is Draft with no result; no signed-in execution | **Pending.** Needs live central authority plus an authenticated tenant admin and approved collections, fields, records and relationships |
| AC2 / F02 / 1915 | Per-viewer current record/field permission filtering without disclosure of hidden values or totals | Repository query filters linked active records through current collection/record grants; sensitive fields require current field permission; unrestricted totals are not cached | Case is Draft with no result; no admin/editor/viewer/unshared comparison | **Pending.** Needs qualified login sessions and exact collection/record/field grants for the approved synthetic actors |
| AC3 / F03 / 1916 | Freshness after source, relationship, status, archive and merge changes, with stale/restricted behavior | Freshness hash includes owner/related record versions, schema, policy and authority revision; inactive and merged records are excluded | Case is Draft with no result; mutation matrix not executed | **Pending.** Needs approved mutable synthetic records and authenticated observations before/after each change |
| AC4 / F04 / 1917 | BTF: cycles/deep fan-out bounded and large rollups remain paginated/asynchronous with safe failure. Bug Off: reject a cycle; exercise a QA-owned `>10000` related-record fixture; interrupt the job; show bounded work plus truthful progress/retry and untouched source data | Exact-merge CI proves only the synchronous safe boundary: 100 permitted targets aggregate, a hidden 101st is not disclosed, and a permitted 101st returns `record_rollup_limit` without a partial value. Evaluator/route error paths pass. The implementation also rejects more than 1,000 stored IDs / more than 100 visible permitted targets; it has no qualified large-rollup pagination, asynchronous job, progress, interruption or completion evidence | Case is Draft with no result; no authenticated cycle or large-job execution | **Implementation and acceptance gap.** Safe rejection is valid partial evidence but cannot be relabelled as the required large-rollup path. Product must either retain AC4/F04 and authorize a bounded async implementation, or explicitly revise the saved requirement/case; until then F04 cannot pass |
| AC5 / F05 / 1918 | Enforce tenant, record, field and action permissions across UI/API/search/previews/downloads/history; configuration never grants access | Repository and route code bind tenant/workspace/actor, recheck current record/field grants and avoid creating grants; focused denial tests pass | Case is Draft with no result; no authorised/revoked/hidden-field/T2-outsider surface matrix | **Pending.** Needs qualified role sessions, exact grants, direct-ID/error-body checks and verification that publication creates no access |
| AC6 / F06 / 1919 | Versioning, duplicate retry/stale-write protection, recoverable drafts, actor/source/time/operation audit, keyboard and phone completion | Exact-merge CI executes PostgreSQL retry/concurrency, expiry/revocation rollback, audit source/time/operation and restart evidence; generic accessibility passed | Case is Draft with no result; no signed-in interrupted-response/cancel/stale-write run, durable draft recovery, keyboard or phone run | **Pending.** PostgreSQL concurrency/restart/rollback evidence is complete on the deployed staging revision; the signed-in F06 manual workflow remains required |

## Exact environment blocker

`authenticateRecordAuthority` has no authority fallback. A signed-in rollup request requires all of:

1. `HS_RECORDS_ENABLED=1`;
2. a server-verified Holy Sheet subject and UID;
3. a valid confidential-client secret;
4. an HTTPS identity issuer whose `/internal/tenant/status` endpoint is deployed and enabled;
5. an active response bound to the exact subject, tenant ID and workspace ID, with the current 64-hex authority revision; and
6. independent current collection, record and sensitive-field grants in Holy Sheet.

The historical central authority review at `deployment/HOLY-19-CENTRAL-TENANT-AUTHORITY-REVIEW.md` says the adapter was prepared but not deployed, had no HTTP/native record activation, and still required approved authority data and verified-session integration. The approved synthetic fixture receipt at `/Users/athena/.codex/.chatgpt-projects/g-p-6ab89116b65c81919bb561fed2d716c0/outputs/holy-sheet/finish29-20261028/fixture-receipt.json` proves three membership rows for workspace `qa-next50-isolated-20261028`, but it also records `createdEmpty: true`. It therefore does not prove qualified login sessions, an enabled tenant-authority response, an organisation/tenant mapping, or any collection, record or sensitive-field grant.

Current credential-free boundary evidence supersedes only the review's statement that the HTTP route was absent: on 28 October 2026, `GET https://accounts.aplyd.org/internal/tenant/status` returned 404 while an empty JSON `POST` returned 401. This proves the protected POST route is deployed, not that its authority adapter is enabled, that any mapping is active, or that a usable authority revision exists. No live operator, enabled proof, tenant/workspace mapping, independent record grants or current 64-hex revision has been handed off. Those remain the concrete central-authority actions owned outside Engineer 2's code path.

## Ownership and safe next action

- Product/release owner: provide or identify the deployed staging central-authority endpoint and its revisioned tenant/workspace mapping.
- Fixture owner: provide normal-login authenticated admin/editor/viewer/unshared subjects mapped to the approved isolated workspace, plus reviewed collection/record/field grants and synthetic rollup data. Existing memberships, credentials or production grants must not be changed merely to manufacture a pass.
- Engineer 2: remain on HOLY-44; add any approved missing service evidence, execute cases 1914–1919 once the fixture is qualified, attach exact observations/receipts, and only then request acceptance. Do not redeploy the unchanged candidate and do not start another story.

Conclusion: HOLY-44 hardening is retained in current staging combined main `de68a4c826b3e3a2bee06b11983ef59568f6e24e`; production remains on `dccc981fbeb0d2a53947f5aca03105d0465bba25`. AC4/F04 has a confirmed implementation gap for asynchronous large rollups, while AC1–AC6 authenticated functional acceptance and all six mapped Bug Off results remain open. BTF is **In Progress** and must not move to Done until those gates have evidence and production is separately authorized and verified.
