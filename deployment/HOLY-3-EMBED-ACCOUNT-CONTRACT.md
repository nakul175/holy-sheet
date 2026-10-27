# SHO launcher account contract (candidate)

The SHO launcher must derive the expected immutable Aplyd subject from its
verified central-session adapter, after checking the user's access to the SHO
task. It must not infer this subject from email or a SHO-native user ID.

Launch the approved HS origin at `/embed/pages/<page UUID>#hs-user=<subject>`.
Only the UUID and a restrictive account hint are passed; never put identity
tokens, cookies, client secrets or passwords in the frame URL. The fragment is
not sent to the HTTP server. A hint is not an authentication assertion or a
content grant, and changing it can only change which verified HS account the
view will accept.

The initial identity check times out after five seconds and presents Check again.
Timeouts and failed checks never mount document content; a successful explicit
retry must verify the same expected account before opening it.

When framed, HS refuses missing/ambiguous context and checks `/auth/session`
before mounting the editor or its document/recovery requests. A different HS
account cannot briefly render its content inside the task. Normal HS JWT,
live suite-session, membership and page-permission checks remain authoritative.
Top-level `/embed` use without a host hint retains its existing behavior and
does not count as actual SHO integration acceptance.

The embed response limits framing to self and the existing official SHO origin.
No wildcard host or ad-hoc debugging tunnel is enabled. A separate staging SHO
origin needs an explicitly reviewed allowlist change before qualification.

If sign-in opens a new window, the launcher should offer Reload document after
sign-in. Its iframe must allow the reviewed scripts, forms, popup sign-in and
authorized downloads, while keeping top-level navigation restricted. Task
membership or attachment must never grant HS access. Do not cache restricted
HS titles into SHO task metadata.

This candidate is not a shipped SHO launcher. The live SHO central-login adapter
is versioned on SHO `release/accepted15-20261024` at `5346f49`; the paired launcher
candidate targets that release line, not the historical main branch. Required paired checks include
matching/mismatched accounts, owner/editor/viewer/unshared permissions, actual
SHO saves visible standalone, parent account changes/logout and unavailable HS.
