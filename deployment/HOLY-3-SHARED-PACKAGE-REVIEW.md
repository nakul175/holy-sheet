# Shared editor package candidate

`@aplyd/holy-sheet-editor@0.1.0-holy3.1` has local, hosted and boundary React
entries. Both editor entries accept a page ID, view context and session provider.
There is no authoritative user/role prop. HS standalone and embedded routes use
the compiled local entry. SHO uses the hosted entry from the same exact package.
The hosted entry runs the real editor surface on HS, retaining its API, cookie,
media and encrypted recovery origin. No credentialed cross-origin API/CORS or
token forwarding is introduced.

The local bundle includes the actual editor, document API client, recovery and
associated dialogs from canonical application sources; it is not a second editor
implementation or a frame-only package. Its build fails on server modules,
server dependencies and undeclared runtime dependencies. Published artifacts
contain compiled ESM, public types, styles and relative source hashes. The package
is distributed as a reviewed tarball pinned by integrity in SHO; no npm account
or registry publication is assumed. CI preserves the packed candidate artifact.

Local providers verify the HS session server-side before mounting content.
Hosted providers verify host task/session context; their subject only restricts
the independently authenticated HS frame. Missing context, mismatched identities,
timeouts, late responses and account changes do not grant access. Explicit retry
is required after a host account switch. Timers clean up and providers receive an
AbortSignal; deadlines also hold if a provider fails to honor that signal.

Evidence: thirteen focused local/boundary/provenance checks and nineteen real
packed-package SHO consumer checks pass. TypeScript and both production builds
pass. Two clean builds/pack operations produced identical tarball bytes. Full
isolated CI must run on the final combined candidates before rollout. Previous
full HS snapshot passed 435 tests with 16 service checks skipped; that run preceded
the last deadline-specific test and is not presented as final combined acceptance.

This remains a staging-only protocol-v1 candidate with the existing reviewed
framing allowlist. No deployment or suite permission changes are included. Actual
SHO integration, both-host authorization/revocation/logout/media/conflict/outage,
mobile/accessibility and prescribed performance evidence remain acceptance gates.
