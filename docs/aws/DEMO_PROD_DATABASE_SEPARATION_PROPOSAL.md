## Lost temporary workspace after initialization
If the original run directory is unavailable, use cloudshell-recover with the pinned operator commit. It prepares only missing local tools/source, reads the newest private before-release archive from the existing CDK asset bucket, checks the source release and all recovered file checksums, and resumes verification/backup/cutover without schema creation or seeding. The database state on RDS is preserved. This avoids hard-coded temporary path assumptions.

## Post-seed verification stop (2026-11-11)
The owner created the TEST secret and initialized/seeded the fresh isolated database. The login verifier then queried schema-qualified privilege names as the intentional NOINHERIT login before taking the Lambda runtime role, causing permission denied for schema ogevia. No API/web cutover occurred before this stop. The corrected verifier takes SET LOCAL ROLE ogevia_app in a read-only transaction, checks session_user and the same denied-table/allowed-API privileges, then rolls back; it does not broaden access. The existing operator's cloudshell-resume mode takes the original run directory and a pinned operator commit, verifies the existing schema/login/checksums, makes a logical backup, and resumes the reviewed endpoint/API/alarms/web steps without invoking the initializer, migrations or seeds. Application source stays pinned to green 6cbab00. The owner must preserve the existing run/capture until resume finishes.
## Owner-authorized CloudShell execution (2026-11-11)
The owner approved TEST, followed by production after TEST validation, and chose execution through the existing authenticated AWS CloudShell. The `cloudshell-release` mode of the existing OPERATOR_TEST_DEPLOY.sh is a single TEST-only entry point. It restores missing local tools/source, pins application source to green commit 6cbab00b2795d0cfe42bf644adc6a559adda7c76 (CI #446), verifies confirmed synthetic sign-ins, applies only the reviewed separation delta and saves private encrypted rollback archives in the existing CDK asset bucket before cutover. It uses an immediate 60-minute bounded execution window and stops before starting another mutation after that window. The owner executes this mode to start the authorized work. No MFA change or local-machine AWS authentication is needed. Missing/RESET_REQUIRED identities, actual functional drift, unknown bundles, a partial/pre-existing candidate initialization or a failed deployment remain real stops. Do not rerun initialization blindly. This mode does not deploy production or waive its acceptance/production migration requirements. Existing default/legacy modes remain historical below.
# TEST database separation and release package — prepared, not executed

## Live TEST reconciliation supersedes the earlier 107/0107 plan
The owner-supplied live comparison stopped c4b9a2b: it would remove six accepted TEST routes, the NoEcho QR parameter and manual code-asset parameters. Local recovery found the accepted QR/workflow artifact (archive SHA-256 9869214790d911d5599ecbc8ffbdcb7a950a2df62b1944ab368821d5fa2ae7df). All 102 recovered migration checksums match its manifest. This is historical accepted-release evidence, not a fresh live database-ledger query; the old TEST database is never migrated or copied in this cutover.

The six existing route IDs are retained, all JWT-protected. QR key configuration stays a Ref to ClientQrEncryptionKey, NoEcho, deployed with previous parameter values; no existing key is generated, replaced or displayed. RepairCodeBucket/RepairCodeKey declarations and existing Handler metadata tags are preserved. Code moves from manual artifact parameters to the reviewed CDK asset bucket/key. The comparison checks the live Handler's index.js against the accepted artifact SHA-256 51801cff1705dc6e1cc6b8a9ed3a02a28ef25f1ad94e568388a9d435a963a591; it refuses an unknown later server build. A verified copy of the actual live Lambda ZIP is saved privately for rollback.

The five unreleased UX migrations have been renumbered to 0103–0107 because live TEST already uses 0089–0102 for different features. Accepted SQL bytes are unchanged. UX 0104 also limits the recovered caregiver-name API to first name and last initial, preserving final R23 privacy; screens retain the client code. Fresh TEST initialization records **107/0107**, including original accepted filenames/checksums and new unique UX versions, each SQL file plus ledger row in one transaction. Default production migration discovery remains 88; no production migration is promoted by this work. The unrelated withdrawn UX 0089 stays withdrawn; it is not the accepted 0089_manager_record_missing_visit.sql.

The previous green CI proves c4b9a2b only. This reconciled candidate needs its own full green CI and a passing live comparison. Nothing has been deployed. Existing candidate ogevia and old shared ogevia_sv_test remain untouched. The owner already passed candidate metadata/role preflight; do not repeat connection discovery. Only the corrected comparison is next.

## Current stage — 2026-11-11
Application work and the offline preview are ready on PR #108. Separation is implemented as an explicit opt-in on that same branch; final CI evidence is the run on the exact release commit, not an earlier green run. Nothing has been deployed, merged, migrated or changed in AWS by this work. The owner’s “start” authorized preparation, not execution. Production remains out of scope.

The owner completed the candidate connection/catalog inventory through a TLS-verified SSM tunnel: `postgres`, server `10.20.134.83:5432`; databases `ogevia` (owner `ogevia_admin`), `postgres`, `rdsadmin`. No `ogevia_sv_test` exists there. Do not repeat connection discovery or classify the existing `ogevia` database as empty/disposable.

## Verified targets and remaining boundary
| Target | Stack prefix | Instance | Database |
|---|---|---|---|
| Current TEST | Ogevia-prod | ogevia-prod-postgres | ogevia_sv_test |
| Production | Ogevia-prd | ogevia-prod-postgres | ogevia_prd |
| Prepared isolated TEST | Ogevia-prod | ogevia-postgres | fresh ogevia_sv_test |

Both existing instances are private, encrypted PostgreSQL 18.3, db.t4g.micro, 20 GiB gp3, Single-AZ, seven-day backups and deletion protection. Candidate SG: `sg-0bc0f1315fd0feaf2`; production RDS SG: `sg-00530a1f4f7648e65`. Existing app SG `sg-064ffce3bcbe8eb3b` is shared. Admin host `i-0ce8db2d7e5839dd5` is SSM-online and already permitted on the candidate. No host start/stop or temporary SG attachment is needed.

Default configuration remains shared. Only `-c env=prod -c testDatabase=isolated -c testMasterSecretArn=<live candidate ARN metadata>` selects the candidate. Production refuses this option. Production foundation, routes, credentials, networking and IAM remain unchanged; shared app code assets are not a production deployment. The new retained secret is `ogevia/test/database/app`; login `ogevia_test_app`, NOINHERIT, no administrator attributes, SET ROLE ogevia_app for the existing API-only runtime. Existing secrets/passwords are never rotated.

One metadata preflight remains meaningful: cluster-wide runtime roles must not already grant access to legacy `ogevia` schemas or RDS-superuser privileges. The script stops before writes if they do. This is a role-isolation blocker requiring a code revision, not permission to alter legacy grants. No application rows are queried. Initialization also refuses an existing TEST database/login; after partial failure, stop and investigate—never delete or overwrite to retry.

## What each future step touches
| Step | Scope | Can affect production? |
|---|---|---|
| Preflight, capture, synth, diff | AWS configuration/catalog metadata; local files | No writes; candidate catalog I/O only |
| New credential stack | One new retained TEST secret | No existing credential changes |
| Initialize/seed/backup | New database/login on candidate; original migration files and synthetic fixtures | No production-instance writes; legacy candidate roles checked before creation |
| NetworkEgress | Append TEST secret ARN pattern to existing Secrets Manager endpoint policy | **Yes:** endpoint is shared; existing production grants remain intact but a failed shared-policy update can disrupt production |
| TEST API | TEST Lambda host/secret/IAM, candidate-only 5432 ingress, existing UX code/three routes | No production stack/RDS change; shared app SG means network isolation is not complete |
| TEST Observability | Three RDS alarm dimensions move to candidate | No production alarm stack change |
| TEST web | Only verified TEST bucket/distribution | No, after confirming both differ from production |
| Rollback | Captured live TEST API/alarm templates and static web assets | No production restore/reboot; reverting TEST restores its old shared-instance resource contention |

Separating the database removes TEST load from production RDS after cutover. It does not remove the shared VPC, app SG or endpoint dependency. Do not claim zero production risk.

## CloudShell preparation — read-only AWS operations, no deployment
Use Node 22, pnpm 9.15.4, AWS CLI v2, jq, python3, curl, session-manager-plugin and PostgreSQL 18 psql/pg_dump/pg_restore. Use the existing pushed PR branch. Set RELEASE to the full final commit after its CI is green; do not use an earlier application SHA for the cutover.

```bash
set -euo pipefail
set +x +H
# Reuse the existing /tmp workspace; never put the repository/store in full $HOME.
: "${WORK:?set the existing CloudShell temporary workspace}"
export REPO="$WORK/repo" COREPACK_HOME="$WORK/corepack" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export OGEVIA_RELEASE_COMMIT='<FINAL_GREEN_COMMIT>'
for bin in "$WORK"/node-v22.*-linux-*/bin; do
  [[ ! -x "$bin/node" ]] || export PATH="$bin:$PATH"
done
export PATH="$WORK/bin:$PATH"
git -C "$REPO" fetch --filter=blob:none --depth=1 origin "$OGEVIA_RELEASE_COMMIT"
git -C "$REPO" checkout --detach "$OGEVIA_RELEASE_COMMIT"
cd "$REPO"
pnpm install --frozen-lockfile --store-dir "$WORK/store" --prefer-offline
export OGEVIA_PREVIOUS_CAPTURE="$WORK/capture"
bash docs/releases/2026-11-10-ux-redesign-test/toolchain/OPERATOR_TEST_DEPLOY.sh isolated-compare
```


The script aggregates CloudFormation JSON before selecting the Handler (no paginated None placeholders), captures only allowlisted Lambda configuration metadata, redacts the known QR key from the earlier private local configuration capture, verifies the live rollback ZIP hash and accepted API source, and preserves QR parameter definitions and Handler tags from the captured template. It synthesizes both shared-compatible and isolated candidates with the pinned bundler; no --all flag is used. It requires exactly three new UX routes, no removed live routes, only the reviewed code asset change, and the exact separation delta. Network/observability live baselines must still match. Any different source, route, permission, QR reference or other drift stops; never bypass the gate. It prints a new private CAPTURE path; use that as BASE for later approved steps, not the earlier failed capture.

## Future execution — DO NOT RUN without a later consolidated owner GO
Approval must name the final green commit, TEST only, operator and UTC window, candidate credential held in memory, candidate schema/role writes, shared endpoint-policy delta and additional secret cost. This is one approval of this concrete package, not a new checklist or signature form. Supply three existing confirmed synthetic TEST Cognito subjects as OWNER_SUB, MANAGER_SUB and CAREGIVER_SUB; no new accounts, invitations or messages are created by these commands.

```bash
# Exports below must come from the owner's actual approval; no defaults.
: "${OGEVIA_DEPLOY_APPROVAL:?set approved reference}"
: "${OGEVIA_WINDOW_START:?set approved UTC start}"
: "${OGEVIA_WINDOW_END:?set approved UTC end}"
: "${OWNER_SUB:?confirmed synthetic TEST owner UUID}"
: "${MANAGER_SUB:?confirmed synthetic TEST manager UUID}"
: "${CAREGIVER_SUB:?confirmed synthetic TEST caregiver UUID}"
export OWNER_SUB MANAGER_SUB CAREGIVER_SUB OGEVIA_DEPLOY_APPROVAL OGEVIA_WINDOW_START OGEVIA_WINDOW_END
export OGEVIA_ISOLATED_TEST_GO=initialize-ogevia-postgres
window() { test "$(date -u +%s)" -ge "$(date -u -d "$OGEVIA_WINDOW_START" +%s)" && test "$(date -u +%s)" -lt "$(date -u -d "$OGEVIA_WINDOW_END" +%s)"; }
window
# BASE is the new successful private CAPTURE directory printed by isolated-compare.
: "${BASE:?set the successful capture directory}"
test "$(cat "$BASE/release-commit.txt")" = "$OGEVIA_RELEASE_COMMIT"
test "$(git rev-parse HEAD)" = "$OGEVIA_RELEASE_COMMIT"
MASTER_ARN=$(cat "$BASE/candidate-master-arn.txt")
QR_SPEC=$(cat "$BASE/qr-parameter-spec.json")
TAGS=$(cat "$BASE/handler-tags.json")
TOOL="$REPO/docs/releases/2026-11-10-ux-redesign-test/toolchain"
FN=$(jq -er .FunctionName "$BASE/test-lambda.json")
TEST_BUCKET=$(sed -n '1p' "$BASE/web-targets.txt")
TEST_DIST=$(sed -n '2p' "$BASE/web-targets.txt")
# Freeze the approved assembly; normalize only the approval tag when comparing.
pnpm --dir infra/aws exec cdk synth '*' --quiet --lookups=false \
  -c env=prod -c mode=deploy -c liveTestBaseline=0102 \
  -c "liveQrParameterSpec=$QR_SPEC" -c "liveTestHandlerTags=$TAGS" -c testDatabase=isolated \
  -c testMasterSecretArn="$MASTER_ARN" --output "$BASE/approved"
python3 "$TOOL/diff_gate_ux.py" --isolated-assemblies "$BASE/shared" "$BASE/approved"
# Explicit --exclusively prevents deployment of unlisted dependencies/stacks.
window
pnpm --dir infra/aws exec cdk deploy --app "$BASE/approved" --exclusively Ogevia-prod-DatabaseSecret --require-approval never
window
bash "$TOOL/OPERATOR_TEST_DB.sh" isolated-initialize
bash "$TOOL/OPERATOR_TEST_DB.sh" isolated-verify
bash "$TOOL/OPERATOR_TEST_DB.sh" isolated-backup
window
pnpm --dir infra/aws exec cdk deploy --app "$BASE/approved" --exclusively Ogevia-prod-NetworkEgress --require-approval never
window
pnpm --dir infra/aws exec cdk deploy --app "$BASE/approved" --exclusively Ogevia-prod-ServiceVerificationApi Ogevia-prod-Observability --previous-parameters true --require-approval never
window
VITE_APP_VERSION="$OGEVIA_RELEASE_COMMIT" OGEVIA_APP_ENV=test bash infra/aws/scripts/deploy-test-slice.sh web
bash "$TOOL/OPERATOR_TEST_DB.sh" isolated-verify
bash infra/aws/scripts/deploy-test-slice.sh smoke
# Read-only final proof: TEST endpoint changed; production configuration unchanged.
aws lambda get-function-configuration --function-name "$FN" \
  --query '{host:Environment.Variables.DB_HOST,database:Environment.Variables.DB_NAME,secret:Environment.Variables.DB_SECRET_ARN}'
for stack in Ogevia-prd-ServiceVerificationApi Ogevia-prd-Observability; do
  aws cloudformation get-template --stack-name "$stack" --template-stage Original --query TemplateBody --output json > "$BASE/$stack.after.json"
  cmp "$BASE/$stack.template.json" "$BASE/$stack.after.json"
done
```

No `--all` deployment, bootstrap, old `infra`/`database`/`seed`/`users` modes, `OPERATOR_TEST_DEPLOY.sh`, or shared-instance migration commands are part of this cutover. The old UX deployment gate is still valid for its original shared release only. The existing web publish step is reused unchanged with explicit TEST labeling and version. Verify the new web origin/version and synthetic OWNER/caregiver Start → End → Confirm workflow; anonymous API must return 401. CSV check writes nothing until confirm; duplicate routes remain absent; new agencies have no automatic CPR/TB types. Phone acceptance remains the owner's task. Record actual results; never infer deployed acceptance from local CI.

The initializer uses the original 88 migrations plus accepted 0089–0102 plus pending UX 0103–0107 with exact filename/checksum ledger rows committed atomically, preserving accepted 0089 and the withdrawn, unrelated UX 0089 decision. Normal db:migrate still uses 88 and refuses unknown UX versions. New TEST initialization explicitly opts in with OGEVIA_INCLUDE_PENDING_UX=test-only; production database names are refused. Seed uses existing scripts 02 and 07 only, no copied client records or fabricated evidence files. Schedule seeding requires a 01:00–20:59 Pacific start; otherwise it stops before writes.

## TEST-only rollback commands — use captured live state
Do not rebuild the latest default shared configuration for rollback: it includes UX routes that the old database may not support. Restore the exact captured live templates/assets. The original TEST database on the shared instance is untouched by initialization/cutover, so no data restore is necessary. Stop using TEST during rollback. A retained synthetic candidate is left for investigation; never drop either database or restore/reboot the production RDS instance.

```bash
set -euo pipefail
cd "$REPO"
sha256sum --check "$BASE/SHA256SUMS" > /dev/null
# Private existing CDK asset bucket; no templates uploaded to the public web origin.
ASSETS=cdk-hnb659fds-assets-300094796789-us-west-2
KEY="ogevia-test-rollback/$(basename "$BASE")"
for stack in Ogevia-prod-ServiceVerificationApi Ogevia-prod-Observability; do
  jq '[.Stacks[0].Parameters[]? | {ParameterKey,UsePreviousValue:true}]' "$BASE/$stack.stack.json" > "$BASE/$stack.params.json"
  aws s3 cp "$BASE/$stack.template.json" "s3://$ASSETS/$KEY/$stack.json" --only-show-errors
  aws cloudformation update-stack --stack-name "$stack" \
    --template-url "https://$ASSETS.s3.us-west-2.amazonaws.com/$KEY/$stack.json" \
    --parameters "file://$BASE/$stack.params.json" --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM
  aws cloudformation wait stack-update-complete --stack-name "$stack"
done
# Restore the exact verified live Handler ZIP, including any prior manual packaging.
FN=$(jq -er .FunctionName "$BASE/test-lambda.json")
aws lambda update-function-code --function-name "$FN" --zip-file "fileb://$BASE/test-lambda.zip" > /dev/null
aws lambda wait function-updated --function-name "$FN"
# Confirm TEST targets still equal the captured targets before restoring static files.
test "$TEST_BUCKET" = "$(sed -n '1p' "$BASE/web-targets.txt")"
test "$TEST_DIST" = "$(sed -n '2p' "$BASE/web-targets.txt")"
aws s3 sync "$BASE/web-before" "s3://$TEST_BUCKET" --exclude index.html --only-show-errors
aws s3 cp "$BASE/web-before/index.html" "s3://$TEST_BUCKET/index.html" --cache-control no-cache --only-show-errors
aws cloudfront create-invalidation --distribution-id "$TEST_DIST" --paths /index.html /
aws lambda get-function-configuration --function-name "$FN" --query '{host:Environment.Variables.DB_HOST,database:Environment.Variables.DB_NAME}'
bash infra/aws/scripts/deploy-test-slice.sh smoke
```

If CloudFormation reports “No updates are to be performed,” that stack already matches; do not treat a different failure as success. Existing Lambda code assets must remain available in the captured template's private CDK bucket. The additive endpoint grant and retained secret can stay unused after rollback; their later cleanup needs separate review. No automatic cleanup touches a shared policy. Restoration to the old TEST database again shares production RDS CPU/I/O/connections.

## Cost and approval boundary
Reuse the already running candidate—no third RDS instance, new NAT, endpoint, Cognito pool or platform. One new Secrets Manager secret adds approximately $0.40/month plus API calls (AWS lists $0.05/10,000 calls); existing storage and backups can grow. No savings claim or deletion is made. Pricing source: https://aws.amazon.com/secrets-manager/pricing/ .

**Next milestone: final green CI → review the bounded preflight/diff → one explicit TEST execution approval → synthetic TEST acceptance. Production release requires its own later scope and approval.**
