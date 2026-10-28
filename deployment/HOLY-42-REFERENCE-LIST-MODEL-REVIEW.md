# HOLY-42 internal model — partial scope

This change is an internal typed model and resolver only. It does not implement the complete story or activate reference lists for any tenant. No database migration, endpoint, field binding, grants, notifications or UI is introduced.

Definitions have explicit UUID tenant/list/item identities, monotonically adjacent configuration versions, stable uppercase item codes, bounded translated labels and deterministic display order. Label updates preserve stored identity. Deprecated items cannot be selected anew but can resolve historical identities. All old item identities and codes remain reserved; deletion is unconditionally blocked until a qualified dependency-inventory and transactional persistence service exists.

Import resolution requires an explicit ID/code/label namespace. Ambiguous labels, including collisions with deprecated items, reject rather than silently mapping to a different item. Tenant mismatch and missing/ambiguous values use a generic error. This check is not a permission proof: the future service must establish current tenant/list/record/field/action authority before calling the model and recheck it inside the durable transaction.

Open acceptance: durable versioned list management, concurrent update/idempotency/audit, field references across collections, historical rendering/current sensitivity, native configuration UI/keyboard/mobile, current-authority adapter, complete dependency-aware removal, filters/import integration, actor draft recovery. No full-story pass or production feature enablement is claimed.

Validation: focused model cases, TypeScript and required regression/CI. Exact outcomes are retained in CI and local artifacts, not inferred from this document.
