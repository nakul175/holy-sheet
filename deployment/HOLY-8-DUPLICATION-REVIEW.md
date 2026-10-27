# Private template duplication

A user can explicitly duplicate a readable published personal template or an immutable starter into a new private unpublished draft. The copy has fresh block identities, its own name/version and source-template revision provenance. Editing/publishing it cannot mutate the source, existing instantiated pages or source ACLs. Creation is actor/workspace-bound and idempotent; duplicate names and stale/unreadable/archived source revisions fail without a half-created copy.

The library preview includes an editable private-copy name. A failed request preserves that field; a committed retry returns the same draft. Duplication does not create a document page or publish the new template.

Validation covers starter independence, creator-only metadata, unpublished state, duplicate retries/audit, source/revision/name failures and UI routing to the new draft. Space publishing and private attachment reuse remain explicit unimplemented HOLY-8 policy/dependency gates; they are not silently enabled by this batch. No permission, identity, storage-key or schedule change is included.
