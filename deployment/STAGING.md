# HOLY-3 staging preparation

This repository contains an **unexecuted staging scaffold**. No services have been deployed. The production feature flag defaults to off. Local tests use embedded PostgreSQL (PGlite); they do not qualify the Docker services, suite identity or SHO integration.

## Configuration and prerequisites

Use Docker Engine with Compose v2 on a dedicated staging host. Copy `.env.staging.example` to `.env.staging` locally; that file is ignored by Git. Supply distinct PostgreSQL, storage administrator, storage service-account and maintenance credentials. Generate a 32-byte Base64 recovery master key, retain it in the staging secret manager and protect its backup separately from database backups. Losing it makes existing encrypted recovery drafts unreadable. Passwords interpolated into `DATABASE_URL` must be URI-safe (random hexadecimal values work).

Set `HS_ORIGIN` to the exact HTTPS origin served by your reverse proxy. Only the application binds a host port, on loopback port 3100. The proxy must terminate TLS, preserve the Host header, forward the Origin header unchanged, enforce request limits above the application's 25 MB upload boundary, and disable buffering/caching for authenticated media. Do not expose the database, storage console or scanner publicly.

Replace the placeholder suite issuer and HTTPS JWKS URL with an agreed identity adapter. The application currently verifies RS256/ES256 JWTs with `sub`, `iat`, `exp`, issuer and audience `holy-sheet`, accepting at most one hour of token lifetime. There is no implemented suite login callback or token exchange. An authenticated bridge must provide the session as an HttpOnly, Secure, SameSite cookie named `hs_session`; document the bridge and logout propagation before enabling access. Do not place tokens in page URLs. Set the bootstrap subject to the exact trusted `sub`, not an email address.

Pin the PostgreSQL, MinIO, mc, ClamAV and Node images to reviewed immutable digests before qualification. The current tags are preparation placeholders. Validate service compatibility and scanner signature freshness on the intended host.

## Commands for a later, explicitly authorized deployment

The following commands are documentation only; they have not been run:

```sh
docker compose --env-file .env.staging -f compose.staging.json config --quiet
docker compose --env-file .env.staging -f compose.staging.json build app
docker compose --env-file .env.staging -f compose.staging.json up -d
docker compose --env-file .env.staging -f compose.staging.json exec app node scripts/provision-workspace.mjs
```

Provisioning adds the configured owner, workspace and space using an additive transaction; it does not change existing grants. The application applies `db/002_documents.sql` on database initialization. Back up the database before migration and verify restoration with matching private objects and recovery master key. The old tables remain available, but turning off the feature is not a reverse data migration.

Keep `HS_RICH_EDITOR_ENABLED=0` until identity and proxy checks pass. Enabling it requires a configuration change and service recreation during an authorized qualification run. The application must return feature-disabled responses while off. Storage bootstrap creates a private bucket and a separate account restricted to that bucket. Scanner failures keep uploads unavailable. Confirm both properties against actual services.

Maintenance is an explicit operator action: `POST /api/internal/maintenance` with `Authorization: Bearer <HS_MAINTENANCE_TOKEN>`. It processes at most 50 candidates per call, honors live references and unexpired recovery leases, retains scanned detached objects for at least seven days, and retries storage deletions after failures. No schedule is installed or enabled. Do not delete storage objects directly to work around a failed cleanup.

## Qualification required before HOLY-3 completion

- Execute the 38 HOLY-3 BugOff acceptance cases against the reviewed spec revision 2.0; record each actual result and evidence. Local unit tests do not change their Draft/Not Run status.
- Exercise real PostgreSQL with concurrent writers, retries, restart and backup restoration; compare persisted documents and stable block IDs.
- Complete suite login/logout, expiry, revoked membership and Owner/Editor/Viewer access checks, including search, page references, recovery keys and every media request.
- Verify private storage, clean and infected uploads, encrypted/macro files, scanner outage, cancellation races, quota replacement, recovery leases and seven-day cleanup boundaries.
- Integrate the actual SHO host with `/embed/pages/:id`; verify identity, focus, navigation, sizing, permission loss and logout in the real embedding context. The HS-owned embed route alone does not qualify SHO.
- Finish the remaining editor behavior recorded in `IMPLEMENTATION-STATUS.md`, then run keyboard, screen-reader, mobile, accessibility and specified large-document performance checks.

Record deployment revision, image digests, configuration names (never secret values), service versions, test evidence and outstanding defects in the release record. Do not mark the story Done or treat a successful build as release acceptance.
