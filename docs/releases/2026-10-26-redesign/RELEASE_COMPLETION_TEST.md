# Release completion record: 2026-10-26-redesign on TEST (code commit 7870a04)

**Status: DEPLOYED to TEST. ACCEPTED on TEST by the Owner (statement below). TEST release NOT CLOSED: Phase C and Phase D items in section 4 are open until they are run, or the Owner records a written exception for each.** Production is not requested, not approved and was never touched. Words used exactly: *implemented*, *tested (where)*, *deployed (where)*, *accepted (by whom)*.

## 1. Owner acceptance, as stated
| Field | Value |
|---|---|
| Statement (verbatim, in the development session) | "Testing is complete and accepted." |
| By | Stella Okereke, Owner / AWS Operator |
| Time of the statement | 2026-10-25 22:56 PDT (2026-10-26 05:56 UTC) |
| Covers | TEST only: code commit `7870a04c43545bacc378ad93ffc6a09d63345b5a`, operator tarball `ac66d1ae0686f7338281ee98528eb23d86228b4c942b5e7ab63e2fec5f942336`, approval reference `owner-go-test-20261026-01`, exception `EX-2026-10-25-EARLY-DEPLOY` |
| Does not cover | production; the Scheduler, Caregiver (phone) and Authorization validators; any item in section 4 |

## 2. What is deployed (evidence: `DEPLOYED_RECORD_TEST.md`)
Migration 0086 applied to `ogevia_sv_test` (1|1|21 objects, ledger 85 / 0085, `verify-0086.sql` 110 of 110, runner verification 375 PASS); `Ogevia-prod-ServiceVerificationApi` deployed (routes 228 to 241, new Handler code, CORS unchanged); web published (bundle version = the code SHA); the other four stacks unchanged. Snapshot `ogevia-prod-postgres-pre-0086-202610260451`. Route smoke: 13 routes x 2 calls, all 401. ComplianceSweep ran after the deploy and evaluated nothing. Step 13: Staff Types (7 seeded defaults plus a test type), a report rendering, and a staff member reported created.

## 3. Gate status (`docs/TESTING_AND_RELEASE_PROCESS.md`)
| Gate | State |
|---|---|
| G1 lint, G2 typecheck, G3 tests (Phase A) | PASS on `bfb851c` (code unchanged since `7870a04`): 2,456 unit, 1,218 database, 152 API tests, none skipped; build exit 0 |
| G4 local harness (Phase B) | PARTIAL: B4 (STF-04 invite, role change, others), B7 (browser console), B9 (manual regression set R) not done; see `CHECKLIST.md` section B |
| G5 pilot/test (Phase C) | PARTIAL: C0 to C5 evidenced; C6 to C10 open, see section 4 |
| Phase D acceptance | Owner: accepted (section 1). Scheduler, Caregiver (phone), Authorization: not recorded |
| G6 Owner GO (production) | NOT REQUESTED |

## 4. Open mandatory validations (each is run, or excepted in writing by the Owner)
| # | Item (checklist row) | What it needs | Command or action |
|---|---|---|---|
| V1 | Regression set R and smoke set S on TEST (C5, C7): `pilot_regression.py` exit 0 | The app client id and six synthetic user subs of the TEST pool. It **writes to TEST**: one synthetic client with a 10-hour authorization, its shifts, all cancelled, the client set Inactive; nothing deleted | See 4.1 |
| V2 | Pilot checks (C5): `pilot_smoke.py` | Same identities; read-mostly, creates nothing | See 4.1 |
| V3 | Every role opened every menu item, no error screens; API log searched read-only for 5xx and error codes for the window (C8) | Sign-ins for each role; CloudShell for the log search | Walk each role through the menu; log search in 4.2 |
| V4 | Negative checks (C9): unauthenticated 401 and forged token 401 are **done** (route smoke); still open: another tenant sees nothing, Caregiver cannot reach Administrator data | A caregiver sign-in and a second organization | Part of the regression runner (V1) and the Caregiver validator |
| V5 | Staff invitation through Cognito and email (STF-04, from B10/C6) | An inbox the Owner controls; creates a real Cognito user and sends real email in the TEST pool | In the product: Staff, a synthetic person with that email, Invite; then sign in |
| V6 | Phase D validators other than the Owner: Scheduler, Caregiver on a phone, Authorization (three balances recalculated by hand: low use, near limit, amended; match to the minute) | The people, and the scripts in `DEPLOY_PLAN_TEST.md` section 9 | Each records accepted or rejected, or the Owner writes an exception |
| V7 | `docs/security-review-checklist.md` completed for 0086 (new SECURITY DEFINER functions, grants, tenant access) | **PREPARED, reviewer signature pending:** `SECURITY_REVIEW_0086.md` answers every box with line-level evidence (all 15 definer functions validate the organization through `staff_guard` and filter every row by it; 21 of 21 functions have a pinned `search_path`; no PUBLIC grant and no application grant on the 6 internal functions; no RLS policy created, the application role has no table privileges) and lists four residual notes (R-1 the Cognito sub is trusted from the API tier; R-2 RLS without policies, consistent with the schema; R-3 re-review if Administrators ever get `staff.manage`; R-4 the author prepared it). It is **not independent** | A person reads sections 1 and 2 against the SQL and signs section 6 |
| V8 | Release checklist signatures (Phases A to D "signed") | A person | Names and dates in `CHECKLIST.md` |

### 4.1 Commands for V1 and V2 (run from the extracted package on CloudShell; there is no git and none is needed)
Find the values (read-only). The app client id of the TEST pool:
```
aws cognito-idp list-user-pool-clients --user-pool-id us-west-2_849AYz5J7 --query 'UserPoolClients[].[ClientName,ClientId]' --output text
```
The synthetic users and their subs (print the subs, and keep the e-mail addresses out of any paste to the development session):
```
aws cognito-idp list-users --user-pool-id us-west-2_849AYz5J7 --query 'Users[].[Username,Attributes[?Name==`sub`]|[0].Value]' --output text
```
`infra/aws/slice/pilot-e2e/subs.env` in the package lists only `TEST_CG` and `PILOT_MG`; the runner also needs `--caregiver-a-sub`, `--caregiver-b-sub`, `--other-manager-sub`, `--test-caregiver-sub`, `--test-manager-sub` and the codes `SCS-CG-A` and `SCS-CG-B`, which are the synthetic identities seeded by `infra/aws/db/deploy/02_*` and `04_*`. Which sub is which is the Operator's mapping; the development session cannot make it.
Then, with the values substituted (`docs/release-process/PILOT_REGRESSION_RUNNER.md` is the reference; run it after reading it):
```
cd /tmp/ogevia-pkg && python3 infra/aws/slice/pilot_regression.py --mode aws --i-am-targeting-the-pilot --commit 7870a04c43545bacc378ad93ffc6a09d63345b5a --client-id <app client id> --manager-sub <PILOT_MG> --caregiver-a-sub <PILOT_CA> --caregiver-b-sub <PILOT_CB> --caregiver-a-code SCS-CG-A --caregiver-b-code SCS-CG-B --other-manager-sub <TEST_MG> --test-caregiver-sub <TEST_CG> --test-manager-sub <TEST_MG> --api-url https://s0epy5rgzb.execute-api.us-west-2.amazonaws.com --report-dir ~/ogevia-regression-reports
```
Exit code **0** passes; 1 is a failed case; 2 refused to start; 3 a case could not run. The gate needs 0 (never `--allow-skip`). Copy `pilot-regression-<run>.md` into `docs/releases/2026-10-26-redesign/evidence/` and tell the development session.
V2:
```
cd /tmp/ogevia-pkg && python3 infra/aws/slice/pilot_smoke.py --client-id <app client id> --manager-sub <PILOT_MG> --caregiver-a-sub <PILOT_CA> --caregiver-b-sub <PILOT_CB> --test-manager-sub <TEST_MG>
```

### 4.2 V3 log search (read-only)
```
source ~/ogevia-before/session-env.sh && FN=$(cat ~/ogevia-before/handler-function-name.txt) && LG=$(aws lambda get-function-configuration --function-name "$FN" --query 'LoggingConfig.LogGroup' --output text) && aws logs filter-log-events --log-group-name "$LG" --filter-pattern '?ERROR ?error' --start-time $(( ($(date -d "2026-10-26 04:50:00 UTC" +%s)) * 1000 )) --query 'events[].message' --output text | head -40
```
Expected: nothing, or only messages the Owner recognises. **This filter has not been run anywhere**; if CloudWatch rejects it, tell the development session and it will be corrected. Paste what it prints only after checking it holds no personal data. API Gateway 5xx counts are in the API's CloudWatch metrics; this log search covers the Lambda only.

## 5. Closing tasks
| Task | State |
|---|---|
| Deployed record written and pushed | done (`DEPLOYED_RECORD_TEST.md`) |
| Exception record `EX-2026-10-25-EARLY-DEPLOY` | exists as a file given to the Owner; not in the repository |
| GO message v2, operator tarball, screenshots | not in the repository (the second screenshot shows the Owner's e-mail address in the footer: do not commit it unredacted) |
| Script window | expired (`2026-10-26T10:32:00Z`); never reuse it; a new window needs a new approval |
| CloudShell `~/ogevia-before/` | **keep** until section 4 is closed; it holds the rollback inputs |
| Snapshot `ogevia-prod-postgres-pre-0086-202610260451` | exists and costs storage. **Deleting it is a RED action**: do it only on the Owner's explicit instruction, after deciding how long to keep it |
| Test data left on TEST | the staff type `Caregiver1`, the staff member and any invited users: synthetic; correct through the product (Deactivate), never by editing the database |
| Demo | live on the new release; the TEST freeze ended with Step 11 |
| Next-package corrections | listed in `DEPLOYED_RECORD_TEST.md` sections 5 and 7 |

## 6. To move this to "completed on TEST"
1. Run V1 to V5 and V7, and bring the results here; or
2. For any item the Owner chooses not to run, write one sentence per item: "I, Stella Okereke (Owner), accept the risk of not running <item> before closing the TEST release, because <reason>." The development session records it here word for word.
3. Record the Scheduler, Caregiver and Authorization validators as accepted, rejected or excepted (V6).
4. Sign Phases A to D in `CHECKLIST.md` (V8).
Then this record's status becomes **TEST release closed** and the development session commits it. Until then the accurate words are: *deployed to TEST; accepted by the Owner on TEST; closure open*.

## 7. Not requested: production
Production needs, in addition: 0086 promoted into `migrations/` and the production release re-pinned, a second TEST run of that exact set, the Administrator-role decision (`REDESIGN_NOTES.md` 5.1), and the Phase E package and Owner GO (`CHECKLIST.md` section E). None of that is started or approved.
