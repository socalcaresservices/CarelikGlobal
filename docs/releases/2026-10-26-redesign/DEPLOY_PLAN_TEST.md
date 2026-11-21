# TEST deployment plan: release 2026-10-26-redesign

**Status: PROPOSED.** Nothing here has been run against AWS. This container has no AWS access (`TESTING_AND_RELEASE_PROCESS.md` section 2); the Operator runs every command that touches AWS, in CloudShell. Words used exactly: *implemented*, *tested (where)*, *deployed (where)*, *accepted (by whom)*. The owner's approval recorded for this plan: **"Approved for TEST"** (2026-10-26, in the session; it is an approval of the TEST target, not of any Production step, and it does not yet name the window, the Operator or the approval reference: section 2, D4).

## 1. Identity and pins
| Item | Value |
|---|---|
| Repository | `socalcaresservices/CarelikGlobal` |
| Review branch | `claude/redesign-review-nav-ui` |
| **Code commit to deploy** | `7870a04c43545bacc378ad93ffc6a09d63345b5a` (full SHA). Commits after it on the branch are documentation only; deploy from this SHA exactly, never from the branch tip. A GO covers this SHA and its window only. |
| Lineage | `main` 466f8ac → `claude/staff-management-nav-ui` 445a68c, 96ba518 → this branch 25b6b32, 7870a04 |
| Target | **TEST only**: stacks `Ogevia-prod-*`, database `ogevia_sv_test`, Cognito pool `us-west-2_849AYz5J7`, API `s0epy5rgzb`, web `d2xumch5w0izfg.cloudfront.net`, alias `demo.ogevia.com`. Source: `docs/releases/2026-10-19-test-rehearsal/DEPLOYED_RECORD_e80b770_TEST.md` (a record, not a live check). **Demo is the same stack: deploying to TEST changes what demo users see.** |
| Never touched | `Ogevia-prd-*`, database `ogevia_prd`, pool `FHJoX71ca`, API `zk527zk4ua`, Netlify, Supabase, DNS, Cognito users, `config.json`, RDS security-group rules other than the one temporary rule per database window |
| Last recorded TEST code | `e80b770` (2026-10-19), ledger **85 / 0085**. What TEST runs today: **UNKNOWN** (not observed in this task; Step 5 establishes it). 72 commits lie between `e80b770` and this SHA and all of them ship: 50 web files changed, API source +178 lines, infra +382 lines, **no change to migrations 0001-0085** (`git diff e80b770 HEAD -- infra/aws/db/migrations infra/aws/db/rollback infra/aws/db/verification` is empty) |
| Deployment status | This branch: not deployed. Migration 0086: staged in `infra/aws/db/pending`, in no release package. The 13 staff routes exist only where `features.staffManagement` is true (TEST yes, `prd` no). |

## 2. Decisions the owner must make before the window
| # | Decision | Recommendation |
|---|---|---|
| D1 | **DECIDED by the owner, 2026-10-26: option (b)** ("build the operator package for D1 option b"). **How 0086 reaches the TEST database.** The migration runner refuses a database that has a migration "not in the repository", and the production release package is pinned to exactly 0001-0085 (count and hash). (a) *Promote 0086* into `migrations/`: re-pin the production release package, verification files, operator tarball and tests; the Production release then also carries 0086 (dormant there: routes are off). (b) *TEST-only apply from the staged file*, in one transaction as `ogevia_owner`, **no ledger row** (TEST ledger stays 85 / 0085), verified by a read-only SQL set; Production pins untouched. | **(b)** for this window: it changes the least and leaves the Production release as approved. Promotion (a) stays a separate, later, owner-approved release step followed by a second TEST run (`db/pending/README.md`). Consequence of (b): TEST schema is one migration ahead of its ledger until promotion; promoting later needs the down script first or an adoption step. |
| D2 | **Hostnames already live?** `db67c95` says the aliases, certificate, Cognito callbacks and CORS origins for `app/admin/demo.ogevia.com` were applied by hand on 2026-10-23 and that the code now preserves them. Offline synthesis vs `e80b770` shows them as additions; against live they should be **no difference**. | Confirm at Step 8. If the live `cdk diff` shows any CloudFront alias, certificate or Cognito callback change, that is a **STOP** and a separate approval. |
| D3 | **Shared resources.** TEST and Production share the RDS instance (separate databases), the VPC and `NetworkEgress`/endpoint policy. This plan touches only `ogevia_sv_test`, the TEST API stack and the TEST web files; NetworkEgress is **not** deployed. | Accept as stated. |
| D4 | Window, Operator, and the approval reference (pattern `owner-go-test-YYYYMMDD-NN`). | Owner supplies; recorded in `CHECKLIST.md` section C. |
| D5 | **Demo users** see the new menu and Staff pages the moment the web files change. UAT invitations create real Cognito users and send real email in the TEST pool. | Use inboxes the owner controls (as `deploy-test-slice.sh` does); created users stay (never deleted by hand). Warn anyone using Demo. |

## 3. What the deployment changes, by layer
| Layer | Change | Evidence |
|---|---|---|
| Database | Migration 0086: 2 tables with RLS, 6 internal and 15 API functions, 1 trigger, 2 permissions (`staff.read`, `staff.manage`, Owner only), `note_my_sign_in` replaced; default staff types seeded for existing agencies. No role, extension, cluster or destructive statement. | `infra/aws/db/pending/migrations/0086_staff_management.sql` sha256 `8eb7b4a353300ba78156bd58a0df6cbc9857b677cec0e8ec51233fcda5a16a4f`; down script `d2773fdfdf502bb2b337b6e8fb888b72f9b9da660bc944f60a7ff60bec8d2942`; static check for destructive keywords: none |
| API | Handler code (+178 lines: 13 routes, auth-separation config) and **13 routes**: `GET/POST /v1/staff-types`, `POST /v1/staff-types/{id}/rename|active`, `GET/POST /v1/staff`, `POST /v1/staff/{id}`, `POST /v1/staff-members/{id}/profile`, `POST /v1/staff/{id}/invitation[/resend]`, `POST /v1/staff-roles/{id}`, `GET /v1/role-permissions`, `GET /v1/staff-audit` | `staff-routes-switch.test.ts` (13, JWT authorizer); offline synthesis |
| Web | New bundle: menu, Help, Reports, Staff, Staff Types, Roles & Permissions, page titles, plus everything since `e80b770` | `pnpm build` |
| Infrastructure (expected `cdk diff` vs TEST as of `e80b770` + the 2026-10-23 hand changes) | `Ogevia-prod-ServiceVerificationApi`: **+13 `AWS::ApiGatewayV2::Route`, Handler `Code.S3Key` changed**, nothing else (+ the `demo.ogevia.com` CORS origin if not already live). `Ogevia-prod-WebHosting`: **no difference** (if D2 holds). `EvidenceStorage`, `Observability`, `NetworkEgress`: no difference. | Offline `cdk` synthesis of both commits, compared resource by resource (this task) |

## 4. The gate for Step 8 (allow-list, nothing else passes)
The reviewed gate is the pattern of `docs/releases/2026-10-19-test-rehearsal/scripts/diff_gate.py` with this release's expected set: for `Ogevia-prod-ServiceVerificationApi`: exactly the 13 routes above and the Handler code asset; **no** IAM, security group, secret, KMS, log retention, stage, authorizer, VPC or deletion/replacement change. For `Ogevia-prod-WebHosting`: no resource change. An `ogevia:deployment-status` tag difference is ignored (as before). Anything else: STOP, nothing deployed.

## 5. Work before the window (Phase A items)
The operator package is in `docs/releases/2026-10-26-redesign-operator/` (README, `OPERATOR_PROCEDURE_7870a04.md`, `scripts/`). **Implemented and tested locally (fakes, real synthesized templates, real PostgreSQL); nothing has been run against AWS.** The procedure's Steps 0-16 are the step table of section 6 below, made executable.
| # | Item | Status |
|---|---|---|
| P1 | Operator tarball builder with pins (code commit, migration-set hash 0001-0085 unchanged, 0086 up and down sha256, lockfile) and the no-git tarball pin check | **BUILT, LOCAL VERIFIED**: `build-operator-tarball.sh`, `tarball-pin-check.sh`, `pkg-lib.sh`; a real tarball was built from `7870a04` and its content pins verified on extraction; 0086 may only travel in `db/pending` (a build with it in `migrations/` is refused) |
| P2 | Diff gate with the section 4 allow-list and a self-test | **BUILT, LOCAL VERIFIED**: `diff_gate.py` (+ `assembly_check.py`, `deploy-guard.sh`): API stack = the 13 routes + the Handler code asset only (DELTA); the other four stacks no difference (NONE); about 25 negative cases each stop; the "hostnames not live" case (D2 = no) stops |
| P3 | `apply-0086-test.sh` + `verify-0086.sql` | **BUILT, LOCAL VERIFIED**: control flow against fakes; the SQL, the exact `psql` command line and the 110 checks against a real PostgreSQL with the real 0001-0085 migrations (15 sabotage cases, rollback, round trip). A defect found by these tests (a missing `say` helper in the first draft) is fixed |
| P4 | Route smoke: the 13 routes answer 401 without a token and with a forged token, plus the CORS preflight | **BUILT, LOCAL VERIFIED** (`route-smoke.sh`, fake `curl`); it refuses the production API id. The real authorizer is **NOT VERIFIED** until Step 12 |
| P5 | Mock-tested rehearsal of P1-P4 | **DONE** (`infra/aws/test/operator-0086-*.test.ts`, `infra/aws/db/test/operator-0086-sql.db.test.ts`; counts in `CHECKLIST.md` section A) |
| P6 | Phase A gates on the final SHA | in `CHECKLIST.md` section A |
| P7 | Catalog rows for the new IDs | proposed in `FEATURE_TEST_PLAN.md` |
Not verifiable here, by design: the real RDS instance, tunnel and secret; `cdk deploy`; the CloudFront publish; the Handler asset key on CloudShell (Step 4 decides); the live hostnames (D2; Step 8 decides); the real authorizer; people at a browser.

## 6. Window procedure (after the package is reviewed and D2-D5 answered)
`[Y]` = YELLOW, changes AWS or TEST data; needs the approval reference. Everything not marked is read-only. Stop conditions are in section 8; the procedure follows the structure that deployed `e80b770` (`OPERATOR_PROCEDURE_e80b770.md`).

| Step | Action | Pass condition |
|---|---|---|
| 0 | CloudShell session: variables, tools, disk | Region `us-west-2`, account `300094796789`, caller is the named Operator |
| 1 | Verify the uploaded tarball hash; extract to `/tmp` | Hash equals the one the owner was given |
| 2 | `pnpm install --frozen-lockfile` in `/tmp` | OK |
| 3 | Pin check | Code commit = `7870a04…`; migration-set hash = the 0001-0085 pin; 0086 sha256 as in section 3 |
| 4 | Synthesize outside the repository; assembly check | Stack set = the five `Ogevia-prod-*` |
| 5 | **Baseline capture**: Lambda `CodeSha256`, route count, CORS origins, web `index.html` sha256 and bundle list, app client callback URLs, CloudFront aliases, RDS state, endpoint-policy counts; the **previous web files and previous API code are saved** (rollback inputs) | Written to the run folder; compared with the 2026-10-19 record (differences noted, not fixed) |
| 6 `[Y]` | Ledger recheck through the one temporary database rule | **85 rows, latest 0085**, rule removed, security-group rule set unchanged |
| 7 `[Y]` | Snapshot `ogevia-prod-postgres-pre-0086-<UTC>`; verify | `available`, manual, encrypted |
| 8 | **Diff gate** (section 4) on `Ogevia-prod-ServiceVerificationApi` and `Ogevia-prod-WebHosting`; self-test first | Only the allowed difference |
| 9 `[Y]` | **Apply 0086** (D1b): temporary rule; one transaction as `ogevia_owner`; `verify-0086.sql`; rule removed | Verify set: both tables exist with RLS on; 21 functions present with `EXECUTE` for `ogevia_app` only and none for PUBLIC; `staff.read`/`staff.manage` exist and belong to the Owner role only; default staff types exist for every agency; no table privilege for `ogevia_app`; 85-row ledger unchanged; the 85 existing verification files still PASS |
| 10 `[Y]` | `cdk deploy Ogevia-prod-ServiceVerificationApi` only (one stack; no other) | `UPDATE_COMPLETE`; new `CodeSha256`; 13 routes present; CDK asks for approval only for the Handler and routes |
| 11 `[Y]` | Build web with `VITE_APP_ENV=test`, upload, invalidate CloudFront; `config.json` untouched | Served `index.html` sha256 equals local; banner "TEST — synthetic data only"; security headers present |
| 12 | Smoke (read-only): `smoke.py`, `pilot_smoke.py`, P4 (13 routes: 401 unauthenticated, 401 forged token), SMK-01..08 | All PASS |
| 13 | Acceptance on TEST (section 9) | See section 9 |
| 14 | ComplianceSweep still runs (15-minute log entries, zero evaluated) | Unchanged behaviour |
| 15 `[Y]` | Final database read through one temporary rule | 85 rows, latest 0085, 0086 objects present, enforcement unchanged |
| 16 | Record the deployed SHA, hashes and snapshot id in `docs/releases/2026-10-26-redesign/DEPLOYED_RECORD_TEST.md` | Written; status words correct |

Order is fixed: database (additive, nothing uses it yet), then API (needs the database), then web (needs the API). An old web bundle works with the new database and API; a new web bundle on an old API shows errors on the Staff pages, which is why web is last.

## 7. Verification on TEST (Phase C)
Smoke set S (SMK-01..08); regression set R (`pilot_regression.py` exit 0 plus the manual cases); changed workflows NAV, HLP, STF, ROL, RPT-10..12, DSH-13, MIG-86a/c, API-86 (`FEATURE_TEST_PLAN.md`); every role opens every menu item with no error screen and the API log is searched read-only for 5xx and error codes for the window; negative checks (unauthenticated 401, forged token 401, other tenant sees nothing, Caregiver cannot reach Administrator data; Manager and Scheduler refused on `/v1/staff*` and `/v1/role-permissions`). The items the harness cannot prove: staff invitation through Cognito and email, authorizer on the 13 routes, CloudFront bundle and headers, CORS from `demo.ogevia.com`.

## 8. Stop conditions (any one stops the procedure; nothing later is run)
Wrong account, region or caller; banner missing; tarball or pin mismatch; ledger not 85 / 0085; snapshot not `available`; diff gate shows anything outside section 4 (including any alias, certificate, Cognito, IAM, security-group, secret, deletion or replacement); `cdk deploy` asks to change anything outside the one stack; temporary database rule cannot be removed (exit 3: recover from a second session, section 10); any verification FAIL; 5xx after the API step; production resource named in any output.

## 9. UAT scripts (Phase D), on TEST with synthetic data
| Validator | Script (catalog IDs) | Result recorded in |
|---|---|---|
| **Owner** | Sign in; find a client, a caregiver, the schedule, run a report and export it (NAV-01, NAV-02, RPT-10, RPT-11); open Staff, add a staff member with a contact email, edit, filter and search (STF-01..04); read Roles & Permissions and check the counts against Staff (ROL-01, ROL-02); invite one person using an inbox you control and have them sign in (STF-04); disable and enable them; confirm "OWNER VIEW" in the footer; Help on three pages (HLP-01) | `CHECKLIST.md` D |
| **Scheduler** | Menu shows Schedule and Reports but not Billing, Staff Types or Roles & Permissions (NAV-03); Staff and Roles pages refuse (STF-06); schedule, repeat, change a shift (SCH set R); Requests tab | same |
| **Caregiver (phone)** | Menu shows My Schedule and Verify Visit; Availability and My documents as tabs; drawer closes after choosing a page; start, end and confirm a visit (SMK-05); Appearance from the footer; nothing of Administrator data visible (NAV-03, NAV-04, NAV-06, SMK-04) | same |
| **Authorization** | Recalculate three authorizations by hand (low use, near limit, amended); numbers must match the minute. Numbers are unchanged by this release; this confirms it | same |

## 10. Rollback
| Order | Action | Cannot undo | Time |
|---|---|---|---|
| R1 web | Re-publish the files saved in Step 5; invalidate CloudFront | nothing | ~5 min |
| R2 API | Redeploy the previous Handler code and template (captured in Step 5; the 13 routes disappear) | nothing | ~10 min |
| R3 database | `rollback/0086_staff_management.down.sql` in a transaction, only after the snapshot exists; it drops the two tables **with their rows** and restores the previous `note_my_sign_in`; sign-ins, memberships, roles and audit stay | staff profiles and staff types created in the window | ~10 min |
| R4 last resort | Restore the Step 7 snapshot **to a new instance** (separate approval); never over the shared instance | everything since the snapshot, for the restored database only | hours |
| R5 stuck temporary rule (exit 3) | Remove the one `/32` rule by id from a second session (commands printed by the script); the next run is refused until removed | | |
The rollback is called if: Step 9 or 10 fails; any Smoke or Regression FAIL; a 5xx pattern after Step 10; the owner says NO-GO after UAT. Data created by users is corrected through the product, never deleted by hand.

## 11. After TEST
Phase D sign-offs, then the production approval package (`TESTING_AND_RELEASE_PROCESS.md` section 8) only if the owner asks for it. Production needs, in addition: promotion of 0086 (D1a) with the production release re-pinned, a second TEST run of that exact set, the Administrator-role decision (it holds almost no permissions, `REDESIGN_NOTES.md` 5.1), and the hostnames/Auth decisions already tracked in the go-live notes. **Production is not requested by this plan.**
