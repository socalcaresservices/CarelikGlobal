# Plan: cross-agency isolation check (PLAN ONLY, 2026-11-01; nothing here has been run or approved)

**Goal:** prove that a person signed in to one agency (organization) can never see or change another agency's data, on the code that is live in production.
**Why now:** production has exactly **one** organization (SoCal Care Services; VERIFIED by the 2026-11-01 probe), so nothing can leak today. The check is the **gate before a second agency is added**, and it is the largest open item of the release (R8, D38).

## 1. Evidence that exists (and what it is not)
| Evidence | Status |
|---|---|
| Automated route sweep (`apps/sv-api/test/tenant-isolation-sweep.db.test.ts`): a Manager of org B names org A's ids on every route; no 2xx on a mutating route, no org A data, org A unchanged; caregiver, scheduler and manager role checks; forged care-portal tokens | **PASSED** in G3 on `be7bccf` (API suite 158/158, 2026-11-01), against a local database. VERIFIED |
| Separate production and TEST sign-in pools; production API accepts only production-pool tokens | VERIFIED (config, 2026-11-01) |
| Live check against a deployed API with two real organizations (UAT steps X1 to X3) | **NOT RUN** (owner risk acceptance D38, for TEST only) |
| Known accepted exception: the `ogevia_readonly` database role can read across tenants (`readonly_select using (true)`) | ACCEPTED earlier; confirm below who can use it |

## 2. Recommended approach (smallest, no production change)
**A. Run X1 to X3 on TEST, then compare code hashes.** TEST already has two synthetic organizations (`ogevia-test-slice`, `scs-pilot-synthetic`; reported by the owner, to be re-verified) and the earlier owner decision D22 names the accounts: a **separate synthetic Manager in each organization** (not shared) and a synthetic Caregiver in `scs-pilot-synthetic`. Nothing in production is touched; no real person is used.
**Precondition (UNKNOWN today):** the TEST API must run the same code as production. Read-only check: compare the TEST handler's `CodeSha256` with production's `Qkm9W6hmnzo21MOwc7RfNGDSsxms9pgaQ4t4ZX9verI=`. If they differ, either the owner approves redeploying TEST with the production commit (a TEST change) or the result is recorded as "valid for the TEST code only".

## 3. Steps (Operator and owner; synthetic data only; screenshots include the address bar)
| # | Who | Action | Pass |
|---|---|---|---|
| P0 | Operator | Read-only: the two organizations and the two Manager accounts exist in TEST; TEST Lambda code hash vs production's | Both organizations and separate accounts exist; hash equal (or the difference accepted in writing) |
| P1 | Operator | Read-only SQL on TEST: one synthetic caregiver id and one client id from each organization (ids only, no names) | Four ids |
| X1 | Org 1 Manager | Sign in; open Staff, Caregivers, Care Team and Accounts | No person or record from Org 2 appears |
| X2 | Org 1 Manager | Open Org 2's caregiver and client pages by address (ids from P1) | Refused or "not found"; no data shown |
| X3 | Org 2 Manager | Repeat X1 and X2 against Org 1 | Same |
| X4 | Org 2 Caregiver | Sign in; open the caregiver view and try Org 1's ids by address | Only own assigned data; Org 1 ids refused |
| X5 | Either Manager | Try the staff, readiness and schedule screens with the other organization's ids | Refused; nothing changes |
| X6 | Operator | Read-only SQL on TEST after X1 to X5: row counts of both organizations unchanged; no audit event written by a refused action | Unchanged |
**Stop rule:** at the first sight of another agency's data, stop all testing and send me the screenshot. That is a P0 exposure: no further steps, the owner is told, nothing is added to production, and a fix follows the normal release process.

## 4. Before agency number two goes into production (owner's gate)
1. X1 to X6 passed on code whose hash equals production's (or the difference was accepted in writing).
2. The route sweep still passes at the commit in production (`pnpm test:all`).
3. Confirm who holds credentials for the `ogevia_readonly` role in production (it reads across tenants by design): UNKNOWN today; it should be nobody except a named, approved reporting use.
4. A short read-only production check on the day: with agency two created and empty, its Manager sees none of agency one's staff or clients (Staff, Caregivers, Accounts). Needs the owner's approval at that time.
Alternative **B** (not recommended): create a synthetic second organization in production now and test there. It adds data and a test user to production, needs Cognito and database changes, and must be removed afterwards. It is only worth it if TEST cannot be made to run the production code.

## 4b. Cost, time, risk
No AWS cost. About 45 to 60 minutes, Operator plus owner. Risk: low on TEST (synthetic data, no production change). If the check finds exposure, production is not affected today (one organization), but adding agency two is blocked until fixed.

## 5. Decisions needed from the owner
1. Approve running P0 to X6 on TEST (read-only SQL on TEST, sign-ins with existing synthetic accounts). If the two separate Manager accounts or the Caregiver do not exist yet, creating TEST users needs your approval (earlier decision D22: no new TEST users outside the approved scope).
2. If the TEST code differs from production's: redeploy TEST with the production commit, or accept a "TEST code only" result.
3. When agency two is expected (this sets the deadline).
Not part of this plan: authorization arithmetic (A1 to A4), live role gating, Task 8.
