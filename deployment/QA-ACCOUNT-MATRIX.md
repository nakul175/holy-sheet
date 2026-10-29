# Staging QA account matrix and custody

Requested by NJ, 28 October 2026. Dwight is a Grok bot and will initiate
contact. Engineer3 is the single creation owner; engineers execute tests.
Dwight stores logins in his vault, maintains the inventory and fills logins
for tests. No secret goes in chat, source control or the nonsecret inventory.
Latest human custody instruction: Dwight reads Product directly. Post only
product, real role, email/username, staging environment and exact shares here.
Generated passwords must be root-owned mode0600 on the staging host at
`/root/hs-staging-qa-accounts.txt`; no local credential copies. Dwight moves
them into his vault and maintains the inventory. Existing HS QA Viewer and
HS QA Unshared explicitly require fresh passwords because old ones were
exposed. Their actual shared production SHO identity source must be disclosed;
rotate only these exact synthetic identities through an authorized normal
credential workflow, preserving all grants/content. No rotation is claimed yet.

This is a PROPOSAL, not evidence of created accounts.

| Persona | Count | Holy Sheet staging access | SHO staging access |
| --- | ---: | --- | --- |
| Owner | 1 | Native Owner of QA resources only | MEMBER with QA project LEADER/creator rights |
| Admin | 1 | Native Admin of QA resources only | Native ADMIN: all projects in the isolated staging app, not QA-project-only |
| Editor | 1 | Member with edit grants on designated pages | MEMBER with QA project EDITOR |
| Viewer | 1 | Member with view grants only | MEMBER with QA project VIEWER |
| Observer | 1 | Native Observer, including ownership/stale-grant denial tests | Explicit VIEWER equivalent; SHO has no native Observer role in inspected source |
| Unshared | 1 | Active QA member with no target-page grant | Active QA user with no target-resource grant |
| Load readers | 9 | View access to distinct approved fixture slices | Least read access to approved QA fixtures |
| Outsider | 1 | Other QA workspace/org only; unmapped from target | Other QA workspace/org only |
| Revoked | 1 | Active identity; native target membership revoked | Active identity; native target membership revoked |
| Disabled | 1 | Disabled sign-in negative control | Disabled sign-in negative control |

Total: eighteen distinct synthetic principals, reused across products with
independently verified native grants. The first fifteen are active benchmark
personas; the three negative controls are excluded from the fifteen-user load
gate. The five-user normal benchmark selects Owner, Editor, Viewer and two
load readers with independently verified differing permission sets.

Use actual normal provisioning and immutable IDs; never invent subject IDs,
infer bindings from email, mint test sessions or silently reset existing
credentials. Reuse existing identities only after exact source verification.
No suite-wide administrator, tenant administrator, production workspace/page/
project grant or default production resource access is included. Verify shared
SSO source and staging/native boundaries before creation. A legacy SHO bridge
may serve cross-product QA but does not prove standalone HS sign-in acceptance.

Nonsecret inventory: `artifacts/qa-accounts/inventory.json`. Populate real IDs,
role mappings, environment/org/workspace, state, normal-login verification and
vault references only from actual receipts. Current null IDs are intentional.
Credentials stay in a protected temporary operator handoff only if needed,
mode0700 directory/mode0600 file, until Dwight's identity and vault destination
are verified. Do not call an account ready or vaulted before those checks.

BTF: personal keys inherit owner permissions and have no key-specific scope
selector. Team project roles support granular read permissions; prepare a
dedicated external bot with only Work items, Dashboards, States and Issue types
Read in SHO and HOLY, no write permissions and no automatic future-project
membership. Issue the key named 'Dwight hourly status' only through a verified
restricted identity and secure one-time-secret custody. No BTF key exists yet.

BTF progress: custom role `Dwight status reader` was created and verified
with exactly four permissions: Work items Read, Dashboards Read, States Read,
Issue types Read. No write permissions. An External bot draft named `Dwight
hourly status` / `dwight-hourly-status` has zero initial projects, future-project
autojoin off and both automatic triggers off. It is NOT created. Browser
security policy requires action-time approval before issuing its persistent
key and assigning read access; the exact approval is pending. Plan: create
with zero projects, capture the once-only visible key privately into
`artifacts/qa-accounts/private/dwight-hourly-status.json` (directory0700,
file0600, ignored by Git), then assign ONLY the restricted role in SHO/HOLY
and verify API reads/denials. Do not create with default Member rights.
Never print or screenshot the secret. Dwight will initiate contact; no key
or login is sent to an unverified destination. Nonsecret proof screenshots:
`artifacts/qa-accounts/dwight-reader-role.png` and `dwight-status-bot-draft.png`.

Source audit: SHO `src/lib/access.ts` exposes project roles LEADER/EDITOR/
VIEWER and application roles MEMBER/ADMIN/SUPER_ADMIN. ADMIN has application-
wide project rights; do not describe it as tenant/project-scoped. The existing
`holyQaRealm` code supports a deliberately isolated QA issuer/schema on
sho-qa.aplyd.org, but currently caps its exact subject allowlist at four.
Actual deployed activation and a bounded eighteen-subject extension must be
verified before provisioning this pool; source code alone is not proof of
live isolation. Ordinary self-signup sends verification mail and restricts
domains; do not invent working inboxes. The existing administrator provisioning
schema accepts reserved test addresses, subject to a safe private verification/
credential workflow. Avoid production SHO source users if they permit native
production sign-in or project creation; inspect the existing isolated route.

The earlier local BTF key-file proposal is superseded by the user's latest
request for a read-only proposal and confirmation. Proposed bot remains
`Dwight hourly status`, only SHO/HOLY and four Read permissions, no automatic
triggers/future-project autojoin. Proposed secret custody: separate root-only
mode0600 `/root/dwight-btf-hourly-status.key` on the same staging host.
NO key or external bot has been created; the role template alone grants
no bot access. Do not issue a key until the user confirms this proposal.
