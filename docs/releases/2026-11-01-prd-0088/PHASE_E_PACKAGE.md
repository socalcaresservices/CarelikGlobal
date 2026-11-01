# Phase E package: production release of migrations 0086, 0087 and 0088 (DRAFT, NOT SUBMITTED)

**Status: DRAFT written 2026-11-01 15:10 UTC. NOT SUBMITTED, NOT APPROVED. This package does not authorize or perform a deployment.** It is the package the process requires before the owner decides (`docs/TESTING_AND_RELEASE_PROCESS.md` section 8, `docs/release-process/RELEASE_CHECKLIST_TEMPLATE.md` section E). Labels: **VERIFIED** (read or run, with the source named), **INFERRED**, **UNKNOWN**, **ASSESSMENT** (my judgment, not a measurement). Items in square brackets are blanks that the GO or the release night fills in.

## 1. E1 Change summary (plain words; all migrations that are not live yet)
**Migrations (production is at 85 / 0085, VERIFIED 2026-11-01):** 0086 `staff_management`, 0087 `staff_invitation_acceptance`, 0088 `caregiver_readiness_approve_for_work`. Applied in this order, one transaction each, by the repository runner (no `adopt` step: production has none of the staff objects, VERIFIED).
**Routes:** 228 to 250: 14 staff routes (staff types, staff, staff members, roles, role permissions, staff audit, staff-invitation acceptance) and 8 readiness routes (caregiver readiness, approve, CPR/TB extend and list, agency settings read and write, caregiver contact, sign-in link). No route is removed or changed in place.
**Infrastructure:** only the stack `Ogevia-prd-ServiceVerificationApi` (the API code asset and the 22 routes) and the production web files change. No IAM, network, database-instance, Cognito or secret change is expected; the gate refuses any other difference.
| Role | What changes | What does not |
|---|---|---|
| Owner (administrator) | New **Staff** and **Staff Types** pages (add staff, staff types, assign a supported system role, invite); **Roles and Permissions**; the caregiver page becomes one checklist (background check, required training, app sign-in, CPR, TB) with **Approve for work**; extend a CPR or TB due date with a reason; agency CPR/TB due-days (API only, default 30 days); **Send sign-in link** (Cognito invitation) | enforcement stays **OFF**: CPR and TB read "flagged only" |
| Manager | sees the calculated caregiver status (Not ready, Approved, Active, Inactive) and "n of 5 done"; cannot approve, verify or extend (Owner only); cannot open Staff pages | scheduling, visits, reports |
| Scheduler | the Schedule offers Approved or Active caregivers and does not offer a Not ready caregiver (seen on TEST) | hours, reservations, authorization arithmetic |
| Caregiver | nothing new except the sign-in invitation email, if one is sent | the visit flow, signatures, hours |
| Operator | the production scripts of this folder | |
**Data created or changed by the release (VERIFIED by rehearsal on synthetic data and by reading the migrations):** one approval row per ready or active caregiver (`source = legacy_status`, so nobody is deactivated or loses scheduling); **existing onboarding requirements of the categories background_check, document and clearance are retired (`is_active = false`, nothing deleted)**; permission seed rows (`ogevia.permissions`, `ogevia.role_permissions`); seven default staff types (Administrator, Manager, Scheduler, Coordinator, Supervisor, Office Assistant, Caregiver) for each existing agency (new table; VERIFIED in 0086); the migration ledger (+3). **Not touched:** authorizations, reservations, billable or balance objects (0088 contains none, VERIFIED by search), visits, signatures, billing.

## 2. E2 Risk assessment (ASSESSMENT: likelihood and effect are my judgment, labelled; detection and reversal are from the scripts)
| # | What could go wrong | Likelihood | Effect (money / hours / access / data) | How it is detected | How it is reversed |
|---|---|---|---|---|---|
| R1 | A migration fails part-way (for example 0087 after 0086) | low (rehearsed locally and applied on TEST) | none yet: each file is one transaction, the ledger shows how far it got | `migrate` stops; ledger read; `verify-0086.sql` (110) and `verify-0087.sql` (22) | `rollback-db` to 85 (destructive, below) or a forward fix; snapshot as the anchor |
| R2 | The backfill approves the wrong set | low | access: someone shown Approved who should not be; nobody loses scheduling | `migrate` requires legacy approvals equal to the ready-or-active count read before | rollback drops the table; or the Owner deactivates (audited) |
| R3 | **Onboarding requirements are retired for real agencies** | **certain by design if such rows exist**; how many is UNKNOWN until `probe` | data: recruiting and onboarding checklists lose their background-check, document and clearance rows (inactive, not deleted); the rollback restores them (rehearsal: 10 of 10) | `probe` prints active requirements by category before; `final` after | rollback (restores); after real use only a forward fix |
| R4 | Existing rows change unexpectedly | low | data | before and after row counts of every existing table; only the ledger (+3) and permission seed rows may move; on a mismatch the marker is not written and the API stays blocked | owner decision; rollback |
| R5 | The API deploy fails | low | none (CloudFormation rolls the stack back) | `deploy-api` output, `post-api` (stack, Lambda environment unchanged, routes 228 to 250 with none removed, 401 without a token) | `rollback-api` (code only) |
| R6 | The gate finds a difference other than the release's | **found once, handled**: the dry-run `check` found one difference (CORS origins in the API template lagging the live API); the gate now allows exactly that addition. To be confirmed by re-running the gate against the saved live template | none: nothing is deployed until the gate passes | `check`; the first real read is the read-only dry run | correct the allow-list from evidence before the GO |
| R7 | Web and API or database out of step during the window | low | none for users: a database ahead of the API is harmless (new tables unused, tested on TEST); an API ahead of the web only adds unused routes | order is fixed: database, API, web | rollback in the reverse order |
| R8 | Cross-agency isolation fails in production | low (DB tests pass; **not tested live**, accepted for TEST only) | access, the worst kind | none live before the release | forward fix; rollback |
| R9 | Real people receive sign-in emails | only if someone presses Send sign-in link | reputation, support | none automatic | do not send links at launch except as a planned, announced batch |
| R10 | Enforcement is switched on later without Task 8 | not part of this release | hours and pay: caregivers with missing CPR or TB could be refused shifts | the Task 8 read-only report | enforcement is not switched on until the owner decides |
| R11 | The shared database instance: snapshot, the temporary security-group rule and any rollback also touch TEST | certain (design) | none expected; TEST is synthetic | the rule-set hash is proven identical after every window | `--restore-only` |
| R12 | A hard-killed session leaves the temporary rule open | low | access (narrow: one /32 from the admin host) | the script's marker; a second tab with `--restore-only` | `--restore-only` |
| R13 | Production holds real PHI before the BAA and security gate are confirmed | UNKNOWN (data classification unverified) | compliance | the BAA confirmation (AWS Artifact), owner | do not proceed |
| R14 | Drift between the baseline and the release night | low | wrong expectations | `capture` re-compares templates, Lambda code, routes and web files and stops on any difference | investigate before any change |
**Calculation-affecting changes:** none found. 0088 contains no authorization, reservation, billable or balance object (VERIFIED by search). The authorization arithmetic was not re-checked live on TEST (owner decision D36).

## 3. E3 Rollback plan
**Order: web, then API, then database.** Each step has a typed phrase and runs only after a stop condition. Who: the Operator (Stella). The point at which rollback is called: a stop condition in the runbook (a failed or differing check after a change), decided with the owner on the call, preferably before the window ends. Times below are **estimates from the pilot run**, not measurements on production.
| Step | Command | Restores | Cannot undo | Estimate |
|---|---|---|---|---|
| Web | `STELLA_PRD_DEPLOY.sh rollback-web` | the captured 83 production web files (never deletes, never touches `config.json`) | browsers that already loaded the new bundle until CloudFront refreshes | a few minutes |
| API | `STELLA_PRD_DEPLOY.sh rollback-api` | the previous Lambda code (`debd1d43...`, present in the CDK asset bucket, VERIFIED 2026-11-01) | CloudFormation is then out of step with the code (tell the owner; redeploy later) | about a minute |
| Database | `STELLA_PRD_DB.sh rollback-db` | ledger 85 / 0085; the staff and readiness objects removed; functions as 0085 left them; retired onboarding requirements active again | **drops the staff tables and the four readiness tables WITH THEIR ROWS**, including every approval and staff record created after launch | a minute or two |
**Preference after launch:** a forward fix, not a database rollback, once anyone has used the new tables. **Restoring the RDS snapshot** creates a new instance, also affects TEST (shared instance) and is a separate approval.

## 4. E4 Backup confirmation
| Item | Value |
|---|---|
| Production snapshot identifier | [`ogevia-prod-postgres-pre-0088-prd-YYYYMMDDtHHMMz`, printed by `STELLA_PRD_DB.sh snapshot`] |
| Created / status | [time] / [`available`, encrypted, manual, of `ogevia-prod-postgres`; the script refuses otherwise] |
| Automated backups | 7 days, continuous backup running (restorable time 2026-11-01T12:57Z), VERIFIED 2026-11-01 |
| Existing manual snapshots | 22 (VERIFIED 2026-11-01); the 2026-11-01 TEST snapshot `...-pre-0088-20261101t0752z` also holds `ogevia_prd` as of 07:53 UTC but is **not** the pre-production snapshot |
| S3 evidence and signature bucket versioning | UNKNOWN here: the baseline capture printed it but it was not read back; confirm from `~/ogevia-prd-baseline-20261101/log.txt` before the GO |
| Restore | goes to a **new** instance; separate approval; also affects TEST |

## 5. E5 Evidence index
| What | Where |
|---|---|
| The release on the pilot (deployed, verified, accepted for TEST with listed gaps) | `docs/releases/2026-10-30-caregiver-readiness/DEPLOYED_RECORD_0088_TEST.md`, `INTEGRATION_RECORD.md` (sections 14 to 25), `DECISION_RECORD.md` (A1 to A30) |
| Production baseline (control plane) and the production database read | `docs/aws/PRODUCTION_BASELINE_2026-11-01.md` (sections 1 to 5) |
| Gates G1 to G3 on this tree | `INTEGRATION_RECORD.md` section 25 |
| Unfinished UAT, accepted for TEST (D38) | `UAT_OUTSTANDING_CHECKLIST.md` |
| The production scripts, their design and their tests | this folder: `PRD_DEPLOYMENT_DESIGN.md` sections 10 and 11, `rehearse_local.sh`, `mock_aws_test.sh`, `mock_aws_test_deploy.sh`, `test_gate_prd0088.py` |
| The runbook and the checklist | `PRD_RUNBOOK.md`, `CHECKLIST.md` |

## 6. E6 Gates (process section 1.1)
| Gate | Status | Evidence |
|---|---|---|
| G1 lint | PASS on this tree | `INTEGRATION_RECORD.md` section 25 |
| G2 typecheck | PASS | same |
| G3 tests (unit, database, API; zero skipped) | PASS: `test:all` all suites ran, none skipped, all passed (1124 database tests in 101 files, 158 API database tests, 1266 web tests, ...) | same; the five tests that failed on the day were fixed and verified on other calendar days |
| G4 local harness | done for the same code on the pilot release: the automated B9 regression run was accepted by the Operator 2026-10-31 (the pilot record says "no separate signed Phase B form") | `docs/releases/2026-10-30-caregiver-readiness/CHECKLIST.md` section B |
| G5 pilot validation | Phase C complete on TEST 2026-11-01 (S0 to S11); UAT closed with **gaps accepted by the owner for TEST only** (D38): live cross-agency isolation, authorization arithmetic on three clients, live role gating, Task 8, the scheduler steps | `DEPLOYED_RECORD_0088_TEST.md` |
| G6 owner GO | **not given** | section 10 below |
**Which commit:** the pilot ran at `464dea64cb939c49fbca624b652f34b2863db2f2`. Since then only four **test** files and documents changed (VERIFIED by `git diff --name-only 464dea64 HEAD -- . ':!docs'`: three database tests and one web test); the Lambda code assets of the production and the pilot assemblies are identical (`9e5a510e...`, `7c5f8eb6...`). **Decision for the owner:** deploy the later commit (G3 green on it, application bytes identical to the pilot's) or `464dea64` itself (the pilot's exact SHA, but G3 does not pass on it because of the five test defects). **Recommendation: the later commit, named in the GO.**

## 7. E7 Window and Operator
Operator: Stella Okereke (only). Owner on the call for the whole window and the post-deploy checks. Window: [start UTC] to [end UTC]; no step may begin after the end. Estimated length: 2 to 3 hours (ASSESSMENT from the pilot). A second CloudShell tab stays open and idle for `--restore-only`.

## 8. E8 Drift check against the last record
Baseline: `docs/aws/PRODUCTION_BASELINE_2026-11-01.md`: **no drift since 2026-10-26** (7 templates, API Lambda, 83 web files, 228 routes; VERIFIED 2026-11-01). The check runs again on release night inside `capture` and stops on any difference. Explained change (found by the read-only dry run, 2026-11-01, VERIFIED): the API template's `AllowOrigins` gains `https://app.ogevia.com` and `https://admin.ogevia.com` (live API already allows both; the template lagged; `app.ogevia.com` is listed twice, API Gateway acceptance UNKNOWN, rollback-safe). The gate accepts only that addition (`--allow-cors-add`). **Open:** owner acceptance of this difference and of the duplicate; confirmation by a local re-run of the gate against the saved live template.

## 9. Conditions before a GO (owner)
1. The commit (section 6) and the window.
2. **Launch scope:** which agency and caregivers; sign-in links at launch (recommended: none); a short note for staff about the new screens.
3. **The BAA confirmation** in AWS Artifact and the security and compliance gate; and the production data class (real or synthetic): UNKNOWN until you say.
4. **The TEST gaps** (section 6, G5): run them on TEST before production, or accept them again for production in writing. Recommended before production: cross-agency isolation (X1 to X3) and the authorization arithmetic (A1 to A4).
5. **Task 8 on production** before enforcement is ever switched on (needs a read-only database approval).
6. **The read-only dry run** (`PRD_RUNBOOK.md` part 2): approval for `probe`, `capture` and `check` on production, so the gate allow-list is corrected from real output before the GO.
7. Read the `probe` output for risk R3: how many onboarding requirements will be retired.

## 10. Decision record (UNSIGNED)
| Field | Value |
|---|---|
| Decision | ☐ GO ☐ NO-GO |
| Owner (name), date and time | |
| Commit SHA the decision covers (40 characters) | |
| Approval reference | |
| Window (UTC) | |
| Operator | Stella Okereke |
| Conditions or exceptions (written) | |
**What a GO would authorize, step by step (each a YELLOW action in `CLAUDE.md` section 13), for that SHA and window only:**
1. creating one manual RDS snapshot (a small storage cost until deleted);
2. for `probe`, `migrate` and `final`: the temporary inbound rule on the RDS security group from the admin host's own /32 (removed and proven identical each time) and reading the RDS master secret into memory;
3. applying migrations 0086, 0087 and 0088 to `ogevia_prd`;
4. one CDK deploy of `Ogevia-prd-ServiceVerificationApi`;
5. publishing the production web files and invalidating CloudFront;
6. the read-only smoke checks;
7. conditionally, each rollback step, only after a stop condition and with its own typed phrase (the database rollback also needs the owner's written word at the time).
A GO for any of these does not extend to a new commit, a missed window, the production Cognito pool, enforcement, or sending any sign-in link.
