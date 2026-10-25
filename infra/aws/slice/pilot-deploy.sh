#!/usr/bin/env bash
# =============================================================================
# Ogevia SCS PILOT -> AWS TEST: one complete, resumable deployment workflow.
# Run in AWS CloudShell (us-west-2) as AdministratorAccess, from the repo root
# that pilot-bootstrap.sh checked out:   bash infra/aws/slice/pilot-deploy.sh
#
# Everything before the single APPROVAL prompt is read-only (inventory, shared-
# resource report, build, tests, synth, rollback capture, scope gate). After
# you type DEPLOY it takes a snapshot, runs one DB window (migrations
# 0012-0018, the 3 individual pilot sign-ins, the synthetic pilot seed), deploys
# the API stack, uploads the web app and runs the smoke suites. Any failed
# check stops it; re-running the same command resumes after the last completed
# step (state in ~/ogevia-pilot-run). TEST ONLY, SYNTHETIC DATA ONLY.
#
# Never: Netlify/Supabase/DNS, production users or real clients, the ogevia-web
# app client, RDS security-group rules, deleting anything.
# =============================================================================
set -Eeuo pipefail
# Explicit environment label for the web app's banner (never guessed): test | development | production.
APP_ENV="${OGEVIA_APP_ENV:-test}"
case "$APP_ENV" in test|development|production) ;; *) echo "OGEVIA_APP_ENV must be test, development or production (got '$APP_ENV')" >&2; exit 1;; esac

# shellcheck source=pilot-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/pilot-lib.sh"
SNAPSHOT_ID=ogevia-prod-postgres-pre-pilot-$(date -u +%Y%m%d)
LOG="$RUN/deploy-$(date -u +%Y%m%dT%H%M%SZ).log"
exec 3>&1
exec > >(tee -a "$LOG") 2>&1
trap '' PIPE                     # a dead tee must not kill this script silently
trap on_exit EXIT
trap 'die "unexpected error on line $LINENO (command: $BASH_COMMAND)"' ERR
PNPM=(npx -y pnpm@9.15.4)
# Small CloudShell environments: one build/test task at a time, capped Node
# heap (parallel typecheck peaks ~2.0 GB and tests ~2.8 GB; serial ~1.15 GB).
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}"
GATE_TEST_ARGS=(-- --pool=forks --poolOptions.forks.maxForks=1 --poolOptions.forks.minForks=1)

# ----------------------------------------------------------------------------
phase "1/12 Prerequisites and versions"
for t in aws node npx python3 jq curl; do command -v "$t" >/dev/null || die "missing tool: $t"; done
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[[ "$NODE_MAJOR" -ge 20 ]] || die "Node.js >= 20 required (found $(node -v))"
if ! command -v psql >/dev/null; then echo "Installing the PostgreSQL client (psql)..."; sudo dnf install -y -q postgresql15 >/dev/null || die "could not install psql"; fi
if ! command -v session-manager-plugin >/dev/null; then
  echo "Installing the AWS Session Manager plugin (official AWS package)..."
  sudo dnf install -y -q https://s3.amazonaws.com/session-manager-downloads/plugin/latest/linux_64bit/session-manager-plugin.rpm >/dev/null \
    || die "could not install session-manager-plugin"
fi
COMMIT=$(git -C "$REPO" rev-parse --short=12 HEAD 2>/dev/null || cat "$REPO/.pilot-commit" 2>/dev/null || echo unknown)
for f in $(seq -w 12 18); do ls "$HERE/db/migrations/00${f}_"*.sql >/dev/null 2>&1 || die "migration 00$f missing from this checkout"; done
[[ "$(ls "$HERE/db/migrations" | tail -1)" == ${FINAL_MIGRATION}_* ]] || die "unexpected newest migration: $(ls "$HERE/db/migrations" | tail -1)"
printf 'Code: %s\naws %s\nnode %s | pnpm %s | %s | %s | python %s\n' "$COMMIT" \
  "$(aws --version 2>&1 | cut -d' ' -f1)" "$(node -v)" "$("${PNPM[@]}" -v)" "$(psql --version)" \
  "session-manager-plugin $(session-manager-plugin --version)" "$(python3 -c 'import sys;print(sys.version.split()[0])')"
df -h "$REPO" | tail -1 | awk '{print "Free disk for the build: " $4}'

# ----------------------------------------------------------------------------
phase "2/12 AWS identity (fresh SSO session)"
ARN=$(aws sts get-caller-identity --query Arn --output text) || die "AWS credentials are not valid: sign in to the console again and reopen CloudShell"
ACCT=$(aws sts get-caller-identity --query Account --output text)
[[ "$ACCT" == "$ACCOUNT" ]] || die "signed in to account $ACCT, expected $ACCOUNT"
[[ "$ARN" == *AdministratorAccess* ]] || die "this needs the AdministratorAccess role (current: $ARN)"
echo "Account $ACCT, region $REGION, role AdministratorAccess: OK"

# ----------------------------------------------------------------------------
phase "3/12 Pilot sign-ins (individual accounts; asked once)"
INPUTS="$RUN/inputs.env"
if [[ ! -f "$INPUTS" ]]; then
  [[ -t 0 ]] || die "run from an interactive CloudShell terminal"
  echo "Three people, three separate accounts (no shared logins). Use inboxes you control."
  echo "Names are only stored in the TEST database; they are never printed or logged."
  ask() { local v; read -r -p "$2: " v; v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"; [[ -n "$v" ]] || die "$2 is required"; printf -v "$1" '%s' "$v"; }
  ask M_EMAIL "Pilot MANAGER email"; ask M_NAME "Pilot manager display name"
  ask A_EMAIL "Pilot CAREGIVER A email"; ask A_FIRST "Caregiver A first name"; ask A_LAST "Caregiver A last name"
  ask B_EMAIL "Pilot CAREGIVER B email"; ask B_FIRST "Caregiver B first name"; ask B_LAST "Caregiver B last name"
  for e in "$M_EMAIL" "$A_EMAIL" "$B_EMAIL"; do
    [[ "$e" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "not an email address: $e"
    [[ "$e" != "$TEST_CAREGIVER_EMAIL" && "$e" != "$TEST_MANAGER_EMAIL" ]] || die "$e is a test-slice account; use separate pilot inboxes"
  done
  [[ "$M_EMAIL" != "$A_EMAIL" && "$M_EMAIL" != "$B_EMAIL" && "$A_EMAIL" != "$B_EMAIL" ]] || die "the three emails must be different people"
  umask 077
  { printf 'M_EMAIL=%q\nM_NAME=%q\nA_EMAIL=%q\nA_FIRST=%q\nA_LAST=%q\nB_EMAIL=%q\nB_FIRST=%q\nB_LAST=%q\n' \
      "$M_EMAIL" "$M_NAME" "$A_EMAIL" "$A_FIRST" "$A_LAST" "$B_EMAIL" "$B_FIRST" "$B_LAST"; } > "$INPUTS"
fi
# shellcheck disable=SC1090
source "$INPUTS"
echo "Manager: $M_EMAIL | Caregiver A: $A_EMAIL | Caregiver B: $B_EMAIL (stored in $INPUTS, mode 600)"

# ----------------------------------------------------------------------------
phase "4/12 Read-only inventory: what is shared with production"
load_rds_and_host
RDS_STATUS=$(jq -r .DBInstanceStatus <<<"$RDS"); RDS_PUBLIC=$(jq -r .PubliclyAccessible <<<"$RDS")
RDS_ENC=$(jq -r .StorageEncrypted <<<"$RDS"); RDS_RET=$(jq -r .BackupRetentionPeriod <<<"$RDS")
[[ "$RDS_STATUS" == available ]] || die "RDS is $RDS_STATUS"
[[ "$RDS_PUBLIC" == false ]] || die "RDS is publicly accessible: stop and review"
[[ "$RDS_ENC" == true ]] || die "RDS storage is not encrypted"
[[ "$RDS_RET" -ge 7 ]] || die "RDS backup retention is $RDS_RET days (< 7)"
for s in "${STACKS[@]}"; do
  st=$(aws cloudformation describe-stacks --stack-name "$s" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo MISSING)
  [[ "$st" == CREATE_COMPLETE || "$st" == UPDATE_COMPLETE ]] || die "$s is $st (needs owner review; this workflow never creates or repairs stacks)"
done
FN=$(aws cloudformation describe-stack-resources --stack-name "$API_STACK" \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId | [0]" --output text)
FNCFG=$(aws lambda get-function-configuration --function-name "$FN" --output json)
LAMBDA_DB=$(jq -r '.Environment.Variables.DB_NAME // empty' <<<"$FNCFG")
[[ "$LAMBDA_DB" == "$DB_NAME" ]] || die "the API Lambda serves database '$LAMBDA_DB', not $DB_NAME: this is not the TEST slice"
WEB=$(out Ogevia-prod-WebHosting WebOrigin); CLIENT=$(out Ogevia-prod-WebHosting TestAppClientId)
BUCKET=$(out Ogevia-prod-WebHosting SiteBucketName); DIST=$(out Ogevia-prod-WebHosting DistributionId)
API=$(out "$API_STACK" ApiUrl)
for v in WEB CLIENT BUCKET DIST API; do [[ -n "${!v}" && "${!v}" != None ]] || die "missing stack output $v"; done
ALIASES=$(aws cloudfront get-distribution-config --id "$DIST" --query 'DistributionConfig.Aliases.Items' --output text)
[[ "$ALIASES" == None ]] && ALIASES=""
POOLINFO=$(aws cognito-idp describe-user-pool --user-pool-id "$POOL" --query 'UserPool.[EstimatedNumberOfUsers,MfaConfiguration]' --output text)
CLIENTS=$(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL" --query 'UserPoolClients[].ClientName' --output text)
cat > "$RUN/SHARED_RESOURCES.md" <<EOF
# Resources this deployment touches, and who else uses them (read live $(date -u +%FT%TZ))

| Resource | Live facts | Shared with production? | This deployment |
| --- | --- | --- | --- |
| RDS \`$RDS_ID\` | $RDS_STATUS, public=$RDS_PUBLIC, encrypted=$RDS_ENC, backups ${RDS_RET}d | Production-NAMED instance. Production runs on Supabase. The databases on the instance are listed in the DB window, before any change. | Snapshot first. Migrations touch database \`$DB_NAME\` only. |
| API Lambda \`$FN\` | DB_NAME=$LAMBDA_DB, code $(jq -r .CodeSha256 <<<"$FNCFG" | cut -c1-12)…, modified $(jq -r .LastModified <<<"$FNCFG") | No: it serves the TEST database only (checked above) | New code + the routes the scope gate lists |
| Stacks \`Ogevia-prod-*\` (5) | all *_COMPLETE | Production-named. They hold the TEST slice; nothing in production depends on them. | Only \`$API_STACK\` changes (scope gate) |
| CloudFront \`$DIST\` / bucket \`$BUCKET\` | origin $WEB; custom domains: ${ALIASES:-none} | ${ALIASES:+REVIEW: serves $ALIASES}${ALIASES:-No custom domain: TEST web origin only} | Web files + config.json |
| Cognito pool \`$POOL\` | users≈$(cut -f1 <<<"$POOLINFO"), MFA=$(cut -f2 <<<"$POOLINFO"), clients: $CLIENTS | Shared pool. The \`ogevia-web\` client is reserved for a future production cutover and is not changed. | +3 individual users |
| Admin host \`$IID\` | running | No | AppSG attached ONLY during the DB window, then restored |
| Netlify, Supabase, DNS | not accessed | Production | None |
EOF
cat "$RUN/SHARED_RESOURCES.md"
[[ -z "$ALIASES" ]] || die "the TEST web distribution serves a custom domain ($ALIASES); review before deploying"

# ----------------------------------------------------------------------------
phase "5/12 Build and test this exact code"
cd "$REPO"
if ! is_done "tests-$COMMIT"; then
  "${PNPM[@]}" install --frozen-lockfile
  for t in typecheck lint test build; do
    extra=(); [[ "$t" == test ]] && extra=("${GATE_TEST_ARGS[@]}")
    echo "-- $t (one task at a time)"
    "${PNPM[@]}" exec turbo run "$t" --concurrency=1 "${extra[@]}" || die "the quality gate failed on this code ($t, exit $?)"
  done
  done_ "tests-$COMMIT"
else
  echo "Quality gate already passed for $COMMIT in this run."
  [[ -d node_modules ]] || "${PNPM[@]}" install --frozen-lockfile
fi
# Synthesize with the LIVE approval tag value when given (pilot-recover-scope.sh),
# so tags stay identical and the strict scope gate sees only the approved change.
export OGEVIA_DEPLOY_APPROVAL="${OGEVIA_PILOT_TAG_REF:-pilot-test-$COMMIT}"
(cd "$HERE" && npx cdk synth --quiet --no-notices -c env=prod -c mode=deploy >/dev/null) || die "cdk synth (deploy mode) failed"
(cd "$REPO/apps/web" && VITE_APP_ENV=test VITE_AUTH_PROVIDER=cognito npx vite build --outDir "$RUN/web-build" --emptyOutDir >/dev/null) \
  || die "web build failed"
assert_test_web_label "$RUN/web-build"
echo "Build, tests, synth: OK"

# ----------------------------------------------------------------------------
phase "6/12 Capture rollback versions (read-only)"
if ! is_done rollback-captured; then
  for s in "${STACKS[@]}"; do
    aws cloudformation get-template --stack-name "$s" --template-stage Original --query TemplateBody --output json > "$RB/templates/$s.json"
    jq -e 'type == "object"' "$RB/templates/$s.json" >/dev/null || die "deployed template of $s is not JSON"
  done
  jq '{FunctionName, CodeSha256, LastModified, Version, Runtime, DB_NAME: .Environment.Variables.DB_NAME}' <<<"$FNCFG" > "$RB/lambda.json"
  aws apigatewayv2 get-routes --api-id "$(aws cloudformation describe-stack-resources --stack-name "$API_STACK" \
    --query "StackResources[?ResourceType=='AWS::ApiGatewayV2::Api'].PhysicalResourceId | [0]" --output text)" \
    --query 'Items[].[RouteKey,AuthorizationType]' --output json > "$RB/routes.json"
  aws s3 sync "s3://$BUCKET" "$RB/web" --only-show-errors
  aws s3api head-object --bucket "$BUCKET" --key index.html --query '{ETag:ETag,LastModified:LastModified,VersionId:VersionId}' --output json > "$RB/web-index.json"
  jq -n --arg commit "$COMMIT" --arg fn "$FN" --arg bucket "$BUCKET" --arg dist "$DIST" --arg snap "$SNAPSHOT_ID" \
    --arg routes "$(jq length "$RB/routes.json")" --arg at "$(date -u +%FT%TZ)" \
    '{capturedAt:$at, deployingCommit:$commit, lambda:$fn, apiRoutesBefore:($routes|tonumber), siteBucket:$bucket, distribution:$dist, snapshot:$snap}' > "$RB/MANIFEST.json"
  done_ rollback-captured
fi
echo "Captured in $RB: 5 stack templates, Lambda $(jq -r .CodeSha256 "$RB/lambda.json" | cut -c1-12)…, $(jq length "$RB/routes.json") API routes, web files ($(find "$RB/web" -type f | wc -l))."

# ----------------------------------------------------------------------------
phase "7/12 Scope gate: deployed vs this build"
python3 "$SLICE/pilot_diff_gate.py" --cdk-out "$HERE/cdk.out" --deployed "$RB/templates" --summary "$RUN/scope-gate.txt" \
  || die "the change set is outside the approved scope (see above)"

# ----------------------------------------------------------------------------
phase "8/12 APPROVAL (the only approval)"
if ! is_done approved; then
  [[ -t 0 ]] || die "approval needs an interactive terminal"
  cat <<EOF

Exactly this will change in AWS TEST (account $ACCOUNT, $REGION):
  1. RDS snapshot $SNAPSHOT_ID of $RDS_ID (kept until you delete it).
  2. DB window: attach $APP_SG to admin host $IID, then restore its original groups.
     The window lists the instance's databases. On $DB_NAME only, it applies
     migrations 0012-0018 and stops unless the ledger is 0001-0011..0018.
     It stops if any existing visit's timestamps change. It runs the
     synthetic pilot seed (org scs-pilot-synthetic).
  3. Cognito $POOL: create 3 users ($M_EMAIL, $A_EMAIL, $B_EMAIL), invited by email.
  4. $API_STACK: the changes listed by the scope gate above. Nothing else.
  5. Web: upload the new build to $BUCKET, write config.json, invalidate $DIST.
  6. Smoke suites (synthetic test-slice and pilot identities).
Not touched: Netlify, Supabase, DNS, production users or clients, ogevia-web, RDS SG rules.
Rollback: bash infra/aws/slice/pilot-rollback.sh (uses $RB).
EOF
  read -r -p "Type DEPLOY to approve exactly this scope (anything else cancels): " answer
  [[ "$answer" == DEPLOY ]] || die "not approved; nothing was changed"
  printf 'approved_at=%s\napproved_by=%s\ncommit=%s\nscope_gate=%s\n' "$(date -u +%FT%TZ)" "$ARN" "$COMMIT" "$(sha256sum "$RUN/scope-gate.txt" | cut -c1-16)" > "$RUN/APPROVAL.txt"
  done_ approved
fi
grep -q "commit=$COMMIT" "$RUN/APPROVAL.txt" || die "approval was given for a different commit ($(grep commit= "$RUN/APPROVAL.txt")); start a fresh run"

# ----------------------------------------------------------------------------
phase "9/12 Backup: RDS snapshot"
if ! is_done snapshot; then
  if ! aws rds describe-db-snapshots --db-snapshot-identifier "$SNAPSHOT_ID" >/dev/null 2>&1; then
    aws rds create-db-snapshot --db-instance-identifier "$RDS_ID" --db-snapshot-identifier "$SNAPSHOT_ID" \
      --tags Key=purpose,Value=pre-pilot-rollback >/dev/null
  fi
  echo "Waiting for $SNAPSHOT_ID (usually 5-15 minutes)..."
  aws rds wait db-snapshot-available --db-snapshot-identifier "$SNAPSHOT_ID" || die "snapshot did not complete"
  done_ snapshot
fi
echo "Snapshot $SNAPSHOT_ID: available"

# ----------------------------------------------------------------------------
phase "10/12 DB window: migrations, pilot sign-ins, synthetic seed"
if ! is_done db-window; then
  trap 'rc=$?; db_window_close; (exit $rc); on_exit' EXIT
  trap 'db_window_close; die "unexpected error on line $LINENO (command: $BASH_COMMAND)"' ERR
  db_window_open

  echo "Databases on $RDS_ID (name, size):"
  Q -d postgres -c "select datname || '  ' || pg_size_pretty(pg_database_size(datname)) from pg_database where not datistemplate order by 1" \
    | tee "$RUN/rds-databases.txt" | sed 's/^/  /'
  grep -q "^$DB_NAME " "$RUN/rds-databases.txt" || die "database $DB_NAME not found on $RDS_ID"

  LEDGER=$(Q -d "$DB_NAME" -c "select string_agg(version, ',' order by version) from ogevia_meta.schema_migrations")
  N=$(tr ',' '\n' <<<"$LEDGER" | wc -l)
  EXPECTED=$(seq -f '%04g' 1 "$N" | paste -sd,)
  [[ "$LEDGER" == "$EXPECTED" && "$N" -ge 11 && "$N" -le 18 ]] || die "unexpected migration ledger: $LEDGER"
  echo "Migration ledger before: 0001-$(printf '%04d' "$N")"

  FP_SQL="set timezone to 'UTC'; select count(*) || ':' || coalesce(md5(string_agg(id::text || '|' || time_in::text || '|' || coalesce(time_out::text, '-') || '|' || coalesce(signed_at::text, '-'), ',' order by id)), 'none') from ogevia.service_visits"
  [[ -f "$RB/visit-fingerprint-before.txt" ]] || Q -d "$DB_NAME" -c "$FP_SQL" | tail -1 > "$RB/visit-fingerprint-before.txt"
  echo "Existing visits (count:fingerprint of id, time_in, time_out, signed_at to the microsecond): $(cat "$RB/visit-fingerprint-before.txt")"

  if [[ "$N" -lt 18 ]]; then
    OGEVIA_DATABASE_URL="$DBURL" npx --prefix "$HERE" tsx "$HERE/db/scripts/migrate.ts" || die "a migration failed (it rolled back; earlier ones stay applied)"
  fi
  OGEVIA_DATABASE_URL="$DBURL" npx --prefix "$HERE" tsx "$HERE/db/scripts/verify.ts" || die "schema verification failed"
  AFTER=$(Q -d "$DB_NAME" -c "$FP_SQL" | tail -1)
  [[ "$AFTER" == "$(cat "$RB/visit-fingerprint-before.txt")" ]] \
    || die "existing visit timestamps changed during migration ($AFTER). Do not continue; see pilot-rollback.sh db"
  echo "Existing visit timestamps unchanged (seconds and microseconds): OK"

  for e in "$M_EMAIL" "$A_EMAIL" "$B_EMAIL"; do
    if [[ -z "$(sub_of "$e")" ]]; then
      aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$e" \
        --user-attributes Name=email,Value="$e" Name=email_verified,Value=true --desired-delivery-mediums EMAIL >/dev/null
      echo "Invited $e"
    else
      echo "$e already exists (kept)"
    fi
  done
  MG=$(sub_of "$M_EMAIL"); CA=$(sub_of "$A_EMAIL"); CB=$(sub_of "$B_EMAIL")
  for s in "$MG" "$CA" "$CB"; do [[ "$s" =~ ^[0-9a-f-]{36}$ ]] || die "a pilot sign-in has no Cognito sub"; done
  printf 'PILOT_MG=%s\nPILOT_CA=%s\nPILOT_CB=%s\n' "$MG" "$CA" "$CB" > "$RUN/pilot-subs.env"

  SEED=$(psql -X -v ON_ERROR_STOP=1 -d "$DB_NAME" -v manager_sub="$MG" -v manager_name="$M_NAME" \
    -v caregiver_a_sub="$CA" -v caregiver_a_code=SCS-CG-A -v caregiver_a_first="$A_FIRST" -v caregiver_a_last="$A_LAST" \
    -v caregiver_b_sub="$CB" -v caregiver_b_code=SCS-CG-B -v caregiver_b_first="$B_FIRST" -v caregiver_b_last="$B_LAST" \
    -f "$HERE/db/deploy/04_seed_scs_pilot_synthetic.sql")
  grep -Eq '3 \|\s+2 \|\s+4 \|\s+4' <<<"$SEED" || die "pilot seed read-back is not 3|2|4|4: $SEED"
  echo "Pilot seed: 3 memberships, 2 caregivers, 4 assignments, 4 authorizations"
  db_window_close
  trap on_exit EXIT
  trap 'die "unexpected error on line $LINENO (command: $BASH_COMMAND)"' ERR
  admin_host_groups | grep -qw "$APP_SG" && die "$APP_SG is still attached to $IID: remove it in the EC2 console"
  done_ db-window
fi
echo "DB window closed; admin host groups: $(admin_host_groups)"

# ----------------------------------------------------------------------------
phase "11/12 Deploy the API stack and the web app"
if ! is_done api-deployed; then
  mkdir -p "$RUN/predeploy-templates"
  for s in "${STACKS[@]}"; do
    aws cloudformation get-template --stack-name "$s" --template-stage Original --query TemplateBody --output json > "$RUN/predeploy-templates/$s.json"
  done
  python3 "$SLICE/pilot_diff_gate.py" --cdk-out "$HERE/cdk.out" --deployed "$RUN/predeploy-templates" >/dev/null \
    || die "AWS changed since approval (scope gate no longer passes); nothing deployed"
  # --require-approval never is safe here ONLY because the scope gate just
  # proved the change set equals the approved scope for this exact cdk.out.
  (cd "$HERE" && npx cdk deploy --app cdk.out --exclusively "$API_STACK" --require-approval never --no-notices) \
    || die "API stack deployment failed (CloudFormation rolls the stack back automatically)"
  st=$(aws cloudformation describe-stacks --stack-name "$API_STACK" --query 'Stacks[0].StackStatus' --output text)
  [[ "$st" == UPDATE_COMPLETE ]] || die "$API_STACK is $st"
  [[ "$(aws lambda get-function-configuration --function-name "$FN" --query 'Environment.Variables.DB_NAME' --output text)" == "$DB_NAME" ]] \
    || die "the deployed Lambda no longer points at $DB_NAME"
  done_ api-deployed
fi
if ! is_done web-deployed; then
  python3 - "$RUN/web-build/config.json" <<PY
import json, sys
json.dump({
  "VITE_COGNITO_REGION": "$REGION", "VITE_COGNITO_USER_POOL_ID": "$POOL", "VITE_COGNITO_CLIENT_ID": "$CLIENT",
  "VITE_COGNITO_DOMAIN": "$COGNITO_DOMAIN", "VITE_COGNITO_REDIRECT_URI": "$WEB/auth/callback",
  "VITE_COGNITO_LOGOUT_URI": "$WEB/", "VITE_COGNITO_SCOPES": "openid email",
  "VITE_COGNITO_REFRESH_PERSISTENCE": "session", "VITE_SV_API_BASE_URL": "$API", "VITE_APP_ENV": "$APP_ENV"}, open(sys.argv[1], "w"), indent=2)
PY
  W="$RUN/web-build"
  aws s3 sync "$W/assets" "s3://$BUCKET/assets" --only-show-errors --cache-control "public,max-age=31536000,immutable"
  aws s3 sync "$W" "s3://$BUCKET" --only-show-errors --exclude "assets/*" --exclude "index.html" --exclude "config.json"
  aws s3 cp "$W/config.json" "s3://$BUCKET/config.json" --only-show-errors --content-type application/json --cache-control "no-store"
  aws s3 cp "$W/index.html" "s3://$BUCKET/index.html" --only-show-errors --content-type "text/html; charset=utf-8" --cache-control "no-cache"
  INV=$(aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" --query Invalidation.Id --output text)
  echo "Waiting for CloudFront to refresh (a few minutes)..."
  aws cloudfront wait invalidation-completed --distribution-id "$DIST" --id "$INV"
  for i in $(seq 1 30); do curl -fsS "$WEB/" 2>/dev/null | grep -q 'id="root"' && break; [[ $i == 30 ]] && die "site not reachable"; sleep 10; done
  done_ web-deployed
fi
echo "API and web deployed: $WEB"

# ----------------------------------------------------------------------------
phase "12/12 Smoke suites"
python3 - "$RUN/outputs.json" <<PY
import json, sys
json.dump({"WebOrigin": "$WEB", "ApiUrl": "$API", "TestAppClientId": "$CLIENT", "SiteBucketName": "$BUCKET", "DistributionId": "$DIST"}, open(sys.argv[1], "w"), indent=2)
PY
TCG=$(sub_of "$TEST_CAREGIVER_EMAIL"); TMG=$(sub_of "$TEST_MANAGER_EMAIL")
# shellcheck disable=SC1091
source "$RUN/pilot-subs.env"
trap - ERR; set +e
python3 "$SLICE/smoke.py" --outputs "$RUN/outputs.json" --caregiver-sub "$TCG" --manager-sub "$TMG" 2>&1 | tee "$RUN/smoke.log"
SMOKE=${PIPESTATUS[0]}
python3 "$SLICE/pilot_smoke.py" --client-id "$CLIENT" --manager-sub "$PILOT_MG" --caregiver-a-sub "$PILOT_CA" \
  --caregiver-b-sub "$PILOT_CB" --test-manager-sub "$TMG" 2>&1 | tee "$RUN/pilot-smoke.log"
PSMOKE=${PIPESTATUS[0]}
set -e
cat > "$RUN/REPORT.md" <<EOF
# Ogevia SCS pilot -> AWS TEST deployment report

- Code: $COMMIT; approved: $(grep approved_at "$RUN/APPROVAL.txt" | cut -d= -f2)
- Snapshot: $SNAPSHOT_ID
- Migrations: 0001-$FINAL_MIGRATION on $DB_NAME; existing visit timestamps unchanged: PASS
- Pilot sign-ins: 3 invited ($M_EMAIL, $A_EMAIL, $B_EMAIL)
- API stack: $(aws cloudformation describe-stacks --stack-name "$API_STACK" --query 'Stacks[0].StackStatus' --output text); Lambda code $(aws lambda get-function-configuration --function-name "$FN" --query CodeSha256 --output text | cut -c1-12)…
- Web: $WEB
- Smoke (test slice): $([[ $SMOKE == 0 ]] && echo PASS || echo FAIL) - $(tail -n 20 "$RUN/smoke.log" | grep -m1 -E '^[0-9]+ checks' || echo see smoke.log)
- Pilot checks: $([[ $PSMOKE == 0 ]] && echo PASS || echo FAIL) - $(grep -m1 -E 'pilot checks' "$RUN/pilot-smoke.log" || echo see pilot-smoke.log)
- Rollback material: $RB (templates, Lambda version, routes, previous web files, visit fingerprint, admin-host groups)
EOF
cat "$RUN/REPORT.md"
[[ "$SMOKE" == 0 && "$PSMOKE" == 0 ]] || { PHASE="12/12 Smoke suites"; die "smoke checks failed (details above). The deployment stays in place for diagnosis; rollback: bash infra/aws/slice/pilot-rollback.sh"; }
done_ complete
cat <<EOF

========================================
OGEVIA PILOT BUILD DEPLOYED TO AWS TEST
========================================
Web URL (open on the phone): $WEB
Next: the real-phone acceptance test in docs/aws/PILOT_PHONE_ACCEPTANCE.md
Each of the 3 people has an invitation email with a temporary password.
First sign-in: new password, then an authenticator app (MFA is required).
EOF
