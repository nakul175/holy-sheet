# Conflict discard refresh candidate

The prior Discard-local action selected the cached conflict snapshot without a
fresh document read. Controlled hook tests reproduced an obsolete version being
marked Saved after a third intervening writer and local work being discarded
without checking current server availability.

The action now reads the current document, checks actor, permission epoch and
edit generation, and only then adopts that version and removes the selected own
checkpoints. A failed refresh keeps the conflict/draft. Edits made while refresh
is pending are retained. Authentication loss, page revocation or account change
locks old content without deleting the checkpoint. No server document write is
performed by the discard action.

Six focused cases pass alongside recovery and access tests. This is automated
client evidence for part of AT25/AT34, not the real two-account/browser matrix.
The source is part of shared package 0.1.0-holy3.4. Full combined CI and package
consumer integrity checks remain required before any rollout. Staging is unchanged.
