# SHO-3062: HS-owned picker

This candidate extends the published shared-editor/account boundary, rather than
copying an editor into SHO. SHO's project/task picker selects an existing accessible
page or creates a private page in an accessible workspace and space. Space creation
uses the existing HS membership rule; no new role, grant or external sharing rule
is introduced. The picker shows workspace/space names, validates the account hint
against the authenticated HS actor, and rechecks existing-page access on selection.
No identity token is passed to the host. Messages target the exact official SHO
origin and carry the per-frame channel plus restrictive central subject.

Creation accepts an optional UUID operation ID. An actor-scoped ledger, page,
initial blocks and revision commit together. A retry returns the same accessible
page; changed fields produce conflict, and deleted/inaccessible pages are not
replayed. Actor locking uses NO KEY UPDATE so ordinary legacy page creates can
still acquire their foreign-key key-share locks. Existing create callers remain
compatible. SHO separately retains a failed native link acknowledgement and retries
that link; no second page creation is needed. The project default is metadata owned
by SHO, checked against HS's accessible spaces each time the picker opens.

The paired SHO branch requires this picker plus the canonical shared-editor
package. The flag remains off by default. Neither candidate should replace an
accepted15 runtime deployment or interrupt shared staging QA. Final revision,
normal-login identity callbacks, paired isolated origin/deployment and rollback
must be recorded before actual SHO acceptance is claimed. Local preview, component
or API tests alone do not satisfy that acceptance gate.
