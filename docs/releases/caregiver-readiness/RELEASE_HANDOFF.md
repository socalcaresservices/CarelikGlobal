# Caregiver-readiness release: deployment handoff (PROPOSED. Nothing here has been run against AWS.)

Release = PR #76 (`539717a6d7b6aea044b4a32f429525026ddb0713`) then PR #77 (its head is the commit that adds this file; the earlier head `e13afced1f8b7763c3706293cfe1c1fc92d494d7` was verified before the recorded-rollback change), migrations 0039-0046.
Verified locally (before the recorded-rollback change; re-run results are in the PR #77 description): fresh migrate to 0046 (46 applied, `db:verify` all PASS); upgrade from main's 0038 (8 applied, 38 already applied, no checksum drift);
database suite 497/497 on PostgreSQL 18.6 and 16.15 (18.6 = conda-forge build, not the RDS engine); CI `postgres` + `validate` green on both heads.
NOT verified: deployed Cognito login/MFA, the live database state, the RDS engine, restore on real data.

## 0. Merge sequence (owner performs; I merged nothing)
1. Merge #76 with **"Create a merge commit"** (never squash/rebase: #77's commits sit on #76's).
2. Change #77's base to `main` (its diff stays 2 commits), merge it.
3. Close #75 as **superseded** (do not delete its branch). Never merge it: its 0039-0041 migrations collide with this chain.
4. Tag/record the resulting `main` commit SHA: that exact SHA is what is deployed.

## 1. Preconditions (stop if any is false)
- Owner approval reference (`OGEVIA_DEPLOY_APPROVAL`, 6-64 chars) and the operator's AWS admin profile; tools: `aws jq psql node pnpm(9.15.4 via corepack) session-manager-plugin`.
- **Live migration ledger is exactly 0001-0038** (query in step 4). If ANY of 0039-0041 are present (e.g. from #75) STOP: same numbers, different contents.
- Admin host `ogevia-db-admin-temp` running and carrying the app security group (the script checks; owner-approved temporary attachment).
- Cognito pool MFA = ON (the `check` step enforces it). A reviewer is available for the post-deploy checks. Low-traffic window (no caregiver mid-shift change expected).

## 2. Checkout
```bash
git fetch origin && git checkout <merge-commit-sha-of-main>
corepack pnpm@9.15.4 install --frozen-lockfile
```

## 3. Read-only check (also runs lint, typecheck, test, build, `cdk synth -c env=prd -c mode=plan`)
```bash
AWS_PROFILE=<admin> bash infra/aws/scripts/deploy-production.sh check
```

## 4. Snapshot (rollback anchor) and ledger check
```bash
OGEVIA_DEPLOY_APPROVAL=<ref> AWS_PROFILE=<admin> bash infra/aws/scripts/deploy-production.sh snapshot
# open the private tunnel exactly as the script does (values come from the repo's validated config; nothing is printed):
CFG=$(cd infra/aws && npx --no-install tsx scripts/print-prd-config.ts)
RDS_HOST=$(jq -r .rdsHost <<<"$CFG"); MASTER_ARN=$(jq -r .rdsMasterSecretArn <<<"$CFG"); DB_NAME=$(jq -r .databaseName <<<"$CFG")
IID=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=ogevia-db-admin-temp" "Name=instance-state-name,Values=running" --query 'Reservations[0].Instances[0].InstanceId' --output text)
aws ssm start-session --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$RDS_HOST,portNumber=5432,localPortNumber=15433" >/dev/null &
sleep 8
MASTER=$(aws secretsmanager get-secret-value --secret-id "$MASTER_ARN" --query SecretString --output text)
export OGEVIA_DATABASE_URL=$(printf 'postgres://%s:%s@127.0.0.1:15433/%s?sslmode=no-verify' \
  "$(jq -rn --arg u "$(jq -r .username <<<"$MASTER")" '$u|@uri')" "$(jq -rn --arg p "$(jq -r .password <<<"$MASTER")" '$p|@uri')" "$DB_NAME"); unset MASTER
psql "$OGEVIA_DATABASE_URL" -Atc "select count(*), max(version) from ogevia_meta.schema_migrations"     # MUST print 38|0038
```

## 5. Migrations 0039 -> 0046 (the runner is checksummed, one transaction per file, refuses drift)
Do NOT use `deploy-production.sh database` or `all` (they create the database, app login, tenant and administrator; this is an existing installation).
```bash
OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner corepack pnpm@9.15.4 --filter @carelik/infra-aws db:migrate   # expect: applied 8, already applied 38
corepack pnpm@9.15.4 --filter @carelik/infra-aws db:verify                                                  # expect: every line PASS, none FAIL
psql "$OGEVIA_DATABASE_URL" -Atc "select count(*), max(version) from ogevia_meta.schema_migrations"          # 46|0046
psql "$OGEVIA_DATABASE_URL" -Atc "select enforcement_active_from from ogevia.organization_readiness_settings" # no rows / null = report-only
```
Stop on any error, any FAIL, a checksum-drift message, or a ledger other than 46|0046. Migration alone changes behaviour only as follows: the old direct availability save returns a clear 422;
candidate lists need approved availability; the readiness gate exists but every agency is REPORT-ONLY, so nothing already booked is stranded.

## 6. API (interactive terminal; CDK asks to confirm IAM changes)
```bash
AWS_PROFILE=<admin> OGEVIA_DEPLOY_APPROVAL=<ref> bash infra/aws/scripts/deploy-production.sh infra
```
Read the `cdk diff` before confirming. Expected: the API stack gains **39 routes** (38 readiness/matching/experience/ZIP routes + `GET /v1/clients/{clientId}` from #75's original commit) and a new Lambda code hash;
no new IAM role, no network/database/hosting change. STOP if the diff shows anything else (other stacks, security groups, secrets, deletions or replacements).
```bash
AWS_PROFILE=<admin> bash infra/aws/scripts/deploy-production.sh smoke     # read-only: Lambda env, anonymous 401, runtime connected to ogevia_prd
```

## 7. Web (last; keeps the previous bundle in S3 history)
```bash
AWS_PROFILE=<admin> OGEVIA_DEPLOY_APPROVAL=<ref> bash infra/aws/scripts/deploy-production.sh web
```

## 8. Stop conditions (at any point)
Ledger not 38 before / 46 after; `db:verify` FAIL; checksum drift; CDK diff beyond step 6; `smoke` fails; `/v1/me` lacks the new permission keys; any cross-tenant read; a caregiver reaching an admin route;
sign-in/MFA/refresh broken for any role; schedule or visit start regresses; the Activate button available before setup is complete.

## 9. Rollback (data-preserving)
- Web/API: redeploy the previous build (keep identifiers saved before step 6/7). The migrated database stays; its records, rules and settings are kept. Do not disable enforcement just to make an old build pass.
- A database schema downgrade is NOT the normal rollback. If unavoidable: freeze writes, snapshot first, then use the recorded rollback (NOT the down scripts by hand):
  `OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner corepack pnpm@9.15.4 --filter @carelik/infra-aws db:rollback-readiness [target]` runs 0046 down to the target (default 0039) as ONE transaction and prints `ATTEMPT ID: <uuid>`;
  it records a unique attempt id and a complete manifest (25 archive slots, including slots with zero records) and tags every archive with the attempt id.
- To bring records back after re-applying (`db:migrate`): `psql -f infra/aws/db/restore/readiness_list_recovery_sets.sql`, then
  `psql -v ON_ERROR_STOP=1 -c "set ogevia.recovery_attempt = '<attempt id>'" -f infra/aws/db/restore/readiness_restore_from_archives.sql`. It restores exactly that attempt, with the same ids, in one transaction; it refuses unknown, older, incomplete, changed, missing or
  mixed-across-attempts archives and destinations that hold other records; it never turns enforcement on. Rehearse on a restored snapshot first; never run against real data without that rehearsal. A full snapshot restore goes to a NEW instance (separate approval; post-snapshot writes need recovery).

## 10. Post-deployment smoke tests (synthetic records only: create clearly named ZZ-TEST client/caregiver; inactivate afterwards with a reason; never use real client data)
**Sign-in (all roles):** sign in through the production URL with MFA, callback, token refresh, sign-out, sign back in; `/v1/me` lists the expected agency and permissions. Disabled membership loses access.
**Admin (organization_owner):** `/v1/me` has `readiness.manage`, `availability.override`, `availability.review`, `documents.requirements.manage`, `matching.manage`; Care Team shows the Readiness card reading "Report-only. Readiness checks are NOT active."
and the setup gaps; the CPR/TB setup form opens; Activate is disabled while setup is incomplete; Review services lists pairs with nothing preselected; an availability request can be approved/declined (decline needs a note); an availability override needs a reason.
**Manager:** has `matching.manage`, `availability.read`, `caregiver_services.read`, `readiness.read`; does NOT have `availability.review/override`, `caregiver_services.approve`, `readiness.manage`; required CPR/TB verification, activation and overrides return 403; ordinary documents review still works.
**Client:** the client page loads with Authorizations (the new `GET /v1/clients/{id}` data), Experience preferences (Preferred/Required with a reason) and Service ZIP; "Distance data is not loaded" is shown; saving a ZIP does not show a distance or a score.
**Caregiver:** own Availability shows approved hours apart from pending; "Request change" says current hours stay until approved; Profile shows Approved services, Documents and **My experience** (reports are notes until confirmed); the form stays disabled if loading fails;
GET `/v1/readiness`, `/v1/caregivers/{id}/zip` and other people's data return 403/404; a caregiver can start a scheduled visit (report-only: not blocked); no DOB/UCI shown.
**Scheduling:** create a shift for the ZZ-TEST caregiver without CPR: allowed in report-only and the panel says "Allowed in report-only mode / does NOT meet the requirement for current, verified CPR and TB"; an overlapping shift is refused;
a care request lists eligible caregivers with "Score incomplete", "Offer manually" appears for a caregiver excluded only for availability; assigning needs approved hours or a recorded override.
**Readiness:** `GET /v1/readiness` shows `enforcementActive:false`, `serviceChecks: Off`, the setup gaps, counts of caregivers without current CPR/TB, no availability, pairs to review, future shifts affected; Service checks can't be turned On before activation.
**Isolation:** another agency's ids return 404/403; expired/wrong-client tokens return 401.

## 11. CPR/TB configuration still required BEFORE activation (owner/agency decisions; nothing is defaulted)
1. Document types: designate which document type is **CPR** and which is **TB** (Documents/Readiness setup; create the types first if absent).
2. Validity rule for each: CPR = the certificate's own expiry date, or issue date + N days; TB = issue date + N days (or the certificate date). **There is no default period**; the agency must choose from its policy (I did not verify what DDS/regional-center rules require).
3. Collect an actual CPR and TB record for every caregiver who will work; an **Administrator (organization_owner)** verifies each. Upload alone, rejected, expired, or missing-expiry = not current. Validity must cover the whole planned interval.
4. Caregivers' availability requested and approved (from 0046 a caregiver with no approved hours cannot START a visit after activation unless an administrator records an override). 
5. Service approvals reviewed if Service checks will be used later (explicit selection and count confirmation; nothing preselected).
6. Resolve the report: caregivers with document gaps, future shifts that would fail, standing assignments needing documents.

## 12. Report-only after deployment? YES. Keep REPORT-ONLY until all of the following are true
- Deployment, smoke tests and the real Cognito login/MFA/role checks all passed, with evidence recorded.
- `GET /v1/readiness`: `setupComplete = true` (CPR and TB type + rule set, with the reasons recorded).
- Every caregiver who will work in the next period has a verified, current CPR and TB covering the period (`withDocumentGaps` is 0, or the remaining caregivers are not scheduled/inactivated).
- Every caregiver who will work has approved availability (`availabilityNotProvided` accounted for), because a new visit start is blocked without it.
- The affected-future-shifts list was reviewed and each case has an owner-decided plan; the activation uses the current `expectedAffectedShifts` count (a stale count is refused).
- A verified RDS snapshot exists; the previous web/API artifacts are saved; the owner (named, with an approval reference) activates deliberately, in a low-traffic window, with an administrator on call for overrides.
- Service checks stay **Off** at first activation (a separate later decision after service approvals are reviewed).
Until activation the software does NOT enforce the owner's requirement for current verified CPR and TB; do not describe the agency as CPR/TB-enforced before then.
After activating: verify with synthetic cases that a missing-CPR/TB assignment and start fail and a correctly verified worker succeeds.

## 13. Known gaps carried into the release
Deployed Cognito/MFA not verified; live database state not verified; RDS engine version not stated in the repo; restore tested only on synthetic local data; distance dataset/weights/radius are not approved (distance stays unavailable, scores incomplete);
series preview does not list mandatory experience per occurrence (the final commitment refuses it); an unscheduled visit has no planned end, so whole-duration validity can't be proven at start; no human review has been recorded on #76 or #77; one unexplained one-off web test failure occurred once under load and passed on rerun.
