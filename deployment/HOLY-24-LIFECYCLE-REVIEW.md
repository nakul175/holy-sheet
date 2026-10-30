# Record archive, reference-safe deletion and 30-day Trash (HOLY-24)

## Foundation already in the tree

The lifecycle service, migration `023_shared_record_lifecycle.sql`, and service tests were already present and were not exposed on a public route or the records screen. That foundation remains the authority for the behaviour below.

Archive and unarchive require the explicit archive capability and an expected version. They preserve the record ID, history and references. Archived records stay out of normal active selectors, remain readable under current rights, and must be unarchived before an ordinary edit or a new link.

Deletion requires the explicit delete capability, a reviewed tenant retention policy of exactly 30 days, and an actor/workspace-bound review of about five minutes. The review binds the record, schema, policy, retention, data and suite-authority revisions. Any incoming internal parent, relationship, document, app-registry or custom-record-value association blocks deletion, including associations the caller cannot read. Owned outgoing relationships stay on the historical Trash record. There is no relationship cascade. The denial exposes no hidden IDs, titles or counts. An empty or incomplete integration registry is not treated as proof that no external references exist.

Confirmed deletion enters tenant Trash with the actor and time, the previous active or archived state, and a 30-day deadline. It releases unique-value reservations, writes protected history plus metadata-only audit and outbox events, and is idempotent. Restore keeps the same ID and checks current view/restore rights, schema and typed values, reference authority, uniqueness and retention. It does not create grants. A uniqueness conflict rolls the recovery back and leaves the Trash row in place. Expiry is checked on the database clock and again after the final suite-authority check, immediately before commit. At the deadline, recovery is denied even when a retention hold keeps the underlying storage.

Trash lists return permitted recoverable metadata only: 50 rows, actor/tenant/workspace/query/revision-bound cursors of about five minutes, and the current collection/record capability union. Deleting a saved view stays independent of deleting records. Permanent removal has no service, route, executable or scheduler.

## Connected in this change

Native routes now call that service through the same suite-tenant authority as records, permissions, schema and saved views (`HS_RECORDS_ENABLED` plus the current suite tenant proof; no JWT-role fallback):

- `POST /api/v1/workspaces/:id/tenants/:tenantId/records/:recordId/lifecycle` with `archive`, `preview-delete`, `trash` and `restore`
- `GET /api/v1/workspaces/:id/tenants/:tenantId/record-trash` for the 50-row keyset

The records screen can include archived records explicitly, archive and unarchive a record the caller may archive, and disable ordinary edits, new relationships and account moves while it is archived. A caller with delete can review deletion and, when the review is not blocked, move the record to Trash. The review UI shows the generic association message and does not add hidden IDs, titles or counts. Tenant Trash for the open collection lists recoverable rows and restores by the same ID. The screen has no permanent-removal action.

## Still open

Suite tenant mapping is still the existing `HS_RECORDS_ENABLED` proof used by records, permissions, schema and saved views. This story does not add a tenant-provisioning adapter or a JWT-role fallback. Real tenant retention approval, a complete application-reference inventory and live role acceptance remain activation gates. Native mobile and keyboard Trash UI, permanent purge, merge, import/export, history value restore and boards stay later stories. This connection does not mark HOLY-24 Done.
