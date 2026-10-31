# Current-permission record history and selected value restore (HOLY-28)

## Foundation already in the tree

The history service, protected event storage, actor-private cursors and restore previews, and the service tests were already present. That foundation remains the authority for the behaviour below. This connection does not add a tenant-provisioning adapter, a JWT-role fallback, a production reference-read adapter, or a retention purge.

History requires current record view/history rights. Fifty-event keyset cursors are bound to actor, workspace, tenant, record, schema/policy and suite proof revision, expire in five minutes and anchor the highest version. Concurrent new events appear on a new first page without repeating older pages. UTC timestamps, actor/app/operation and import batch/source-row metadata are returned.

Current field history permission and historical sensitivity are both enforced on old/new values. Nonempty historical record/attachment references are omitted unless a qualified current reference-read adapter exists; selecting them for restoration fails closed without that adapter. Missing/deprecated fields cannot be restored. Ordinary database updates/deletions of protected events and restore provenance are blocked. History is retained independently of Trash; no purge schedule or retention policy is invented. Future approved retention/purge requires a separate reviewed operator workflow, including legal holds.

Restoration selects event, before/after side and stable field IDs (or name), never arbitrary submitted values. Actor-private ten-minute previews pin current record/schema/policy/proof versions. Current history, edit and restore-values rights plus historical read/current write are required separately. Current kernel validation, required fields, types, uniqueness and reference-link authority run at preview and apply. A new version, protected event, ordinary metadata audit, idempotency operation and immutable source-event provenance commit atomically. Unselected fields, identity, parent/core relationships, attached documents, lifecycle and grants are preserved. Concurrent changes require re-review. Completed retries reconcile under current permissions without applying a second mutation; pending previews expiring during final authority proof roll back entirely.

## Connected in this change

Native routes call `SharedRecordHistoryRepository` through the same suite-tenant authority as records, permissions, schema, saved views, lifecycle, merge, import and export (`authenticateRecordAuthority` and `HS_RECORDS_ENABLED`). There is no JWT-role fallback and no tenant-provisioning adapter. Each route constructs the repository with the verified authority only. No `HistoricalReferenceAuthority` is supplied, so nonempty attachment and record values stay omitted and their restoration still fails closed with `record_history_reference_unavailable`.

- `GET /api/v1/workspaces/:id/tenants/:tenantId/records/:recordId/history` lists one anchored page. An optional `cursor` continues that actor's page. The response is `no-store`.
- `POST` on that path reviews a selection (`kind: preview`) or applies the pinned review (`kind: apply`). The body names the event, before/after side and field ids. It does not accept replacement values. Apply requires `confirm: restore-selected-values`, the review hash and an operation id. The record id comes from the URL; a preview for a different record is not applied.
- The records screen shows Record history when the open record grant includes history. Times stay UTC. An operator with history, edit and restore-values can select a loaded change, a side and current writable history fields, review the stored before/after values, and save them as a new version. A failed apply retries the same operation id. A conflict clears the review.

The previous record route read only the latest fifty events and did not restore values. That read remains available to existing service tests. The screen no longer uses it.

## Still open

Native keyboard and mobile history qualification remains open. Local-time presentation is not added; the screen shows UTC. Service-initiator identity in a future delegated API is not added. Scalar snapshots still do not reconstruct core relationship or document-link changes. Approved suite mapping, a qualified reference-read adapter, and tenant retention or performance qualification are not supplied. No purge schedule was added. This connection does not mark HOLY-28 Done.
