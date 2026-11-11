# TEST database separation and release package — prepared, not executed

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

Default configuration remains shared. Only `-c env=prod -c testDatabase=isolated -c testMasterSecretArn=<live candidate ARN metadata>` selects the candidate. Production refuses this option. Production foundation values and all synthesized production templates remain unchanged. The new retained secret is `ogevia/test/database/app`; login `ogevia_test_app`, NOINHERIT, no administrator attributes, SET ROLE ogevia_app for the existing API-only runtime. Existing secrets/passwords are never rotated.

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
umask 077
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""
export REPO="$HOME/CarelikGlobal"
# Replace this with the reviewed full final commit, not a branch tip that can move.
export OGEVIA_RELEASE_COMMIT='<FINAL_GREEN_COMMIT>'
cd "$REPO"
git fetch origin claude/ogevia-ux-audit-redesign-w36cov
git switch --detach "$OGEVIA_RELEASE_COMMIT"
test -z "$(git status --porcelain --untracked-files=no)"
corepack pnpm install --frozen-lockfile
export TOOL="$REPO/docs/releases/2026-11-10-ux-redesign-test/toolchain"
test "$(aws sts get-caller-identity --query Account --output text)" = 300094796789
export BASE="$HOME/ogevia-test-cutover-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$BASE"
# Managed master-secret ARN metadata only; no credential value printed.
export MASTER_ARN=$(aws rds describe-db-instances --db-instance-identifier ogevia-postgres \
  --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)
bash "$TOOL/OPERATOR_TEST_DB.sh" isolated-preflight
out() { aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
export TEST_BUCKET=$(out Ogevia-prod-WebHosting SiteBucketName)
export TEST_DIST=$(out Ogevia-prod-WebHosting DistributionId)
test -n "$TEST_BUCKET" && test "$TEST_BUCKET" != None
test -n "$TEST_DIST" && test "$TEST_DIST" != None
test "$TEST_BUCKET" != "$(out Ogevia-prd-WebHosting SiteBucketName)"
test "$TEST_DIST" != "$(out Ogevia-prd-WebHosting DistributionId)"
printf '%s\n%s\n' "$TEST_BUCKET" "$TEST_DIST" > "$BASE/web-targets.txt"
for stack in Ogevia-prod-ServiceVerificationApi Ogevia-prod-Observability Ogevia-prod-NetworkEgress Ogevia-prd-ServiceVerificationApi Ogevia-prd-Observability; do
  aws cloudformation get-template --stack-name "$stack" --template-stage Original \
    --query TemplateBody --output json > "$BASE/$stack.template.json"
  aws cloudformation describe-stacks --stack-name "$stack" --output json > "$BASE/$stack.stack.json"
done
# Code locations/role/VPC/environment references only, not credential values.
FN=$(aws cloudformation list-stack-resources --stack-name Ogevia-prod-ServiceVerificationApi \
  --query "StackResourceSummaries[?starts_with(LogicalResourceId, 'Handler') && ResourceType=='AWS::Lambda::Function'].PhysicalResourceId | [0]" --output text)
aws lambda get-function-configuration --function-name "$FN" > "$BASE/test-lambda.json"
aws s3 sync "s3://$TEST_BUCKET" "$BASE/web-before" --only-show-errors
pnpm --dir infra/aws exec cdk synth --all --quiet --lookups=false \
  -c env=prod -c mode=plan --output "$BASE/shared"
pnpm --dir infra/aws exec cdk synth --all --quiet --lookups=false \
  -c env=prod -c mode=plan -c testDatabase=isolated \
  -c testMasterSecretArn="$MASTER_ARN" --output "$BASE/isolated"
python3 "$TOOL/diff_gate_ux.py" \
  --live "$BASE/Ogevia-prod-ServiceVerificationApi.template.json" \
  --new "$BASE/shared/Ogevia-prod-ServiceVerificationApi.template.json" --expect pre
python3 "$TOOL/diff_gate_ux.py" --isolated-assemblies "$BASE/shared" "$BASE/isolated"
# These existing shared-stack baselines must match live before adding separation changes.
python3 - "$BASE" "$TOOL" <<'PY'
import pathlib, runpy, sys
b=pathlib.Path(sys.argv[1]); g=runpy.run_path(str(pathlib.Path(sys.argv[2])/'diff_gate_ux.py'))
for s in ['Ogevia-prod-NetworkEgress','Ogevia-prod-Observability']:
    assert g['norm'](g['load'](b/(s+'.template.json'))) == g['norm'](g['load'](b/'shared'/(s+'.template.json'))), 'STOP: live drift in '+s
print('LIVE SHARED BASELINES: match')
PY
find "$BASE" -type f -not -name SHA256SUMS -exec sha256sum {} + > "$BASE/SHA256SUMS"
printf '\033[32m%s\033[0m\n' 'PREPARATION COMPLETE — NOTHING DEPLOYED'
```

If the live API no longer matches the known 250-route baseline, this gate stops. Do not change `pre` to `post` to suppress a code difference, bypass a gate, or deploy unrelated drift. Return the metadata diff for review. The isolated assembly gate permits only the exact API target/credential/ingress, additive endpoint grant, RDS alarm dimensions and retained credential stack. It does not authorize applying them.

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
# Freeze the approved assembly; normalize only the approval tag when comparing.
pnpm --dir infra/aws exec cdk synth --all --quiet --lookups=false \
  -c env=prod -c mode=deploy -c testDatabase=isolated \
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
pnpm --dir infra/aws exec cdk deploy --app "$BASE/approved" --exclusively Ogevia-prod-ServiceVerificationApi Ogevia-prod-Observability --require-approval never
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

The initializer uses the original 88 migrations plus pending 0090–0094 with exact filename/checksum ledger rows committed atomically, leaving 0089 withdrawn. Normal db:migrate still uses 88 and refuses unknown UX versions. New TEST initialization explicitly opts in with OGEVIA_INCLUDE_PENDING_UX=test-only; production database names are refused. Seed uses existing scripts 02 and 07 only, no copied client records or fabricated evidence files. Schedule seeding requires a 01:00–20:59 Pacific start; otherwise it stops before writes.

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
