# HOLY-104 knowledge verification badges

Scope is HS N67. This change implements AC1 through AC6 for steward attestation of an exact published page or record revision. Bug Off is Not Run, and local tests are not a Passed result. It does not implement parent epic HOLY-81, and it does not merge, deploy, or change BTF.

## What shipped

An eligible steward can attest a permitted published page or record revision. The attestation records an accountable owner, a basis, and an expiry of 1–365 days. The badge states that it is a steward attestation. It is not an AI truth score and it is not a legal certification.

The title-only policy is `preserve`, and it is stored on the policy and on every badge. A title or record-name change keeps the badge current. A change to the body, or to the recorded source, marks the badge stale. Unpublishing the page marks it stale as well. Revocation stays revoked. A badge past its expiry reads as expired.

Search, role-interface rows, and the verification source preview include the badge only when the viewer can read the underlying content and the verification metadata. A hidden record is omitted. A sensitive verification field leaves the record in place and omits the badge.

Renew and revoke require steward authority and a reason, and both write history. A reader who can see the badge can inspect its scope and report a concern. The concern is kept in the history.

Tenant, record, field, and action checks apply to the API, search, source preview, download, and history. Naming a steward, saving the policy, or granting an action does not add a page, record, collection, or field grant. An action list cannot reveal a record the person cannot open. Once a person has an action list, a missing action is denied even if another capability would have allowed it.

Policy and badge changes are versioned. The same operation id returns the first result, and a different body is rejected. A stale save keeps the recoverable draft and does not overwrite the current version. Audit records the actor, source `knowledge-verification`, IST time, and operation id. Core dialog actions are buttons, at least 44px, and the verification entry sits in Page options so the export row can wrap.

Existing schedules stay paused. No schedule is installed. Synthetic staging fixtures live in `fixtures/knowledge-verification/staging.json`.

## Migration

`db/130_knowledge_verification.sql` adds the policy, badge, revision, draft, preview, event, concern, steward, field, and action tables. Inserting a policy with any title-only value other than `preserve` is rejected. Re-running it is safe. It does not update `hs_data_periodic_review_schedules`, `parent_organisation_id`, or `release.py`.

## Staging QA

Bug Off folder, status Not Run until an isolated signed-in run: `HOLY-104 — Knowledge verification badges (HS N67)`.

| Case | AC | Local evidence | Staging |
| --- | --- | --- | --- |
| N67-01 | Stewards verify a published revision with owner, basis, and a 1–365 day expiry | Page and record badges; 0 and 400 days rejected; unpublished, non-steward, and hidden targets rejected; one replayed save | Not Run |
| N67-02 | Content or source changes mark the badge stale; title-only stays current | Title-only stays current; body, source, and unpublish go stale | Not Run |
| N67-03 | Search, interfaces, and source previews show the badge only with content and metadata access | Hidden record omitted; sensitive field returns the record without a badge; interface row matches | Not Run |
| N67-04 | Renew and revoke need authority and a reason; readers inspect scope and report a concern | Reader cannot renew; steward renew and revoke write history; concern is in the history | Not Run |
| N67-05 | Tenant, record, field, and action checks; configuration does not grant access | Other tenant is not found; steward and action grants do not change record grants; action list blocks download | Not Run |
| N67-06 | Versions, recoverable drafts, audit, and keyboard or phone actions | Stale policy and badge saves keep the draft; audit has `knowledge-verification` and IST; dialog actions stay off the export row and are at least 44px | Not Run |

## Local checks

`npx vitest run lib/knowledge-verification-plan.test.ts lib/knowledge-verification.test.ts lib/knowledge-verification-route.test.ts lib/knowledge-verification-dialog.test.ts`
