# HOLY-3 staging preparation

Checkpoint, 27 October 2026: staging remains on `99a6327`, with OIDC/editor enabled and local preview disabled. The constrained status wrapper reports the app running and PostgreSQL/scanner healthy. The merged package/recovery batch `dbc5066` and subsequent picker batch `9aa0556` are not deployed. The latter adds an actor-scoped creation ledger migration. Read [the controlled rollout plan](HOLY-3-ROLLOUT.md) before switching. Infrastructure and anonymous readiness do not establish full product acceptance; historical local evidence remains in LOCAL-QUALIFICATION.md.

## Configuration and prerequisites

For a new environment, keep `HS_OIDC_ENABLED=0` until the confidential `holy-sheet` client and exact `/auth/callback` plus `/auth/signed-out` URLs are registered. Existing staging registration and secrets must be preserved. Provide separate private `HS_OIDC_CLIENT_SECRET` and 32-byte Base64 `HS_OIDC_TRANSACTION_KEY`. Enabling sign-in is distinct from enabling the editor. See HOLY-3-IDENTITY-BRIDGE-REVIEW.md and HOLY-3-SUITE-SESSION-REVIEW.md. Never paste real secret values into commands, chat or Git.

Use Docker Engine with Compose v2 on a dedicated staging host. Copy `.env.staging.example` to `.env.staging` locally; that file is ignored by Git. Supply distinct PostgreSQL, scoped storage service-account and maintenance credentials. Generate a 32-byte Base64 recovery master key, retain it in the staging secret manager and protect its backup separately from database backups. Losing it makes existing encrypted recovery drafts unreadable. Passwords interpolated into `DATABASE_URL` must be URI-safe (random hexadecimal values work).

Set `HS_ORIGIN` to the exact HTTPS origin served by your reverse proxy. Only the application binds a host port, on loopback port 3100. The proxy must terminate TLS, preserve the Host header, forward the Origin header unchanged, enforce request limits above the application's 25 MB upload boundary, and disable buffering/caching for authenticated media. Do not expose the database, storage console or scanner publicly.

For a new environment, configure the agreed issuer and HTTPS JWKS URL. The implemented authorization-code/S256 bridge verifies identity and provides the protected `__Host-hs_session` cookie (with a legacy compatibility alias), HttpOnly/Secure/SameSite=Lax. HS verifies signature, `sub`, `iat`, `exp`, issuer and audience `holy-sheet`, plus live suite-session status when OIDC is enabled. Tokens are short-lived; one hour is an upper guard, not a refresh promise. Never put credentials in page URLs. Bootstrap uses the immutable trusted `sub`, not an email; do not re-provision the existing staging workspace during a code rollout.

Set `S3_ENDPOINT` to a qualified HTTPS S3-compatible endpoint and `S3_BUCKET` to a private bucket with public access disabled. Scope the service account to that bucket and verify anonymous denial, authorization loss, range requests and cleanup against the actual provider. The previous MinIO/mc registry tags could not be pulled (registry 401); the official MinIO source repository is archived. They are no longer deployment dependencies. Existing `storage-bootstrap.sh` and `media-policy.json` remain unqualified MinIO-specific reference material, not an automatic deployment step. See [the official repository](https://github.com/minio/minio).

PostgreSQL, ClamAV and Node are pinned to immutable image digests. The qualified local ClamAV image is amd64; choose a qualified native image/platform for another target architecture. Service compatibility and signature freshness checks on the intended host remain required. Scanner acceptance used isolated loopback services, not a public deployment.

## Deployment after prerequisites are satisfied

The following are generic operator commands, not an assertion that each command has been run on staging. Use the host's constrained deployment wrapper when applicable; do not print interpolated configuration/secrets into chat or public logs:

```sh
docker compose --env-file .env.staging -f compose.staging.json config --quiet
docker compose --env-file .env.staging -f compose.staging.json build app
docker compose --env-file .env.staging -f compose.staging.json up -d
docker compose --env-file .env.staging -f compose.staging.json exec app node scripts/provision-workspace.mjs
```

Provisioning adds the configured owner, workspace and space using an additive transaction; it does not change existing grants. The application applies the ordered additive migrations from `db/002_documents.sql` onward under a database migration lock. Back up the database before migration and verify restoration with matching private objects and recovery master key. The old tables remain available, but turning off the feature is not a reverse data migration.

New environments default `HS_RICH_EDITOR_ENABLED=0` until identity and proxy checks pass. Existing staging's editor is enabled for qualification; preserve that setting unless deliberately using the constrained kill switch. Feature-disable is not a data rollback. Scanner failures keep uploads unavailable. Confirm private bucket/service-account boundaries and quarantine against actual services.

Maintenance is an explicit operator action: `POST /api/internal/maintenance` with `Authorization: Bearer <HS_MAINTENANCE_TOKEN>`. It processes at most 50 candidates per call, honors live references, unexpired recovery leases and available history pins, retains ordinary scanned detached objects for at least seven days, and retries storage deletions after failures. Security-rejected objects bypass these retention protections and are purged promptly. History availability expires 90 days after supersession; current revisions remain retained. No schedule is installed or enabled. Do not delete storage objects directly to work around a failed cleanup.

## Qualification required before HOLY-3 completion

- Execute the 38 HOLY-3 BugOff acceptance cases against the reviewed spec revision 2.0; record each actual result and evidence. Local unit tests do not change their Draft/Not Run status.
- Exercise real PostgreSQL with concurrent writers, retries, restart and backup restoration; compare persisted documents and stable block IDs.
- Complete suite login/logout, expiry, revoked membership and Owner/Editor/Viewer access checks, including search, page references, recovery keys and every media request.
- Verify private storage, clean and infected uploads, encrypted/macro files, scanner outage, cancellation races, quota replacement, recovery leases and seven-day cleanup boundaries.
- Integrate the actual SHO host with `/embed/pages/:id`; verify identity, focus, navigation, sizing, permission loss and logout in the real embedding context. The HS-owned embed route alone does not qualify SHO.
- Finish the remaining editor behavior recorded in `IMPLEMENTATION-STATUS.md`, then run keyboard, screen-reader, mobile, accessibility and specified large-document performance checks.

Record deployment revision, image digests, configuration names (never secret values), service versions, test evidence and outstanding defects in the release record. Do not mark the story Done or treat a successful build as release acceptance.
