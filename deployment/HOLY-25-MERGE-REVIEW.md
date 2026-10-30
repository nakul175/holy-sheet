# Duplicate suggestions and reference-preserving merge (HOLY-25)

## Foundation already in the tree

The merge service, migration `024_shared_record_merges.sql`, and service tests were already present. That foundation remains the authority for the behaviour below. No live mapping, grants or connected-client resolver is enabled by the service itself.

Duplicate suggestions return at most ten current permitted name/domain/email matches. Email predicates require current field read permission; hidden or unshared matches do not affect results. They are advisory. Import warning and override UI remains later integration work.

Merge requires distinct active same-tenant, same-collection records with read/edit/merge rights on both. Field conflicts need explicit source/survivor choices and current field write rights even when selecting the unchanged survivor value. Unreadable fields block collection merges consistently irrespective of value presence/equality, avoiding a protected-value comparison oracle. Deprecated conflicts require separate reconciliation. Account parents with differing values need an explicit current authorised parent selection. Outgoing Contract legal parties/covered Accounts are unioned; conflicting relationship roles/status/primary flags need choices, and multiple primary Accounts block pending prior reconciliation. Document associations retain independent current page access and never create page grants.

An actor/workspace-bound five-minute preview binds both versions, current schema/policy/data/authority and a mandatory qualified connected-app alias-consumer revision. **No production consumer adapter is supplied. Apply is unavailable without that adapter.** The contract must cover all real clients and use leases/fences compatible with the transaction. Synthetic qualification proofs are not live client adoption. A changed consumer revision before commit rolls the transaction back.

Apply atomically advances both versions, preserves source data/history, creates a durable immutable old-ID alias, copies reviewed associations, transfers unique reservations, emits protected history plus metadata-only outbox/audit, and records immutable source/survivor provenance. It creates no grants. Old-ID reads require current read access through the alias chain and the survivor. Writes/lifecycle mutations to merged sources are fenced, ordinary lists exclude aliases, and retained IDs still protect incoming references from deletion. Chains are bounded to eight hops; extension beyond that requires separately qualified compaction. Idempotent retries report the original applied version and current permitted survivor truthfully.

Service tests cover both-record rights, blocked unqualified consumers, explicit field/parent/relationship choices, hidden fields, no grant widening, Contract invariants, document access, current duplicates, stable aliases/chains, provenance guards, rollback and actual PostgreSQL concurrent identical apply.

## Connected in this change

Native routes call that service through the same suite-tenant authority as records, permissions, schema, saved views and lifecycle (`HS_RECORDS_ENABLED` plus the current suite tenant proof; no JWT-role fallback and no tenant-provisioning adapter):

- `GET /api/v1/workspaces/:id/tenants/:tenantId/record-duplicates` for the advisory name, domain and email query. The route does not raise the ten-match cap. Email and domain predicates are forwarded only when the caller supplies them; field read permission stays in the service.
- `POST /api/v1/workspaces/:id/tenants/:tenantId/record-merges` with `preview` and `apply`.

`nativeRecordMergeRepository` constructs `SharedRecordMergeRepository` with no connected-app alias consumer. Preview therefore reports `integrationReady: false`. Apply still calls the service, which rejects with `record_merge_consumers_unavailable` until a real qualified adapter is passed into that repository. This change does not add a synthetic or suite-client stand-in.

The records screen can check duplicates while creating a record. The result is advisory, shows at most ten permitted matches, and does not block create. An email or website predicate is sent only when that field is currently writable on the form and the value is usable. The screen can review a merge when the open record is active and the caller has edit and merge. The open record is the source. Field, relationship and Account-parent choices are sent back through preview. Apply stays disabled while the review is stale, blocked, or `integrationReady` is false, and the screen says that no qualified alias consumer is connected. Document titles shown in the review are the permitted associations only. The screen states that merge does not create record or page grants.

## Still open

No production connected-app alias-consumer adapter is in the tree. Apply stays gated on that adapter, including leases and fences that cover every real client. Synthetic qualification proofs are not live client adoption. Complete alias adoption across connected apps, reference delivery and fault qualification, permission and history presentation, import duplicate warning/override UI, and fuller merge-screen polish remain open. This connection does not mark HOLY-25 Done.
