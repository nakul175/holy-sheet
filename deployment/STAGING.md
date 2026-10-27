# HOLY-3 staging preparation

Staging infrastructure is live at the requested domain. Scanner startup has been corrected by the operator, and constrained revision deployment now exists. PR22 editor fixes at 993465f3d5987f2ec0f81226276c6d68d42091d0 were deployed with app/database/scanner running and passed 17 unauthenticated boundaries. The editor stays off. A subsequent disabled OIDC bridge candidate has 365 local tests and typecheck/build evidence; accounts registration and actual login/logout remain required. Earlier local PostgreSQL/scanner/restore checks do not qualify staging private cloud objects or actual SHO integration. See LOCAL-QUALIFICATION.md for exact source/image boundaries.

## Configuration and prerequisites

Sign-in bridge: keep `HS_OIDC_ENABLED=0` until the confidential `holy-sheet` client and exact `/auth/callback` plus `/auth/signed-out` URLs are registered. Provide separate private `HS_OIDC_CLIENT_SECRET` and 32-byte Base64 `HS_OIDC_TRANSACTION_KEY`. Enabling sign-in is distinct from enabling the editor. See HOLY-3-IDENTITY-BRIDGE-REVIEW.md for logout propagation and qualification gates. Never paste real secret values into commands, chat or Git.

Use Docker Engine with Compose v2 on a dedicated staging host. Copy `.env.staging.example` to `.env.staging` locally; that file is ignored by Git. Supply distinct PostgreSQL, scoped storage service-account and maintenance credentials. Generate a 32-byte Base64 recovery master key, retain it in the staging secret manager and protect its backup separately from database backups. Losing it makes existing encrypted recovery drafts unreadable. Passwords interpolated into `DATABASE_URL` must be URI-safe (random hexadecimal values work).

Set `HS_ORIGIN` to the exact HTTPS origin served by your reverse proxy. Only the application binds a host port, on loopback port 3100. The proxy must terminate TLS, preserve the Host header, forward the Origin header unchanged, enforce request limits above the application's 25 MB upload boundary, and disable buffering/caching for authenticated media. Do not expose the database, storage console or scanner publicly.

Replace the placeholder suite issuer and HTTPS JWKS URL with an agreed identity adapter. The application currently verifies RS256/ES256 JWTs with `sub`, `iat`, `exp`, issuer and audience `holy-sheet`, accepting at most one hour of token lifetime. There is no implemented suite login callback or token exchange. An authenticated bridge must provide the session as an HttpOnly, Secure, SameSite cookie named `hs_session`; document the bridge and logout propagation before enabling access. Do not place tokens in page URLs. Set the bootstrap subject to the exact trusted `sub`, not an email address.

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

Keep `HS_RICH_EDITOR_ENABLED=0` until identity and proxy checks pass. Enabling it requires a configuration change and service recreation during an authorized qualification run. The application must return feature-disabled responses while off. Scanner failures keep uploads unavailable. Confirm private bucket/service-account boundaries and quarantine against actual services.

Maintenance is an explicit operator action: `POST /api/internal/maintenance` with `Authorization: Bearer <HS_MAINTENANCE_TOKEN>`. It processes at most 50 candidates per call, honors live references, unexpired recovery leases and available history pins, retains ordinary scanned detached objects for at least seven days, and retries storage deletions after failures. Security-rejected objects bypass these retention protections and are purged promptly. History availability expires 90 days after supersession; current revisions remain retained. No schedule is installed or enabled. Do not delete storage objects directly to work around a failed cleanup.

## Qualification required before HOLY-3 completion

- Execute the 38 HOLY-3 BugOff acceptance cases against the reviewed spec revision 2.0; record each actual result and evidence. Local unit tests do not change their Draft/Not Run status.
- Exercise real PostgreSQL with concurrent writers, retries, restart and backup restoration; compare persisted documents and stable block IDs.
- Complete suite login/logout, expiry, revoked membership and Owner/Editor/Viewer access checks, including search, page references, recovery keys and every media request.
- Verify private storage, clean and infected uploads, encrypted/macro files, scanner outage, cancellation races, quota replacement, recovery leases and seven-day cleanup boundaries.
- Integrate the actual SHO host with `/embed/pages/:id`; verify identity, focus, navigation, sizing, permission loss and logout in the real embedding context. The HS-owned embed route alone does not qualify SHO.
- Finish the remaining editor behavior recorded in `IMPLEMENTATION-STATUS.md`, then run keyboard, screen-reader, mobile, accessibility and specified large-document performance checks.

Record deployment revision, image digests, configuration names (never secret values), service versions, test evidence and outstanding defects in the release record. Do not mark the story Done or treat a successful build as release acceptance.
