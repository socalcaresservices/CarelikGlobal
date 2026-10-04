#!/usr/bin/env bash
# =============================================================================
# Preflight (MODE=pre) and post-check (MODE=post) for the pinned 1a39dd5
# increment. Run from increment-resume-block.sh; never deploys anything.
#
#   bash increment-preflight.sh pre  <pinned checkout> <tools dir>
#   bash increment-preflight.sh post <pinned checkout> <tools dir>
#
# Facts gathered (read-only, except the usual temporary DB window, which is
# always closed and verified):
#   * migration ledger: contiguous, every checksum equal to the pinned files;
#   * database objects: every function body and every column equal to the
#     fingerprints generated from the pinned migrations at that ledger version;
#   * TEST database: the API Lambda serves ogevia_sv_test, which holds exactly
#     the two synthetic agencies;
#   * API routes: exact route set, public/JWT authorisation per route, the one
#     JWT authorizer (issuer, audience) and the one integration;
#   * API Lambda: the running code equals the asset its CloudFormation template
#     names (SHA-256 of the asset file), its environment equals the template's,
#     and it is either the pilot code (prefix recorded by the pilot run in
#     ~/ogevia-pilot-run/REPORT.md) or this build (its cdk.out);
#   * web: the bucket's index.html and the served index.html are identical and
#     equal either the pilot build (~/ogevia-pilot-run/web-build) or this build;
#     anything that cannot be fetched or matched is UNKNOWN and stops the run;
#   * records: in a fresh run, a value fingerprint of every existing row of every
#     0018 table (all columns), the permission rows and the audit log.
# MODE=pre decides with increment_preflight.py decide: FRESH, RESUME (only the
# supported recovery states), COMPLETE (exit 3) or STOP. MODE=post requires the
# finished increment: ledger and objects at 0021, 1a39dd5 routes, Lambda and
# web of this build, and every existing record unchanged by value.
# =============================================================================
set -Eeuo pipefail
MODE=$1; SRC=$2; TOOLS=$3
export OGEVIA_PILOT_RUN_DIR="${OGEVIA_PREFLIGHT_RUN_DIR:-$HOME/ogevia-increment-preflight}"
# shellcheck disable=SC1091
source "$SRC/infra/aws/slice/pilot-lib.sh"
PIN=$(git -C "$SRC" rev-parse HEAD)
INC="$HOME/ogevia-increment-run"
PILOTRUN="$HOME/ogevia-pilot-run"
EXP="$TOOLS/increment-preflight-expected"
PY=(python3 "$TOOLS/increment_preflight.py")
LOG="$RUN/$MODE-$(date -u +%Y%m%dT%H%M%SZ).log"
F="$RUN/facts-$MODE"; rm -rf "$F"; mkdir -p "$F"
exec 3>&1
exec > >(tee -a "$LOG") 2>&1
trap 'db_window_close' EXIT
trap 'db_window_close; die "unexpected error on line $LINENO (command: $BASH_COMMAND)"' ERR
for t in aws jq python3 curl openssl git; do command -v "$t" >/dev/null || die "missing tool: $t"; done
if ! command -v psql >/dev/null; then sudo dnf install -y -q postgresql15 >/dev/null || die "could not install psql"; fi
if ! command -v session-manager-plugin >/dev/null; then
  sudo dnf install -y -q https://s3.amazonaws.com/session-manager-downloads/plugin/latest/linux_64bit/session-manager-plugin.rpm >/dev/null \
    || die "could not install session-manager-plugin"
fi
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT" ]] || die "wrong AWS account (expected $ACCOUNT)"
fact() { printf '%s' "$2" > "$F/$1"; }

# ---------------------------------------------------------------------------
phase "Preflight ($MODE) 1/4: API routes and their authorisation"
API_ID=$(aws cloudformation describe-stack-resources --stack-name "$API_STACK" \
  --query "StackResources[?ResourceType=='AWS::ApiGatewayV2::Api'].PhysicalResourceId | [0]" --output text)
aws apigatewayv2 get-routes --api-id "$API_ID" --output json \
  --query 'Items[].{RouteKey:RouteKey,AuthorizationType:AuthorizationType,AuthorizerId:AuthorizerId,Target:Target}' > "$F/routes.json"
aws apigatewayv2 get-authorizers --api-id "$API_ID" --query Items --output json > "$F/authorizers.json"
aws apigatewayv2 get-integrations --api-id "$API_ID" --query Items --output json > "$F/integrations.json"
ROUTES_DETAIL=$("${PY[@]}" routes "$F/routes.json" "$F/authorizers.json" "$F/integrations.json" "$SRC") && ROUTES_OK=true || ROUTES_OK=false
ROUTES=${ROUTES_DETAIL%%:*}
echo "API routes: $ROUTES_DETAIL"

# ---------------------------------------------------------------------------
phase "Preflight ($MODE) 2/4: API Lambda code and settings"
FN=$(aws cloudformation describe-stack-resources --stack-name "$API_STACK" \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function' && starts_with(LogicalResourceId, 'Handler')].PhysicalResourceId | [0]" --output text)
aws lambda get-function-configuration --function-name "$FN" --output json > "$F/lambda.json"
aws cloudformation get-template --stack-name "$API_STACK" --template-stage Original --query TemplateBody --output json > "$F/api-template.json"
SHA=$(jq -r .CodeSha256 "$F/lambda.json")
KEY=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key | startswith("Handler")))][0].value.Properties.Code.S3Key // empty' "$F/api-template.json")
ASSET_SHA=$(aws s3 cp "s3://cdk-hnb659fds-assets-$ACCOUNT-$REGION/$KEY" - 2>/dev/null | openssl dgst -sha256 -binary | base64 || true)
ENV_OK=$(python3 - "$F/lambda.json" "$F/api-template.json" <<'PY'
import json, sys
live = (json.load(open(sys.argv[1])).get("Environment") or {}).get("Variables") or {}
t = json.load(open(sys.argv[2]))["Resources"]
h = [r for k, r in t.items() if r["Type"] == "AWS::Lambda::Function" and k.startswith("Handler")][0]
want = (h["Properties"].get("Environment") or {}).get("Variables") or {}
ok = set(live) == set(want) and all(live[k] == v for k, v in want.items() if isinstance(v, str))
print("yes" if ok else "no")
PY
)
PILOT_PREFIX=$(grep -oE 'Lambda code [A-Za-z0-9+/=]{12}' "$PILOTRUN/REPORT.md" 2>/dev/null | head -1 | cut -c13- || true)
PILOT_COMMIT=$(grep '^commit=' "$PILOTRUN/APPROVAL.txt" 2>/dev/null | cut -d= -f2 || true)
BUILD_KEY=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key | startswith("Handler")))][0].value.Properties.Code.S3Key // empty' \
  "$SRC/infra/aws/cdk.out/$API_STACK.template.json" 2>/dev/null || true)
LAMBDA=UNKNOWN; LDETAIL=""
if [[ -z "$KEY" || -z "$ASSET_SHA" || "$ASSET_SHA" != "$SHA" ]]; then
  LAMBDA=OTHER; LDETAIL="the running code is not the asset its CloudFormation template names (template ${KEY:0:12}…, code ${SHA:0:12}…, asset ${ASSET_SHA:-unreadable})"
elif [[ "$ENV_OK" != yes ]]; then
  LAMBDA=OTHER; LDETAIL="the Lambda settings differ from its CloudFormation template"
elif [[ -n "$BUILD_KEY" && "$KEY" == "$BUILD_KEY" ]]; then
  LAMBDA=BUILD; LDETAIL="this 1a39dd5 build (asset ${KEY:0:12}…)"
elif [[ -n "$PILOT_PREFIX" && "$PILOT_COMMIT" == 87a9be2* && "$SHA" == "$PILOT_PREFIX"* ]]; then
  LAMBDA=PILOT; LDETAIL="the pilot code recorded by the pilot run (${PILOT_PREFIX}…, commit ${PILOT_COMMIT:0:7})"
elif [[ -z "$PILOT_PREFIX" || "$PILOT_COMMIT" != 87a9be2* ]]; then
  LAMBDA=UNKNOWN; LDETAIL="no pilot evidence in $PILOTRUN (REPORT.md Lambda code and APPROVAL.txt commit 87a9be2 are needed to recognise the pilot code)"
elif [[ -d "$INC/state" ]] && grep -q "^commit=$PIN$" "$INC/APPROVAL.txt" 2>/dev/null; then
  LAMBDA=TEMPLATE; LDETAIL="code equals the current CloudFormation template, not the pilot; this build's output is not on disk yet"
else
  LAMBDA=OTHER; LDETAIL="neither the pilot code (${PILOT_PREFIX}…) nor this build"
fi
echo "API Lambda: $LAMBDA - $LDETAIL; CodeSha256 ${SHA:0:12}…; database $(jq -r '.Environment.Variables.DB_NAME // "none"' "$F/lambda.json")"

# ---------------------------------------------------------------------------
phase "Preflight ($MODE) 3/4: web build"
WEB=$(out Ogevia-prod-WebHosting WebOrigin); BUCKET=$(out Ogevia-prod-WebHosting SiteBucketName)
SERVED=$(curl -fsS --max-time 20 "${WEB%/}/index.html" 2>/dev/null | sha256sum | cut -d' ' -f1 || true)
STORED=$(aws s3 cp "s3://$BUCKET/index.html" - 2>/dev/null | sha256sum | cut -d' ' -f1 || true)
EMPTY=$(printf '' | sha256sum | cut -d' ' -f1)
PILOT_WEB=$(sha256sum "$PILOTRUN/web-build/index.html" 2>/dev/null | cut -d' ' -f1 || true)
BUILD_WEB=$(sha256sum "$INC/web-build/index.html" 2>/dev/null | cut -d' ' -f1 || true)
if [[ -z "$SERVED" || "$SERVED" == "$EMPTY" || -z "$STORED" || "$STORED" == "$EMPTY" ]]; then
  WEBSTATE=UNKNOWN; WDETAIL="index.html could not be fetched from the web URL and the bucket"
elif [[ "$SERVED" != "$STORED" ]]; then
  WEBSTATE=UNKNOWN; WDETAIL="the web URL serves a different index.html than the bucket holds (a cache refresh may be pending)"
elif [[ -n "$BUILD_WEB" && "$STORED" == "$BUILD_WEB" && "$STORED" == "$PILOT_WEB" ]]; then
  # Byte-identical builds: the run's own record says whether the new files were uploaded.
  if [[ -f "$INC/state/web-deployed" ]]; then WEBSTATE=BUILD; else WEBSTATE=PILOT; fi
  WDETAIL="the pilot build and this build are identical"
elif [[ -n "$BUILD_WEB" && "$STORED" == "$BUILD_WEB" ]]; then
  WEBSTATE=BUILD; WDETAIL="this 1a39dd5 build"
elif [[ -n "$PILOT_WEB" && "$STORED" == "$PILOT_WEB" ]]; then
  WEBSTATE=PILOT; WDETAIL="the pilot build recorded in $PILOTRUN/web-build"
elif [[ -z "$PILOT_WEB" ]]; then
  WEBSTATE=UNKNOWN; WDETAIL="no pilot web build in $PILOTRUN/web-build to compare with"
else
  WEBSTATE=OTHER; WDETAIL="neither the pilot build nor this build"
fi
echo "Web: $WEBSTATE - $WDETAIL (index.html ${STORED:0:12}…)"

# ---------------------------------------------------------------------------
phase "Preflight ($MODE) 4/4: TEST database, ledger, database objects and records (temporary DB window, always restored)"
load_rds_and_host
[[ "$(jq -r .PubliclyAccessible <<<"$RDS")" == false ]] || die "RDS is publicly accessible: stop and review"
db_window_open
TESTDB=false; TDETAIL="the API Lambda serves $(jq -r '.Environment.Variables.DB_NAME // "none"' "$F/lambda.json")"
if [[ "$(jq -r '.Environment.Variables.DB_NAME // ""' "$F/lambda.json")" == "$DB_NAME" ]] \
   && Q -d postgres -c "select 1 from pg_database where datname = '$DB_NAME'" | grep -qx 1; then
  ORGS=$(Q -d "$DB_NAME" -c "select string_agg(id || ' ' || slug || ' ' || (display_name like '%(synthetic%')::text, ',' order by slug) from ogevia.organizations")
  TDETAIL="agencies: $ORGS"
  [[ "$ORGS" == "7e570000-0000-4000-8000-000000000001 ogevia-test-slice true,5c500000-0000-4000-8000-000000000001 scs-pilot-synthetic true" ]] && TESTDB=true
fi
Q -d "$DB_NAME" -F' ' -c "select version, checksum from ogevia_meta.schema_migrations order by version" > "$F/ledger.txt"
CHANGED=""
while read -r v sum; do
  f=$(ls "$SRC/infra/aws/db/migrations/${v}_"*.sql 2>/dev/null || true)
  [[ -n "$f" && "$(sha256sum "$f" | cut -d' ' -f1)" == "$sum" ]] || CHANGED="$CHANGED $v"
done < "$F/ledger.txt"
N=$(wc -l < "$F/ledger.txt"); LEDGER=$(tail -1 "$F/ledger.txt" | cut -d' ' -f1)
[[ "$(cut -d' ' -f1 "$F/ledger.txt" | paste -sd,)" == "$(seq -f '%04g' 1 "$N" | paste -sd,)" ]] || CHANGED="$CHANGED not-contiguous"
Q -d "$DB_NAME" -c "select p.oid::regprocedure::text || ' ' || md5(replace(p.prosrc, E'\r', '') || '|' || p.prosecdef::text || '|' || coalesce(array_to_string(p.proconfig, ','), '')) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('ogevia', 'ogevia_api') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') order by 1" > "$F/functions.txt"
Q -d "$DB_NAME" -c "select table_schema || '.' || table_name || '.' || column_name || ' ' || data_type from information_schema.columns where table_schema in ('ogevia', 'ogevia_api', 'ogevia_meta') order by 1" > "$F/columns.txt"
SCHEMA_DETAIL=$("${PY[@]}" schema "$LEDGER" "$F/functions.txt" "$F/columns.txt" "$EXP") && SCHEMA_OK=true || SCHEMA_OK=false
echo "TEST database: $TESTDB - $TDETAIL"
echo "Ledger: $N migrations (0001-$LEDGER); checksums differing from the repository:${CHANGED:- none}"
echo "Database objects: $SCHEMA_DETAIL"
if [[ "$MODE" == pre && ! -d "$INC/state" && ! -f "$RUN/baseline.txt" ]]; then
  # Fresh run only: the value fingerprint every later check compares with.
  Q -d "$DB_NAME" -f <("${PY[@]}" snapshot-sql "$EXP") > "$RUN/baseline.tmp"
  printf 'pin=%s\ntaken=%s\n' "$PIN" "$(date -u +%FT%TZ)" > "$RUN/baseline.meta"
  mv "$RUN/baseline.tmp" "$RUN/baseline.txt"
  echo "Record baseline taken: $(grep -c '^table ' "$RUN/baseline.txt") tables, $(grep -c '^rp ' "$RUN/baseline.txt") role permissions, audit rows up to id $(grep '^audit ' "$RUN/baseline.txt" | cut -d' ' -f2)"
fi
if [[ "$MODE" == post ]]; then
  Q -d "$DB_NAME" -f <("${PY[@]}" snapshot-sql "$EXP") > "$F/after.txt"
  Q -d "$DB_NAME" -f <("${PY[@]}" audit-sql "$EXP" "$(grep '^audit ' "$RUN/baseline.txt" | cut -d' ' -f2)") > "$F/audit-prefix.txt"
fi
db_window_close
admin_host_groups | grep -qw "$APP_SG" && die "$APP_SG is still attached to the admin host: remove it in the EC2 console"
echo "DB window closed; admin host groups: $(admin_host_groups)"

# ---------------------------------------------------------------------------
if [[ "$MODE" == pre ]]; then
  phase "Decision"
  STEPS=""; [[ -d "$INC/state" ]] && STEPS=$(ls "$INC/state" | xargs)
  APPROVED=$(grep '^commit=' "$INC/APPROVAL.txt" 2>/dev/null | cut -d= -f2 || true)
  BASEOK=false; grep -q "^pin=$PIN$" "$RUN/baseline.meta" 2>/dev/null && [[ -f "$RUN/baseline.txt" ]] && BASEOK=true
  jq -n --arg pin "$PIN" --arg changed "${CHANGED# }" --argjson testdb "$TESTDB" --arg tdetail "$TDETAIL" \
    --argjson schema "$SCHEMA_OK" --arg sdetail "$SCHEMA_DETAIL" --argjson rok "$ROUTES_OK" --arg rdetail "$ROUTES_DETAIL" \
    --arg ledger "$LEDGER" --arg routes "$ROUTES" --arg lambda "$LAMBDA" --arg web "$WEBSTATE" --arg edetail "Lambda: $LDETAIL; web: $WDETAIL" \
    --argjson run "$([[ -d "$INC/state" ]] && echo true || echo false)" --arg steps "$STEPS" --arg approved "$APPROVED" --argjson base "$BASEOK" \
    '{pin:$pin, changed_checksums:$changed, test_database:$testdb, test_database_detail:$tdetail, schema_ok:$schema, schema_detail:$sdetail,
      routes_ok:$rok, routes_detail:$rdetail, ledger:$ledger, routes:$routes, lambda:$lambda, web:$web, evidence_detail:$edetail,
      run_exists:$run, steps:($steps | split(" ") | map(select(. != ""))), approved_commit:$approved, baseline:$base}' > "$F/facts.json"
  DECISION=$("${PY[@]}" decide "$F/facts.json") || die "${DECISION#STOP: }. Nothing deployed; send $LOG to Claude"
  echo "DECISION: $DECISION"
  [[ "$DECISION" == COMPLETE* ]] && exit 3
  exit 0
fi

phase "Post-check result"
r=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; r=1; }
[[ "$LEDGER" == 0021 && -z "${CHANGED# }" ]] && pass "ledger 0001-0021, every checksum equal to the repository" || fail "ledger 0001-$LEDGER, differing:${CHANGED:- none}"
[[ "$SCHEMA_OK" == true ]] && pass "database objects: $SCHEMA_DETAIL" || fail "database objects: $SCHEMA_DETAIL"
[[ "$TESTDB" == true ]] && pass "TEST database, synthetic agencies only" || fail "TEST database: $TDETAIL"
[[ "$ROUTES_OK" == true && "$ROUTES" == INCREMENT ]] && pass "API: $ROUTES_DETAIL" || fail "API: $ROUTES_DETAIL"
[[ "$LAMBDA" == BUILD ]] && pass "API Lambda: $LDETAIL" || fail "API Lambda: $LAMBDA - $LDETAIL"
[[ "$WEBSTATE" == BUILD ]] && pass "web: $WDETAIL" || fail "web: $WEBSTATE - $WDETAIL"
CMP=$("${PY[@]}" compare "$RUN/baseline.txt" "$F/after.txt" "$EXP" "$F/audit-prefix.txt") && pass "records: $CMP" || fail "records: $CMP"
[[ $r == 0 ]] || die "post-check failed; the deployment stays in place for diagnosis; send $LOG to Claude"
date -u +%FT%TZ > "$STATE/postcheck"
echo "Post-check: all PASS"
