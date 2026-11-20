# Export ordering (2026-11-20)

Status: **implemented and tested locally. Not deployed.** No migration, no release switch, no AWS change.

## Owner instruction (2026-11-20)
"Export ordering" means every export. Exported rows follow the same visible order as the screen. Use the screen's active sort whenever one exists. If a screen has no sort control, use a documented default order in both the screen and the export. Add tests proving it.

## Inventory of exports (checked in code)
| Export | Screen | Order rule | Where enforced |
|---|---|---|---|
| Incidents CSV | Incidents table | the displayed rows (search, filter, active sort) | exports `table.rows` |
| Credentials CSV | Credentials table | same | `table.rows` |
| Audit activity CSV | Audit table | same | `table.rows` |
| Authorizations CSV | Authorizations table | same | `table.rows` |
| Clients CSV | Clients table | same | `table.rows` |
| Candidates CSV | Candidates table | same | `table.rows` |
| Billing submission items CSV | Line items under a submission (no sort control) | client A-Z, service A-Z, service date oldest first | `orderBillingSubmissionItems`, used for the list and the file |
| Client monthly calendar / reconciliation CSV (browser) | Monthly service rows (no sort control) | service code, service name, authorization period oldest first | `orderMonthlyServiceRows` |
| Correction history CSV (browser) | Correction history (no sort control) | corrected on newest first, then visit ref | `orderCorrectionRows` |
| Server-made monthly chain, calendar, reconciliation, correction files | same screens | same rules as above | `apps/sv-api/src/exports.ts` calls the same functions |
| Server-made billing review and audit report files | no on-screen list with its own order | the database function's order, unchanged | not reordered |
| Excel | none exists (Excel is import only) | n/a | n/a |

Text sorts case-insensitively with numbers in natural order (C-2 before C-10). Empty values go last. Ties keep input order.
The shared module is `packages/auth/src/export-order.ts` (the one package both the web app and the API already depend on; no new dependency).

## Limits
- A user's own column sort on the Reports visit table does not reach the server-made billing review file; that file uses the database order.
- The list exports contain only the rows loaded (existing, documented limit of the paginated screens).

## Tests
- `packages/auth/src/export-order.test.ts` (the order rules)
- `apps/sv-api/test/exports-order.test.ts` (server files)
- Page tests that sort a column, export, and compare the file to the rows on screen: incidents, credentials, audit, authorizations, candidates, clients, billing, monthly chain.
- Helper: `apps/web/src/test/csv-capture.ts`.
