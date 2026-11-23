# Phase 9 — Release validation

Date: 2026-11-23 · Branch `stabilization/main-reconciliation` · STATUS: **COMPLETE — all gates pass on the final commit set** (commit 3900474a; later commits are documents only)
Method: the repository's own gate runner `pnpm test:all` (refuses to pass if any suite is skipped or no test ran), preceded by forced (non-cached) lint, typecheck and build. Local PostgreSQL 16, synthetic data. Not a deployed or TEST result.

| Gate | Command | Result |
|---|---|---|
| Lint | `pnpm run lint --force` (turbo: web `eslint --max-warnings=0`, others `tsc --noEmit`) | 6/6 tasks successful |
| Typecheck | `pnpm run typecheck --force` | 7/7 tasks successful |
| Build | `pnpm run build --force` | 6/6 tasks successful (web `tsc -b && vite build`) |
| Unit and static tests, all workspaces | `pnpm test:all` step 1 | passed (web 156 files / 1,417 tests before the final dependency change; infra/auth/shared/ui/sv-api unit suites included) |
| Database tests (infra-aws) | `pnpm test:all` step 2 | passed, none skipped |
| API tests against a real database (sv-api) | `pnpm test:all` step 3 | 32 files / 191 tests passed |
| Summary line | `test:all` | "PASS all suites ran, none skipped, all passed." exit 0 |

## Failures found and repaired (the "repeat until clean" loop)
1. First full run (with `pnpm update -r` applied): 13 unit and 5 database failures. Cause, computed by running the same file with and without the dependency change: the AWS SDK update changed the API Lambda bundle, so the pinned production release-discovery gate refused ("RELEASE code asset key 79e0…, not the pinned eab9…"); with the change reverted `prd-release-discovery.db.test.ts` passes 31/31. Repair: reverted the in-range updates and kept only the three security upgrades (react-router-dom, zod 4, qs override), which leave the API bundle byte-identical.
2. Release pin guard (`release-pins.test.ts`) after each application change: expected by design; re-pinned using the two-commit pattern, including the new `pnpm-lock.yaml` hash.
3. Earlier in this phase: the sorting change touched application files (pins re-pinned, 5/5), and a TypeScript error in the schedule header helper (`exactOptionalPropertyTypes`) was fixed before the commit.

## New tests added in this stabilization
`apps/web/src/aws/hours-table-sort.test.tsx` (1), `infra/aws/test/invitation-email.test.ts` (7).

## Not verified
- Real phone widths and mobile interaction for the new sort headers; email-client rendering of the invitation (only a 390/900 px Chromium file check); accessibility pass beyond existing tests.
- TEST and production behavior: nothing was deployed or run against AWS.
- The previously flagged pre-existing failures noted on the Open Shifts branch (prd-rehearsal, operator-tarball etc.) did not occur on this branch.
