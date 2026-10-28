# HOLY-16 acceptance checkpoint — 29 Oct 2026 IST

Candidate: `073175bfcb034d207916b13ca6d9e07fb81cde4d` (`origin/main`). The HOLY-16 implementation is already in this candidate through `39b452185b2d97f16cb2916020f9d587ade8e3cc` and `87b9f9345625c697d9db2dcc0679553a820d98bd`.

## Completed evidence

- Focused connected-search, HTTP-boundary, picker-route and picker-UI tests: 35/35 passed.
- Full Vitest regression: 1,002 passed, 46 skipped, 128 files passed and two skipped. Skips are reported separately and are not acceptance passes.
- TypeScript gate passed.
- Next.js production build passed and includes `/api/v1/connected-search` plus the HS-owned `/embed/picker`.
- Local browser acceptance passed in Chrome: a 390px picker searched a 25-page fixture in stable 20 + 5 pages, reused current page access on selection, produced no WCAG 2A/AA/2.1AA/2.2AA Axe violations, and withheld the selection message from the deliberately different parent origin.
- Staging unauthenticated rollout-boundary suite passed at `https://staging.holysheet.aplyd.org`, including sign-in readiness, picker framing and picker identity boundaries. The private connected-search endpoint remained `no-store` and identity protected.
- Production returned HTTP 200 for the public shell and HTTP 401 with `Cache-Control: no-store` for an unauthenticated same-origin `POST /api/v1/connected-search`, confirming the route is deployed and fails closed.

## Remaining acceptance

The connected staging picker correctly requested Aplyd sign-in, but the locked Mac has no retained HS session. The authenticated staging search/result-selection matrix cannot run until the native browser callback can complete. Exact blocker: **Mac unlock for native callback**.

Do not mark HOLY-16 Done or Bug Off 1732–1737 Passed from this checkpoint. After unlock, run the authenticated staging matrix for current permission filtering, immediate revocation, wrong-scope/tampered cursor rejection, save freshness, explicit failure/rate-limit states and current-access recheck on selection. Record exact actor/workspace/page/request IDs without raw private query or content. Production mutation is not required for this read-only search story, but exact deployed revision evidence remains required before final acceptance.
