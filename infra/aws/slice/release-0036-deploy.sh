#!/usr/bin/env bash
# =============================================================================
# Ogevia AWS TEST release 0027-0036: continuity pack, outage visit records,
# billing rounding, hire type / scheduling / family relationship, visit review,
# shift-card and refusal wording fix, document reminders + one Needs attention
# definition, recurring shifts, daylight-saving refusals (0035), missing-
# signature recovery (0036). Base: release 0022-0026 (0ca5616) live.
#
# Changes (all checked by release_0036_gate.py and its self-test):
#   DB       migrations 0027-0036 on ogevia_sv_test (one transaction each)
#   API      30 JWT routes + 2 owner-approved public visit-confirmation link
#            routes on the existing integration (no invoke permission
#            added); Handler code package only (identity function: code only,
#            if its bundle changed). NO new resource, NO new fixed cost.
#   Web      matching build (config.json kept)
#   NOT changed: NetworkEgress, EvidenceStorage, Observability, WebHosting
#   stacks; IAM policies; environment variables.
#
# Everything before the single DEPLOY prompt is read-only. After DEPLOY:
# snapshot, one DB window, API stack, web files, then read-only live checks.
# Re-running resumes (state in ~/ogevia-release-0036-run; earlier run folders
# are never written). TEST ONLY, SYNTHETIC DATA ONLY.
#
# Never: Netlify/Supabase/DNS, Cognito, config.json, the other four stacks,
# RDS security-group rules, deleting anything, modifying an applied migration
# (ledger checksums must match).
# =============================================================================
set -Eeuo pipefail

export OGEVIA_PILOT_RUN_DIR="${OGEVIA_RELEASE_RUN_DIR:-$HOME/ogevia-release-0036-run}"
# shellcheck source=pilot-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/pilot-lib.sh"
FINAL_MIGRATION=0036
BASE_MIGRATION=0026
NEW_ROUTE_COUNT=32

IDENTITY_FN=Ogevia-prod-IdentityAdmin
PIN="${OGEVIA_RELEASE_PIN:-}"
SNAPSHOT_ID=ogevia-prod-postgres-pre-0036-$(date -u +%Y%m%d)
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
KEEP_SQL="select (select count(*) from ogevia.app_users) || ' users, ' || (select count(*) from ogevia.organization_memberships) || ' memberships (' || (select count(*) from ogevia.organization_memberships where status = 'active') || ' active), ' || (select count(*) from ogevia.caregiver_records) || ' caregiver records, ' || (select count(*) from ogevia.clients) || ' clients, ' || (select count(*) from ogevia.client_authorizations) || ' authorizations, ' || (select count(*) from ogevia.caregiver_assignments) || ' assignments (' || (select count(*) from ogevia.caregiver_assignments where caregiver_user_id is not null) || ' with access), ' || (select count(*) from ogevia.billing_approvals) || ' billing approvals, ' || (select count(*) from ogevia.shifts) || ' shifts, ' || (select count(*) from ogevia.authorization_reservations where released_at is null) || ' held reservations, ' || (select count(*) from ogevia.staff_documents) || ' staff documents'"

# ----------------------------------------------------------------------------
phase "1/11 Prerequisites and the pinned code"
for t in aws node npx python3 jq curl git; do command -v "$t" >/dev/null || die "missing tool: $t"; done
[[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]] || die "Node.js >= 20 required (found $(node -v))"
if ! command -v psql >/dev/null; then sudo dnf install -y -q postgresql15 >/dev/null || die "could not install psql"; fi
if ! command -v session-manager-plugin >/dev/null; then
  sudo dnf install -y -q https://s3.amazonaws.com/session-manager-downloads/plugin/latest/linux_64bit/session-manager-plugin.rpm >/dev/null \
    || die "could not install session-manager-plugin"
fi
[[ "$PIN" =~ ^[0-9a-f]{40}$ ]] || die "OGEVIA_RELEASE_PIN is not a full commit id; start from release-0036-bootstrap.sh"
COMMIT=$(git -C "$REPO" rev-parse HEAD)
[[ "$COMMIT" == "$PIN" ]] || die "the checkout is at $COMMIT, not the pinned $PIN"
DIRTY=$(git -C "$REPO" status --porcelain --untracked-files=no)
[[ -z "$DIRTY" ]] || die "the checkout has local changes: $DIRTY"
for v in 0027 0028 0029 0030 0031 0032 0033 0034 0035 0036; do ls "$HERE/db/migrations/${v}_"*.sql >/dev/null 2>&1 || die "migration $v missing"; done
[[ "$(ls "$HERE/db/migrations" | tail -1)" == ${FINAL_MIGRATION}_* ]] || die "unexpected newest migration: $(ls "$HERE/db/migrations" | tail -1)"
echo "Code: $(git -C "$REPO" log --oneline -1) (pinned, clean)"
printf 'aws %s | node %s | %s\n' "$(aws --version 2>&1 | cut -d' ' -f1)" "$(node -v)" "$(psql --version)"

# ----------------------------------------------------------------------------
phase "2/11 AWS identity"
ARN=$(aws sts get-caller-identity --query Arn --output text) || die "AWS credentials are not valid: sign in again and reopen CloudShell"
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT" ]] || die "wrong AWS account (expected $ACCOUNT)"
[[ "$ARN" == *AdministratorAccess* ]] || die "this needs the AdministratorAccess role (current: $ARN)"
echo "Account $ACCOUNT, region $REGION, AdministratorAccess: OK"

# ----------------------------------------------------------------------------
phase "3/11 Read-only inventory and pilot preconditions"
load_rds_and_host
[[ "$(jq -r .DBInstanceStatus <<<"$RDS")" == available ]] || die "RDS is $(jq -r .DBInstanceStatus <<<"$RDS")"
[[ "$(jq -r .PubliclyAccessible <<<"$RDS")" == false ]] || die "RDS is publicly accessible: stop and review"
[[ "$(jq -r .StorageEncrypted <<<"$RDS")" == true ]] || die "RDS storage is not encrypted"
for s in "${STACKS[@]}"; do
  st=$(aws cloudformation describe-stacks --stack-name "$s" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo MISSING)
  [[ "$st" == CREATE_COMPLETE || "$st" == UPDATE_COMPLETE ]] || die "$s is $st (this workflow never creates or repairs stacks)"
done
# The API handler by logical id (the stack gains a second function in this release).
FN=$(aws cloudformation list-stack-resources --stack-name "$API_STACK" --output json | jq -r '[.StackResourceSummaries[] | select(.ResourceType == "AWS::Lambda::Function" and (.LogicalResourceId | startswith("Handler")))] | if length == 1 then .[0].PhysicalResourceId else "" end')
FNCFG=$(aws lambda get-function-configuration --function-name "$FN" --output json)
[[ "$(jq -r '.Environment.Variables.DB_NAME // empty' <<<"$FNCFG")" == "$DB_NAME" ]] || die "the API Lambda does not serve $DB_NAME"
API_ID=$(aws cloudformation list-stack-resources --stack-name "$API_STACK" --output json | jq -r '[.StackResourceSummaries[] | select(.ResourceType == "AWS::ApiGatewayV2::Api" and (.LogicalResourceId | startswith("")))] | if length == 1 then .[0].PhysicalResourceId else "" end')
POLICY_ARN=$(aws cloudformation list-stack-resources --stack-name "$API_STACK" --output json | jq -r '[.StackResourceSummaries[] | select(.ResourceType == "AWS::IAM::ManagedPolicy" and (.LogicalResourceId | startswith("HandlerPolicy")))] | if length == 1 then .[0].PhysicalResourceId else "" end')
WEB=$(out Ogevia-prod-WebHosting WebOrigin); BUCKET=$(out Ogevia-prod-WebHosting SiteBucketName)
DIST=$(out Ogevia-prod-WebHosting DistributionId); API=$(out "$API_STACK" ApiUrl)
for v in WEB BUCKET DIST API API_ID POLICY_ARN; do [[ -n "${!v}" && "${!v}" != None ]] || die "missing $v"; done
ALIASES=$(aws cloudfront get-distribution-config --id "$DIST" --query 'DistributionConfig.Aliases.Items' --output text)
[[ "$ALIASES" == None || -z "$ALIASES" ]] || die "the TEST web distribution serves a custom domain ($ALIASES); review first"
LIVE_ROUTES=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query 'Items[].[RouteKey,AuthorizationType]' --output json)
jq -e 'map(.[0]) | index("GET /v1/shifts")' <<<"$LIVE_ROUTES" >/dev/null \
  || die "GET /v1/shifts is not live: release 0022-0026 is not the base; deploy it first"
aws lambda get-function-configuration --function-name "$IDENTITY_FN" >/dev/null 2>&1 \
  || die "$IDENTITY_FN not found: release 0022-0026 is not the base"
[[ "$(aws lambda get-policy --function-name "$FN" --query Policy --output text | jq '.Statement | length')" == 1 ]] \
  || die "the API Lambda does not have the single API-scoped invoke permission: stop and review"
jq -e 'map(.[0]) | index("GET /v1/shift-series") | not' <<<"$LIVE_ROUTES" >/dev/null || echo "Note: GET /v1/shift-series is already live (resuming after the API deploy)."
echo "RDS $RDS_ID available, private, encrypted. Stacks complete. Lambda serves $DB_NAME."
echo "API $API_ID: $(jq length <<<"$LIVE_ROUTES") live routes, release 0022-0026 present. Web $WEB (no custom domain)."

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
phase "4/11 Quality gate, synth and web build of the pinned code"
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
(cd "$REPO/apps/web" && VITE_APP_ENV=test VITE_AUTH_PROVIDER=cognito npx vite build --outDir "$RUN/web-build" --emptyOutDir >/dev/null) \
  || die "web build failed"
rm -f "$RUN/web-build/config.json"   # the live config.json is kept as it is
assert_test_web_label "$RUN/web-build"
mkdir -p "$RUN/built-templates" && cp "$HERE/cdk.out/"*.template.json "$RUN/built-templates/"   # the approved build, for a later verify-only rerun
echo "Lint, typecheck, unit tests, build, synth, web build: OK"

# ----------------------------------------------------------------------------
phase "5/11 Capture rollback material (read-only)"
if ! is_done rollback-captured; then
  cp "$RUN/live-templates/"*.json "$RB/templates/"
  jq '{FunctionName, CodeSha256, LastModified, Runtime, MemorySize, Timeout, DB_NAME: .Environment.Variables.DB_NAME}' <<<"$FNCFG" > "$RB/lambda.json"
  jq 'del(.CodeSha256, .LastModified, .Version, .RevisionId, .LastUpdateStatus, .State)' <<<"$FNCFG" > "$RB/handler-config.json"
  aws lambda get-function-configuration --function-name "$IDENTITY_FN" --output json \
    | jq 'del(.CodeSha256, .LastModified, .Version, .RevisionId, .LastUpdateStatus, .State)' > "$RB/identity-config.json"
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
phase "6/11 Strict scope gate: live templates vs this build"
TEMPLATE_BASE="$RB/templates"   # always the pre-deploy capture, also when resuming
python3 "$SLICE/release_0036_gate_selftest.py" --cdk-out "$HERE/cdk.out" --deployed "$TEMPLATE_BASE" | tail -1 | grep -q 'Gate self-test: PASS' \
  || die "the scope gate self-test failed (the gate would not catch a tampered change)"
python3 "$SLICE/release_0036_gate.py" --cdk-out "$HERE/cdk.out" --deployed "$TEMPLATE_BASE" --summary "$RUN/scope-gate.txt" \
  || die "the change set is outside the approved scope (see above); nothing was changed"
echo "Gate self-test: PASS (refuses every tampered variant of this exact build)"

# ----------------------------------------------------------------------------
phase "7/11 APPROVAL (the only approval for the deployment)"
if ! is_done approved; then
  [[ -t 0 ]] || die "approval needs an interactive terminal"
  cat <<EOF

Exactly this will change in AWS TEST (account $ACCOUNT, $REGION), commit ${COMMIT:0:12}:
  1. RDS snapshot $SNAPSHOT_ID of $RDS_ID (kept until you delete it).
  2. DB window: $APP_SG is attached to admin host $IID, then its original groups are restored.
     On $DB_NAME only: the ledger must be exactly 0001-$BASE_MIGRATION with matching checksums
     (no applied migration is modified); migrations 0027-0036 are applied (one transaction
     each); db:verify must pass. Every existing row of every 0026 table must be unchanged
     BY VALUE (all 0026 columns); permissions = today's plus exactly the 2 permissions and
     3 role grants 0027-0036 add; earlier audit rows unchanged. Otherwise it stops before
     the API and web are changed.
  3. $API_STACK: 30 JWT routes + 2 public visit-confirmation link routes (token + phone
     code; approved 10/05/2026) on the existing integration (covered by the existing single
     API-scoped invoke permission; none added); Handler code package (and the identity
     function's code package if its bundle changed). No IAM policy, environment or resource change.
  4. Web: new files to $BUCKET (config.json NOT changed), CloudFront $DIST invalidated.
  5. Read-only live checks.
NEW FIXED COST: none. Not touched: Cognito, Netlify, Supabase, DNS, RDS SG rules, the other 4 stacks.
Rollback: docs/aws/DEPLOYMENT_PLAN_0027_0036.md section 5 (material in $RB).
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
phase "8/11 Backup: RDS snapshot"
if ! is_done snapshot; then
  SNAPSHOT_ID=$(jq -r .snapshot "$RB/MANIFEST.json")
  if ! aws rds describe-db-snapshots --db-snapshot-identifier "$SNAPSHOT_ID" >/dev/null 2>&1; then
    aws rds create-db-snapshot --db-instance-identifier "$RDS_ID" --db-snapshot-identifier "$SNAPSHOT_ID" \
      --tags Key=purpose,Value=pre-0036-rollback >/dev/null
  fi
  echo "Waiting for $SNAPSHOT_ID (usually 5-15 minutes)..."
  aws rds wait db-snapshot-available --db-snapshot-identifier "$SNAPSHOT_ID" || die "snapshot did not complete"
  done_ snapshot
fi
SNAPSHOT_ID=$(jq -r .snapshot "$RB/MANIFEST.json")
echo "Snapshot $SNAPSHOT_ID: available"

# ----------------------------------------------------------------------------
phase "9/11 DB window: migrations 0027-0036 and verification"
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
  # Value fingerprint of every existing row (all 0026 columns), permissions and audit log.
  if [[ ! -f "$RB/records-before.txt" ]]; then
    Q -d "$DB_NAME" -f <(python3 "$SLICE/release_0036_records.py" snapshot-sql "$SLICE/release-0036-expected") > "$RB/records-before.tmp"
    mv "$RB/records-before.tmp" "$RB/records-before.txt"
  fi
  echo "Record values captured: $(grep -c '^table ' "$RB/records-before.txt") tables, $(grep -c '^rp ' "$RB/records-before.txt") role permissions, audit rows up to id $(grep '^audit ' "$RB/records-before.txt" | cut -d' ' -f2)"

  done_ migrate-started
  OGEVIA_DATABASE_URL="$DBURL" npx --prefix "$HERE" tsx "$HERE/db/scripts/migrate.ts" \
    || die "a migration failed (that migration rolled back; earlier ones stay applied). Re-run to resume"
  OGEVIA_DATABASE_URL="$DBURL" npx --prefix "$HERE" tsx "$HERE/db/scripts/verify.ts" | tee "$RUN/db-verify.txt" \
    || die "schema verification failed"
  grep -q '^FAIL' "$RUN/db-verify.txt" && die "schema verification reported FAIL"
  Q -d "$DB_NAME" -F' ' -c "select version, checksum from ogevia_meta.schema_migrations order by version" > "$RUN/ledger-after.txt"
  [[ "$(cut -d' ' -f1 "$RUN/ledger-after.txt" | paste -sd,)" == "$(seq -f '%04g' 1 36 | paste -sd,)" ]] || die "ledger after is not 0001-0036"
  while read -r v sum; do
    [[ "$(grep "^$v " "$RUN/ledger-before.txt" | cut -d' ' -f2)" == "$sum" ]] || die "applied migration $v changed its checksum"
  done < <(grep -E '^00(0[1-9]|1[0-9]|2[0-6]) ' "$RUN/ledger-after.txt")
  AFTER=$(Q -d "$DB_NAME" -c "$FP_SQL" | tail -1)
  [[ "$AFTER" == "$(cat "$RB/visit-fingerprint-before.txt")" ]] \
    || die "existing visits changed during migration ($AFTER). Stop; see the rollback section of the plan"
  echo "Existing visits unchanged (id, Time In/Out, signed time, status): OK"
  KEEP_AFTER=$(Q -d "$DB_NAME" -c "$KEEP_SQL")
  [[ "$KEEP_AFTER" == "$(cat "$RB/keep-before.txt")" ]] \
    || die "accounts or records changed during migration: before $(cat "$RB/keep-before.txt"); after $KEEP_AFTER. Stop; see the rollback section"
  echo "Existing users, memberships, records, assignments and approvals unchanged: OK ($KEEP_AFTER)"
  Q -d "$DB_NAME" -f <(python3 "$SLICE/release_0036_records.py" snapshot-sql "$SLICE/release-0036-expected") > "$RUN/records-after.txt"
  Q -d "$DB_NAME" -f <(python3 "$SLICE/release_0036_records.py" audit-sql "$SLICE/release-0036-expected" "$(grep '^audit ' "$RB/records-before.txt" | cut -d' ' -f2)") > "$RUN/audit-prefix.txt"
  RECORDS=$(python3 "$SLICE/release_0036_records.py" compare "$RB/records-before.txt" "$RUN/records-after.txt" "$SLICE/release-0036-expected" "$RUN/audit-prefix.txt") \
    || die "existing record values changed during migration: $RECORDS. The API and web were NOT changed; see the rollback section"
  echo "$RECORDS" > "$RUN/records-compare.txt"
  echo "Record values: $RECORDS"
  db_window_close
  trap on_exit EXIT
  trap 'die "unexpected error on line $LINENO (command: $BASH_COMMAND)"' ERR
  admin_host_groups | grep -qw "$APP_SG" && die "$APP_SG is still attached to $IID: remove it in the EC2 console"
  done_ db-window
fi
echo "DB window closed; admin host groups: $(admin_host_groups)"

# ----------------------------------------------------------------------------
phase "10/11 Deploy the API stack and the web files"
if ! is_done api-deployed; then
  mkdir -p "$RUN/predeploy-templates"
  for s in "${STACKS[@]}"; do
    aws cloudformation get-template --stack-name "$s" --template-stage Original --query TemplateBody --output json > "$RUN/predeploy-templates/$s.json"
  done
  python3 "$SLICE/release_0036_gate.py" --cdk-out "$HERE/cdk.out" --deployed "$RUN/predeploy-templates" >/dev/null \
    || die "AWS changed since approval (the scope gate no longer passes); nothing deployed"
  # --require-approval never is safe ONLY because the strict gate just proved
  # the change set equals the approved scope for this exact cdk.out.
  (cd "$HERE" && npx cdk deploy --app cdk.out --exclusively "$API_STACK" --require-approval never --no-notices) \
    || die "stack deployment failed (CloudFormation rolls the failed stack back automatically); run release-0036-rollback.sh status"
  [[ "$(aws lambda get-function-configuration --function-name "$FN" --query 'Environment.Variables.DB_NAME' --output text)" == "$DB_NAME" ]] \
    || die "the deployed Lambda no longer points at $DB_NAME"
  done_ api-deployed
fi
if ! is_done web-deployed; then
  W="$RUN/web-build"
  assert_test_web_label "$W"; assert_live_config_label "$WEB"
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
phase "11/11 Live verification (read-only)"
# shellcheck source=release-0036-live-checks.sh
source "$SLICE/release-0036-live-checks.sh"
BUILD_DIR="$HERE/cdk.out"
live_checks
write_report
[[ "$FAILS" == 0 ]] || die "live verification failed ($FAILS of $TOTAL). The deployment stays in place for diagnosis; send $VERIFY to Claude"
done_ verified

done_ complete
cat <<EOF

==============================================
OGEVIA 0027-0036 DEPLOYED AND VERIFIED (TEST)
==============================================
Web URL: $WEB
Next: the retest batch in docs/aws/DEPLOYMENT_PLAN_0027_0036.md section 6 (synthetic data only).
Report: $RUN/REPORT.md   Verification: $VERIFY
EOF
