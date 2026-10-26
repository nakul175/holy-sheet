# Local qualification evidence, 27 October 2026

These checks use isolated synthetic data and loopback-only services. They are not staging, suite identity, actual SHO integration or full BugOff acceptance.

Service versions: PostgreSQL 18.6; ClamAV 1.5.4, signature database 28164 dated 25 October 2026. Scanner image digest: `sha256:bda39705e291105049c3936e2803ac90b955172af8030f94f05dce1252df6c6d`.

- Regression candidate: 117 local tests passed; 11 opt-in service tests were skipped in that default run. Type checking and production build passed.
- Real PostgreSQL: six separate opt-in tests passed, covering disjoint writers, duplicate operation acknowledgements/restart durability, inherited permission revocation, discussion/notification deduplication, history restore deduplication and template/page creation concurrency.
- Real ClamAV: five separate opt-in checks passed against the repository scanner policy: clean bytes; standard antivirus test-signature detection; encrypted archive rejection; quarantine with recovery/retry when scanning returns; rejected bytes unavailable and removed without retention delay. These checks use local private objects, not a qualified cloud bucket. Rejected-object cleanup now attempts immediate storage deletion after the rejection tombstone; maintenance retries failures.
- Database restore: a custom-format dump of the synthetic database was restored to a separate new database. All 26 HS tables matched by row count and ordered row digest. All 38 owned synthetic pages matched through authorized repository reads after migration initialization. This does not restore cloud objects or recovery-master-key backups.
- Immutable package from merged source `e541a2cd3f0e20a838b19ea8ed9d10446d5c5fc8`: image digest `sha256:ecdecc50c4a9dff5dd9f34223d5eb9b0efdcda97a69de60df89132dd6aea1dee`. Thirteen disabled-access runtime checks passed. Container ran as `holy`, with a read-only root filesystem, all capabilities dropped and a loopback-only port. Synthetic identity URLs and no session credentials were used; no signed-in suite session was qualified. Missing identity configuration separately returned 503 as designed, rather than the configured/no-session 401.
- Updated Compose configuration validated with synthetic ignored credentials and an external HTTPS object-store placeholder. The original MinIO registry dependency returned 401; it is removed from the deployment path. Actual private cloud storage is still unqualified.

Reproducible entry points:

```sh
npm test
npm run typecheck
npm run build
# Only against the dedicated isolated services, with private environment variables loaded:
npm test -- lib/postgres.integration.test.ts
HS_TEST_CLAMAV_PORT=57310 npm test -- lib/scanner.integration.test.ts
node --import tsx scripts/verify-postgres-restore.mts
node scripts/smoke-disabled-package.mjs
```

Full local logs/reports live under ignored `artifacts/`. The database dump contains synthetic acceptance data only. Service credentials remain in ignored private configuration and are not included in this record. The encrypted-archive scanner fixture requires the system `zip` utility and uses disposable temporary files. No schedules were created or enabled.

Open gates: requested staging domain still has no DNS address; existing deploy account lacks required Holy Sheet service/container privileges; trusted suite issuer/bridge and actual SHO host remain unresolved; a qualified private HTTPS object-store endpoint/account is needed. HOLY-5 sensitive policy decisions remain open, and HOLY-9–17 are absent from the current BTF inventory. Continue eligible implementation without treating these checks as release completion.
