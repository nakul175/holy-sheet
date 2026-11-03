# HOLY-105 quick capture and web clipping

Scope is HS N70. This change implements AC1 through AC6 for an explicit capture of selected text, a link, or a note. Bug Off is Not Run, and local tests are not a Passed result. It does not implement parent epic HOLY-81, and it does not merge, deploy, or change BTF.

## What shipped

A signed-in member can preview and confirm a capture into a permitted space or intake form. The preview shows the sanitised text, the private audience, and that external sharing is not inherited. The source address, title, and capture time are recorded as provenance. Holy Sheet does not open that address.

The committed page stays private. An intake record is created only when the person can create in that collection, and no record grant is copied. Unsafe links, scripts, hidden form values, cookies, and unselected remote images are removed. A selected asset is cited and is not downloaded.

An offline capture stays in a device-local draft. Repeating the same attempt does not duplicate it. A changed attempt leaves the original draft in place. If the source page is not available, the error says nothing was fetched and the draft is kept.

Search, source preview, download, and history follow tenant, record, field, and action checks. Naming an operator or saving configuration does not add a page, record, collection, or field grant. Policy changes are versioned. The same operation returns the first result. Audit records the actor, source `quick-capture`, IST time, and operation id. Core dialog actions are buttons, at least 44px, and the capture entry sits in Page options so the export row can wrap.

Existing schedules stay paused. No schedule is installed. Synthetic staging fixtures live in `fixtures/quick-capture/staging.json`.

## Migration

`db/131_quick_capture.sql` adds the policy, capture, revision, draft, preview, event, operator, field, and action tables. A capture cannot be updated in place, and a destination cannot be stored as shared. Re-running it is safe. It does not update `hs_data_periodic_review_schedules`, `parent_organisation_id`, or `release.py`.

## Staging QA

Bug Off folder, status Not Run until an isolated signed-in run: `HOLY-105 — Quick capture and web clipping (HS N70)`.

| Case | AC | Local evidence | Staging |
| --- | --- | --- | --- |
| N70-01 | Signed-in user captures text, a link, or a note with preview and a permitted destination | Preview then commit for a private space and an intake form | Not Run |
| N70-02 | Destination rules at commit; default is private and does not inherit external sharing | Private page, no page or record grants, intake requires create | Not Run |
| N70-03 | Sanitise HTML, scripts, unsafe URLs, hidden values, and cookies; assets only when selected | Hidden token, cookie, script, and tracker URL absent; selected asset cited and not fetched | Not Run |
| N70-04 | Offline local draft, deduped retry, truthful source failure | Local draft replay and mismatch; unavailable source keeps one draft and does not fetch | Not Run |
| N70-05 | Tenant, record, field, and action checks; configuration does not grant access | Other tenant not found; operator and action grants do not change record grants; sensitive field hides the capture | Not Run |
| N70-06 | Versions, recoverable drafts, audit, keyboard and phone | Stale policy keeps the draft; audit has `quick-capture` and IST; dialog actions stay off the export row and are at least 44px | Not Run |
