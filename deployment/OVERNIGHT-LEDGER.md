# Sequential delivery ledger

User instruction: continue HOLY-3 through HOLY-17 in sequence; build, test, merge eligible work and deploy to `staging.holysheet.aplyd.org`. Staging deployment is now authorized. If blocked, preserve evidence and continue the next available story. Production changes and unrelated suite access changes are outside this instruction.

## Inventory

BTF All view currently lists HOLY-1 through HOLY-8. HOLY-9 returns Issue not found. HOLY-9 through HOLY-17 requirements have been requested from the user; do not invent or mark absent stories complete. Read-only backlog snapshots are retained outside the repository in the project output folder.

## Infrastructure

- Connected GitHub integration can access `nakul175/holy-sheet` with push rights; local gh CLI login remains invalid. Use the connector for publication.
- Existing deployment host is reachable through the configured deploy identity. There is no Holy Sheet service/tree currently discovered there.
- Deployment account lacks Docker daemon access and general sudo; only specific existing suite service commands and Caddy configuration/reload are allowed. Do not repurpose existing SHO services or bypass those boundaries.
- Requested staging domain did not resolve on the host during inspection. DNS/host deployment setup needs qualification before claiming availability.
- No deployment or production mutation has been performed in this run.

## Story checkpoints

- HOLY-3: local rich-document checkpoint `cae877c`; 48 tests/typecheck/build passed there. Remaining editor and integrated acceptance work documented separately. Continuing bounded editor improvements.
- HOLY-4: requirements read; inherited sharing, effective access, owner-only management and audit required.
- HOLY-5: requirements read; sensitive legacy mapping and administration decisions remain delivery gates. Do not infer blanket access to private content or activate central writer.
- HOLY-6: requirements read; discussions depend on Commenter and current effective access.
- HOLY-7: requirements read; history requires 90 days from supersession, editor-only historical access and atomic restore.
- HOLY-8: requirements read; explicit template-management/asset policies are delivery gates.
- HOLY-9–17: not listed in current backlog inventory; requirements unresolved.

No story is marked Done by this ledger. Automated checks and manual BugOff execution remain distinct.
