# Pilot operator runbook: Wave 1 (migrations 0047 to 0052) on the AWS pilot/test environment

**Status: PREPARED, NOT EXECUTED. Nothing in this file has been run against AWS. No deployment is authorized.** Read-only steps (marked **R**) need only the Operator's access. Steps marked **W** create synthetic records, and steps marked **DEPLOY** change the environment: both need the owner's explicit written authorization first. Process: `docs/TESTING_AND_RELEASE_PROCESS.md`. Checklist to fill: `docs/releases/2026-10-13-wave1/CHECKLIST.md`. Older plan for 0047 to 0049: `docs/releases/2026-10-13-0047-0048-0049/DEPLOYMENT_PLAN.md` (still the source for the rollback procedure in its section 10; its ledger numbers are superseded by section 3 below).

**Target:** the pilot/test stacks `Ogevia-prod-*`, database `ogevia_sv_test`, banner "TEST — synthetic data only". **Never** `Ogevia-prd-*` or `ogevia_prd` (production). Pilot app `https://d2xumch5w0izfg.cloudfront.net`, pilot API `https://s0epy5rgzb.execute-api.us-west-2.amazonaws.com` (from `docs/aws/URL_REGISTRY_AND_LAUNCH_CHECKLIST.md`, 2026-10-10; not re-checked live).

**Who:** the Operator (admin AWS credentials in CloudShell, `session-manager-plugin`), the owner (decisions), testers for Phase D. Claude Code cannot run any step in this file (no AWS CLI, no credentials, no tunnel).

## STOP rules (apply to every step)
Stop, change nothing, and report if: the account is not `300094796789`/`us-west-2`; the target is not the pilot; the ledger is not exactly what a step expects; any `db:verify` line is FAIL; a checksum-drift message appears; `cdk diff` shows anything outside section 5; a check below fails; anything touches real client data. A failed gate means: fix forward with a new commit and restart at Phase A. Never edit data by hand, never delete a snapshot, database, table or user.

## 0. Before anything (owner, once)
| # | Needed | Why |
|---|---|---|
| O1 | The release **SHA** (full 40 characters). Code verified at `63de403`; `main` now adds documentation and `smoke.py` changes only (see the Pilot Readiness Report, section 2). | The deployment, the tests and the decision must name one SHA. |
| O2 | A written pilot authorization: SHA, "pilot/test only", Operator, window, and an `OGEVIA_DEPLOY_APPROVAL` reference. | Process section 5 (Phase C). The earlier reference was given for different commits. |
| O3 | Decision on the deployment tooling (Blocker B-03): no reviewed pilot script exists for 0047 to 0052. | Section 5 below is a manual procedure that mirrors `release-0036-*`; a script is safer. |

## 1. Read-only preflight (R) — nothing is changed
Run in CloudShell with the admin profile. Record every output in `docs/releases/2026-10-13-wave1/evidence/` (no secrets, no tokens).
```bash
aws sts get-caller-identity --query Account --output text                       # expect 300094796789
aws configure get region || echo $AWS_REGION                                      # expect us-west-2
aws cloudformation describe-stacks --query "Stacks[?starts_with(StackName,'Ogevia-prod-')].[StackName,StackStatus,LastUpdatedTime]" --output table
#   expect every Ogevia-prod-* stack CREATE_COMPLETE or UPDATE_COMPLETE. Record the time of the last update.
aws lambda get-function-configuration --function-name <pilot handler name from the stack> \
  --query '[FunctionName,LastModified,CodeSha256,Environment.Variables.DB_NAME,Environment.Variables.OGEVIA_ENV]' --output text
#   expect DB_NAME=ogevia_sv_test and OGEVIA_ENV not prd. Record CodeSha256 and LastModified.
aws apigatewayv2 get-routes --api-id s0epy5rgzb --query 'length(Items)'          # record. A pilot without Wave 1 has fewer routes than section 5 lists.
```
**Which commit is deployed.** Artifacts carry no build stamp (Blocker B-14), so the deployed SHA is established from: the deploy log of the last release (`$RUN` evidence folder of the last `pilot-*`/`release-*` script, which prints the SHA), the migration ledger below, and the route and function fingerprint below. If none names a SHA, write "SHA NOT VERIFIED" and continue with the ledger.

**Migration ledger (R)** — open the private tunnel exactly as in `docs/releases/caregiver-readiness/RELEASE_HANDOFF.md` section 4, but for the **pilot** database `ogevia_sv_test` (the pilot values, not `print-prd-config.ts`), then:
```bash
psql "$OGEVIA_DATABASE_URL" -Atc "select count(*), max(version) from ogevia_meta.schema_migrations"
psql "$OGEVIA_DATABASE_URL" -Atc "select version from ogevia_meta.schema_migrations order by version desc limit 8"
```
| Result | Meaning | Action |
|---|---|---|
| `46|0046` | Expected starting point for this release | Continue. |
| `49|0049` or `48|0048` or `47|0047` | A partial release is live | Record; the plan below applies only the missing migrations. Owner confirms. |
| `52|0052` | Wave 1 database is already live | Skip section 5.1; go to section 6 checks. |
| anything lower than 46 | 0039 to 0046 (caregiver readiness) is **not** live; deploying 0047 or later would deploy it too | **STOP.** That release has its own approval (`docs/releases/caregiver-readiness/RELEASE_HANDOFF.md`). |
| anything else | unknown state | **STOP.** |

**Function fingerprint (R)** — which release is live, independent of the ledger:
```bash
psql "$OGEVIA_DATABASE_URL" -Atc "select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='ogevia_api' and p.proname in ('get_visit_outcome','pickup_open_shift','list_open_shifts','list_visit_rules','set_visit_rule','list_accounts')  order by 1"
#   0050 adds get_visit_outcome, list_visit_rules, set_visit_rule; 0051 adds list_open_shifts, pickup_open_shift; 0048 adds list_accounts.
```
**Seed 03 (R)** — decides whether the smoke's care workflow finds a candidate (Blocker B-09). Do **not** re-apply the seed.
```bash
psql "$OGEVIA_DATABASE_URL" -Atc "select caregiver_code, status, (select count(*) from ogevia.caregiver_availability_windows w where w.caregiver_record_id = c.id) as windows from ogevia.caregiver_records c where caregiver_code = 'TEST-CG-02'"
#   expect: TEST-CG-02|active|7. No row, or windows other than 7: seed 03 is not (fully) applied. Report it; the owner decides.
```
**Synthetic data only (R):**
```bash
psql "$OGEVIA_DATABASE_URL" -Atc "select slug, display_name from ogevia.organizations order by 1"            # expect the synthetic agencies only (ogevia-test-slice, scs-pilot-synthetic)
psql "$OGEVIA_DATABASE_URL" -Atc "select count(*) from ogevia.clients where client_code !~ '^(TEST-|P-|ZZ-|REG)' "   # expect 0; any other client code: stop and ask the owner before continuing (inactive clients left by earlier regression runs are synthetic)
```
**Banner (R, browser):** open the pilot app; the "TEST — synthetic data only" banner must show on every page. Missing banner: STOP.

## 2. Backup and rollback readiness (R, then one W-class safe action)
Before any DEPLOY step:
1. Previous **web bundle** is kept in S3 history (record its version id) and the previous **API template/code** is identifiable (stack template saved with `aws cloudformation get-template`). 
2. A manual **RDS snapshot** of the pilot instance (`ogevia-prod-postgres`): record the identifier and wait for `available`. (`deploy-production.sh snapshot` is for production only; use `aws rds create-db-snapshot` for the pilot with an owner-approved name.) This is the only rollback anchor for data; restore goes to a **new** instance (separate approval).
3. The rollback procedure of `docs/releases/2026-10-13-0047-0048-0049/DEPLOYMENT_PLAN.md` section 10 (0049, 0048, 0047) extends to the Wave 1 down scripts: **0052, 0051, 0050 first**. Down 0050 **refuses** once any rule version, rule evaluation, unscheduled reason or attestation version exists; after real use the way back is forward-fix or snapshot restore, not the down script. Say so to the owner before deploying.
4. Accounts disabled while 0048 is live stay disabled after a rollback: re-enable them first.

## 3. Expected state after a successful deployment
Ledger `52|0052`; `db:verify` all PASS (`latest_migration_is_0052`); the API stack has the Wave 1 routes (below); web bundle published last. Between the **database** step and the **API** step the old API still works for visits on a scheduled shift, but a start with **no** scheduled shift is refused (reason required) and creating an availability override fails (0047). Do the three steps in one sitting, database first.

## 4. Deployment — DEPLOY (separate approval; only if the preflight shows it is needed)
Blocked until O1 to O3. Mirrors the 0047 to 0049 plan, extended to 0052:
```bash
git fetch origin && git checkout <SHA>
corepack pnpm@9.15.4 install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm build
OGEVIA_TEST_DATABASE_URL=<local throwaway database> pnpm test:all          # 0 skipped (local database, not the pilot)
# database (tunnel to the PILOT database; ledger must read 46|0046 immediately before)
OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner corepack pnpm@9.15.4 --filter @carelik/infra-aws db:migrate     # expect: applied 6, already applied 46
corepack pnpm@9.15.4 --filter @carelik/infra-aws db:verify                                                    # every line PASS
psql "$OGEVIA_DATABASE_URL" -Atc "select count(*), max(version) from ogevia_meta.schema_migrations"          # 52|0052
```
Then the API/identity/IAM deployment for the pilot stacks (`cdk diff -c env=prod`, read the diff, then deploy), then the web build for the pilot published last (keep `config.json`). **Expected `cdk diff` for `Ogevia-prod-ServiceVerificationApi` only:** the routes `GET /v1/accounts`, `POST /v1/accounts/{userId}/disable`, `POST /v1/accounts/{userId}/enable`, `GET /v1/visit-rules`, `POST /v1/visit-rules`, `GET /v1/open-shifts`, `POST /v1/shifts/{shiftId}/pickup` (all JWT), the IAM statement `SwitchSignInsOnOff` (`AdminDisableUser`, `AdminEnableUser` on the one pool), new code for the API and identity Lambdas, description changes. **STOP** on anything else (another stack, a security group, a secret, a deletion or replacement). Reference: `docs/releases/account-status/CLOUDFORMATION_TEMPLATE_DIFF.txt`.

## 5. Authentication and API boundary smoke (R) — SMK-06
No sign-in is used; nothing is created. Run from any machine that can reach the pilot API (the pilot only, never the production API without permission):
```bash
API=https://s0epy5rgzb.execute-api.us-west-2.amazonaws.com
curl -s -o /dev/null -w "%{http_code}\n" "$API/v1/me"                                           # expect 401 (anonymous)
curl -s -o /dev/null -w "%{http_code}\n" -H "authorization: Bearer forged.token.value" "$API/v1/me"   # expect 401 (forged token)
curl -s -o /dev/null -w "%{http_code}\n" "$API/v1/visit-rules?organizationId=00000000-0000-4000-8000-000000000000"   # expect 401 (new Wave 1 route is behind the authorizer)
curl -s -o /dev/null -w "%{http_code}\n" "$API/v1/open-shifts?organizationId=00000000-0000-4000-8000-000000000000"   # expect 401
```
All four 401. Any 200, 403 from a route that should not be reached anonymously, 404 for the two Wave 1 routes (route missing: the API deploy did not include Wave 1), or 5xx: **STOP**. The same two HTTPS checks run inside `pilot_regression.py --api-url` (case SMK-06); with the URL given that case no longer reports "could not run".

## 6. Automated suites (W — they create synthetic records on the pilot; need authorization O2)
```bash
python3 infra/aws/slice/smoke.py --outputs <pilot outputs.json> --caregiver-sub <TEST_CG> --manager-sub <TEST_MG>
python3 infra/aws/slice/pilot_smoke.py --client-id <pilot app client id> --manager-sub <PILOT_MG> --caregiver-a-sub <PILOT_CA> --caregiver-b-sub <PILOT_CB> --test-manager-sub <TEST_MG>
python3 infra/aws/slice/pilot_regression.py --mode aws --i-am-targeting-the-pilot --commit <SHA> --api-url https://s0epy5rgzb.execute-api.us-west-2.amazonaws.com <arguments as in docs/release-process/PILOT_REGRESSION_RUNNER.md>   # expect exit 0
```
Expected: `smoke.py` — all PASS including the new `workflow` unscheduled checks, the `scheduled` clean-signed workflow and the `care` checks (needs seed 03). `smoke.py` creates one 15-minute shift and about four visits per run for TEST-CG-01. The AWS-mode infrastructure checks of `smoke.py` have **not been run since the route count changed from 38 to 169**; if one of them fails for a reason that is not a defect (a renamed resource), report it, do not edit the pilot. `pilot_smoke.py` is read-only (11 checks). `pilot_regression.py` leaves one inactive synthetic client per run. Keep every report; link them in checklist rows C5 and C7.

## 7. By-hand checks (W; synthetic data only; testers sign in with the synthetic identities)
| Check | Steps | Expected |
|---|---|---|
| Scheduling | Scheduler creates a one-time shift for a synthetic client inside the authorization | Reserved +minutes; remaining falls by the shift length; a shift larger than the remaining is refused with the hours stated |
| Normal signed visit (SMK-05, VIS-01) | Caregiver (phone): start on that shift, end after a few minutes, client draws a signature, tick the attestation | Final screen: signed/Billing Ready, no review reason; Office: billing review "ready"; reservation released and the worked minutes used once |
| Unscheduled visit review (VIS-23/24) | Caregiver: start for a client with no shift, enter a reason, finish, sign | Final screen says the visit needs the office's review and names why; Office: Visit review shows reason "unscheduled" and the typed reason; billing approval is refused until a review decision exists |
| Verbal / declined (VIS-14 to 16) | Confirm with "Verbal only" (name required) and with "Client declined" | Both go to review with 0 confirmed minutes; no signature is stored |
| Open-shift pickup (SCH-18 to 21b) | A second caregiver picks up an open shift; the caregiver who called out tries to take theirs back | One winner; the called-out caregiver is refused; the schedule shows the new caregiver |
| Visit rule (VIS-50 to 53) | Administrator: Settings → Visit rules; view the default (15 minutes, labeled not verified); a Manager attempts to change it | Administrator can save a new version with a reason; Manager is refused |
| Accounts / override (USR-04/05/06, SCH-15) | As in `DEPLOYMENT_PLAN.md` stage 3 step 9 | Two audit events per disable/enable; an override covers one shift |
| Authorization balances (AUT-01) | Recompute by hand for one low-use, one near-limit, one amended client; compare with the client page and the monthly summary | Match to the minute: authorized − used − reserved = remaining, no minute in two buckets |
| Permissions and tenants | Caregiver opens every office URL; a Manager of the other synthetic agency lists clients/visits | Caregiver sees only assigned clients (codes) and own visits; the other agency sees nothing |
| Every role, every menu item | Owner, Manager, Scheduler, Caregiver each open each menu entry | No error screen; no horizontal scroll at 390 px on the caregiver screens |

## 8. Logs and evidence (R)
Search the pilot Lambda log group for the run window: **no** 5xx, **no** `function ... does not exist`, `column ... does not exist`, `invalid input value for enum`, **no** signature bytes, visit/organization ids, reasons or tokens (`smoke.py` already checks the last two). Record counts of 4xx by route. Save, under `docs/releases/2026-10-13-wave1/evidence/`: preflight outputs, ledger before/after, `db:verify`, `cdk diff`, `smoke.py` and `pilot_smoke.py` logs, the regression report (`.md` and `.json`), screenshots (desktop 1280 and caregiver 390). Never include tokens, passwords, secret values or real data.

## 9. Failure and stop criteria
Any FAIL in sections 5 to 8 stops the pilot. Classify it (Blocker, Major, Minor) in the checklist's defect log. A Blocker or an unexplained Major means: do not continue to Phase D; fix forward with a new commit and restart at Phase A. A rollback is called when production-like symptoms appear on the pilot that cannot be fixed forward within the window (the owner decides). Roll back newest first: web, then API, then database (section 2 point 3).

## 10. After Phase C
Phase D (owner, scheduler, caregiver on a real phone, authorization by hand) uses the scripts in `docs/releases/2026-10-13-0047-0048-0049/DEPLOYMENT_PLAN.md` stage 4, extended with the Wave 1 rows of section 7. Production is a separate decision (Phase E) and a separate runbook execution against `Ogevia-prd-*`; nothing in this file authorizes it.
