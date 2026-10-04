#!/usr/bin/env bash
# =============================================================================
# Ogevia AWS TEST release 0022-0026: client/authorization, Care Team, service
# and assignment administration; caregiver invitations; planned assignments.
# Base: the 1a39dd5 increment (ledger 0001-0021, GET /v1/attention live).
#
# Changes (all checked by release_0026_gate.py and its 25-variant self-test):
#   DB       migrations 0022-0026 on ogevia_sv_test (one transaction each)
#   API      30 JWT routes; Handler code + IDENTITY_FUNCTION_NAME; one invoke
#            statement; NEW identity Lambda (outside the VPC) with
#            AdminCreateUser/AdminGetUser on the one pool, its role, policy and
#            log group
#   Network  NEW Lambda interface endpoint (1 AZ, ~$7.30/month fixed; invoke
#            the identity function only); S3 gateway endpoint policy also
#            allows the staff-document and logo key shapes
#   Web      matching build (config.json kept)
#
# Everything before the single DEPLOY prompt is read-only. After DEPLOY:
# snapshot, one DB window, NetworkEgress + API stacks, web files, then 12
# read-only live checks. Re-running resumes (state in ~/ogevia-release-0026-run;
# earlier run folders are never written). TEST ONLY, SYNTHETIC DATA ONLY.
#
# Never: Netlify/Supabase/DNS, Cognito users/clients/pool settings,
# config.json, the other three stacks, RDS security-group rules, deleting
# anything, modifying an applied migration (ledger checksums must match).
# =============================================================================
set -Eeuo pipefail

export OGEVIA_PILOT_RUN_DIR="${OGEVIA_RELEASE_RUN_DIR:-$HOME/ogevia-release-0026-run}"
# shellcheck source=pilot-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/pilot-lib.sh"
FINAL_MIGRATION=0026
BASE_MIGRATION=0021
NEW_ROUTE_COUNT=30
EGRESS_STACK=Ogevia-prod-NetworkEgress
IDENTITY_FN=Ogevia-prod-IdentityAdmin
PIN="${OGEVIA_RELEASE_PIN:-}"
SNAPSHOT_ID=ogevia-prod-postgres-pre-0026-$(date -u +%Y%m%d)
LOG="$RUN/deploy-$(date -u +%Y%m%dT%H%M%SZ).log"
exec 3>&1
exec > >(tee -a "$LOG") 2>&1
trap '' PIPE
trap on_exit EXIT
trap 'die "unexpected error on line $LINENO (command: $BASH_COMMAND)"' ERR
PNPM=(npx -y pnpm@9.15.4)
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}"
export PYTHONDONTWRITEBYTECODE=1
GATE_TEST_ARGS=(-- --pool=forks --poolOptions.forks.maxForks=1 --poolOptions.forks.minForks=1)
VERIFY="$RUN/VERIFY.txt"
FP_SQL="set timezone to 'UTC'; select count(*) || ':' || coalesce(md5(string_agg(id::text || '|' || time_in::text || '|' || coalesce(time_out::text, '-') || '|' || coalesce(signed_at::text, '-') || '|' || status::text, ',' order by id)), 'none') from ogevia.service_visits"
ROWS_SQL="select (select count(*) from ogevia.service_visits) || ' visits, ' || (select count(*) from ogevia.visit_corrections) || ' corrections, ' || (select count(*) from ogevia.audit_events) || ' audit events'"
# Accounts and records that must be identical before and after the migrations.
KEEP_SQL="select (select count(*) from ogevia.app_users) || ' users, ' || (select count(*) from ogevia.organization_memberships) || ' memberships (' || (select count(*) from ogevia.organization_memberships where status = 'active') || ' active), ' || (select count(*) from ogevia.caregiver_records) || ' caregiver records, ' || (select count(*) from ogevia.clients) || ' clients, ' || (select count(*) from ogevia.client_authorizations) || ' authorizations, ' || (select count(*) from ogevia.caregiver_assignments) || ' assignments (' || (select count(*) from ogevia.caregiver_assignments where caregiver_user_id is not null) || ' with access), ' || (select count(*) from ogevia.billing_approvals) || ' billing approvals'"

# ----------------------------------------------------------------------------
phase "1/12 Prerequisites and the pinned code"
for t in aws node npx python3 jq curl git; do command -v "$t" >/dev/null || die "missing tool: $t"; done
[[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]] || die "Node.js >= 20 required (found $(node -v))"
if ! command -v psql >/dev/null; then sudo dnf install -y -q postgresql15 >/dev/null || die "could not install psql"; fi
if ! command -v session-manager-plugin >/dev/null; then
  sudo dnf install -y -q https://s3.amazonaws.com/session-manager-downloads/plugin/latest/linux_64bit/session-manager-plugin.rpm >/dev/null \
    || die "could not install session-manager-plugin"
fi
[[ "$PIN" =~ ^[0-9a-f]{40}$ ]] || die "OGEVIA_RELEASE_PIN is not a full commit id; start from release-0026-bootstrap.sh"
COMMIT=$(git -C "$REPO" rev-parse HEAD)
[[ "$COMMIT" == "$PIN" ]] || die "the checkout is at $COMMIT, not the pinned $PIN"
DIRTY=$(git -C "$REPO" status --porcelain --untracked-files=no)
[[ -z "$DIRTY" ]] || die "the checkout has local changes: $DIRTY"
for v in 0022 0023 0024 0025 0026; do ls "$HERE/db/migrations/${v}_"*.sql >/dev/null 2>&1 || die "migration $v missing"; done
[[ "$(ls "$HERE/db/migrations" | tail -1)" == ${FINAL_MIGRATION}_* ]] || die "unexpected newest migration: $(ls "$HERE/db/migrations" | tail -1)"
echo "Code: $(git -C "$REPO" log --oneline -1) (pinned, clean)"
printf 'aws %s | node %s | %s\n' "$(aws --version 2>&1 | cut -d' ' -f1)" "$(node -v)" "$(psql --version)"

# ----------------------------------------------------------------------------
phase "2/12 AWS identity"
ARN=$(aws sts get-caller-identity --query Arn --output text) || die "AWS credentials are not valid: sign in again and reopen CloudShell"
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT" ]] || die "wrong AWS account (expected $ACCOUNT)"
[[ "$ARN" == *AdministratorAccess* ]] || die "this needs the AdministratorAccess role (current: $ARN)"
echo "Account $ACCOUNT, region $REGION, AdministratorAccess: OK"

# ----------------------------------------------------------------------------
phase "3/12 Read-only inventory and pilot preconditions"
load_rds_and_host
[[ "$(jq -r .DBInstanceStatus <<<"$RDS")" == available ]] || die "RDS is $(jq -r .DBInstanceStatus <<<"$RDS")"
[[ "$(jq -r .PubliclyAccessible <<<"$RDS")" == false ]] || die "RDS is publicly accessible: stop and review"
[[ "$(jq -r .StorageEncrypted <<<"$RDS")" == true ]] || die "RDS storage is not encrypted"
for s in "${STACKS[@]}"; do
  st=$(aws cloudformation describe-stacks --stack-name "$s" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo MISSING)
  [[ "$st" == CREATE_COMPLETE || "$st" == UPDATE_COMPLETE ]] || die "$s is $st (this workflow never creates or repairs stacks)"
done
# The API handler by logical id (the stack gains a second function in this release).
FN=$(aws cloudformation describe-stack-resources --stack-name "$API_STACK" \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function' && starts_with(LogicalResourceId, 'Handler')].PhysicalResourceId | [0]" --output text)
FNCFG=$(aws lambda get-function-configuration --function-name "$FN" --output json)
[[ "$(jq -r '.Environment.Variables.DB_NAME // empty' <<<"$FNCFG")" == "$DB_NAME" ]] || die "the API Lambda does not serve $DB_NAME"
API_ID=$(aws cloudformation describe-stack-resources --stack-name "$API_STACK" \
  --query "StackResources[?ResourceType=='AWS::ApiGatewayV2::Api'].PhysicalResourceId | [0]" --output text)
POLICY_ARN=$(aws cloudformation describe-stack-resources --stack-name "$API_STACK" \
  --query "StackResources[?ResourceType=='AWS::IAM::ManagedPolicy' && starts_with(LogicalResourceId, 'HandlerPolicy')].PhysicalResourceId | [0]" --output text)
WEB=$(out Ogevia-prod-WebHosting WebOrigin); BUCKET=$(out Ogevia-prod-WebHosting SiteBucketName)
DIST=$(out Ogevia-prod-WebHosting DistributionId); API=$(out "$API_STACK" ApiUrl)
for v in WEB BUCKET DIST API API_ID POLICY_ARN; do [[ -n "${!v}" && "${!v}" != None ]] || die "missing $v"; done
ALIASES=$(aws cloudfront get-distribution-config --id "$DIST" --query 'DistributionConfig.Aliases.Items' --output text)
[[ "$ALIASES" == None || -z "$ALIASES" ]] || die "the TEST web distribution serves a custom domain ($ALIASES); review first"
LIVE_ROUTES=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query 'Items[].[RouteKey,AuthorizationType]' --output json)
jq -e 'map(.[0]) | index("GET /v1/attention")' <<<"$LIVE_ROUTES" >/dev/null \
  || die "GET /v1/attention is not live: the 1a39dd5 increment (0019-0021) is not the base; finish it first"
jq -e 'map(.[0]) | index("GET /v1/clients") | not' <<<"$LIVE_ROUTES" >/dev/null || echo "Note: GET /v1/clients is already live (resuming after the API deploy)."
echo "RDS $RDS_ID available, private, encrypted. Stacks complete. Lambda serves $DB_NAME."
echo "API $API_ID: $(jq length <<<"$LIVE_ROUTES") live routes, 1a39dd5 increment present. Web $WEB (no custom domain)."

# The live approval tag value, so the synthesized tags equal the deployed ones.
mkdir -p "$RUN/live-templates"
for s in "${STACKS[@]}"; do
  aws cloudformation get-template --stack-name "$s" --template-stage Original --query TemplateBody --output json > "$RUN/live-templates/$s.json"
done
TAGS=$(python3 - "$RUN/live-templates" <<'PY'
import json, glob, sys
vals = set()
for f in glob.glob(sys.argv[1] + "/*.json"):
    for r in json.load(open(f)).get("Resources", {}).values():
        for t in (r.get("Properties", {}).get("Tags") or []):
            if isinstance(t, dict) and t.get("Key") == "ogevia:deployment-status":
                vals.add(t.get("Value"))
print("\n".join(sorted(vals)))
PY
)
[[ "$(wc -l <<<"$TAGS")" == 1 && "$TAGS" == approved-* ]] || die "live ogevia:deployment-status values are not one consistent value: $(tr '\n' ' ' <<<"$TAGS")"
TAG_REF="${TAGS#approved-}"
[[ "$TAG_REF" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || die "live approval tag is not a valid reference: $TAGS"
echo "Live ogevia:deployment-status: $TAGS (kept unchanged)"

# ----------------------------------------------------------------------------
phase "4/12 Quality gate, synth and web build of the pinned code"
cd "$REPO"
if ! is_done "tests-$COMMIT"; then
  "${PNPM[@]}" install --frozen-lockfile
  for t in typecheck lint test build; do
    extra=(); [[ "$t" == test ]] && extra=("${GATE_TEST_ARGS[@]}")
    echo "-- $t (one task at a time)"
    "${PNPM[@]}" exec turbo run "$t" --concurrency=1 "${extra[@]}" || die "the quality gate failed ($t)"
  done
  done_ "tests-$COMMIT"
else
  echo "Quality gate already passed for $COMMIT in this run."
  [[ -d node_modules ]] || "${PNPM[@]}" install --frozen-lockfile
fi
export OGEVIA_DEPLOY_APPROVAL="$TAG_REF"
(cd "$HERE" && npx cdk synth --quiet --no-notices -c env=prod -c mode=deploy >/dev/null) || die "cdk synth (deploy mode) failed"
(cd "$REPO/apps/web" && VITE_APP_ENV=production VITE_AUTH_PROVIDER=cognito npx vite build --outDir "$RUN/web-build" --emptyOutDir >/dev/null) \
  || die "web build failed"
rm -f "$RUN/web-build/config.json"   # the live config.json is kept as it is
echo "Lint, typecheck, unit tests, build, synth, web build: OK"

# ----------------------------------------------------------------------------
phase "5/12 Capture rollback material (read-only)"
if ! is_done rollback-captured; then
  cp "$RUN/live-templates/"*.json "$RB/templates/"
  jq '{FunctionName, CodeSha256, LastModified, Runtime, MemorySize, Timeout, DB_NAME: .Environment.Variables.DB_NAME}' <<<"$FNCFG" > "$RB/lambda.json"
  printf '%s\n' "$LIVE_ROUTES" > "$RB/routes.json"
  PV=$(aws iam get-policy --policy-arn "$POLICY_ARN" --query Policy.DefaultVersionId --output text)
  aws iam get-policy-version --policy-arn "$POLICY_ARN" --version-id "$PV" --query PolicyVersion.Document --output json > "$RB/handler-policy.json"
  aws s3 sync "s3://$BUCKET" "$RB/web" --only-show-errors
  aws s3api head-object --bucket "$BUCKET" --key index.html --query '{ETag:ETag,LastModified:LastModified,VersionId:VersionId}' --output json > "$RB/web-index.json"
  jq -n --arg commit "$COMMIT" --arg fn "$FN" --arg bucket "$BUCKET" --arg dist "$DIST" --arg snap "$SNAPSHOT_ID" \
    --arg routes "$(jq length "$RB/routes.json")" --arg at "$(date -u +%FT%TZ)" \
    '{capturedAt:$at, deployingCommit:$commit, lambda:$fn, apiRoutesBefore:($routes|tonumber), siteBucket:$bucket, distribution:$dist, snapshot:$snap}' > "$RB/MANIFEST.json"
  done_ rollback-captured
fi
SNAPSHOT_ID=$(jq -r .snapshot "$RB/MANIFEST.json")
echo "Captured in $RB: 5 templates, Lambda $(jq -r .CodeSha256 "$RB/lambda.json" | cut -c1-12)…, $(jq length "$RB/routes.json") routes, Handler policy ($(jq '.Statement | length' "$RB/handler-policy.json") statements), $(find "$RB/web" -type f | wc -l) web files."

# ----------------------------------------------------------------------------
phase "6/12 Strict scope gate: live templates vs this build"
TEMPLATE_BASE="$RB/templates"   # always the pre-deploy capture, also when resuming
python3 "$SLICE/release_0026_gate_selftest.py" --cdk-out "$HERE/cdk.out" --deployed "$TEMPLATE_BASE" | tail -1 | grep -q 'Gate self-test: PASS' \
  || die "the scope gate self-test failed (the gate would not catch a tampered change)"
python3 "$SLICE/release_0026_gate.py" --cdk-out "$HERE/cdk.out" --deployed "$TEMPLATE_BASE" --summary "$RUN/scope-gate.txt" \
  || die "the change set is outside the approved scope (see above); nothing was changed"
echo "Gate self-test: PASS (refuses 25 tampered variants of this exact build)"

# ----------------------------------------------------------------------------
phase "7/12 APPROVAL (the only approval for the deployment)"
if ! is_done approved; then
  [[ -t 0 ]] || die "approval needs an interactive terminal"
  cat <<EOF

Exactly this will change in AWS TEST (account $ACCOUNT, $REGION), commit ${COMMIT:0:12}:
  1. RDS snapshot $SNAPSHOT_ID of $RDS_ID (kept until you delete it).
  2. DB window: $APP_SG is attached to admin host $IID, then its original groups are restored.
     On $DB_NAME only: the ledger must be exactly 0001-$BASE_MIGRATION with matching checksums
     (no applied migration is modified); migrations 0022-0026 are applied (one transaction
     each); db:verify must pass; existing visits must be unchanged; existing users,
     memberships, caregiver records, clients, authorizations, assignments and billing
     approvals must have the same counts afterwards.
  3. $EGRESS_STACK: + Lambda interface endpoint (1 AZ; NEW FIXED COST about 7.30 USD/month;
     may invoke $IDENTITY_FN only); S3 endpoint policy + document and logo key shapes.
  4. $API_STACK: 30 JWT routes + permissions; Handler code + IDENTITY_FUNCTION_NAME; one
     invoke statement; NEW $IDENTITY_FN (outside the VPC; Cognito AdminCreateUser and
     AdminGetUser on the one pool only), its role, policy and log group.
  5. Web: new files to $BUCKET (config.json NOT changed), CloudFront $DIST invalidated.
  6. 12 read-only live checks.
Not touched: Cognito users, app clients and pool settings; Netlify, Supabase, DNS, RDS SG rules;
the other 3 stacks. No one is invited by this deployment.
Afterwards, optionally and only if you type SEED: synthetic names for the synthetic pilot clients.
Rollback: docs/aws/DEPLOYMENT_PLAN_0022_0026.md section 5 (material in $RB).
EOF
  read -r -p "Type DEPLOY to approve exactly this scope (anything else cancels): " answer
  [[ "$answer" == DEPLOY ]] || die "not approved; nothing was changed"
  printf 'approved_at=%s\napproved_by=%s\ncommit=%s\nscope_gate=%s\n' "$(date -u +%FT%TZ)" "$ARN" "$COMMIT" \
    "$(sha256sum "$RUN/scope-gate.txt" | cut -c1-16)" > "$RUN/APPROVAL.txt"
  done_ approved
fi
grep -q "^commit=$COMMIT$" "$RUN/APPROVAL.txt" || die "the approval was for a different commit; start a fresh run directory"
grep -q "^scope_gate=$(sha256sum "$RUN/scope-gate.txt" | cut -c1-16)$" "$RUN/APPROVAL.txt" \
  || die "the scope gate result differs from the approved one; nothing more is changed"

# ----------------------------------------------------------------------------
phase "8/12 Backup: RDS snapshot"
if ! is_done snapshot; then
  SNAPSHOT_ID=$(jq -r .snapshot "$RB/MANIFEST.json")
  if ! aws rds describe-db-snapshots --db-snapshot-identifier "$SNAPSHOT_ID" >/dev/null 2>&1; then
    aws rds create-db-snapshot --db-instance-identifier "$RDS_ID" --db-snapshot-identifier "$SNAPSHOT_ID" \
      --tags Key=purpose,Value=pre-0026-rollback >/dev/null
  fi
  echo "Waiting for $SNAPSHOT_ID (usually 5-15 minutes)..."
  aws rds wait db-snapshot-available --db-snapshot-identifier "$SNAPSHOT_ID" || die "snapshot did not complete"
  done_ snapshot
fi
SNAPSHOT_ID=$(jq -r .snapshot "$RB/MANIFEST.json")
echo "Snapshot $SNAPSHOT_ID: available"

# ----------------------------------------------------------------------------
phase "9/12 DB window: migrations 0022-0026 and verification"
if ! is_done db-window; then
  trap 'rc=$?; trap - ERR; db_window_close; (exit $rc); on_exit' EXIT
  trap 'db_window_close; die "unexpected error on line $LINENO (command: $BASH_COMMAND)"' ERR
  db_window_open
  Q -d postgres -c "select datname from pg_database where not datistemplate order by 1" > "$RUN/rds-databases.txt"
  grep -qx "$DB_NAME" "$RUN/rds-databases.txt" || die "database $DB_NAME not found on $RDS_ID"

  Q -d "$DB_NAME" -F' ' -c "select version, checksum from ogevia_meta.schema_migrations order by version" > "$RUN/ledger-before.txt"
  N=$(wc -l < "$RUN/ledger-before.txt")
  [[ "$(cut -d' ' -f1 "$RUN/ledger-before.txt" | paste -sd,)" == "$(seq -f '%04g' 1 "$N" | paste -sd,)" ]] \
    || die "the migration ledger is not contiguous: $(cut -d' ' -f1 "$RUN/ledger-before.txt" | paste -sd,)"
  if [[ "$N" != "${BASE_MIGRATION#00}" ]] && ! is_done migrate-started; then
    die "the ledger ends at $(printf '%04d' "$N"), expected $BASE_MIGRATION before this deployment"
  fi
  while read -r v sum; do
    f=$(ls "$HERE/db/migrations/${v}_"*.sql)
    [[ "$(sha256sum "$f" | cut -d' ' -f1)" == "$sum" ]] || die "ledger checksum of $v differs from the repository ($f)"
  done < "$RUN/ledger-before.txt"
  echo "Ledger before: 0001-$(printf '%04d' "$N"), all checksums match the repository"

  [[ -f "$RB/visit-fingerprint-before.txt" ]] || Q -d "$DB_NAME" -c "$FP_SQL" | tail -1 > "$RB/visit-fingerprint-before.txt"
  [[ -f "$RB/rows-before.txt" ]] || Q -d "$DB_NAME" -c "$ROWS_SQL" > "$RB/rows-before.txt"
  [[ -f "$RB/keep-before.txt" ]] || Q -d "$DB_NAME" -c "$KEEP_SQL" > "$RB/keep-before.txt"
  echo "Existing data: $(cat "$RB/rows-before.txt"); visit fingerprint $(cat "$RB/visit-fingerprint-before.txt")"
  echo "Accounts and records: $(cat "$RB/keep-before.txt")"

  done_ migrate-started
  OGEVIA_DATABASE_URL="$DBURL" npx --prefix "$HERE" tsx "$HERE/db/scripts/migrate.ts" \
    || die "a migration failed (that migration rolled back; earlier ones stay applied). Re-run to resume"
  OGEVIA_DATABASE_URL="$DBURL" npx --prefix "$HERE" tsx "$HERE/db/scripts/verify.ts" | tee "$RUN/db-verify.txt" \
    || die "schema verification failed"
  grep -q '^FAIL' "$RUN/db-verify.txt" && die "schema verification reported FAIL"
  Q -d "$DB_NAME" -F' ' -c "select version, checksum from ogevia_meta.schema_migrations order by version" > "$RUN/ledger-after.txt"
  [[ "$(cut -d' ' -f1 "$RUN/ledger-after.txt" | paste -sd,)" == "$(seq -f '%04g' 1 26 | paste -sd,)" ]] || die "ledger after is not 0001-0026"
  while read -r v sum; do
    [[ "$(grep "^$v " "$RUN/ledger-before.txt" | cut -d' ' -f2)" == "$sum" ]] || die "applied migration $v changed its checksum"
  done < <(grep -E '^00(0[1-9]|1[0-9]|2[01]) ' "$RUN/ledger-after.txt")
  AFTER=$(Q -d "$DB_NAME" -c "$FP_SQL" | tail -1)
  [[ "$AFTER" == "$(cat "$RB/visit-fingerprint-before.txt")" ]] \
    || die "existing visits changed during migration ($AFTER). Stop; see the rollback section of the plan"
  echo "Existing visits unchanged (id, Time In/Out, signed time, status): OK"
  KEEP_AFTER=$(Q -d "$DB_NAME" -c "$KEEP_SQL")
  [[ "$KEEP_AFTER" == "$(cat "$RB/keep-before.txt")" ]] \
    || die "accounts or records changed during migration: before $(cat "$RB/keep-before.txt"); after $KEEP_AFTER. Stop; see the rollback section"
  echo "Existing users, memberships, records, assignments and approvals unchanged: OK ($KEEP_AFTER)"
  db_window_close
  trap on_exit EXIT
  trap 'die "unexpected error on line $LINENO (command: $BASH_COMMAND)"' ERR
  admin_host_groups | grep -qw "$APP_SG" && die "$APP_SG is still attached to $IID: remove it in the EC2 console"
  done_ db-window
fi
echo "DB window closed; admin host groups: $(admin_host_groups)"

# ----------------------------------------------------------------------------
phase "10/12 Deploy the network endpoint, the API stack and the web files"
if ! is_done api-deployed; then
  mkdir -p "$RUN/predeploy-templates"
  for s in "${STACKS[@]}"; do
    aws cloudformation get-template --stack-name "$s" --template-stage Original --query TemplateBody --output json > "$RUN/predeploy-templates/$s.json"
  done
  python3 "$SLICE/release_0026_gate.py" --cdk-out "$HERE/cdk.out" --deployed "$RUN/predeploy-templates" >/dev/null \
    || die "AWS changed since approval (the scope gate no longer passes); nothing deployed"
  # --require-approval never is safe ONLY because the strict gate just proved
  # the change set equals the approved scope for this exact cdk.out.
  (cd "$HERE" && npx cdk deploy --app cdk.out --exclusively "$EGRESS_STACK" "$API_STACK" --require-approval never --no-notices) \
    || die "stack deployment failed (CloudFormation rolls the failed stack back automatically); run release-0026-rollback.sh status"
  [[ "$(aws lambda get-function-configuration --function-name "$FN" --query 'Environment.Variables.DB_NAME' --output text)" == "$DB_NAME" ]] \
    || die "the deployed Lambda no longer points at $DB_NAME"
  done_ api-deployed
fi
if ! is_done web-deployed; then
  W="$RUN/web-build"
  aws s3 sync "$W/assets" "s3://$BUCKET/assets" --only-show-errors --cache-control "public,max-age=31536000,immutable"
  aws s3 sync "$W" "s3://$BUCKET" --only-show-errors --exclude "assets/*" --exclude "index.html" --exclude "config.json"
  aws s3 cp "$W/index.html" "s3://$BUCKET/index.html" --only-show-errors --content-type "text/html; charset=utf-8" --cache-control "no-cache"
  INV=$(aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" --query Invalidation.Id --output text)
  echo "Waiting for CloudFront to refresh (a few minutes)..."
  aws cloudfront wait invalidation-completed --distribution-id "$DIST" --id "$INV"
  done_ web-deployed
fi
echo "API and web deployed."

# ----------------------------------------------------------------------------
phase "11/12 Live verification (read-only)"
: > "$VERIFY"
PASSES=0; FAILS=0; TOTAL=12
check() { if [[ "$2" == ok ]]; then PASSES=$((PASSES + 1)); echo "PASS $1${3:+ - $3}" | tee -a "$VERIFY"; else FAILS=$((FAILS + 1)); echo "FAIL $1${3:+ - $3}" | tee -a "$VERIFY"; fi; }
APPROVED_AT=$(grep '^approved_at=' "$RUN/APPROVAL.txt" | cut -d= -f2)
r=ok; detail=""
for s in "$EGRESS_STACK" "$API_STACK"; do
  ST=$(aws cloudformation describe-stacks --stack-name "$s" --query 'Stacks[0].[StackStatus,LastUpdatedTime]' --output text)
  [[ "$(cut -f1 <<<"$ST")" == UPDATE_COMPLETE && "$(cut -f2 <<<"$ST")" > "$APPROVED_AT" ]] || r=no
  detail="$detail ${s#Ogevia-prod-}=$(cut -f1 <<<"$ST")"
done
check "1 NetworkEgress and API stacks UPDATE_COMPLETE after the approval" "$r" "${detail# }"

aws apigatewayv2 get-routes --api-id "$API_ID" --query 'Items[].[RouteKey,AuthorizationType]' --output json > "$RUN/routes-after.json"
r=$(python3 "$SLICE/release_0026_live.py" routes "$RB/routes.json" "$RUN/routes-after.json")
check "2 $NEW_ROUTE_COUNT new routes, all JWT; every earlier route unchanged" "$r" "$(jq length "$RB/routes.json") -> $(jq length "$RUN/routes-after.json") routes"

codes=""; r=ok
for p in /v1/clients /v1/caregivers /v1/assignments; do
  c=$(curl -s -o /dev/null -w '%{http_code}' "${API%/}$p"); codes="$codes $p=$c"; [[ "$c" == 401 ]] || r=no
done
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${API%/}/v1/caregivers/00000000-0000-4000-8000-000000000000/invitation")
codes="$codes invitation=$c"; [[ "$c" == 401 ]] || r=no
check "3 new routes refuse requests without sign-in (401), the invitation route included" "$r" "${codes# }"

FNCFG2=$(aws lambda get-function-configuration --function-name "$FN" --output json)
HANDLER_KEY='.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key | startswith("Handler"))) | .value.Properties.Code.S3Key'
LIVE_KEY=$(aws cloudformation get-template --stack-name "$API_STACK" --template-stage Original --query TemplateBody --output json | jq -r "$HANDLER_KEY")
BUILD_KEY=$(jq -r "$HANDLER_KEY" "$HERE/cdk.out/$API_STACK.template.json")
NEW_SHA=$(jq -r .CodeSha256 <<<"$FNCFG2")
[[ "$LIVE_KEY" == "$BUILD_KEY" && "$NEW_SHA" != "$(jq -r .CodeSha256 "$RB/lambda.json")" \
   && "$(jq -r .Environment.Variables.IDENTITY_FUNCTION_NAME <<<"$FNCFG2")" == "$IDENTITY_FN" \
   && "$(jq -r .Environment.Variables.DB_NAME <<<"$FNCFG2")" == "$DB_NAME" ]] && r=ok || r=no
check "4 API Lambda runs this build; IDENTITY_FUNCTION_NAME set; still serves $DB_NAME" "$r" "CodeSha256 ${NEW_SHA:0:12}…"

PV=$(aws iam get-policy --policy-arn "$POLICY_ARN" --query Policy.DefaultVersionId --output text)
aws iam get-policy-version --policy-arn "$POLICY_ARN" --version-id "$PV" --query PolicyVersion.Document --output json > "$RUN/handler-policy-after.json"
IDENTITY_ARN=$(aws lambda get-function-configuration --function-name "$IDENTITY_FN" --query FunctionArn --output text 2>/dev/null || echo missing)
r=$(python3 "$SLICE/release_0026_live.py" handler-policy "$RB/handler-policy.json" "$RUN/handler-policy-after.json" "$IDENTITY_ARN")
check "5 Handler policy = previous statements + exactly InvokeIdentityAdmin on $IDENTITY_FN" "$r" "policy version $PV"

aws lambda get-function-configuration --function-name "$IDENTITY_FN" --output json > "$RUN/identity-fn.json" 2>/dev/null || echo '{}' > "$RUN/identity-fn.json"
IROLE=$(jq -r '.Role // "" | split("/") | last' "$RUN/identity-fn.json")
r=no
if [[ -n "$IROLE" ]]; then
  aws iam list-attached-role-policies --role-name "$IROLE" --query 'AttachedPolicies[].PolicyArn' --output json > "$RUN/identity-attached.json"
  aws iam list-role-policies --role-name "$IROLE" --query 'PolicyNames' --output json > "$RUN/identity-inline.json"
  if [[ "$(jq length "$RUN/identity-attached.json")" == 1 && "$(jq length "$RUN/identity-inline.json")" == 0 ]]; then
    IPA=$(jq -r '.[0]' "$RUN/identity-attached.json")
    IPV=$(aws iam get-policy --policy-arn "$IPA" --query Policy.DefaultVersionId --output text)
    aws iam get-policy-version --policy-arn "$IPA" --version-id "$IPV" --query PolicyVersion.Document --output json > "$RUN/identity-policy.json"
    r=$(python3 "$SLICE/release_0026_live.py" identity "$RUN/identity-fn.json" "$RUN/identity-policy.json")
  fi
fi
check "6 identity function: outside the VPC, pool id its only setting, only Cognito create/get on the one pool" "$r" "role ${IROLE:-missing}"

aws ec2 describe-vpc-endpoints --filters "Name=service-name,Values=com.amazonaws.$REGION.lambda" Name=vpc-id,Values=vpc-0ee9df0c38297cbc1 --output json > "$RUN/lambda-endpoint.json"
aws ec2 describe-vpc-endpoints --filters "Name=service-name,Values=com.amazonaws.$REGION.s3" Name=vpc-id,Values=vpc-0ee9df0c38297cbc1 --output json > "$RUN/s3-endpoint.json"
r=$(python3 "$SLICE/release_0026_live.py" endpoints "$RUN/lambda-endpoint.json" "$RUN/s3-endpoint.json")
check "7 Lambda endpoint available (1 AZ, private DNS, identity function only); S3 endpoint allows the 3 key shapes" "$r"

OUT="$RUN/identity-probe.json"
aws lambda invoke --function-name "$IDENTITY_FN" --cli-binary-format raw-in-base64-out \
  --payload '{"action":"check","email":"not-an-email"}' "$OUT" >/dev/null 2>&1 || echo '{}' > "$OUT"
[[ "$(jq -c . "$OUT" 2>/dev/null)" == '{"ok":false,"error":"invalid_email"}' ]] && r=ok || r=no
check "8 identity function answers and refuses bad input before calling Cognito (no user created)" "$r"

r=no; grep -q '^PASS .*latest_migration_is_0026' "$RUN/db-verify.txt" && grep -q '^PASS .*migration_count_is_26' "$RUN/db-verify.txt" \
  && ! grep -q '^FAIL' "$RUN/db-verify.txt" && r=ok
check "9 database at 0026 (0001-0021 checksums unchanged), db:verify all PASS, accounts and records kept" "$r" "$(grep -c '^PASS' "$RUN/db-verify.txt") checks; $(cat "$RB/keep-before.txt" 2>/dev/null)"

SERVED=$(curl -fsS "${WEB%/}/index.html" | sha256sum | cut -d' ' -f1 || true)
[[ "$SERVED" == "$(sha256sum "$RUN/web-build/index.html" | cut -d' ' -f1)" ]] && r=ok || r=no
CFG=$(curl -fsS "${WEB%/}/config.json" | sha256sum | cut -d' ' -f1 || true)
[[ "$CFG" == "$(sha256sum "$RB/web/config.json" | cut -d' ' -f1)" ]] || r=no
check "10 the web URL serves this build; config.json unchanged" "$r"

[[ "$(admin_host_groups | tr -s ' \t' '\n' | sort | xargs)" == "$(tr -s ' \t' '\n' < "$RB/admin-host-sgs.txt" | grep -v "^$APP_SG$" | sort | xargs)" ]] && r=ok || r=no
check "11 DB window closed: admin host groups are back to the original" "$r" "$(admin_host_groups)"

SS=$(aws rds describe-db-snapshots --db-snapshot-identifier "$SNAPSHOT_ID" --query 'DBSnapshots[0].Status' --output text 2>/dev/null || echo missing)
[[ "$SS" == available ]] && r=ok || r=no
check "12 pre-deploy snapshot available" "$r" "$SNAPSHOT_ID"
echo "Live verification: $PASSES/$TOTAL PASS" | tee -a "$VERIFY"

cat > "$RUN/REPORT.md" <<EOF
# Ogevia AWS TEST release 0022-0026: deployment report

- Code: $COMMIT (pinned); approved $APPROVED_AT
- Snapshot: $SNAPSHOT_ID
- Database $DB_NAME: ledger 0001-0026; existing visits unchanged; accounts and records kept: $(cat "$RB/keep-before.txt")
- API: $(jq length "$RB/routes.json") -> $(jq length "$RUN/routes-after.json") routes; identity function $IDENTITY_FN
- Network: Lambda interface endpoint (1 AZ); S3 endpoint policy covers documents and logo
- Web: $WEB (config.json unchanged)
- Live verification: $PASSES/$TOTAL PASS
- Rollback material: $RB
EOF
cat "$RUN/REPORT.md"
[[ "$FAILS" == 0 ]] || die "live verification failed ($FAILS of $TOTAL). The deployment stays in place for diagnosis; send $VERIFY to Claude"
done_ verified

# ----------------------------------------------------------------------------
phase "12/12 Optional: synthetic client names (TEST only)"
if ! is_done seeded; then
  echo "This gives the synthetic clients of agency scs-pilot-synthetic obviously synthetic names"
  echo "(\"Synthetic Client Alpha\", ...) so the calendar print can be checked. It refuses any other database."
  read -r -p "Type SEED to add them now (anything else skips; you can re-run later): " answer || answer=""
  if [[ "$answer" == SEED ]]; then
    trap 'rc=$?; trap - ERR; db_window_close; (exit $rc); on_exit' EXIT
    trap 'db_window_close; die "unexpected error on line $LINENO (command: $BASH_COMMAND)"' ERR
    db_window_open
    psql -X -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$HERE/db/deploy/05_seed_synthetic_client_names.sql" | tail -3
    db_window_close
    trap on_exit EXIT
    trap 'die "unexpected error on line $LINENO (command: $BASH_COMMAND)"' ERR
    admin_host_groups | grep -qw "$APP_SG" && die "$APP_SG is still attached to $IID: remove it in the EC2 console"
    done_ seeded
    echo "Synthetic names added; DB window closed."
  else
    echo "Skipped."
  fi
fi
done_ complete
cat <<EOF

==============================================
OGEVIA 0022-0026 DEPLOYED AND VERIFIED (TEST)
==============================================
Web URL: $WEB
Next: the screen checks in docs/aws/DEPLOYMENT_PLAN_0022_0026.md section 6 (synthetic data only).
Report: $RUN/REPORT.md   Verification: $VERIFY
EOF
