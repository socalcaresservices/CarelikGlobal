# Office filtering (2026-11-20)

Status: **implemented and tested locally. Not deployed.** No migration, no release switch, no AWS change.

"Office filtering" is not defined anywhere in the repository (no office or branch field exists in the data). The only documented, unbuilt office filter is VIS-26 (`docs/releases/2026-10-13-wave1/CHECKLIST.md`: "exception center groups/filters by reason ... NOT BUILT"; `RELEASE_DECISION_PACKAGE.md`: "let the office filter by reason"). This item is read as VIS-26 for Billing review. If the owner meant something else (for example filtering by office location), that needs a data model first and is a separate decision.

## What changed
- Billing review (`apps/web/src/aws/billing-review-page.tsx`, `billing-filters.ts`): a "Review reason" filter next to Client, Caregiver, Service, Visit status and Approval status. It lists only reasons present in the loaded rows, in plain words, A-Z, and appears only when at least one row carries a reason. It filters the loaded rows only (no new request, no record changes). It combines with the other filters (AND), is counted in "Filters (N active)", and Clear filters resets it.
- Plain-word labels: started with no scheduled shift; worked time differs from the schedule; no client signature or mark; over the monthly authorization; authorization was decreased. An unknown reason code is shown in its own words, never hidden.
- The server already returns `reviewReasons` per visit; nothing changed server-side.

## Tests
`billing-review-filters.test.tsx`: 4 added (options, filtering, combining with other filters, page-level select and Clear filters). Full web suite passes.
