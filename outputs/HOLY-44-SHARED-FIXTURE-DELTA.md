# HOLY-44 shared authenticated fixture delta proposal

Prepared: 28 October 2026

Purpose: give Product one bounded fixture change-set that can support HOLY-44 authenticated acceptance and the shared five-actor QA requirement without changing real users, reusing credentials as proof, or mutating production. This is a proposal, not provisioning authority.

## Authoritative historical baseline

The historical receipt `finish29-20261028/fixture-receipt.json` records one active, empty staging workspace:

- workspace: `qa-next50-isolated-20261028`;
- native membership rows: subject `c9492fe8-38a8-4d67-9063-8f0ebdd2a919` as `admin`, plus subjects `e0bbba6b-7887-47fe-9178-ce5a9444a152` and `004bd7ee-ef9b-44ff-a86b-3d265e2786f7` as `member`;
- two empty synthetic spaces: `qa-next50-isolated-20261028-a` and `qa-next50-isolated-20261028-b`;
- `createdEmpty: true`, `credentialsChanged: false`, `existingRolesUnchanged: true`, `productionChanged: false`.

The companion live-check proves only that the first subject used a normal QA Editor OIDC session and that the three native roles were observed at that historical time. It does not prove current sessions for all three subjects, native Owner/Observer authority, a tenant mapping, central record authority, or record/field grants.

## Minimal new fixture

Provision two **new empty staging-only realms** under a Product-approved namespace; do not repurpose the historical workspace or infer permissions from it.

### Realm A — T1 / W1 functional acceptance

- Five distinct normal-login synthetic subjects, one each for aliases `O`, `E`, `C`, `V`, and `X`.
- Product may reuse the three historical subject IDs for `O`, `E`, and `V` only after current normal-login proof and an explicit new-realm mapping. Add two new distinct synthetic subjects for `C` and `X`; five browser tabs for three accounts are not sufficient.
- `O`, `E`, `C`, and `V` map to T1/W1 with the exact native workspace/page roles required by the cases. `X` has no T1/W1 membership or record grant.
- A deployed `/internal/tenant/status` response binds each permitted subject to the exact T1 tenant ID and W1 workspace ID, is enabled, and returns the current 64-hex authority revision. `X` must receive a non-disclosing denial.
- Holy Sheet contains independent current collection, record, action and sensitive-field grants. Native workspace membership alone is not a record grant.

### Realm B — T2 / W2 cross-tenant negative

- A second new empty realm with a distinct tenant/workspace mapping.
- `X` is a normal authenticated T2/W2 user with no T1/W1 authority. This makes cross-tenant denial observable without treating an anonymous 401 as acceptance.
- No T1 subject receives T2 data by default. Any positive T2 control data must be explicitly QA-owned and separately granted.

## QA-owned HOLY-44 data contract

Create only after the five sessions and central-authority readbacks pass:

- two synthetic organisations, including Gates;
- two Gates accounts and one cross-organisation account;
- same-currency and mixed-currency contract amounts plus one incompatible typed field;
- active, inactive, archived and mergeable synthetic related records;
- one sensitive input field visible to `O`/`E` but hidden from `V` and `X`;
- grant subsets that make `O` full-scope, `E` operational, `C` comment/view-only as specified, `V` restricted/hidden-field, and `X` T2-only;
- exactly 100 permitted targets, one permitted 101st target, and one hidden 101st target for the deployed boundary checks;
- the live case 1917 `>10000` fixture only after Product approves its bounded generator, cleanup ownership and resource window;
- versioned rollup configuration, recoverable draft state and audit sink for actor/source/time/operation evidence.

## Required receipt before execution

The fixture owner should return one redacted receipt containing:

1. realm, tenant and workspace IDs for T1/W1 and T2/W2;
2. aliases O/E/C/V/X mapped to five distinct subject IDs, with current normal-login timestamp and issuer (no credentials, cookies or tokens);
3. native role readback and independent collection/record/action/sensitive-field grant matrix;
4. current 64-hex central-authority revision and successful enabled status readbacks for permitted subjects plus non-disclosing X/T1 denial;
5. QA-owned collection, field, record, relationship and rollup configuration IDs;
6. current staging source/image/rollback and service health;
7. approved controlled-fault method for case 1919 and bounded large-fixture method for case 1917;
8. cleanup owner and exact QA-only resources eligible for later removal.

## Safety and approval boundary

- Do not change existing real-user access, historical workspace roles, passwords, client secrets or production data.
- Do not expose session material or confidential-client secrets in receipts, logs, BTF, Bug Off or chat.
- Do not mark a Bug Off case Passed from provisioning readback; execution evidence remains required.
- Provisioning, temporary grant/revocation changes, fault injection, cleanup and production promotion each require the applicable Product/user release authority. This document grants none of them.
