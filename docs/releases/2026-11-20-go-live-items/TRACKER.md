# Go-live items tracker (owner list of 2026-11-15, worked 2026-11-20)

Source of the list: the owner's instructions in the build session. The repository holds no earlier written list, so item meanings are the builder's reading and need owner confirmation. Status words: COMPLETE = code committed, tests passing, commit hash recorded. Implemented never means deployed: nothing here is deployed, no migration, no release switch, no AWS change.

Branch `claude/sharp-mendel-sy1p24`, stacked on `claude/ops-fixes-requests-documents-sorting` (PR #113). Pull request: #114.

| # | Item | Status | Commit |
|---|---|---|---|
| 1 | Calendar CSV sort | COMPLETE | 93e84d1 |
| 2 | Export ordering (all exports) | COMPLETE | f88bdc4 |
| 3 | Caregiver picker | COMPLETE | 494b3fd |
| 4 | Shift drawer | COMPLETE | 4fc3859 |
| 5 | Dashboard refresh after shift updates | COMPLETE | eef6b23 |
| 6 | Requests refresh after shift updates | COMPLETE | fea082a |
| 7 | Office filtering (read as VIS-26: Billing review filter by review reason) | COMPLETE | 7bf0a4c |
| 8 | Homepage updates (read as: Home Refresh uses the shared shift-change refresh) | COMPLETE | 369e988 |
| 9 | Mobile view improvements (read as: phone sorting for Documents and Staff, the open gap in R38) | COMPLETE | 914695f |
| 10 | Scheduling refusal message improvements | COMPLETE | c19453d |

## Gate (local, 2026-11-20, at c19453d)
- `pnpm lint`, `pnpm typecheck`, `pnpm build`: pass.
- Unit suites: shared 118, auth 155, ui 73, sv-api 110, web 1367, infra-aws 718: pass.
- API suite against PostgreSQL 16 (`@carelik/sv-api test:db`): 184 pass.
- Database suite (`@carelik/infra-aws test:db`, 1183 tests) last run on PR #113's code before items 1-10; no migration or infra file changed since, so it was not rerun.
- CI on the pushed commits: see PR #114.

## Not done / blockers
- Item meanings are the builder's reading (the owner's written list is not in the repository): confirm items 1, 2, 3, 4, 7, 8, 9 and 10.
- Migration 0109 (PR #113) is applied nowhere and its `requestCleanup` switch is OFF everywhere.
- No real-phone check; no demo or production verification; no deployment (needs the owner's GO, production credentials and the release checklist).
