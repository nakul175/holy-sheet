# Suite session revocation

When HS OIDC is enabled, every authenticated API request now checks the verified
JWT's `aplyd_session_uid` against accounts' existing confidential-client
`POST /internal/session/status` contract. Accounts verifies its central session,
client grant and app binding, then checks the upstream SHO source session. The
existing HS client secret stays server-side; credentials never enter a URL.
The authority's local account identifier does not replace the JWT subject or
grant any HS workspace/content role.

There is no positive-result cache. An inactive session returns 401 even while
the JWT remains cryptographically valid. Missing signed session identity also
requires sign-in. Network errors, malformed responses, mismatched subjects,
bad client configuration and authority failures return 503 and block protected
operations; they are not represented as confirmed user logout. Requests have
a three-second timeout, do not follow redirects and disable response caching.

Local preview remains separate. OIDC-disabled integrations retain the existing
JWT contract. Bearer authentication in OIDC mode receives the same live check
as protected cookies.

The browser's existing focus/visibility checks and one-minute session poll
observe logout; this is not an instantaneous cross-origin push notification.
Server rejection applies on the next protected request. Live qualification must
prove both central logout and upstream SHO logout with a fresh, unexpired HS
token, and verify outage/draft behavior separately. Keep the provider's expiry
and signature validation unchanged.

Focused tests use real signed tokens and a mocked authority to verify validation
order, active-to-inactive transitions, confidential request binding, missing
claims, invalid responses and unavailable-authority semantics. Those tests do
not substitute for integrated accounts/SHO staging acceptance.
