# HOLY-44 upload manifest

Prepared against GitHub `main` commit `6f7e10964b719abb7b0d7ee9c609ef8ca5406f90`.

This checkpoint does not authorize or claim an upload. The eight paths below are the complete intended HOLY-44 payload; unrelated working-tree files are excluded.

| Path | Bytes | SHA-256 |
| --- | ---: | --- |
| `db/037_record_rollups.sql` | 1,505 | `1f015f63410a2e50176e40a578a48bb681413ecb11f9fdd34c2bbcc098ffdaf5` |
| `lib/record-rollups.ts` | 3,906 | `cc78ca42eb578efe87fa8640dee51075a7478d0df27c60cfb0f9f59c4a3ab4cf` |
| `lib/record-rollups.test.ts` | 2,520 | `9153349f23cb9010755a559a7c7c43fd4aa438a27f81c51aa3a858ef311165c5` |
| `lib/shared-record-rollups.ts` | 10,009 | `c1884d4a2c869e7e0b77f32265c51a3459d9611ca40574fb5c8e4efd984b7be1` |
| `lib/record-rollup-route.test.ts` | 3,464 | `97c18bb68a74e91ddfda30b32cd8b29924746e90ff66fcb24db8b20da7acf962` |
| `app/api/v1/workspaces/[id]/tenants/[tenantId]/record-rollups/route.ts` | 2,726 | `412d24b65f9a67da1c8e7ae35e5de3359aba6ab9d8fa019f25663469961cf0e5` |
| `components/rollup-manager.tsx` | 5,790 | `73ecda8c6e32fdb274a58eec3777c04105a1376532b47885d62aef5eafc88d2a` |
| `app/workspaces/[id]/tenants/[tenantId]/collections/[collection]/rollups/page.tsx` | 318 | `6ee400a17169d625fdc4937125d681b6bb21a8a62dcc01d22644e1590975812d` |

Final qualification after permission-policy/authority freshness hardening:

- Webpack production build: passed.
- Turbopack production build: passed.
- Full Vitest suite: 997 passed, 44 skipped, 0 failed across 127 files.
- Focused rollup and route tests: 7 passed.
- TypeScript: passed.

The manifest hashes were captured after the final freshness change and before these final gates. No payload file changed during qualification.
