# HOLY-3 implementation checkpoint

Status: **in progress, not release qualified**. Authoritative requirements are HOLY-3 final spec revision 2.0 in BTF and its linked 38-case BugOff catalogue.

Implemented locally: shared rich editor, structured document validation, stable block IDs, SQL-backed documents and revisions, permission-filtered reads/search, optimistic save operations and conservative merges, encrypted local draft recovery with authorized key retrieval, private upload reservations/scanning gateway, protected media downloads, and staging infrastructure scaffolding.

Known work remaining before full acceptance:

- Real suite identity adapter/login/logout and actual SHO host integration.
- Pending-upload recovery across reload, upload replacement flow and direct file drop/paste handling. Long-session lease renewal is implemented but still needs browser qualification.
- Oversize/merged table paste preview and splitting. Row/column reorder and final-row keyboard boundaries now have implementation and focused unit coverage; browser qualification remains.
- Complete safe block transformations with content-loss warnings and large-code highlighting fallback. Code indentation and exit controls are implemented; browser qualification remains.
- Find results for dynamically resolved page-reference labels and complete temporary collapsed-section navigation restoration. Image alt/caption and newly attached filenames are included; old file nodes without stored names still need metadata reconciliation.
- Full end-to-end acceptance, accessibility, mobile and prescribed performance evidence, plus integrated suite/private-cloud-storage/scanner qualification on the intended host. Isolated local PostgreSQL and ClamAV evidence is recorded separately.

The staging configuration has not been deployed to the requested domain. An immutable merged package has been container-built and passed 13 disabled-access runtime checks with non-root/read-only filesystem verification. Six real PostgreSQL tests, five real ClamAV tests and a synthetic database backup/restore rehearsal provide bounded local evidence. Its production feature flag defaults off. No claim is made that every acceptance criterion or BugOff test has passed.
