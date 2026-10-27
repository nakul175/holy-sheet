# Holy Sheet editor

The local entry contains the real HS editor, document API client, uploads and
encrypted recovery, compiled from the canonical application sources. The hosted
entry mounts that editor at the HS origin for another suite app. This keeps API
credentials, storage and encrypted drafts on their intended origin. No duplicate
document, raw role assertion, token-in-URL or service account is used.

Both React entries accept `pageId`, `viewContext` and a stable session provider.
Use `createHolySheetSessionProvider()` for the local entry on the HS origin. The
hosted provider checks the host's trusted server-side suite session and returns
only its restrictive subject/context; HS independently verifies its own identity,
audience, live session and page permissions before opening content. A host
subject is not an HS credential or grant. Providers must honor AbortSignal.

Build with `npm run build:editor` in the HS repository; pack from this directory.
The tarball contains compiled ESM, types, styles and a source-hash manifest. SHO
pins that exact tarball and integrity. No npm registry publication is required.
Protocol v1 is staging-only; additional origins need an explicit reviewed change.

This package does not establish live cross-host qualification, performance,
accessibility or full HOLY-3 acceptance. Keep host rollout disabled until paired
account, logout, media, conflict and outage checks pass.
