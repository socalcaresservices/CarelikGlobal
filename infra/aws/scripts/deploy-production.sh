#!/usr/bin/env bash
# =============================================================================
# Ogevia PRODUCTION deployment (database ogevia_prd). YELLOW (CLAUDE.md s.13):
# run only with the owner's approval reference, from an operator shell that has
# AWS admin credentials and the SSM session-manager-plugin.
#
#   # read-only checks first (no mutation):
#   AWS_PROFILE=<admin> ./scripts/deploy-production.sh check
#
#   OGEVIA_DEPLOY_APPROVAL=<approval-ref> \
#   OGEVIA_ADMIN_EMAIL=<the administrator's own inbox> \
#   OGEVIA_ADMIN_NAME="<display name, optional>" \
#   AWS_PROFILE=<admin> ./scripts/deploy-production.sh all
#
# Order (each step is re-runnable; `all` runs them in this order):
#   check     inputs + production config + RDS status/backups     [read-only]
#   snapshot  manual RDS snapshot = the rollback anchor            [mutates]
#   secret    cdk deploy Ogevia-prd-DatabaseSecret                 [mutates]
#   egress    cdk deploy Ogevia-prod-NetworkEgress (additive policy) [mutates]
#   database  create ogevia_prd, migrate, app login, tenant, admin,
#             access checks                                        [mutates]
#   infra     cdk diff + deploy the remaining Ogevia-prd-* stacks  [mutates]
#   smoke     prove the deployed API runs on ogevia_prd            [read-only]
#   web       (separate) build + publish the frontend for the prd API [mutates]
#
# The database is fully prepared BEFORE the API stack exists; nothing serves
# traffic from an unprepared database. The pilot (Ogevia-prod-*, the test database)
# is never repointed. Secret VALUES are read only into this shell's memory and
# are never printed, logged, or written to disk. Shell tracing is never enabled.
# =============================================================================
set -euo pipefail
set +x

HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
LOCAL_PORT=${OGEVIA_TUNNEL_PORT:-15433}
ADMIN_HOST_TAG=ogevia-db-admin-temp
export CDK_DISABLE_CLI_TELEMETRY=true

STEP="startup"
TUNNEL=""
IID=""
die() { echo "ERROR [$STEP]: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing tool: $1"; }
on_error() {
  local code=$?
  echo "" >&2
  echo "DEPLOYMENT FAILED at step '$STEP' (exit $code). Nothing after this step ran." >&2
  echo "Recovery: docs/aws/PRODUCTION_DEPLOYMENT.md section 6. Every step is re-runnable: fix the cause, then re-run from '$STEP'." >&2
}
cleanup() {
  [[ -n "$TUNNEL" ]] && kill "$TUNNEL" 2>/dev/null || true
  [[ -n "$IID" ]] && pkill -f "session-manager-plugin.*$IID" 2>/dev/null || true
  unset PGPASSWORD APP_PASSWORD TEST_PASSWORD MASTER 2>/dev/null || true
}
trap on_error ERR
trap cleanup EXIT

cfg() { jq -r "$1" <<<"$CFG"; }

load_config() {
  STEP="config"
  # Single source of truth + fail-closed validation (rejects the test database,
  # the shared test secret, ogevia_app as the login).
  CFG=$(cd "$HERE" && npx --no-install tsx scripts/print-prd-config.ts) || die "production configuration is invalid"
  REGION=$(cfg .region); ACCOUNT=$(cfg .account); DB_NAME=$(cfg .databaseName); APP_LOGIN=$(cfg .appLogin)
  APP_SECRET_NAME=$(cfg .appSecretName); TEST_DB=$(cfg .testDatabaseName); RDS_ID=$(cfg .rdsInstance)
  RDS_HOST=$(cfg .rdsHost); MASTER_ARN=$(cfg .rdsMasterSecretArn); APP_SG=$(cfg .appSecurityGroup)
  POOL=$(cfg .userPoolId); IDENTITY_FN=$(cfg .identityFunction); TEST_SECRET_ARN=$(cfg .testAppSecretArn)
  S_SECRET=$(cfg .stacks.secret); S_API=$(cfg .stacks.api); S_WEB=$(cfg .stacks.web); S_EGRESS=$(cfg .stacks.egressOwner)
  mapfile -t S_REST < <(jq -r '.stacks.rest[]' <<<"$CFG")
  export AWS_REGION=$REGION
  [[ "$DB_NAME" == "ogevia_prd" ]] || die "production database must be ogevia_prd (got '$DB_NAME')"
  [[ "$DB_NAME" != "$TEST_DB" ]] || die "production database equals the test database"
  [[ "$APP_LOGIN" == "ogevia_prd_app" ]] || die "unexpected production login"
}

guard() {
  STEP="guard"
  [[ "${OGEVIA_DEPLOY_APPROVAL:-}" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || die "set OGEVIA_DEPLOY_APPROVAL to the owner's approval reference"
  local acct; acct=$(aws sts get-caller-identity --query Account --output text)
  [[ "$acct" == "$ACCOUNT" ]] || die "credentials are for account $acct, expected $ACCOUNT"
}

admin_email() {
  STEP="inputs"
  [[ -n "${OGEVIA_ADMIN_EMAIL:-}" ]] || die "set OGEVIA_ADMIN_EMAIL to the primary administrator's own email (it is never guessed)"
  [[ "$OGEVIA_ADMIN_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "OGEVIA_ADMIN_EMAIL is not a valid email address"
}

cdk_() { (cd "$HERE" && npx --no-install cdk "$@" --no-notices -c env=prd -c mode=deploy); }
cdk_prod_egress() { (cd "$HERE" && npx --no-install cdk "$@" --no-notices -c env=prod -c mode=deploy); }

# ---------------------------------------------------------------- check ------
do_check() {
  STEP="check:tools"
  for t in aws jq psql node npx; do need "$t"; done
  STEP="check:identity"
  local acct; acct=$(aws sts get-caller-identity --query Account --output text)
  [[ "$acct" == "$ACCOUNT" ]] || die "credentials are for account $acct, expected $ACCOUNT"
  STEP="check:rds"
  local r; r=$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" \
    --query 'DBInstances[0].[DBInstanceStatus,BackupRetentionPeriod,StorageEncrypted,PubliclyAccessible,DeletionProtection]' --output text)
  read -r status retention encrypted public delprot <<<"$r"
  [[ "$status" == "available" ]] || die "RDS $RDS_ID status is '$status' (need available)"
  # Existing requirement (docs/aws/CONTINUITY_AND_RECOVERY.md): 7-day automated
  # backups with PITR, encrypted, private, deletion protection on.
  (( retention >= 7 )) || die "RDS backup retention is $retention days (need >= 7)"
  [[ "$encrypted" == "True" ]] || die "RDS storage is not encrypted"
  [[ "$public" == "False" ]] || die "RDS is publicly accessible"
  [[ "$delprot" == "True" ]] || die "RDS deletion protection is off"
  local restorable; restorable=$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0].LatestRestorableTime' --output text)
  [[ -n "$restorable" && "$restorable" != "None" ]] || die "RDS has no restorable point in time"
  echo "RDS $RDS_ID: available, backups ${retention}d, latest restorable $restorable, encrypted, private, deletion-protected."
  STEP="check:mfa"
  local mfa; mfa=$(aws cognito-idp describe-user-pool --user-pool-id "$POOL" --query 'UserPool.MfaConfiguration' --output text)
  [[ "$mfa" == "ON" ]] || die "Cognito pool MFA is '$mfa' (required: ON). Not changing it."
  echo "Cognito pool MFA: ON."
  STEP="check:quality-gate"
  (cd "$REPO" && pnpm --silent lint && pnpm --silent typecheck && pnpm --silent test && pnpm --silent build) || die "repository quality gate failed"
  (cd "$HERE" && npx --no-install cdk synth --quiet --no-notices -c env=prd -c mode=plan >/dev/null) || die "cdk synth (env=prd) failed"
  echo "CHECK OK."
}

# ------------------------------------------------------------- snapshot ------
do_snapshot() {
  guard; STEP="snapshot"
  SNAP="${OGEVIA_SNAPSHOT_ID:-$RDS_ID-pre-prd-$(date -u +%Y%m%d)}"
  if aws rds describe-db-snapshots --db-snapshot-identifier "$SNAP" >/dev/null 2>&1; then
    echo "Snapshot $SNAP already exists; reusing it as the rollback anchor."
  else
    aws rds create-db-snapshot --db-instance-identifier "$RDS_ID" --db-snapshot-identifier "$SNAP" >/dev/null
  fi
  aws rds wait db-snapshot-available --db-snapshot-identifier "$SNAP"
  echo "Rollback anchor available: $SNAP (restore only to a NEW instance)."
}

# --------------------------------------------------------- secret / egress ---
do_secret() {
  guard; STEP="secret"
  cdk_ deploy "$S_SECRET" --require-approval broadening
}

do_egress() {
  guard; STEP="egress"
  # Additive endpoint-policy entries on the pilot's NetworkEgress stack so the
  # production Lambda can reach its own secret/bucket/identity function through
  # the shared endpoints. Review the diff: only these three Resource lists grow.
  cdk_prod_egress diff "$S_EGRESS" || true
  cdk_prod_egress deploy "$S_EGRESS" --exclusively --require-approval broadening
}

# -------------------------------------------------------------- database -----
open_tunnel() {
  IID=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$ADMIN_HOST_TAG" "Name=instance-state-name,Values=running" \
    --query 'Reservations[0].Instances[0].InstanceId' --output text)
  [[ "$IID" == i-* ]] || die "admin host $ADMIN_HOST_TAG is not running (start it, or approve another private access path)"
  aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text \
    | grep -q "$APP_SG" || die "admin host lacks $APP_SG, so RDS will refuse it (owner-approved temporary attachment; see the test-slice approval doc section 8)"
  aws ssm start-session --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters "host=$RDS_HOST,portNumber=5432,localPortNumber=$LOCAL_PORT" >/dev/null &
  TUNNEL=$!
  sleep 8
  kill -0 "$TUNNEL" 2>/dev/null || die "SSM tunnel did not start"
  local MASTER
  MASTER=$(aws secretsmanager get-secret-value --secret-id "$MASTER_ARN" --query SecretString --output text)
  export PGHOST=127.0.0.1 PGPORT=$LOCAL_PORT PGSSLMODE=require
  PGUSER=$(jq -r .username <<<"$MASTER"); export PGUSER
  PGPASSWORD=$(jq -r .password <<<"$MASTER"); export PGPASSWORD
  MASTER_USER=$PGUSER; MASTER_PASS=$PGPASSWORD
}

url_of() { # url_of <database>  (master credentials; tunnel host; TLS name differs, so no-verify on the local tunnel only)
  printf 'postgres://%s:%s@127.0.0.1:%s/%s?sslmode=no-verify' \
    "$(jq -rn --arg u "$MASTER_USER" '$u|@uri')" "$(jq -rn --arg p "$MASTER_PASS" '$p|@uri')" "$LOCAL_PORT" "$1"
}

# expect_connect_refused <user> <password> <database> <label>
expect_connect_refused() {
  local out
  if out=$(PGPASSWORD="$2" psql -X -w -h 127.0.0.1 -p "$LOCAL_PORT" -U "$1" -d "$3" -c 'select 1' 2>&1); then
    die "$4: connection SUCCEEDED (it must be refused)"
  fi
  grep -qiE "permission denied for database|not permitted to log in|password authentication failed" <<<"$out" \
    || die "$4: connection failed for an unexpected reason (not a clean refusal)"
  echo "PASS $4: refused."
}

do_database() {
  guard; admin_email; STEP="database:tunnel"
  open_tunnel

  STEP="database:read-credentials"
  local APP_JSON APP_PASSWORD TEST_JSON TEST_USER TEST_PASSWORD
  APP_JSON=$(aws secretsmanager get-secret-value --secret-id "$APP_SECRET_NAME" --query SecretString --output text) \
    || die "production secret $APP_SECRET_NAME not found; run the 'secret' step first"
  [[ "$(jq -r .username <<<"$APP_JSON")" == "$APP_LOGIN" && "$(jq -r .dbname <<<"$APP_JSON")" == "$DB_NAME" ]] \
    || die "production secret does not name $APP_LOGIN / $DB_NAME"
  APP_PASSWORD=$(jq -r .password <<<"$APP_JSON"); unset APP_JSON
  [[ "$APP_PASSWORD" =~ ^[A-Za-z0-9]{24,}$ ]] || die "production secret password has an unexpected format"

  STEP="database:create"
  psql -X -q -v ON_ERROR_STOP=1 -d postgres -f "$HERE/db/deploy/10_prd_create_database.sql"

  STEP="database:migrate"
  # The SAME runner and folder as the test slice: db/scripts/migrate.ts over
  # db/migrations (38 files, 0001-0038; ledger ogevia_meta.schema_migrations; checksum drift
  # refuses; reruns apply nothing).
  OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner OGEVIA_DATABASE_URL="$(url_of "$DB_NAME")" \
    npx --no-install --prefix "$HERE" tsx "$HERE/db/scripts/migrate.ts"

  STEP="database:app-login"
  # Variables travel on stdin (a here-document), never on a command line.
  psql -X -q -v ON_ERROR_STOP=1 -d "$DB_NAME" -f - >/dev/null <<SQL
\set app_user $APP_LOGIN
\set app_password '$APP_PASSWORD'
\i $HERE/db/deploy/11_prd_app_login.sql
SQL

  STEP="database:tenant"
  psql -X -q -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$HERE/db/deploy/12_prd_bootstrap_tenant.sql" >/dev/null

  STEP="database:admin-signin"
  # Account activation uses Cognito's own invitation: Cognito generates the
  # temporary password and emails it; the administrator sets a password and
  # enrolls TOTP MFA at first sign-in. No password is created or seen here.
  local SUB
  if SUB=$(aws cognito-idp admin-get-user --user-pool-id "$POOL" --username "$OGEVIA_ADMIN_EMAIL" \
      --query 'UserAttributes[?Name==`sub`].Value' --output text 2>/dev/null); then
    echo "Administrator sign-in already exists; reusing it."
  else
    SUB=$(aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$OGEVIA_ADMIN_EMAIL" \
      --user-attributes Name=email,Value="$OGEVIA_ADMIN_EMAIL" Name=email_verified,Value=true \
      --desired-delivery-mediums EMAIL --query 'User.Attributes[?Name==`sub`].Value' --output text)
    echo "Invitation email sent by Cognito."
  fi
  [[ "$SUB" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die "could not resolve the administrator's sign-in id"

  STEP="database:admin-membership"
  psql -X -q -v ON_ERROR_STOP=1 -d "$DB_NAME" -f - >/dev/null <<SQL
\set admin_sub '$SUB'
\set admin_name '$(printf '%s' "${OGEVIA_ADMIN_NAME:-}" | tr -d "'\\\\\n")'
\i $HERE/db/deploy/13_prd_bootstrap_admin.sql
SQL

  STEP="database:verify"
  psql -X -q -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$HERE/db/deploy/14_prd_verify_access.sql" >/dev/null
  OGEVIA_DATABASE_URL="$(url_of "$DB_NAME")" npx --no-install --prefix "$HERE" tsx "$HERE/db/scripts/verify.ts"

  STEP="database:credential-isolation"
  # 1. The production login reaches ogevia_prd and ONLY ogevia_prd.
  local who
  who=$(PGPASSWORD="$APP_PASSWORD" psql -X -At -w -h 127.0.0.1 -p "$LOCAL_PORT" -U "$APP_LOGIN" -d "$DB_NAME" -c 'select current_database()')
  [[ "$who" == "$DB_NAME" ]] || die "production login did not land in $DB_NAME"
  echo "PASS production login connects to $DB_NAME."
  if psql -X -At -d postgres -c "select 1 from pg_database where datname='$TEST_DB'" | grep -q 1; then
    expect_connect_refused "$APP_LOGIN" "$APP_PASSWORD" "$TEST_DB" "production login -> $TEST_DB"
  fi
  # 2. The test slice's application credential cannot connect to ogevia_prd.
  TEST_JSON=$(aws secretsmanager get-secret-value --secret-id "$TEST_SECRET_ARN" --query SecretString --output text)
  TEST_USER=$(jq -r .username <<<"$TEST_JSON"); TEST_PASSWORD=$(jq -r .password <<<"$TEST_JSON"); unset TEST_JSON
  expect_connect_refused "$TEST_USER" "$TEST_PASSWORD" "$DB_NAME" "test-slice credential -> $DB_NAME"
  unset APP_PASSWORD TEST_PASSWORD
  echo "DATABASE READY: $DB_NAME migrated, tenant and administrator in place, credentials isolated."
}

# ------------------------------------------------------------------ infra ----
do_infra() {
  guard; STEP="infra:preconditions"
  # Do not create the API until the database has been prepared by this script.
  aws secretsmanager describe-secret --secret-id "$APP_SECRET_NAME" >/dev/null 2>&1 || die "run 'secret' and 'database' first"
  [[ -t 0 ]] || die "run 'infra' from an interactive terminal: CDK asks you to confirm IAM changes"
  STEP="infra:diff"
  cdk_ diff "${S_REST[@]}" || true
  STEP="infra:deploy"
  cdk_ deploy "${S_REST[@]}" --require-approval broadening
}

# ------------------------------------------------------------------ smoke ----
stack_output() { aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }

do_smoke() {
  STEP="smoke:lambda-config"
  local API; API=$(stack_output "$S_API" ApiUrl)
  [[ "$API" == https://* ]] || die "could not read the production API URL"
  local fn found=""
  for fn in $(aws cloudformation list-stack-resources --stack-name "$S_API" \
      --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text); do
    local env; env=$(aws lambda get-function-configuration --function-name "$fn" --query 'Environment.Variables' --output json)
    [[ "$(jq -r '.DB_NAME // empty' <<<"$env")" ]] || continue
    found=$fn
    [[ "$(jq -r .DB_NAME <<<"$env")" == "$DB_NAME" ]] || die "Lambda DB_NAME is not $DB_NAME"
    [[ "$(jq -r .OGEVIA_ENV <<<"$env")" == "prd" ]] || die "Lambda OGEVIA_ENV is not prd"
    [[ "$(jq -r .DB_SECRET_ARN <<<"$env")" == *":secret:$APP_SECRET_NAME-"* ]] || die "Lambda is not using the production secret"
    [[ "$(jq -r .DB_SECRET_ARN <<<"$env")" != "$TEST_SECRET_ARN" ]] || die "Lambda is using the TEST secret"
    [[ "$(jq -r 'to_entries[] | select(.key|test("PASSWORD|SECRET_KEY|TOKEN";"i")) | .key' <<<"$env")" == "" ]] || die "Lambda environment carries a secret-looking value"
  done
  [[ -n "$found" ]] || die "no API Lambda found in $S_API"
  echo "PASS Lambda $found: DB_NAME=$DB_NAME OGEVIA_ENV=prd, production secret, no secret values in environment."

  STEP="smoke:api"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "$API/v1/me"); [[ "$code" == 401 ]] || die "anonymous /v1/me returned $code (expected 401)"
  echo "PASS API rejects anonymous calls (401)."

  STEP="smoke:runtime-database"
  # A well-formed but unknown public token makes the Lambda open its database
  # connection (and returns no data). Then ask Postgres who is connected.
  local token; token=$(openssl rand -hex 32)
  curl -s -o /dev/null "$API/v1/public/care-portals/$token" || true
  open_tunnel
  local seen
  seen=$(psql -X -At -d postgres -c "select datname || '/' || usename from pg_stat_activity where application_name = 'ogevia-sv-api' and usename = '$APP_LOGIN' group by 1")
  [[ "$seen" == "$DB_NAME/$APP_LOGIN" ]] || die "runtime connection not observed on $DB_NAME as $APP_LOGIN (saw: '${seen:-none}')"
  local wrong
  wrong=$(psql -X -At -d postgres -c "select count(*) from pg_stat_activity where application_name = 'ogevia-sv-api' and datname = '$TEST_DB' and usename = '$APP_LOGIN'")
  [[ "$wrong" == 0 ]] || die "production login is connected to the test database"
  echo "PASS the deployed API is connected to $DB_NAME as $APP_LOGIN (observed in pg_stat_activity)."
  echo "SMOKE OK."
}

# -------------------------------------------------------------------- web ----
do_web() {
  guard; STEP="web"
  local WEB CLIENT BUCKET DIST API
  WEB=$(stack_output "$S_WEB" WebOrigin); CLIENT=$(stack_output "$S_WEB" TestAppClientId)
  BUCKET=$(stack_output "$S_WEB" SiteBucketName); DIST=$(stack_output "$S_WEB" DistributionId)
  API=$(stack_output "$S_API" ApiUrl)
  local DOMAIN; DOMAIN=$(aws cognito-idp describe-user-pool --user-pool-id "$POOL" --query 'UserPool.Domain' --output text)
  (cd "$REPO/apps/web" && \
    VITE_APP_ENV=production VITE_AUTH_PROVIDER=cognito VITE_COGNITO_REGION=$REGION VITE_COGNITO_USER_POOL_ID=$POOL \
    VITE_COGNITO_CLIENT_ID="$CLIENT" VITE_COGNITO_DOMAIN="https://$DOMAIN.auth.$REGION.amazoncognito.com" \
    VITE_COGNITO_REDIRECT_URI="$WEB/auth/callback" VITE_COGNITO_LOGOUT_URI="$WEB/" VITE_COGNITO_REFRESH_PERSISTENCE=session \
    VITE_SV_API_BASE_URL="$API" npx vite build --outDir dist-aws-prd --emptyOutDir)
  aws s3 sync "$REPO/apps/web/dist-aws-prd/assets" "s3://$BUCKET/assets" --cache-control "public,max-age=31536000,immutable"
  aws s3 cp "$REPO/apps/web/dist-aws-prd/index.html" "s3://$BUCKET/index.html" --cache-control "no-cache"
  aws s3 sync "$REPO/apps/web/dist-aws-prd" "s3://$BUCKET" --exclude "assets/*" --exclude "index.html"
  aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/index.html" "/" >/dev/null
  echo "Production web origin: $WEB"
}

usage() { sed -n '2,31p' "$0"; exit 2; }

CMD="${1:-}"
[[ -n "$CMD" ]] || usage
need npx; need jq; need aws
load_config
case "$CMD" in
  check)    do_check ;;
  snapshot) do_snapshot ;;
  secret)   do_secret ;;
  egress)   do_egress ;;
  database) do_database ;;
  infra)    do_infra ;;
  smoke)    do_smoke ;;
  web)      do_web ;;
  all)
    guard; admin_email
    do_check; do_snapshot; do_secret; do_egress; do_database; do_infra; do_smoke
    STEP="done"
    echo ""
    echo "PRODUCTION DEPLOYED on $DB_NAME. Remaining operator actions: run 'web', then the GO/NO-GO sign-off in docs/aws/PRODUCTION_DEPLOYMENT.md."
    ;;
  *) usage ;;
esac
