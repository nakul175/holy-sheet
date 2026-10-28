# HOLY-17 server-authoritative collaboration checkpoint

This checkpoint selects ProseMirror's central collaboration protocol for the application integration. Clients exchange schema-valid ProseMirror steps with a canonical HS authority; they do not send an opaque CRDT document that the server trusts. The dependency is pinned to `prosemirror-collab@1.3.1` with the npm lockfile integrity. The earlier Loro experiment remains useful evidence, including its raw delete/move resurrection counterexample, but is not imported by the app.

`POST /api/v1/pages/:id/collaboration` is disabled unless `HS_COLLABORATION_ENABLED=1`. It supports strict start, pull, submit, presence and leave actions. Every action uses the normal verified HS identity and exact-origin mutation boundary. Start, pull and submit acquire the canonical workspace/page locks and require current Editor/Owner authority. Revocation, membership deactivation, Trash or an external ordinary save/history restore terminates the old epoch rather than accepting stale operations.

The authority stores bounded step batches, actor/client attribution, random operation IDs and durable acknowledgement before reporting `saved`. Request retries are idempotent; changed reuse fails. A stale base step version must pull and rebase before retry. Page revisions and collaboration batch audit commit in the same database transaction. Ordinary audit contains epoch/version/count metadata, not step JSON or private document text.

Stable block IDs are checked after every projected batch. IDs that disappear are server tombstoned and cannot be reintroduced within that authority epoch, closing the raw experiment's resurrection counterexample. A history restore or other authorised external document replacement creates a new epoch and clears the old collaboration state; old sessions and steps cannot cross that barrier. Protected file/image/page-link atoms cannot be added or removed through the first collaboration slice and must use their reviewed ordinary workflows.

Presence is current-page only, stores labelled block IDs and bounded offsets, and disappears after 30 seconds without a heartbeat. Sessions expire after one hour and explicit leave removes presence. No keystroke telemetry or cross-page activity record is created.

Focused evidence: seven tests cover read-only refusal, durable step application/audit, retry deduplication, stale concurrent submit and ordered pull, tombstone resurrection refusal, 30-second presence expiry/explicit leave, revocation termination and external-save epoch barriers. TypeScript passes.

This is not HOLY-17 acceptance. Browser rebasing, client transport/status UI, cursor rendering, own-operation Undo, tables/checklists/moves across multiple clients, failed-persistence/restart, history/discussion integration, 20-editor performance and device/screen-reader qualification remain. The flag stays off; no staging or production enablement is claimed.
