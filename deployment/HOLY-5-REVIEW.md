# HOLY-5 workspace administration

Policy confirmed by the product owner: workspace administrators can access all
content in their workspace, including private pages.

This branch introduces an explicit `hs_members.role` (`member` or `admin`).
Existing memberships default to `member`. Active native admins receive effective
Editor content access, including discovery, private page references, backlinks,
and their own personal navigation. Ownership is preserved. The role is scoped to
the membership's workspace; neither JWT role strings nor suite roles implicitly
grant it. Membership deactivation or demotion removes implicit access on the
next server check. Trashed pages remain outside ordinary reads.

The completed candidate expands the workspace model to Owner, Administrator,
Member and Observer and adds explicit Leader, Editor and Viewer space roles.
Every role mutation is previewed, version checked, idempotent and audited.
Owners and Administrators receive workspace-wide content access; an Observer is
read-only even when an older direct editor grant remains. Ordinary Members only
receive explicit space or page access.

Seven-day invitations bind a central invitation identifier to the exact immutable
suite subject. Email equality is never an identity merge. Acceptance applies the
reviewed native workspace and space roles atomically; resend, revoke and accept
remain separate audited operations. The UI lets a signed-in user inspect and
accept their invitations and lets authorized administrators create/revoke them.

Ownership transfer is a separate seven-day acceptance workflow. The existing
Owner remains in place until an eligible active Administrator/Owner accepts.
Acceptance transfers page ownership without changing page IDs, links, revisions
or historical actor attribution and demotes the previous Owner to Administrator.

The Accounts integration adds a hash-pinned, read-only application-entitlement
authority. With `HS_APP_AUTHORITY_ENABLED=1`, every authenticated Holy Sheet
request verifies the current upstream session and current `holy-sheet`
ApplicationAccess for the exact subject, including an active person and active
organisation membership. Unknown, revoked, disabled or unavailable authority
fails closed. Tenant/resource authority remains a separate HOLY-19 concern and
is not a prerequisite for this application-level check.

Focused regression tests cover private reads and edits, search discovery,
backlinks, personal navigation, demotion, inactive membership, workspace
isolation, unchanged ownership, claim spoofing, and ordinary Trash exclusion.

## Native administration continuation

Adds the native Workspace access dialog, self-only membership inspection, explicit before/after previews, version-checked and digest-bound changes, atomic operation deduplication and audit, last-active-admin protection under a workspace lock, and refusal to deactivate an account that still owns pages. All existing memberships remain ordinary members after migration; no real account is promoted. Native reactivation is an explicit reviewed action preserving existing scope-only grants. Global app entitlement and account deactivation have separate semantics and are not implemented by this workspace endpoint.

Existing workspaces remain on access-model version 1 until parity is explicitly
verified; version 2 activation is never automatic. No background schedule is
added. Staging must verify central/native parity, entitlement revocation, each
role, invitation expiry/acceptance/revoke, ownership acceptance and rollback
before the same accepted revision can move to production.
