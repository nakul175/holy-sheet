# HOLY-4 review checkpoint

Implemented on the HOLY-3 foundation: explicit Viewer/Editor grants to active workspace members; recursive descendant inheritance; highest applicable access; owner-only sharing APIs and review/confirm UI; Shared with me navigation; copy-link permission explanation; versioned, idempotent changes; and append-only before/after audit events.

Content/permission mutations serialize on the workspace row so a concurrent inherited grant revocation cannot race an already-authorized document commit. Real PostgreSQL qualification pauses a save before commit, observes the revocation blocked on a database lock, releases the save, then proves subsequent descendant reads/writes are denied. This is separate from manually executing BugOff cases.

Ownership rule in this checkpoint: an ancestor owner receives inherited Editor access to descendant content; only the actual page owner may manage that page's direct sharing. A newly created subpage belongs to its creator. No workspace administrator or suite classification receives implicit private-content access. This page-tree ownership rule needs reconciliation with the pending HOLY-5 capability matrix before final release acceptance.

Known gates: current suite identity/app-entitlement integration, actual SHO embed acceptance, HOLY-5 native space-role mapping, mobile/screen-reader qualification and complete BugOff execution. The current synthetic browser rehearsal covered confirmed grant and removal on the local QA page only. Preview members are synthetic local fixtures, never actual invitations.

No production permissions were changed and no story Done transition is claimed. Staging infrastructure blockers remain in `OVERNIGHT-LEDGER.md`.
