# HOLY-44 acceptance-hardening upload manifest

Frozen: 28 October 2026 IST

## Exact base and payload

- GitHub repository: `nakul175/holy-sheet`
- Required base revision: `dccc981fbeb0d2a53947f5aca03105d0465bba25` (merged PR 118; current production revision)
- Intended change: test and harden HOLY-44 only. No migration, credential, grant, fixture, staging, production or unrelated-story file is included.

| Path | Bytes | SHA-256 |
| --- | ---: | --- |
| `lib/shared-record-rollups.ts` | 10,419 | `7fe2bc3d226122f58b2640ccb11b69ea11d037660323888faf9b3239a2da59ac` |
| `lib/postgres.integration.test.ts` | 74,074 | `e33dc0dab34e5e5a04c77055ed29599ba8fcd18763b5ca37eed4f4b47469792e` |

This two-file payload is frozen. If either hash changes, this manifest and any approval based on it are invalid and must be regenerated.

## Meaningful diff

- `lib/shared-record-rollups.ts`
  - changes the over-100 **permitted-record** boundary from silent truncation to a safe `record_rollup_limit` result with no partial aggregate;
  - does not expose total linked count when some linked targets are permission-hidden;
  - permits 100 visible targets plus hidden targets without treating hidden targets as a visible-limit failure;
  - retains a separate hard bound of 1,000 stored relationship IDs for corrupted/out-of-contract data;
  - records the explicit `holy-sheet` source in the append-only publication audit payload.
- `lib/postgres.integration.test.ts`
  - adds one isolated real-PostgreSQL HOLY-44 case;
  - covers durable configuration/readback and pool restart;
  - covers current record and sensitive-field grants, tenant isolation and no implicit access;
  - covers identical-operation replay, competing version writes, preview expiry and grant-revocation rollback;
  - covers source revision, relationship edit, archive and merge freshness behavior;
  - covers audit actor/source/time/operation evidence; and
  - inserts 101 actual active related records and covers exact 100-target aggregation, a hidden 101st target without total-count leakage, then safe no-partial failure after that real 101st target becomes permitted.

## Exact isolated qualification

The shared checkout contains unrelated work and is not release evidence. Final qualification was reconstructed in `/private/tmp/holy44-clean.I476pc/repo` from exact base `dccc981`, with only this frozen two-file HOLY-44 payload plus Engineer 4's separately owned baseline dependency `28e43fd`.

The baseline dependency is **not** part of this upload payload. It contains only:

- `app/api/v1/templates/route.ts`
- `lib/template-command-route.test.ts`
- `lib/template-command-schema.ts`

Without that dependency, exact `dccc981` passes focused tests and `tsc` but Next.js rejects the illegal `templateCommandSchema` route export during the production build. With the exact `28e43fd` dependency applied, the combined candidate passed:

- `npm ci`: passed in the isolated checkout.
- TypeScript: passed.
- Focused HOLY-44 plus template-baseline tests: 25 passed, 0 failed (HOLY-44 remains 7/7; template baseline remains 18/18).
- Dedicated real PostgreSQL suite against the exact CI-pinned PostgreSQL 18 image: 39 passed, 0 skipped, 0 failed. The corrected HOLY-44 storage case executed rather than skipping.
- Full exact-combined Vitest run with real PostgreSQL: 1,021 passed, 6 skipped, 0 failed across 126 suites. The only skipped tests were the six real-ClamAV cases, unrelated to this payload; they remain skipped, not passed.
- Full exact-combined JUnit receipt: `artifacts/holy44-clean-combined-full.xml`, SHA-256 `186a5102c87fd6ff8a11fc1f93123db166f2f3cdbadf59de951cc0b65d7ba949`.
- Dedicated PostgreSQL JUnit receipt: `artifacts/holy44-postgres.xml`, SHA-256 `05a4f7ec22fa7d2e2d962f633c515ed9a47ad514788dbc1160fc12a3ead24115`.
- Webpack production build: passed with a real isolated `node_modules`; TypeScript passed; 19/19 static pages generated; rollup API/UI routes present.
- Turbopack production build: passed with a real isolated `node_modules`; TypeScript passed; 19/19 static pages generated; rollup API/UI routes present.

The disposable `holy44-acceptance-db` container and its private credential file were removed after the terminal test results. No other engineer's container, scanner, credential, data or session was changed.

## Still required after approval

1. Upload these exact two files from the exact base to a review branch.
2. Run required GitHub CI, whose isolated PostgreSQL service must execute the new case rather than skip it.
3. Review and merge only if the service test and all existing required jobs pass.
4. Coordinate a serialized staging slot before any switch; do not overwrite another engineer's candidate or acceptance session.
5. Complete the independent authenticated staging/Bug Off AC1–AC6 gates once Product supplies the qualified central-authority role fixture.
6. Use the reserved production slot only if the merged code change is approved for release; do not redeploy the unchanged `dccc981` candidate.

## Preserved approval denial

The first attempted Git blob upload was rejected before any remote mutation. The security reviewer classified the action as uploading changed private source-code contents after the original HOLY-44 deployment and found that the retained earlier approval did not clearly authorize this exact post-deployment follow-up payload to `nakul175/holy-sheet`. No alternate upload path or workaround was attempted. Fresh user approval must refer to this frozen HOLY-44 acceptance-hardening upload.
