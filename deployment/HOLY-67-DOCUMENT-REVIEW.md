# HOLY-67 — Document review dates and expiry

Scope revision HS-SF-N29-r0-20261031 (DRAFT). This change adds review cycles and expiry flags. It does not unpublish a page when the expiry date passes.

## Behaviour

- Page owners set a cycle (months), a start date, and an expiry date. Dates are workspace calendar dates in Asia/Kolkata. The header shows `Next review 1 May 2027` when the cycle starts on 1 Nov 2026 and the cycle is 6 months.
- Mark as reviewed records the reviewer, the IST time, and a note, then moves the next review forward by one cycle. Readers see a Verified badge with the reviewer and date while the page is not overdue or expired.
- A daily job at or after 10:00 IST reminds the current owner 14, 7, and 1 days before the review, on the due date, daily for the first 7 overdue days, then weekly. Trashed pages are skipped until restore. If the owner is no longer an active member, reminders go to the active space leader, otherwise the active workspace owner. The space review list shows Owner needed.
- Readers see `Expired — may be out of date` on the page and in search. A space can hide expired pages from search for readers. Owners and editors still find them. The published version stays published.
- Space › Reviews lists due, overdue, and expired pages the actor can read, with filters and CSV export.

## Bug Off

Folder: `deployment/HOLY-67-bug-off/`. One case per HS-TC-N29. Every case is **Not Run** until it is executed signed-in on isolated staging. Local Vitest is not a Passed result for HS-AC-N29-10.

## Verify locally

```bash
npx vitest run lib/page-review.test.ts lib/page-review-ui.test.ts lib/search-dialog.test.ts lib/workspace-search.test.ts
npx tsc --noEmit
```
