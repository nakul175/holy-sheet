# HOLY-72 space home landing

Code and Vitest cover HS-AC-N38-01 through HS-AC-N38-09. This change does not record a staging Lighthouse run, and it does not move the story to Done.

The landing is a designated page plus four widgets: Pinned, Recently updated, Key record views, and Owners. A new space gets a private page from the Space home template (title, overview, Start here). While that page is the current home, active space members can read it. Setting another page as home leaves the previous page in place and does not publish it.

Widgets call the same page access check as the rest of Holy Sheet. Trashed, hidden, and foreign-tenant targets are omitted with no placeholder count. Unknown spaces, non-members, revoked members, and cross-tenant ids return one not-found shape. Mutations lock the workspace row, take an idempotent operation id, and append `hs_audit` with actor, target ids, and an IST timestamp. Audit payloads do not include page bodies.

The client refetches every 4 seconds, on focus, and on logout. A 404 clears the landing immediately. That is the HOLY-4 recheck used by other surfaces. It is not a measured revoke-window certification.

Layout stacks the four widgets in one column at 420px and below, which covers a 390×844 phone. The LCP budget is under 2.0 seconds at p75. This build does not record a staging Lighthouse run.
