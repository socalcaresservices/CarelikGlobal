# Deployed record: demo.ogevia.com (TEST), code `fb491a554c0fdc484102025179c9c993f694b4e0` (`fb491a5`), 2026-10-29

**Status: DEPLOYED to demo.ogevia.com (TEST). NOT ACCEPTED.** "Deployed" here means the record below exists and the Owner has the TEST link (procedure Step 16). "Accepted" means the Phase D sign-offs, which have not been given. Step 13 was later reported PASS (section 4a; not a Phase D sign-off). Step 14 and V4 to V6 had not been reported when this was written. Nothing here touches production (`app.` / `admin.ogevia.com`, stacks `Ogevia-prd-*`, `ogevia_prd`), `main`, or any production resource.

**Names.** Per the Owner's instruction of 2026-10-29, this environment is called **demo.ogevia.com (TEST)**. Exact internal identifiers, quoted only where needed: CloudFront domain `d2xumch5w0izfg.cloudfront.net` (alias `demo.ogevia.com`), stacks `Ogevia-prod-*` (the pilot/TEST slice; see `docs/aws/INVENTORY_RECONCILIATION_2026-10-21.md` section 4), database `ogevia_sv_test`, API `s0epy5rgzb`. No resource was renamed.

**Evidence.** Every line below was pasted by the Owner/Operator from CloudShell (account 300094796789, us-west-2) or read from the run folders on it. The development session ran no AWS command. Approval: reference `OGEVIA-TEST-GO-20261028`, "APPROVED FOR TEST DEPLOYMENT ONLY", Operator recorded as Stella Okereke (the Owner also stated they acted as both approver and operator), window 2026-10-29T05:00:00Z to 09:00:00Z, admin host `10.20.132.179` (instance `i-0ce8db2d7e5839dd5`). Package: `ogevia-operator-fb491a5.tar.gz`, sha256 `c61e2a73df6c9c57e14cf9f443f21b324e6d993a311444046dec023757bed6b8`, verified before extraction.

## 1. What is deployed (Step 16, recorded 2026-10-29T08:37:40Z; all PASS)
| Item | Value |
|---|---|
| Deployed SHA | `fb491a554c0fdc484102025179c9c993f694b4e0` (code tree `9c33b7b4e3d9d33c240c45385f2cad2ad40d1e8a`) |
| Lambda | `Ogevia-prod-ServiceVerificationApi-Handler886CB40B-2ZkW4XDDj5vu`; CodeSha256 b64 `VFN/cMO326y63xaTOQERNhyvp+mHC19EM3/xN4IWeE4=` (hex `54537f70c3b7dbacbadf1693390111361cafa7e9870b5f44337ff1378216784e`), before `u+G3k5pp3INWM39VEA7hBbCVXkX64rsPVdKnYsBWJvs=`; LastUpdateStatus Successful; **LastModified 2026-10-29T08:00:38Z (the time the API was deployed)** |
| Handler asset in the deployed stack | `2871b03d6be42b0b8c85bac6feea12de75b3d05ca4636610259b6a18e1d00ed7.zip` (the release's pinned build; reproduced in CloudShell, which closes the open item "Handler key in CloudShell NOT VERIFIED") |
| Web | bundle version `VITE_APP_VERSION:"fb491a554c0fdc484102025179c9c993f694b4e0"`, built for TEST (`VITE_APP_ENV:"test"`), `index.html` sha256 `38adebb140069d8272113de33633cbfd535d6d74b528c9d2e1706797090396cb` (served = built), main script `assets/index-BuKbuoqT.js`, `config.json` unchanged |
| API routes | 241 to 242 (exactly one added: `POST /v1/me/staff-invitations/{organizationId}/accept`); no earlier route lost; CORS unchanged |
| Database | `ogevia_sv_test`: ledger 85 / `0085` unchanged; 0086 present (`1|1|21`); **0087 applied** (functions of 2: 2); enforcement activated for 0 of 0 agencies |
| Stacks | EvidenceStorage CREATE_COMPLETE; NetworkEgress UPDATE_COMPLETE; WebHosting UPDATE_COMPLETE; ServiceVerificationApi UPDATE_COMPLETE; Observability CREATE_COMPLETE |

## 2. Timeline (UTC, 2026-10-29)
| Time | Step | Result |
|---|---|---|
| (before 07:00) | 0 to 5 | Node on CloudShell was v20.20.2; Node v22.22.0 installed under `/tmp` from nodejs.org (checksum OK) and added to `session-env.sh`. Tarball hash verified; manifest 1075 files; pin check `PINS HOLD`; assembly check `PASS all checks` (Handler `2871b03d6be4…`, 242 routes, 14 staff routes); Step 5 baseline captured (RDS available, not public, encrypted; 155 web files; `index.html` captured = served) |
| 07:14:58 | 6 ledger recheck | ledger 85 / 0085; 0086 present; **0087 absent (0)**; security group restored and verified (`76e9c753…`) |
| 07:19:50 | 7 snapshot | `ogevia-prod-postgres-pre-0087-202610290719`: available, manual, encrypted, of `ogevia-prod-postgres`, created inside the window; `SNAPSHOT VERIFIED` |
| (about 07:3x) | 8 gates | API stack `CHECK PASSED (DELTA)`: exactly one route and the Handler asset `94b73574c5a6… -> 2871b03d6be4…`; the four other stacks passed (inferred from the loop having reached the API stack). `cdk diff` printed "Number of stacks with differences: 4" (informational) |
| 07:30:53 | 9 apply, first run | **0087 applied**: objects 0 to 2; `verify-0087.sql` 24/24, `verify-0086.sql` 110 PASS, runner set 375 PASS 0 FAIL; ledger 85 / 0085 unchanged; people and access unchanged |
| 07:33:22 | 9 apply, second invocation | **refused** (`STOPPED: the 0087 objects are not absent (2) ... Nothing was changed.`); security group restored and verified. Investigated and explained as a harmless duplicate invocation of the same operator (run folders, `OWNER_DECISIONS_FOR_TEST.md` section 9); the Owner lifted the stop |
| 08:00:38 | 10 API deploy, first run | `Ogevia-prod-ServiceVerificationApi` deployed (Lambda LastModified); post-check `POST-CHECK PASSED` (UPDATE_COMPLETE, code changed, 241 to 242 routes, CORS unchanged, ComplianceSweep ENABLED) |
| after 08:00 | 10 second invocation | **refused** by the guard (`NOTHING TO DEPLOY ... 'NONE', not DELTA`); nothing deployed. `cdk diff` for the API stack: "There were no differences"; the count of stacks with differences fell from 4 to 3 |
| (about 08:05 to 08:15) | 11 web | built and published; assets first, `index.html` last; `WEB VERIFIED`; exact time not in the pasted output |
| (about 08:15) | 12 smoke | `Smoke OK`; accept route 401 with no token and with a forged token; CORS preflight from `https://demo.ogevia.com` 204 |
| 08:21:55 | 15 final read, first attempt | `psql ... port 15439 ... timeout expired` (tunnel); nothing read, nothing changed; rule removed and security group verified identical |
| (about 08:3x) | 15 final read, retry (once, with `OGEVIA_TUNNEL_WAIT=60 OGEVIA_WINDOW_MAX_SECONDS=600`) | **passed**: 85 / 0085, 0086 present `1|1|21`, 0087 present (2), enforcement 0 of 0; security group restored and verified |
| 08:37:40 | 16 record | `RECORDED: every deployed artifact maps to fb491a554c0fdc484102025179c9c993f694b4e0` |

## 3. Deviations from the procedure (all disclosed)
1. Node 20 on CloudShell: Node 22.22.0 installed manually (same as 2026-10-26); a PATH line was appended to `session-env.sh`.
2. Step 9 and Step 10 were each invoked twice; the second invocation was refused by the script's own precondition in both cases, with nothing changed.
3. Step 14's default log group does not exist (as on 2026-10-26); a corrected command (the Lambda's own `LoggingConfig.LogGroup`, last-modified time printed, one-hour look-back) was supplied. Its result was later reported PASS (section 4b).
4. Step 15 needed one retry after a tunnel timeout (cleanup verified both times), with two documented timing variables raised.
5. Steps ran in the order 9, 10 (after a first-run), 11, 12, 15, 16 with 13 and 14 still to report; the procedure puts 13 and 14 before 15 and 16. Neither 15 nor 16 depends on them.
6. The procedure's Step 8 gate for the other four stacks was inferred from the loop reaching the API stack rather than from the printed lines.

## 4. NOT done, NOT verified
- **Step 13 walkthrough: reported PASS** (see section 4a). **V4** (same-agency Caregiver, whose sign-in does not exist yet), **V5** (needs an existing sign-in outside the demo.ogevia.com (TEST) agency; browser sign-in of accounts D and E NOT VERIFIED) and **V6**: not run. **V7**: Owner option B (TEST-only exception); independent review still required before any production request.
- **Step 14: reported PASS** (section 4b).
- The JWT authorizer with a real Cognito token on the accept route: NOT VERIFIED (only refusals, 401, were exercised).
- **Phase C and Phase D sign-offs: UNSIGNED.** No production approval exists or is implied.
- Not rehearsed on AWS: rollbacks R1 to R3. They were not needed.

## 4a. Step 13 walkthrough on demo.ogevia.com (TEST), reported 2026-10-29
Reported by the Owner in the session (not independently observed by the development session). **Performed by: Stella Okereke.** Result reported: **PASS, no blockers.**
- TEST banner visible ("TEST - SYNTHETIC DATA ONLY").
- Dashboard, Clients, Staff, Scheduling, Operations and Settings accessible; Agency Settings pages load; Continuity page loads and the continuity pack is available.
- Roles & Permissions and Staff Types load.
- One synthetic staff member created and saved; one report generated.

What this is and is not: a smoke walkthrough of the navigation and the Staff area, recorded as the Step 13 result. It is **not** the Phase D sign-off (still UNSIGNED, the Owner's to give), and it does not cover V4, V5 or V6, the invitation flow (M-1, L-1, L-2, L-3) in a browser, or the JWT authorizer with a real token. "Add one synthetic staff member" does not by itself exercise the 0087 invitation-acceptance path.

## 4b. Step 14 (ComplianceSweep still runs and still does nothing), reported 2026-10-29
Read-only, pasted by the Owner from CloudShell. Function `Ogevia-prod-ServiceVerificationApi-Handler886CB40B-2ZkW4XDDj5vu`, log group `Ogevia-prod-ServiceVerificationApi-HandlerLogGroup881018CA-MkXDAX4WQkVB` (read from `LoggingConfig.LogGroup`), `LastModified` 2026-10-29T08:00:38Z (the Step 10 deployment).
- Four sweep log lines in the last hour (15:23 to 16:23Z): 15:38:30, 15:53:30, 16:08:30 and 16:23:31, every 15 minutes, each `{"task":"compliance-sweep","organizations":0,"evaluated":0,"holdsOpened":0,"holdsReleased":0,"failedOrganizations":0}`. They ran after the deployment, so they are from the `fb491a5` Handler.
- The EventBridge listing shows two rules, both `ENABLED`: `Ogevia-prod-ServiceVerifica-ComplianceSweep51D1109D-oAlBozy5Hiaa` (this TEST slice) and `Ogevia-prd-ServiceVerificat-ComplianceSweep51D1109D-j1dUZnc9UTOj` (production). The listing is account-wide and read-only; only the TEST function's log group was read, and nothing on production was touched or checked.
- Result: matches the expected values. Still not verified by this: that the sweep does nothing once an agency has enforcement activated (it evaluates 0 organizations today).

## 5. Rollback inputs and clean-up (for the Owner)
Kept until acceptance: `~/ogevia-before/` on CloudShell (previous Lambda code, web files, templates, route list, CORS), the run folders under `~/ogevia-apply-0087-*` and `~/ogevia-ledger-window-test-*`, and the snapshot `ogevia-prod-postgres-pre-0087-202610290719` (taken before the first apply; it bills until deleted; deleting it is the Owner's decision). Database rollback if ever needed: `apply-0087-test.sh rollback` (0087 only; 0086 stays).
