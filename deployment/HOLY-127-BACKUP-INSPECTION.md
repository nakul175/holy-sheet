# HOLY-127 read-only wrapper inspection

NJ explicitly approved inspection ONLY of `/opt/holy-sheet-staging/backup.sh` and `/opt/holy-sheet-staging/deploy.sh` through the existing DigitalOcean root console on168.144.144.69. Product read those two source files and metadata, withholding credential-bearing lines. No environment/config files, database data, backup contents or credential files read; no commands from the scripts executed; no server edits, backup, deployment, password/key changes. Root session exited afterward.

## Backup helper

SHA-256 `8013214d38b8679e5bbe4f9044e178104fe9e8f30a4ef78a4e0a2400d1525a31`;858bytes/14lines.

- Uses strict shell mode and umask077.
- Fixed compose project holy-sheet-staging; reads existing env file through Compose, not printed during inspection.
- If DB not running, reports skip and exits0; a successful exit alone does not prove a backup exists.
- Runs `pg_dump -U holy_sheet -d holy_sheet -Fc` through compose exec, stdout redirected directly into one timestamped `.dump` under `/opt/holy-sheet-staging/backups`.
- chmod600 and SHA-256 sidecar; reports final `du` size.
- **No output-size cap, capacity gate or provable175,686,353byte bound.** No explicit second temporary on-host dump copy, but that fact is not an upper bound on output/growth.
- **Line13 deletes older `.dump` files beyond newest14 via xargs rm.** Normal invocation is incompatible with preserve-backups/no-cleanup scope unless separately addressed/authorized. Do not execute helper under inspection approval.

## Deployment helper

SHA-256 `8f22574a637f9704e0dd7b023b2340e809bc9f49ce790b606d0df2813631492c`;11655bytes/242lines.

Has an existing staging-only flock. `roll_to` performs checkout, backup helper, compose build app, compose up. Both deploy and rollback call roll_to. `up` also invokes backup helper but tolerates its failure with `|| true`. Supported command cases have no image-import/load/tag mode. Thus the selected CI-image import plan is NOT implemented by the existing constrained deploy helper; invoking deploy would rebuild and invalidate that method's disk budget.

## Gate disposition

Inspection complete; backup-size bound NOT proven. Backup, transfer, image import and deployment remain unauthorized under this inspection-only approval. Need a concrete bounded no-prune backup operation (with output+temporary allocation capped within the available167.5MiB allowance) plus an explicitly supported/reviewed exact-image import and rollback operation, separate authorization and fresh reserve measurement. No inferred authority to edit wrappers, prune backups or run arbitrary root commands. Engineer4 received exact provenance/control-flow findings. Snapshot screenshot: artifacts/product/holy127-wrapper-inspection.png, no secrets.
