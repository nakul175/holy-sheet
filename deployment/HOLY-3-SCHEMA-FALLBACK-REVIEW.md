# HOLY-3 incompatible document version fallback

The server already refuses document writes when the stored schema differs from
the current editor schema. The client previously relied on the page role alone:
it reported Saved, allocated a recovery key and mounted the old editor for an
unfamiliar document. Four focused regressions reproduced that behavior, including
an attempted Keep both merge with a future-schema conflict snapshot.

The shared editor now opens incompatible schemas as read-only. It does not mount
the old rich editor or allocate/unlock/renew draft protection for that document.
Editing, saving and recovery restoration also check compatibility. An access-check
outage/recovery cannot reactivate that writer. A current-version local conflict
draft remains retained, but Keep both cannot merge it with a different schema;
explicit Load latest can enter the read-only preview instead.

The preview extracts text without schema normalization or active HTML rendering.
It tolerates unfamiliar child shapes and states that some formatting/blocks may
not appear. Download document data retains the complete received document tree,
unknown attributes, title and schema version. Temporary download URLs are revoked.
The title is read-only; content-mutating editor/media/history/template/discussion
controls are not mounted. Navigation and permitted sharing remain available.

Package version is `0.1.0-holy3.5`; the prior SHO pin remains a historical candidate
and has not been silently replaced or deployed. The hosted entry still serves the
HS-origin editor. This change adds no database migration or deployment flag.

Evidence includes hook tests for old/future schemas, access recovery, external
refresh and conflict loading; surface tests for avoiding the old parser, inert
text, unchanged download data and current-schema behavior; and a repository test
that an old-writer save preserves future nodes and records no operation.

This is bounded automated fallback evidence for AT26/AT38, not an application
rollback rehearsal, legacy conversion qualification, device/accessibility pass or
live SHO acceptance. No staging deployment/restart or BugOff status promotion is
part of this batch.
