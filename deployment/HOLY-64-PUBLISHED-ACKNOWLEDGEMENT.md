# HOLY-64 published document acknowledgement

Scope HS-SF-N26-r0-20261031 is still draft. This change implements HS-AC-N26-01 through HS-AC-N26-10 for published Holy Sheet pages. HS-AC-N26-11 stays open: Bug Off has not been executed on staging, and local tests are not a Passed result.

Acknowledgement extends HOLY-63 publications and HOLY-4 effective page access. It does not create a second document model and it does not grant read access.

## What shipped

- An owner requests acknowledgement for the current published version from users, workspace groups, workspace or space roles, and space members. People who cannot already read the page are returned only to the owner as `Cannot be assigned — no access`. Assignees receive an in-app notification and an email outbox row. No document body is stored in either.
- An assignee sees `Please read and acknowledge vN`. Acknowledge stays disabled until they confirm and either reach the end of the document or, for a short document, wait 30 seconds. The record stores the user, published version, UTC timestamp, IST label, content hash, and country code.
- The owner dashboard shows completion, pending / overdue / acknowledged filters, per-person version and IST time, CSV export, and an evidence pack.
- The reminder job sends at most one assignee reminder and one owner overdue summary per campaign per IST day. Acknowledgement stops that person's reminders. Paused campaigns are skipped.
- A later **major** publication can require acknowledgement again. Earlier records stay in the chain. A **minor** publication keeps the current acknowledgements.
- Evidence is append-only. Each record stores the previous record's hash. The pack includes the content hash, user, UTC timestamp, IST time, country code, and chained hash. Full IP addresses are not accepted and are not stored.

## Migration

`db/099_published_acknowledgements.sql` adds publication `version_number` and `bump`, audience groups, campaigns, assignments, append-only `hs_ack_records`, reminder dedupe, and the email outbox. It also allows acknowledgement rows in `hs_notifications` without a discussion thread. Re-running it is safe (`IF NOT EXISTS`, guarded constraints, replaceable functions and triggers).

Trash and restore pause and resume the open campaign through the existing `hs_pages.deleted_at` update. Evidence rows are kept.

Existing publication rows stay immutable, so they are not backfilled. Publications created after this migration receive a version number. The first publication defaults to major when the publisher does not choose a bump. Later publications default to minor.

## Database role

Create `hs_app` out of band. Do not commit a password or put one in this repository. The migration role should own the tables. `hs_app` should not own `hs_ack_records` and should not be a superuser.

When `hs_app` already exists, the migration revokes every privilege on `hs_ack_records` and grants only `SELECT` and `INSERT`. The append-only trigger rejects `UPDATE` and `DELETE` for every role, including the table owner. If `hs_app` does not exist, the grant block is skipped so local and test databases can still replay the file.

## Reminder schedule

Run the job at 10:00 Asia/Kolkata. That is 04:30 UTC. A second run on the same IST date does not send another reminder.

```text
# Operator-supplied token. Do not commit a value.
# 10:00 Asia/Kolkata:
0 10 * * *  TZ=Asia/Kolkata  curl -fsS -X POST -H "Authorization: Bearer $HS_ACK_REMINDER_TOKEN" https://<holy-sheet-host>/api/v1/acknowledgements/reminders
```

| Variable | Purpose |
| --- | --- |
| `HS_ACK_REMINDER_TOKEN` | Bearer token for the reminder route. The route returns 503 when it is unset. No default is shipped. |
| `HS_ACK_SMTP_URL` | Optional later mailer for `hs_ack_email_outbox`. This change records the outbox row and does not send mail. Leave unset. Do not invent credentials. |
| `X-HS-IP-Country` | Two-letter country set by the edge before the app sees the request. The app does not read `X-Forwarded-For` or any full IP. |

## Rollback

Stop the reminder schedule first. Deploying the previous application build leaves the new tables in place and stops serving the acknowledgement routes. Do not `DELETE` from `hs_ack_records`; the trigger rejects it, and deleting evidence is not a rollback. Dropping the tables requires a migration role, disables the trigger, and destroys the compliance record. That is a separate explicit decision.

## Deferred

Quizzes, attestation questions, and eIDAS e-signature compliance are out of scope. Group administration beyond the membership tables used to resolve an audience is out of scope. SMTP delivery is an outbox only. Bug Off F01–F11 are Not Run until an isolated signed-in FX-WIKI-20261031 staging run. Do not mark HOLY-64 Done from local Vitest.

## Staging QA

Bug Off folder to create, status Not Run: `HOLY-64 — Published document acknowledgement`.

| Case | AC | Local evidence | Staging |
| --- | --- | --- | --- |
| F01 | HS-AC-N26-01 | Audience resolution keeps no-access people off the assignment list and out of notifications | Not Run |
| F02 | HS-AC-N26-02 | Scroll or 30-second short-document gate, confirm checkbox, content hash | Not Run |
| F03 | HS-AC-N26-03 | Completion, filters, IST CSV | Not Run |
| F04 | HS-AC-N26-04 | One reminder per IST day; acknowledgement stops the next day's reminder | Not Run |
| F05 | HS-AC-N26-05 | Major re-acknowledgement keeps history; minor publish keeps the current acknowledgement | Not Run |
| F06 | HS-AC-N26-06 | Chained hash verifies; UPDATE and DELETE are rejected | Not Run |
| F07 | HS-AC-N26-07 | Non-assignee and no-access calls return generic not-found and write no record | Not Run |
| F08 | HS-AC-N26-08 | Revoked read access fails server-side; owner sees Lost access | Not Run |
| F09 | HS-AC-N26-09 | Trash pauses the campaign, notification is generic not-found, evidence remains, restore resumes | Not Run |
| F10 | HS-AC-N26-10 | Another tenant replaying a version id gets the same generic 404 and writes no record | Not Run |
| F11 | HS-AC-N26-11 | Traceability only. Do not mark Done from this table | Not Run |

Reset FX-WIKI-20261031 on isolated staging. Sign in as the actor in each Given clause. Record the candidate SHA, environment, and an IST timestamp. Keep screenshots and sanitized responses. Chain checks can use `node scripts/verify-acknowledgement-chain.mjs <evidence.json>`. Do not infer Passed from this repository's Vitest run.

## Local checks

`npx vitest run lib/document-acknowledgements.test.ts lib/document-acknowledgements-ui.test.ts` covers audience resolution and access, chained-hash verification, append-only enforcement, generic not-found for deny / revoke / trash / cross-tenant, reminder dedupe, and major versus minor re-acknowledgement. `npx tsc --noEmit` covers the TypeScript build.
