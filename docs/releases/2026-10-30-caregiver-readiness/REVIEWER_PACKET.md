# Reviewer's security review packet: release 2026-10-30-caregiver-readiness (migration 0086)

**Status: PREPARED FOR THE REVIEWER. NOT REVIEWED. 0086 is NOT RELEASABLE.** This packet is the cover for `SECURITY_REVIEW.md`, which holds the per-function and per-table tables and the sign-off. The reviewer records findings and signs there. Author statements are evidence to check, not conclusions. **Reviewing needs no AWS access and gives no deployment authority.** Designated reviewer: **Stella Okereke** (owner decision D15), who is also the release Operator. Her operator authority comes only from the owner's separate written decisions (D14 for Part 2; a GO for Phase C); nothing in the review grants any. Everything below runs on a scratch local PostgreSQL.

## 1. What is asked
Review the security of migration 0086, 8 new API routes, and one small API fix, against `docs/security-review-checklist.md` (translated to this stack in `SECURITY_REVIEW.md` header). Return one outcome: APPROVED / CHANGES REQUESTED / REJECTED, with findings classed Blocker / Major / Minor. Not asked: infrastructure review, penetration testing, the web bundle beyond "no rule lives in the browser", any live data.

## 2. What the release does, in six lines
1. Caregiver readiness is computed in the database (background check, app sign-in, required training are hard; CPR and TB are flexible with an agency due-days setting, default 30, API-only by decision D9).
2. One "Approve for work" action (`caregivers.manage`), re-checked in the database, one approval row per caregiver, append-only.
3. Administrator-only CPR/TB extension (`caregivers.compliance.manage`) with a reason, append-only.
4. A restricted `caregiver_contacts` table (email, phone): no role can read it directly; only two functions touch the values; lists return booleans.
5. "Send sign-in link" reuses the Cognito invitation; rate limit 1 per minute, 5 per day; the address never goes back to the browser.
6. Legacy backfill: existing Ready/Active caregivers get a `legacy_status` approval; nothing is deleted or deactivated.

## 3. Pinned artifacts (verify before reviewing)
| Item | Value |
|---|---|
| Branch / code commit | `claude/practical-tesla-r07odb`; code under review `54894411f0e69ac29bec762006e47f7d943b94f2` (later commits are documentation, tests and operator scripts only) |
| Migration 0086 sha256 | `d9c8cc372011e68221868767e83922da641457535e796b9de23b836881c568ee` |
| Rollback 0086 sha256 | `fe47381cb9c888e8cb541936dbd8402a550aac83b5926a64d736a1463f520e29` |
| Migrations 0001 to 0085 set sha256 | `de0c8abbe12023ba6b7291661f592c7636ef0912827fb5ca57ccf12dac5608ef` (unchanged by this release) |
Check: `cd infra/aws/db/migrations && sha256sum 0086_caregiver_readiness_approve_for_work.sql` and `LC_ALL=C sha256sum -- *.sql | sha256sum` (all 86: `af15f5bb…c33461`).

## 4. Reading order
| # | File | Why |
|---|---|---|
| 1 | `SECURITY_REVIEW.md` | The tables you complete; author evidence; "points to look at hardest" (section 4) |
| 2 | `infra/aws/db/migrations/0086_caregiver_readiness_approve_for_work.sql` | The change under review |
| 3 | `infra/aws/db/rollback/0086_caregiver_readiness_approve_for_work.down.sql` | Reversal; BACKUP REQUIRED (data-changing) |
| 4 | `apps/sv-api/src/routes.ts` (the 8 `readiness`, `approve`, `cpr-tb`, `compliance/settings`, `contact`, `signin-link` routes; `withClientNames`) | Authorization at the API edge; no client-supplied org, role or status is trusted |
| 5 | `infra/aws/db/test/caregiver-readiness.db.test.ts`, `apps/sv-api/test/caregiver-readiness-http.db.test.ts`, `apps/sv-api/test/with-client-names.test.ts` | Refusal, tenant-isolation, concurrency and no-leak tests |
| 6 | `docs/security-review-checklist.md` | The checklist being applied |
| 7 | `DECISION_RECORD.md` (D1 to D14) | Which owner decisions shape behaviour (D9 API-only setting; D10 enforcement stays off) |

## 5. Reproduce the author's facts (scratch local database only; never TEST or production)
```bash
# 1. a local, throwaway PostgreSQL 16 that accepts a password login (the DB tests create and drop their own databases)
export OGEVIA_TEST_DATABASE_URL='postgres://<local admin>:<local password>@127.0.0.1:<port>/postgres'
pnpm install --frozen-lockfile
# 2. run single files with vitest directly. ("pnpm … test:db -- <pattern>" does NOT filter: it runs all 99 DB files.)
cd infra/aws && npx vitest run --config vitest.db.config.ts db/test/caregiver-readiness.db.test.ts        # 22 tests
cd ../../apps/sv-api && npx vitest run --config vitest.db.config.ts test/caregiver-readiness-http.db.test.ts   # 5 tests
npx vitest run test/with-client-names.test.ts                                                          # 4 tests
```
Then run the two catalog queries printed in `SECURITY_REVIEW.md` ("How the facts below were obtained") against a scratch database migrated to 0086 (`OGEVIA_DATABASE_URL=<scratch> pnpm --filter @carelik/infra-aws db:migrate`). The runner refuses non-local hosts without an owner-approval variable; do not set it. Expected counts are from the author's run on 2026-10-31.

## 6. What the author measured, for you to check
- All 13 `ogevia_api` functions: `SECURITY DEFINER`, pinned `search_path = ogevia, pg_temp`, EXECUTE revoked from PUBLIC, granted to `ogevia_app` only.
- `ogevia_app` has no table privileges anywhere in this release; `caregiver_contacts` has RLS on with no policy and no role grant.
- Three new tables use the schema's established `readonly_select using (true)` policy for `ogevia_readonly` (cross-tenant by design for the read-only role). The extension `reason` is free text.
- Mutations carry idempotency keys; approval uses a row lock and a unique row (3 parallel approvals produce one row).

## 7. Facts learned since the review was filed (2026-10-31)
1. **Cross-agency isolation can be tested by hand.** TEST has four organizations (read-only Part 2, V6), so manual cross-agency UAT (X1 to X3) will run. Item 6a ("only one organization") is **not triggered**; you may record "not applicable" there. Automated tests still carry the primary proof; UAT is a second line.
2. **Enforcement is OFF in all four TEST organizations** (V5) and stays off during UAT (D10). The application cannot turn it back off (no reverse function). This is context for 0086's "flagged only" CPR/TB behaviour, not part of this migration.
3. **TEST migration ledger is exactly 85 / `0085`** (V2), so only 0086 would be applied; baseline 5 of 6 caregivers Ready/Active (V4).
4. **A new operational artifact exists that handles a powerful credential:** `STELLA_PART2_WINDOW.sh`, used once for the read-only check (D14). It attached the app security group to the admin host temporarily, read the database master secret into memory only, ran read-only SQL as `ogevia_readonly`, and restored the group (verified). It is **not part of the release** and was not shipped. Because the reviewer ran that window, S12 is her own work: she may report on it but the owner decides whether anyone else reads it. It is optional and, by owner decision D16, may remain unreviewed with no second reader; the checks are listed as item S12 in `SECURITY_REVIEW.md` (optional, does not gate 0086).

## 8. Decisions only the reviewer can make
1. Is `readonly_select using (true)` acceptable on the three new tables, given the extension reason is cross-tenant visible to the read-only role? (`SECURITY_REVIEW.md` section 4, point 1.)
2. Is plain-text email at rest in an encrypted RDS column acceptable for a caregiver's work email? (point 4.)
3. Is it acceptable that a manager (not only the administrator) can approve for work, while only the administrator can extend CPR/TB? The owner has not confirmed this yet (README decision 2); if you object, record a finding so the owner decides before any GO.
4. Is there any path that sets a verified background result or an assignment without the required permission or the commit-time gate? (points 3 and 6)

## 9. Return
Fill in `SECURITY_REVIEW.md` sections 1 to 4 (tick or justify every box), findings (6), item 6a, and the sign-off (7); sign and date it. Return it to the owner. Any finding classed Blocker keeps 0086 NOT RELEASABLE until fixed and re-reviewed. Claude will record the outcome in `CHECKLIST.md` but will not tick any box for you.
