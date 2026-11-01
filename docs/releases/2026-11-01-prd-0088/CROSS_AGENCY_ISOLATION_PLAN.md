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

## 6. Owner decisions and progress (2026-11-01, evening)
- **Decided by the owner (in conversation):** keep the 17:03 snapshot; proceed with the read-only TEST isolation verification; "I do not have the TEST Manager/Caregiver passwords or MFA authenticators"; "Schedule the cross-agency isolation test before a second agency is onboarded". **Gate recorded:** no second agency is added to production until X1 to X6 have passed on code whose hash equals production's, or the owner accepts the gap in writing.
- **Done (VERIFIED from the Operator's output, 22:30 UTC, TEST database only, read-only, security group restored and proven):** both organizations exist and are active; accounts per role (`ogevia-test-slice`: Manager 1, Caregiver 1; `scs-pilot-synthetic`: Owner 1, Manager 1, Scheduler 1 invited, Caregiver 4); ids for X2 and X4 (saved in the Operator's `~/isolation_results_20261101T223029Z.txt`); baseline counts for X6: `ogevia-test-slice` 2 caregivers, 2 clients, 103 audit events, 2 memberships; `scs-pilot-synthetic` 5, 5, 215, 7.
- **Waiting:** (a) rerun of the window with the added separation and account-map queries (commit `c6b1afe`); (b) the TEST Lambda hash versus production's `Qkm9W6hm...`.
- **Blocker for the sign-in steps X1 to X5:** nobody has confirmed holding credentials and authenticators for a Manager in each organization and a Caregiver in `scs-pilot-synthetic`. Paths: ask the Operator whether she holds them (no change); else, with the owner's approval and after the account map confirms the three accounts are synthetic, set new temporary passwords and clear the old authenticator for exactly those three TEST accounts (TEST pool only; no email is sent by a temporary-password reset; each person enrolls an authenticator at first sign-in).
- **Incident (2026-11-01 22:41 UTC, second window run): false alarm, nothing changed.** An AWS call returned an HTML `500 - Internal Server Error` page during the script's pre-checks ("RDS is publicly accessible: unexpected"), so the script stopped before attaching anything; its closing re-checks read empty values and printed "RESTORE NOT VERIFIED". The Operator's read-only re-check afterwards (VERIFIED from output): admin host groups `sg-00e01e2ca80442c1f` only; database firewall group sources `sg-064ffce3bcbe8eb3b` (unchanged baseline); no address-based rules; database `PubliclyAccessible False`. Note for later: the reviewed window script treats "could not read" the same as "differs", so a transient AWS fault looks like a failed restore; the correct response is a read-only re-check, never a fix by hand.
- **Rerun (2026-11-01 22:49 UTC, VERIFIED from the Operator's output; TEST database, read-only; `RESTORE VERIFIED`):** counts unchanged from the first run (baseline for X6 stands). **`users_in_both_orgs` = 1:** the sign-in user with prefix `58d173c0` is the Manager of `ogevia-test-slice` and also holds a Scheduler membership in `scs-pilot-synthetic` with status **invited** (not active). Account map (role, status, sign-in prefix): `ogevia-test-slice`: manager active `58d173c0`; caregiver active `8861c310`. `scs-pilot-synthetic`: organization_owner active `685183b0`; manager active `d86123c0`; scheduler invited `58d173c0`; caregivers active `78a103c0`, `88b1a3e0`, `b84183a0`, `e881f300`.
- **Consequence for the steps:** the Org 2 Manager (`d86123c0`) is a separate account. The Org 1 Manager (`58d173c0`) is not, so X1 and X2 for Org 1 become a stricter test: the account's Org 2 membership is only *invited*, so it must show **no** Org 2 data until the invitation is accepted (a pending invitation must grant no access). A clean Org 1-only subject would be the Org 1 caregiver `8861c310` (caregiver view only). Whether a user in two organizations is intended is a design question for the owner, not by itself a defect.
- **Next:** map the sign-in prefixes to TEST pool users (read-only), confirm none is a real person, then the credential question (Operator holds them? else approved reset of the chosen accounts); TEST Lambda hash still owed.
