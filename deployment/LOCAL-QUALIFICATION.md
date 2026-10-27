# Local qualification evidence, 27 October 2026

These checks use isolated synthetic data and loopback-only services. They are not staging, suite identity, actual SHO integration or full BugOff acceptance.

Service versions: PostgreSQL 18.6; ClamAV 1.5.4, signature database 28164 dated 25 October 2026. Scanner image digest: `sha256:bda39705e291105049c3936e2803ac90b955172af8030f94f05dce1252df6c6d`.

- Latest regression candidate: 309 local tests passed; 16 opt-in service tests were skipped in that default run and executed separately against the real services. Type checking and production build passed. PR #16 passed CI and merged as `bbee762955ac0c0d9d1da6c0720128a0d6660e46`; ten real PostgreSQL and six real scanner checks passed again on that combined main.
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

Latest immutable package: merged source `bbee762955ac0c0d9d1da6c0720128a0d6660e46`, image `sha256:8d7d9f7411f1a7d7c5bf43db52b956a8e1fc315d189df635983f248d4e327043`, built from a separate git archive. All 17 boundary checks passed with the same non-root/read-only/capability/loopback restrictions. The preceding package and restore evidence above remain historical checkpoints. Local preview POST connected-search returned three synthetic scoped results; foreign Origin returned 403. This preview is not suite authentication.

Staging infrastructure update: HTTPS at `https://staging.holysheet.aplyd.org` independently returned HTTP 200 with HSTS, and all 17 unauthenticated boundary checks passed there. Configured staging maintenance correctly returns 401 without its credential; the unconfigured isolated package returns 503. These are explicit different expectations. Public accounts discovery returned an issuer, authorization/token/end-session endpoints and S256 support; JWKS returned one RS256 key. No authorization code, token mint, audience approval or signed-in session was tested. The operator reports the staging app at `d2693bd4b21a4f5788efd165dd0de88b7c676ab1`; the available wrapper builds successfully but cannot update/report a revision. Latest-main staging deployment has not been claimed. The operator reports private object storage and healthy PostgreSQL/scanner; actual product storage/scanning/restore acceptance there remains unrun.

Subsequent service inspection: the dedicated wrapper's `ps` lists the app and healthy PostgreSQL, but no running scanner. Retained scanner logs end with “Failed to start clamd.” The cause/exit state is not established by those logs. This supersedes the operator's earlier scanner-health report; no blind restart or product scanning acceptance is claimed. A focused operator follow-up was requested.

Open gates: scanner startup/capacity diagnosis, constrained revision update/reporting for staging, accounts client/audience/redirect registration and session/logout bridge, exact bootstrap subject, actual SHO embed and real staging PG/scanner/private-object qualification. HOLY-5 sensitive policy decisions remain open. HOLY-9–17 now exist; foundations for HOLY-11/12/16 are merged and remaining gates are recorded in HOLY-9-17-GATES.md. The Grok infrastructure prompt remains outside public Git in the private local staging handoff. Continue eligible implementation without treating these checks as release completion.
