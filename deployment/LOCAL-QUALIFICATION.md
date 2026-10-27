# Local qualification evidence, 27 October 2026

These checks use isolated synthetic data and loopback-only services. They are not staging, suite identity, actual SHO integration or full BugOff acceptance.

Service versions: PostgreSQL 18.6; ClamAV 1.5.4, signature database 28164 dated 25 October 2026. Scanner image digest: `sha256:bda39705e291105049c3936e2803ac90b955172af8030f94f05dce1252df6c6d`.

- Latest regression candidate: 283 local tests passed; 16 opt-in service tests were skipped in that default run and executed separately against the real services. Type checking and production build passed.
- Real PostgreSQL: ten separate opt-in tests passed, covering disjoint writers, duplicate operation acknowledgements/restart durability, inherited permission revocation, discussion/notification deduplication, history restore deduplication, template/page creation concurrency, replacement reservations, personal-list concurrency, backlink transaction visibility and scoped-cursor restart/replay.
- Real ClamAV: six separate opt-in checks passed against the repository scanner policy: clean bytes; standard antivirus test-signature detection; encrypted archive rejection; quarantine with recovery/retry when scanning returns; rejected bytes unavailable and removed without retention delay. The sixth check covers atomic Ready-object recovery pinning after a lost acknowledgement. These checks use local private objects, not a qualified cloud bucket. Rejected-object cleanup now attempts immediate storage deletion after the rejection tombstone; maintenance retries failures.
- Database restore: a custom-format dump of the synthetic database was restored to a separate new database. The latest fresh restore matched all 33 HS tables by row count and ordered row digest. Fifty sampled owned synthetic pages matched through authorized repository reads after migration initialization. The earlier 26-table/38-page backup and restore were preserved; the latest restore uses a separate dedicated test database. This does not restore cloud objects or recovery-master-key backups.
- Immutable package from merged source `e311efdb9f2b3e8ab21bb29f3cca34334cfe28a6`: image digest `sha256:0ae40d72a925ee28767f3fee4382c58ef5d6a12c992e8fa1bb1338827ae3233f`. Seventeen disabled-access runtime checks passed, including the new personal-list, backlink, connected-search and upload-state boundaries. Container ran as UID 1001 (`holy`), with a read-only root filesystem, all capabilities dropped, no-new-privileges and a loopback-only port. Synthetic identity URLs and no session credentials were used; no signed-in suite session was qualified. An earlier unconfigured-identity rehearsal separately returned 503 as designed, rather than the configured/no-session 401.
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

Open gates: requested staging domain still has no DNS address; existing deploy account lacks required Holy Sheet service/container privileges; trusted suite issuer/bridge and actual SHO host remain unresolved; a qualified private HTTPS object-store endpoint/account is needed. HOLY-5 sensitive policy decisions remain open. HOLY-9–17 now exist; foundations for HOLY-11/12/16 are merged and remaining gates are recorded in HOLY-9-17-GATES.md. The Grok infrastructure prompt is in the private local staging handoff. Continue eligible implementation without treating these checks as release completion.
