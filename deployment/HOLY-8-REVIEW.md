# HOLY-8 private template foundation

Incremental implementation; production access remains disabled and HOLY-8 is not Done.

Implemented: workspace-scoped creator-only personal library; three read-only starters (Meeting notes, Project brief and SOP); name/description search and scope filter; rich private draft authoring; source page Owner-only snapshot of an exact saved revision; validated names and case-insensitive catalogue uniqueness; explicit private publication into immutable revisions; draft editing without changing the published revision; reviewed revision selection; atomic independent page creation with fresh page/block identities and private ownership; source provenance with restricted-name redaction for page recipients; archive blocking stale new use while preserving existing copies; operation-bound retry deduplication and minimal audits. No tasks, notifications, comments, ACLs, history, child trees or SHO bindings are copied.

Shared Space publication and file/image reuse are deliberately unavailable. The recorded HOLY-5 template-management permission mapping and approved asset reuse policy are unresolved delivery gates. The implementation does not infer LEADER roles or grant private source access from suite/SHO administration. Private template creation uses the existing HS page-creation membership model; native role qualification remains required before production release.

Template preparation adds editor defaults and the trailing text paragraph before publication, preventing a fabricated first save when a new copy opens. Historical document representations and integrity hashes are not rewritten. Source snapshots retain semantic content but may include these explicit editor defaults. Attachments cause a clear recoverable policy error rather than an unsafe copy or partial page.

Automated evidence covers private metadata/content isolation, Owner-only snapshots, immutable publication, duplicate names, draft/published separation, fresh identities, independent copies, archive/stale revision rejection, idempotency, provenance redaction, revoked membership and attachment-policy denial. A jsdom editor-mount check verifies starter content is unchanged on open. PostgreSQL covers concurrent duplicate creation alongside ordinary page creation and stale archived use. Browser rehearsal created a starter copy, saved it as a private draft and explicitly published a private revision.

The fresh-workspace landing also offers template creation before a first page exists, using the selected workspace/space without a fabricated source page.

Remaining acceptance: shared Space catalogue/management with agreed native capabilities; permitted attachment cloning/export policy; actual suite/SHO integration; full accessibility/mobile and performance measurements with agreed representative sizes/budgets; failure-outcome audit policy; full BugOff case execution. Manual browser rehearsals and automated tests are not substituted for these release gates.
