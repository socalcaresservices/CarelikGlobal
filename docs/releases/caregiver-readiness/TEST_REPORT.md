# Test report (what actually ran; local, synthetic data; PostgreSQL 16.15)

| Suite | Command | Result |
|---|---|---|
| Typecheck | `pnpm typecheck` | 7/7 tasks pass |
| Lint | `pnpm lint` (`--max-warnings=0`) | 6/6 pass |
| Build | `pnpm build` | 6/6 pass |
| Unit/UI | `pnpm test` | shared 118, auth 138, ui 73, sv-api 64, infra-aws (CDK) 124, **web 743**, all pass |
| Database | `pnpm --filter @carelik/infra-aws test:db` (local PG 16) | **459 pass in 46 files** (397 baseline before this work) |
| API + DB | `apps/sv-api` `vitest.db.config.ts` | 63 pass |

Notes: production RDS is PostgreSQL 18 (CI uses `postgres:18`); these runs used 16.15. Features used (multiranges, `range_agg`) exist in 16 and 18; **not run on 18 here**.
CDK tests must be run through the package script (`pnpm test` in `infra/aws`) so `esbuild` is on the PATH.

Covered: own-user/administrator/other-agency access (DB, API); pending preserves approved hours; exceptions preserved; temporary changes; stale form; duplicate/concurrent approval
(one winner); whole-interval and overnight validity; DST (spring-forward, fall-back nights); missing/unverified/rejected/expired CPR and TB, TB rule vs certificate date; service
mismatch, expiry, revocation, flags; overlap; historical visits and billing approvals unchanged by revocation; care-request double-booking race (control + fix); revoke-vs-assign race;
every shift-writing function gated (catalog scan); matching arithmetic, missing inputs, ties, mandatory gate, address non-disclosure; rollback of 0043->0039 on populated data and re-apply;
Option B style contract, collapsed/mobile drawer, keyboard (links are real anchors).

**Not tested / not done:** real phone hardware; assistive-technology run (only roles/labels asserted); load; PostgreSQL 18; the deployed stack; the Cognito path (the harness replaces authentication only);
authorisation *limit* behaviour was reused from existing tests (no new tests; rule unchanged); visual regression of pages other than the ones screenshotted.
