#!/usr/bin/env bash
# =============================================================================
# Ogevia TEST SLICE deployment (Phases 3-6). YELLOW: run ONLY after the owner's
# single consolidated approval (docs/aws/TEST_SLICE_DEPLOYMENT_APPROVAL.md).
#
#   OGEVIA_DEPLOY_APPROVAL=<approval-ref> \
#   OGEVIA_TEST_CAREGIVER_EMAIL=<inbox you control> \
#   OGEVIA_TEST_MANAGER_EMAIL=<inbox you control> \
#   AWS_PROFILE=<admin profile> ./scripts/deploy-test-slice.sh <step>
#
# Steps (run in order; each is re-runnable):
#   preflight   read-only checks (identity, region, admin host, gate)
#   bootstrap   cdk bootstrap (creates the CDKToolkit stack)          [mutates]
#   infra       cdk deploy of the 5 Ogevia stacks                    [mutates]
#   database    create ogevia_sv_test, migrate, login role (via SSM) [mutates]
#   users       create 2 synthetic test sign-ins in Cognito          [mutates]
#   seed        synthetic org/clients/assignments for those users    [mutates]
#   web         build the AWS frontend, upload, invalidate           [mutates]
#   smoke       read-only checks of the deployed slice
#
# Never: production users, real clients/PHI, Netlify/Supabase/DNS changes,
# deletion of any existing resource, or changes to the ogevia-web client.
# Secret VALUES are read only by the operator's own shell in `database` and
# are never printed or written to disk.
# =============================================================================
set -euo pipefail

ACCOUNT=300094796789
REGION=us-west-2
POOL=us-west-2_849AYz5J7
RDS_HOST=ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com
APP_SECRET_ARN=arn:aws:secretsmanager:us-west-2:300094796789:secret:ogevia/database/app-JsOTVQ
ADMIN_HOST_TAG=ogevia-db-admin-temp
DB_NAME=ogevia_sv_test
LOCAL_PORT=15432
STACKS=(Ogevia-prod-EvidenceStorage Ogevia-prod-NetworkEgress Ogevia-prod-WebHosting Ogevia-prod-ServiceVerificationApi Ogevia-prod-Observability)
HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
export AWS_REGION=$REGION CDK_DISABLE_CLI_TELEMETRY=true

die() { echo "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "missing tool: $1"; }
out() { aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }

guard() {
  [[ "${OGEVIA_DEPLOY_APPROVAL:-}" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || die "Set OGEVIA_DEPLOY_APPROVAL to the owner's approval reference."
  local acct; acct=$(aws sts get-caller-identity --query Account --output text)
  [[ "$acct" == "$ACCOUNT" ]] || die "Credentials are for $acct, expected $ACCOUNT."
}

cdk_() { (cd "$HERE" && npx cdk "$@" --no-notices -c env=prod -c mode=deploy); }

case "${1:-}" in
  preflight)
    need aws; need jq; need psql; need pnpm; need session-manager-plugin
    guard
    aws cloudformation describe-stacks --stack-name CDKToolkit >/dev/null 2>&1 && echo "CDK bootstrap: present" || echo "CDK bootstrap: ABSENT (run: bootstrap)"
    aws ec2 describe-instances --filters "Name=tag:Name,Values=$ADMIN_HOST_TAG" \
      --query 'Reservations[].Instances[].[InstanceId,State.Name]' --output text
    aws lambda get-account-settings --query 'AccountLimit.ConcurrentExecutions' --output text | xargs echo "Lambda concurrency limit:"
    (cd "$REPO" && pnpm lint && pnpm typecheck && pnpm test && pnpm build)
    (cd "$HERE" && npx cdk synth --quiet --no-notices -c env=prod -c mode=plan && npx tsx scripts/synth-inventory.ts >/dev/null)
    echo "Preflight OK."
    ;;

  bootstrap)
    guard
    # Default bootstrap: CDKToolkit stack, asset bucket (SSE), ECR repo, deploy roles.
    (cd "$HERE" && npx cdk bootstrap "aws://$ACCOUNT/$REGION" --no-notices)
    ;;

  infra)
    guard
    cdk_ diff "${STACKS[@]}" || true
    # broadening: CDK stops for confirmation on any IAM/security-group widening.
    cdk_ deploy "${STACKS[@]}" --require-approval broadening
    ;;

  database)
    guard
    : "${OGEVIA_RDS_MASTER_SECRET_ARN:?set to the RDS-managed master secret ARN}"
    IID=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$ADMIN_HOST_TAG" "Name=instance-state-name,Values=running" \
      --query 'Reservations[0].Instances[0].InstanceId' --output text)
    [[ "$IID" == i-* ]] || die "Admin host $ADMIN_HOST_TAG is not running (start it, or approve another tunnel)."
    aws ssm start-session --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost \
      --parameters "host=$RDS_HOST,portNumber=5432,localPortNumber=$LOCAL_PORT" >/dev/null &
    TUNNEL=$!; trap 'kill $TUNNEL 2>/dev/null || true' EXIT; sleep 5
    # Secret values stay in shell variables only (never echoed, never on disk).
    MASTER=$(aws secretsmanager get-secret-value --secret-id "$OGEVIA_RDS_MASTER_SECRET_ARN" --query SecretString --output text)
    APP=$(aws secretsmanager get-secret-value --secret-id "$APP_SECRET_ARN" --query SecretString --output text)
    export PGHOST=127.0.0.1 PGPORT=$LOCAL_PORT PGSSLMODE=require
    export PGUSER; PGUSER=$(jq -r .username <<<"$MASTER")
    export PGPASSWORD; PGPASSWORD=$(jq -r .password <<<"$MASTER")
    psql -X -v ON_ERROR_STOP=1 -d postgres -f "$HERE/db/deploy/00_create_test_database.sql"
    # Node TLS through the SSM tunnel: the RDS certificate names the RDS host,
    # not 127.0.0.1, so verification is relaxed ONLY on this local tunnel.
    OGEVIA_DATABASE_URL="postgres://$(jq -rn --arg u "$PGUSER" '$u|@uri'):$(jq -rn --arg p "$PGPASSWORD" '$p|@uri')@127.0.0.1:$LOCAL_PORT/$DB_NAME?sslmode=no-verify" \
      npx --prefix "$HERE" tsx "$HERE/db/scripts/migrate.ts"
    psql -X -v ON_ERROR_STOP=1 -d "$DB_NAME" -v app_user="$(jq -r .username <<<"$APP")" -v app_password="$(jq -r .password <<<"$APP")" \
      -f "$HERE/db/deploy/01_app_login_role.sql" >/dev/null
    OGEVIA_DATABASE_URL="postgres://$(jq -rn --arg u "$PGUSER" '$u|@uri'):$(jq -rn --arg p "$PGPASSWORD" '$p|@uri')@127.0.0.1:$LOCAL_PORT/$DB_NAME?sslmode=no-verify" \
      npx --prefix "$HERE" tsx "$HERE/db/scripts/verify.ts"
    unset MASTER APP PGPASSWORD
    ;;

  users)
    guard
    : "${OGEVIA_TEST_CAREGIVER_EMAIL:?}" "${OGEVIA_TEST_MANAGER_EMAIL:?}"
    for EMAIL in "$OGEVIA_TEST_CAREGIVER_EMAIL" "$OGEVIA_TEST_MANAGER_EMAIL"; do
      # Invitation email with a temporary password; change + TOTP at first sign-in.
      aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$EMAIL" \
        --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
        --desired-delivery-mediums EMAIL --query 'User.Attributes[?Name==`sub`].Value' --output text || true
    done
    ;;

  seed)
    guard
    sub_of() { aws cognito-idp admin-get-user --user-pool-id "$POOL" --username "$1" --query 'UserAttributes[?Name==`sub`].Value' --output text; }
    CG=$(sub_of "$OGEVIA_TEST_CAREGIVER_EMAIL"); MG=$(sub_of "$OGEVIA_TEST_MANAGER_EMAIL")
    echo "Seed with caregiver_sub=$CG manager_sub=$MG (synthetic organization only)."
    echo "Run through the same tunnel as 'database':"
    echo "  psql -X -d $DB_NAME -v caregiver_sub=$CG -v manager_sub=$MG -f $HERE/db/deploy/02_seed_synthetic_test_slice.sql"
    ;;

  web)
    guard
    WEB=$(out Ogevia-prod-WebHosting WebOrigin); CLIENT=$(out Ogevia-prod-WebHosting TestAppClientId)
    BUCKET=$(out Ogevia-prod-WebHosting SiteBucketName); DIST=$(out Ogevia-prod-WebHosting DistributionId)
    API=$(out Ogevia-prod-ServiceVerificationApi ApiUrl)
    (cd "$REPO/apps/web" && \
      VITE_APP_ENV=production VITE_AUTH_PROVIDER=cognito VITE_COGNITO_REGION=$REGION VITE_COGNITO_USER_POOL_ID=$POOL \
      VITE_COGNITO_CLIENT_ID="$CLIENT" VITE_COGNITO_DOMAIN=https://us-west-2849ayz5j7.auth.us-west-2.amazoncognito.com \
      VITE_COGNITO_REDIRECT_URI="$WEB/auth/callback" VITE_COGNITO_LOGOUT_URI="$WEB/" VITE_COGNITO_REFRESH_PERSISTENCE=session \
      VITE_SV_API_BASE_URL="$API" npx vite build --outDir dist-aws --emptyOutDir)
    aws s3 sync "$REPO/apps/web/dist-aws/assets" "s3://$BUCKET/assets" --cache-control "public,max-age=31536000,immutable"
    aws s3 cp "$REPO/apps/web/dist-aws/index.html" "s3://$BUCKET/index.html" --cache-control "no-cache"
    aws s3 sync "$REPO/apps/web/dist-aws" "s3://$BUCKET" --exclude "assets/*" --exclude "index.html"
    aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/index.html" "/" >/dev/null
    echo "Open: $WEB"
    ;;

  smoke)
    WEB=$(out Ogevia-prod-WebHosting WebOrigin); API=$(out Ogevia-prod-ServiceVerificationApi ApiUrl)
    code=$(curl -s -o /dev/null -w '%{http_code}' "$API/v1/me"); [[ "$code" == 401 ]] || die "API without a token returned $code (expected 401)"
    code=$(curl -s -o /dev/null -w '%{http_code}' "$API/v1/anything"); [[ "$code" == 404 || "$code" == 401 ]] || die "unknown route returned $code"
    curl -sI "$WEB/" | grep -qi '^content-security-policy:' || die "CSP header missing"
    curl -sI "$WEB/service-verification" | grep -q ' 200' || die "SPA route rewrite failed"
    echo "Smoke OK: API rejects anonymous calls; web origin serves the app with security headers."
    ;;

  *) sed -n '2,30p' "$0"; exit 2 ;;
esac
