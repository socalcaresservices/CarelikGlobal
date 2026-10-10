# PR #76 independent review — actual local results

Synthetic data only. No deployment, AWS mutation or real Cognito login. Server: **PostgreSQL 18.3** (native embedded distribution), disposable loopback database; psql client 16.15 for deployment-script integration tests. Node 24.19.0; pnpm 9.15.4 pinned to the repository lockfile. The production Lambda target remains Node 22; deployment/runtime smoke checks are still required.

| Check | Actual result |
|---|---|
| Workspace typecheck | All seven workspace packages passed |
| Workspace lint | Passed, including web ESLint with zero warnings |
| Workspace build | Passed; existing Vite large-chunk warning remains |
| Shared/auth/UI unit tests | 118 / 138 / 73 passed |
| API unit tests | 64 passed |
| Web unit/UI tests | **747 passed in 89 files**, including administrator required-TB permission and the three new experience/preferences/ZIP flows |
| Local CDK synthesis | Passed with `env=prod`, `mode=plan`; no AWS lookups/deployment. Used `node --import tsx bin/ogevia.ts` because this container blocks the tsx CLI Unix socket |
| Infrastructure/CDK tests | **124 passed in 10 files**, including API/CDK route contract |
| PostgreSQL 18 database suite | **466 passed in 47 files** |
| Real API + PostgreSQL 18 | **64 passed in 2 files** |
| Real administrator screenshot exercise | Passed; real AWS app shell, API handler and PostgreSQL 18, with synthetic verified-claims/auth session only; optional client preference saved and checked in the database |

Commands use `corepack pnpm@9.15.4 -r typecheck`, `-r lint`, `-r build`, and each package's `run test`. Web and infrastructure tests used `--maxWorkers=2 --minWorkers=1` to avoid resource exhaustion. A temporary PATH wrapper supplied pnpm 9.15.4 to CDK's child bundler; the runtime's default pnpm 11 otherwise attempted an incompatible dependency reinstall. No package or lockfile changes were made.

Database commands: with `OGEVIA_TEST_DATABASE_URL` pointing only to disposable local PostgreSQL 18, `corepack pnpm@9.15.4 --filter @carelik/infra-aws test:db` and `--filter @carelik/sv-api test:db`. Each file migrates from zero with the real checksummed runner. The constrained container needed local-only PostgreSQL uid and Chromium runtime workarounds; none was added to application or production configuration.

New meaningful checks cover manual work with incomplete optional scores; a not-eligible Matches candidate manually assigned using an audited availability override; overlap refusing that override; Administrator-only required CPR/TB review; mandatory experience at direct, reschedule, reassign, standing and recurring-series commitment; manager live-start checks in active and report-only modes; a client-requirement/assignment race; ZIP read isolation. Existing document, service, availability, tenant, client-authorisation, concurrency, billing and historical-record tests also passed. One old isolation fixture now gives its manager a valid worker profile; another retires unrelated overlapping synthetic shifts instead of leaking them into the next visit test.

Rollback tests prove archived copies remain and reapplication succeeds, and now explicitly prove that operational approval/experience tables are empty after reapplication and archive tables have no operational constraints. Archived approval IDs still join to surviving caregiver/service records; this is not an automatic dependency-restoring import. The 0039–0043 down scripts are therefore classified BACKUP REQUIRED, not SAFE AUTOMATED.

Earlier failing runs found real issues or local tooling limits and were corrected before the passing results above. The final database run took 51.66 seconds; API/database 2.65 seconds; web 57.23 seconds. JSDOM emits existing print-CSS/canvas limitations; these did not fail the final suites. Real browser screenshots were visually inspected in both desktop and mobile widths.

Remaining verification: deployed Cognito login/MFA/token refresh and each database role, actual phone hardware, assistive technology, load, production migration ledger/checksums and exact deployed artifacts. See [deployment handoff](DEPLOYMENT_AND_ROLLBACK.md). Nothing here certifies a report-only agency for real work.

## Review follow-up (patch on top of #76): added tests
`manual-assignment.db.test.ts` (8), `enforcement-matrix.db.test.ts` (5: 7 conditions x report-only / active / Service checks On x assignment / visit start), `readiness-restore.db.test.ts` (9), `visit-start-availability.db.test.ts` (9),
migration 0045 covered by the manual-offer tests and the updated rollback test; UI: report-only CPR wording, "Offer manually", My experience (3 tests).

Second review round (visit-start availability, restore recovery sets, My experience): see the PR #77 description for the exact commands and counts.
