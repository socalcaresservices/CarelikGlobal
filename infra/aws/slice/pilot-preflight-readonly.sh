#!/usr/bin/env bash
# =============================================================================
# Ogevia AWS PILOT/TEST: READ-ONLY PREFLIGHT. DRAFT, NOT YET RUN AGAINST AWS.
#
# Establishes, without changing anything, what is live in the pilot (stacks Ogevia-prod-*, database ogevia_sv_test):
#   account and region; stack states and outputs; the API Lambda (code hash, last modified, database name); live API routes
#   against the routes in THIS checkout (the deployment delta); the web files; RDS state, backups and snapshots; the
#   admin host and whether its security groups already allow a database read; unauthenticated health probes.
# Optional: --probe-lambda runs pilot_preflight_probe.py (read-only GET routes through the Lambda with the synthetic test
#   identity; no database write) to fingerprint the migration level and to check seed 03.
#
# EVERY aws command below is describe-, list-, get- or head-. The static test infra/aws/test/pilot-preflight.test.ts fails
# if any other verb appears.
#
# NOT in this script, because they WRITE or use a secret (each needs its own explicit approval):
#   aws rds create-db-snapshot                      (creates a snapshot)
#   aws ec2 modify-instance-attribute               (the "DB window" changes the admin host's security groups)
#   aws secretsmanager get-secret-value             (reads the RDS master password; needed only for the ledger query)
#   aws ssm start-session                           (opens the database tunnel; part of the ledger read)
#   psql / db:migrate / db:verify against the pilot (the ledger read itself, see the runbook)
#   cdk deploy / cdk bootstrap / cloudformation update-stack
#   aws s3 sync|cp|rm, aws cloudfront create-invalidation
#   aws lambda invoke (other than inside --probe-lambda), aws iam *, aws cognito-idp admin-*
#
# Run in AWS CloudShell, in a checkout of the release candidate, with the admin profile:
#   bash infra/aws/slice/pilot-preflight-readonly.sh [--probe-lambda]
# Output: a folder (mode 700) with one text file per section and SUMMARY.txt. No secret values are read or printed.
# =============================================================================
set -uo pipefail
ACCOUNT=300094796789
REGION=us-west-2
RDS_ID=ogevia-prod-postgres
ADMIN_TAG=ogevia-db-admin-temp
APP_SG=sg-064ffce3bcbe8eb3b
DB_NAME_EXPECTED=ogevia_sv_test
STACKS=(Ogevia-prod-EvidenceStorage Ogevia-prod-NetworkEgress Ogevia-prod-WebHosting Ogevia-prod-ServiceVerificationApi Ogevia-prod-Observability)
API_STACK=Ogevia-prod-ServiceVerificationApi
WEB_STACK=Ogevia-prod-WebHosting
PROBE=0; [[ "${1:-}" == "--probe-lambda" ]] && PROBE=1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
OUT="${OGEVIA_PREFLIGHT_DIR:-$HOME/ogevia-preflight-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT"; chmod 700 "$OUT"
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION AWS_PAGER=""
SUMMARY="$OUT/SUMMARY.txt"; : > "$SUMMARY"
FAILS=0
note() { printf '%s\n' "$*" | tee -a "$SUMMARY"; }
ok()   { note "  OK    $*"; }
bad()  { note "  STOP  $*"; FAILS=$((FAILS + 1)); }
info() { note "  INFO  $*"; }
sect() { note ""; note "== $*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing tool: $1" >&2; exit 2; }; }
for t in aws jq curl python3 git; do need "$t"; done

sect "0. This checkout"
COMMIT=$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)
info "commit $COMMIT; clean: $([[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no 2>/dev/null)" ]] && echo yes || echo NO)"
info "newest migration in this checkout: $(ls "$REPO/infra/aws/db/migrations" | grep -v down | tail -1)"

sect "1. AWS account and region"
IDENT=$(aws sts get-caller-identity --output json 2>"$OUT/sts.err") || { bad "no valid AWS credentials: sign in again and reopen CloudShell"; exit 1; }
[[ "$(jq -r .Account <<<"$IDENT")" == "$ACCOUNT" ]] && ok "account $ACCOUNT, region $REGION" || bad "wrong account: $(jq -r .Account <<<"$IDENT")"
info "caller: $(jq -r .Arn <<<"$IDENT" | sed 's#assumed-role/\([^/]*\)/.*#assumed-role/\1/…#')"

sect "2. Pilot stacks (Ogevia-prod-*; the PRODUCTION stacks use a different prefix and are not touched)"
for s in "${STACKS[@]}"; do
  row=$(aws cloudformation describe-stacks --stack-name "$s" --query 'Stacks[0].[StackStatus,LastUpdatedTime||CreationTime]' --output text 2>/dev/null) || row="MISSING"
  st=${row%%$'\t'*}
  if [[ "$st" == CREATE_COMPLETE || "$st" == UPDATE_COMPLETE ]]; then ok "$s  $row"; else bad "$s  $row"; fi
done
WEB=$(aws cloudformation describe-stacks --stack-name "$WEB_STACK" --query "Stacks[0].Outputs[?OutputKey=='WebOrigin'].OutputValue" --output text 2>/dev/null)
API=$(aws cloudformation describe-stacks --stack-name "$API_STACK" --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text 2>/dev/null)
BUCKET=$(aws cloudformation describe-stacks --stack-name "$WEB_STACK" --query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue" --output text 2>/dev/null)
DIST=$(aws cloudformation describe-stacks --stack-name "$WEB_STACK" --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text 2>/dev/null)
CLIENT_ID=$(aws cloudformation describe-stacks --stack-name "$WEB_STACK" --query "Stacks[0].Outputs[?OutputKey=='TestAppClientId'].OutputValue" --output text 2>/dev/null)
info "pilot web $WEB"; info "pilot API $API"
aws cloudformation get-template --stack-name "$API_STACK" --template-stage Original --query TemplateBody --output json > "$OUT/api-template-live.json" 2>/dev/null \
  && info "live API stack template saved to $OUT/api-template-live.json (rollback input)"

sect "3. API Lambda"
FN=$(aws cloudformation list-stack-resources --stack-name "$API_STACK" --output json 2>/dev/null | jq -r '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId|startswith("Handler")))][0].PhysicalResourceId // empty')
if [[ -z "$FN" ]]; then bad "API handler function not found in $API_STACK"; else
  CFG=$(aws lambda get-function-configuration --function-name "$FN" --output json)
  info "function $FN"
  info "code sha256 $(jq -r .CodeSha256 <<<"$CFG")  last modified $(jq -r .LastModified <<<"$CFG")  state $(jq -r .State <<<"$CFG")/$(jq -r .LastUpdateStatus <<<"$CFG")"
  [[ "$(jq -r '.Environment.Variables.DB_NAME // empty' <<<"$CFG")" == "$DB_NAME_EXPECTED" ]] && ok "serves database $DB_NAME_EXPECTED (the pilot)" || bad "DB_NAME is '$(jq -r '.Environment.Variables.DB_NAME // empty' <<<"$CFG")', expected $DB_NAME_EXPECTED: this is not the pilot"
  [[ "$(jq -r '.Environment.Variables.OGEVIA_ENV // empty' <<<"$CFG")" != prd ]] && ok "OGEVIA_ENV is not prd" || bad "OGEVIA_ENV is prd: STOP, this is production"
fi

sect "4. API Gateway routes: live versus this checkout (the deployment delta)"
API_ID=$(aws cloudformation list-stack-resources --stack-name "$API_STACK" --output json 2>/dev/null | jq -r '[.StackResourceSummaries[] | select(.ResourceType=="AWS::ApiGatewayV2::Api")][0].PhysicalResourceId // empty')
if [[ -n "$API_ID" ]]; then
  aws apigatewayv2 get-routes --api-id "$API_ID" --query 'Items[].RouteKey' --output json | jq -r '.[]' | sort > "$OUT/routes-live.txt"
  grep -oE '^  "(GET|POST|PUT|PATCH|DELETE) /[^"]*": \{' "$REPO/apps/sv-api/src/routes.ts" | sed -E 's/^  "([^"]*)": \{$/\1/' | sort > "$OUT/routes-repo.txt"
  info "live routes: $(wc -l < "$OUT/routes-live.txt"); routes in this checkout: $(wc -l < "$OUT/routes-repo.txt")"
  comm -13 "$OUT/routes-live.txt" "$OUT/routes-repo.txt" > "$OUT/routes-to-add.txt"
  comm -23 "$OUT/routes-live.txt" "$OUT/routes-repo.txt" > "$OUT/routes-live-only.txt"
  info "routes the deployment would ADD: $(wc -l < "$OUT/routes-to-add.txt") (list: $OUT/routes-to-add.txt)"
  for r in "GET /v1/visit-rules" "POST /v1/visit-rules" "GET /v1/open-shifts" "POST /v1/shifts/{shiftId}/pickup" "GET /v1/accounts" "POST /v1/accounts/{userId}/disable" "POST /v1/accounts/{userId}/enable"; do
    grep -qxF "$r" "$OUT/routes-live.txt" && info "route live: $r" || info "route NOT live: $r"
  done
  [[ -s "$OUT/routes-live-only.txt" ]] && bad "routes live but not in this checkout ($(wc -l < "$OUT/routes-live-only.txt")): a different or newer build is deployed; see $OUT/routes-live-only.txt" || ok "no live route is missing from this checkout"
else bad "API id not found"; fi

sect "5. Web files (pilot)"
if [[ -n "$BUCKET" && "$BUCKET" != None ]]; then
  aws s3api head-object --bucket "$BUCKET" --key index.html --query '{LastModified:LastModified,VersionId:VersionId,ETag:ETag}' --output json 2>/dev/null | tee "$OUT/web-index.json" >/dev/null
  info "index.html: $(jq -c . "$OUT/web-index.json" 2>/dev/null)"
fi
[[ -n "$DIST" && "$DIST" != None ]] && info "CloudFront $DIST: $(aws cloudfront get-distribution --id "$DIST" --query 'Distribution.[Status,LastModifiedTime]' --output text 2>/dev/null)"
if [[ -n "$WEB" && "$WEB" != None ]]; then
  curl -s -m 20 "$WEB/" -o "$OUT/web-index.html"; info "web asset files: $(grep -oE 'assets/[A-Za-z0-9._-]+\.(js|css)' "$OUT/web-index.html" | sort -u | tr '\n' ' ')"
fi

sect "6. Database instance, backups and snapshots (read-only descriptions)"
RDS=$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0]' --output json 2>/dev/null)
if [[ -z "$RDS" || "$RDS" == null ]]; then bad "RDS $RDS_ID not found"; else
  info "status $(jq -r .DBInstanceStatus <<<"$RDS"); engine $(jq -r .Engine <<<"$RDS") $(jq -r .EngineVersion <<<"$RDS"); class $(jq -r .DBInstanceClass <<<"$RDS"); multi-AZ $(jq -r .MultiAZ <<<"$RDS")"
  [[ "$(jq -r .PubliclyAccessible <<<"$RDS")" == false ]] && ok "private (not publicly accessible)" || bad "PUBLICLY ACCESSIBLE"
  [[ "$(jq -r .StorageEncrypted <<<"$RDS")" == true ]] && ok "storage encrypted" || bad "storage NOT encrypted"
  info "automated backup retention $(jq -r .BackupRetentionPeriod <<<"$RDS") days; latest restorable time $(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0].LatestRestorableTime' --output text 2>/dev/null); deletion protection $(jq -r .DeletionProtection <<<"$RDS")"
  [[ "$(jq -r .BackupRetentionPeriod <<<"$RDS")" -ge 1 ]] && ok "automated backups on" || bad "automated backups OFF"
  aws rds describe-db-snapshots --db-instance-identifier "$RDS_ID" --query 'reverse(sort_by(DBSnapshots,&SnapshotCreateTime))[:8].[DBSnapshotIdentifier,SnapshotType,Status,SnapshotCreateTime]' --output text > "$OUT/snapshots.txt" 2>/dev/null
  info "latest snapshots (identifier, type, status, created):"; sed 's/^/        /' "$OUT/snapshots.txt" | tee -a "$SUMMARY" >/dev/null
  info "this script creates NO snapshot; the pre-deployment snapshot is a separate approved step"
fi

sect "7. Admin host (for the database read) — informational"
HOST=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$ADMIN_TAG" "Name=instance-state-name,Values=running" --query 'Reservations[0].Instances[0].[InstanceId,SecurityGroups[].GroupId]' --output json 2>/dev/null)
if [[ -z "$HOST" || "$HOST" == null || "$HOST" == "[null,null]" ]]; then info "admin host $ADMIN_TAG is not running: the database read would first need it started (a change)"; else
  info "admin host $(jq -r '.[0]' <<<"$HOST"), security groups $(jq -rc '.[1]' <<<"$HOST")"
  if jq -e --arg g "$APP_SG" '.[1] | index($g)' <<<"$HOST" >/dev/null; then
    info "the app security group is ALREADY attached: the ledger read needs no security-group change (still needs the owner's OK to use the master secret)"
  else
    info "the app security group is NOT attached: reading the ledger needs the DB window, which CHANGES the host's security groups (separate approval). Use --probe-lambda instead."
  fi
fi

sect "8. Unauthenticated health probes (HTTP GET, no credentials, read-only)"
probe() { code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$1" 2>/dev/null); printf '%s' "$code"; }
if [[ -n "$API" && "$API" != None ]]; then
  c=$(probe "$API/v1/me"); [[ "$c" == 401 ]] && ok "GET /v1/me anonymous -> 401" || bad "GET /v1/me anonymous -> $c (expected 401)"
  c=$(probe "$API/v1/visit-rules?organizationId=00000000-0000-4000-8000-000000000000"); info "GET /v1/visit-rules anonymous -> $c (401 = route live, 404 = Wave 1 API not deployed)"
  c=$(probe "$API/v1/open-shifts?organizationId=00000000-0000-4000-8000-000000000000"); info "GET /v1/open-shifts anonymous -> $c (401 = route live, 404 = not deployed)"
fi
[[ -n "$WEB" && "$WEB" != None ]] && { c=$(probe "$WEB/"); [[ "$c" == 200 ]] && ok "web / -> 200" || bad "web / -> $c"; c=$(probe "$WEB/config.json"); [[ "$c" == 200 ]] && ok "web /config.json -> 200" || bad "web /config.json -> $c"; }

if [[ $PROBE == 1 ]]; then
  sect "9. Migration fingerprint and seed 03 through the Lambda (read-only GET routes, synthetic test identity)"
  PREFLIGHT_CLIENT_ID="$CLIENT_ID" python3 "$HERE/pilot_preflight_probe.py" 2>&1 | tee -a "$SUMMARY"
else
  sect "9. Migration fingerprint and seed 03"
  info "not run (add --probe-lambda). The exact ledger (count|max version) can only be read from the database: runbook section 1, needs the owner's OK to use the master secret."
fi

sect "Result"
if [[ $FAILS == 0 ]]; then note "No STOP items. Send $SUMMARY (and the other files in $OUT) to Claude Code. Nothing was changed."; else note "$FAILS STOP item(s). Change nothing. Send $SUMMARY to Claude Code."; fi
exit $(( FAILS > 0 ? 1 : 0 ))
