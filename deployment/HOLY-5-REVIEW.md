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

This is a bounded content-access foundation, not completed HOLY-5. No promotion
endpoint, suite writer, invitation UI, real-account promotion, or staging config
change is included. Content access does not yet grant ownership transfer,
sharing administration, export, or Trash recovery capabilities. Those actions
need explicit capabilities and their own audited workflows.

Remaining acceptance work includes suite/native role mapping, delegated grant
authority, before/after capability previews, versioned/idempotent audited role
mutations, last-administrator protection under concurrency, invitations,
deactivation reconciliation, and integrated BugOff qualification. Any future
role mutation must take the same workspace lock as document mutations before
changing membership, to serialize revocation against commits.

Focused regression tests cover private reads and edits, search discovery,
backlinks, personal navigation, demotion, inactive membership, workspace
isolation, unchanged ownership, claim spoofing, and ordinary Trash exclusion.

## Native administration continuation

Adds the native Workspace access dialog, self-only membership inspection, explicit before/after previews, version-checked and digest-bound changes, atomic operation deduplication and audit, last-active-admin protection under a workspace lock, and refusal to deactivate an account that still owns pages. All existing memberships remain ordinary members after migration; no real account is promoted. Native reactivation is an explicit reviewed action preserving existing scope-only grants. Global app entitlement and account deactivation have separate semantics and are not implemented by this workspace endpoint.

Central writer/invitations, space roles, identity-binding inventory/parity and ownership transfer remain open HOLY-5 scope. This batch must not be represented as the full story being Done. No background schedule is added.
