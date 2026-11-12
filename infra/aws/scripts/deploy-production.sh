#!/usr/bin/env bash
# Existing production deployment entry point, promotion of the owner-accepted TEST app.
if [[ "${1:-}" == ux-release ]]; then
  set -euo pipefail
  set +x +H
  umask 077
  export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER='' AWS_CLI_AUTO_PROMPT=off
  A() { aws --cli-connect-timeout 5 --cli-read-timeout 60 "$@"; }
  stop() { echo "STOP: $*"; exit 1; }
  stage() { STEP="$1"; printf '\033[32m%s\033[0m\n' "$STEP"; }
  [[ "${OGEVIA_DEPLOY_APPROVAL:-}" == owner-production-ux-go ]] || stop 'production owner authorization is required'
  [[ "$(uname -s)" == Linux ]] || stop 'run in AWS CloudShell'
  [[ "$(A sts get-caller-identity --query Account --output text)" == 300094796789 ]] || stop 'wrong account'
  exec 9>/tmp/ogevia-production-release.lock
  flock -n 9 || stop 'another production release is running'
  WORK=$(mktemp -d /tmp/ogevia-production-release.XXXXXX)
  exec > >(tee "$WORK/release.log") 2>&1
  SELF=$(readlink -f "${BASH_SOURCE[0]}")
  OPERATOR_DIR=$(dirname "$SELF")
  PLAN="$OPERATOR_DIR/production-ux-release.py"
  [[ -f "$PLAN" ]] || stop 'verified production-ux-release.py is required beside the operator'
  SOURCE=6cbab00b2795d0cfe42bf644adc6a559adda7c76
  ASSETS=cdk-hnb659fds-assets-300094796789-us-west-2
  KEY=ed01f08a2df9d8870ed44c25912ce9c9d18f4e6dd73dba29594c954a538c983b.zip
  HOST=ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com
  IID=i-0ce8db2d7e5839dd5; ADMIN=sg-00e01e2ca80442c1f; APP=sg-064ffce3bcbe8eb3b
  ATTACHED=0; TUNNEL=''; STEP=preparation; DB_APPLIED=0; API_APPLIED=0; WEB_STARTED=0
  PREFIX="s3://$ASSETS/ogevia-production-release/$(basename "$WORK")"
  cleanup_ux_production() {
    rc=$?; trap - EXIT; unset PGPASSWORD MASTER PASSWORD
    if [[ -n "$TUNNEL" ]]; then pkill -P "$TUNNEL" 2>/dev/null || true; kill "$TUNNEL" 2>/dev/null || true; wait "$TUNNEL" 2>/dev/null || true; fi
    if [[ "$ATTACHED" == 1 ]]; then
      groups=$(A ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text | tr '\t' '\n' | sort | xargs) || groups=''
      both=$(printf '%s\n%s\n' "$ADMIN" "$APP" | sort | xargs)
      if [[ "$groups" == "$ADMIN" ]]; then echo 'ADMIN HOST RESTORED';
      elif [[ "$groups" == "$both" ]] && A ec2 modify-instance-attribute --instance-id "$IID" --groups "$ADMIN" && [[ "$(A ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)" == "$ADMIN" ]]; then echo 'ADMIN HOST RESTORED';
      else echo "RESTORE FAILED: restore $ADMIN only on $IID"; rc=1; fi
    fi
    echo "Release state: database=$DB_APPLIED API=$API_APPLIED website-started=$WEB_STARTED"
    echo "Private recovery: $PREFIX/before-update.tgz"
    [[ "$rc" == 0 ]] || echo "STOPPED at $STEP. Keep this session open; do not rerun. Log: $WORK/release.log"
    exit "$rc"
  }
  trap cleanup_ux_production EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  stage '[1/6] Restore tools and the accepted application checkout'
  export COREPACK_HOME="$WORK/corepack" XDG_CACHE_HOME="$WORK/cache" npm_config_cache="$WORK/npm-cache" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  major=$(pg_dump --version 2>/dev/null | sed -E 's/.* ([0-9]+)\..*/\1/' || true)
  if [[ ! "$major" =~ ^[0-9]+$ || "$major" -lt 18 ]]; then
    if rpm -q postgresql16 >/dev/null 2>&1; then sudo dnf swap -y --releasever=latest postgresql16 postgresql18; else sudo dnf install -y --releasever=latest postgresql18; fi
    hash -r
  fi
  major=$(pg_dump --version | sed -E 's/.* ([0-9]+)\..*/\1/')
  [[ "$major" =~ ^[0-9]+$ && "$major" -ge 18 ]] || stop 'PostgreSQL 18+ pg_dump required'
  for bin in /tmp/ogevia-*/node-v22.*-linux-*/bin; do [[ ! -x "$bin/node" ]] || { export PATH="$bin:$PATH"; break; }; done
  if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" != 22 ]]; then
    case "$(uname -m)" in x86_64) arch=x64;; aarch64) arch=arm64;; *) stop 'unsupported CPU';; esac
    archive="node-v22.23.5-linux-$arch.tar.xz"
    curl -fsS --retry 3 --connect-timeout 10 --max-time 180 "https://nodejs.org/dist/v22.23.5/$archive" -o "$WORK/$archive"
    curl -fsS --connect-timeout 10 --max-time 60 https://nodejs.org/dist/v22.23.5/SHASUMS256.txt -o "$WORK/node-sums"
    awk -v f="$archive" '$2==f' "$WORK/node-sums" > "$WORK/node-check"
    test -s "$WORK/node-check"
    (cd "$WORK" && sha256sum --check node-check)
    tar -xJf "$WORK/$archive" -C "$WORK"
    export PATH="$WORK/${archive%.tar.xz}/bin:$PATH"
  fi
  mkdir -p "$WORK/bin"
  corepack enable --install-directory "$WORK/bin"
  export PATH="$WORK/bin:$PATH"
  REPO=''
  while IFS= read -r g; do
    r="${g%/.git}"
    if [[ "$(git -C "$r" rev-parse HEAD 2>/dev/null)" == "$SOURCE" && -z "$(git -C "$r" status --porcelain --untracked-files=no)" ]]; then REPO="$r"; break; fi
  done < <(find /tmp -maxdepth 5 -type d -name .git -print 2>/dev/null)
  if [[ -z "$REPO" ]]; then
    REPO="$WORK/repo"; git init -q "$REPO"
    git -C "$REPO" remote add origin https://github.com/socalcaresservices/CarelikGlobal.git
    git -C "$REPO" config remote.origin.promisor true
    git -C "$REPO" config remote.origin.partialclonefilter blob:none
    git -C "$REPO" fetch --filter=blob:none --depth=1 origin "$SOURCE"
    git -C "$REPO" checkout --detach -q FETCH_HEAD
  fi
  [[ -x "$REPO/apps/web/node_modules/.bin/vite" ]] || pnpm --dir "$REPO" install --frozen-lockfile --store-dir "$WORK/store" --prefer-offline
  # The helper is operator tooling; its immutable SQL inputs come from the accepted checkout.
  export OGEVIA_UX_SOURCE_ROOT="$REPO"
  python3 "$PLAN" sql > "$WORK/upgrade.sql"
  stage '[2/6] Capture production rollback and verify the code-only change'
  for s in Ogevia-prd-ServiceVerificationApi Ogevia-prd-WebHosting Ogevia-prd-Auth Ogevia-prod-ServiceVerificationApi; do
    A cloudformation describe-stacks --stack-name "$s" --query 'Stacks[0].{Status:StackStatus,Outputs:Outputs,Parameters:Parameters[].{ParameterKey:ParameterKey,UsePreviousValue:`true`}}' --output json > "$WORK/$s.stack.json"
    jq -e '.Status=="UPDATE_COMPLETE" or .Status=="CREATE_COMPLETE" or .Status=="UPDATE_ROLLBACK_COMPLETE"' "$WORK/$s.stack.json" >/dev/null || stop "stack not settled: $s"
    A cloudformation get-template --stack-name "$s" --template-stage Original --query TemplateBody --output json > "$WORK/$s.template.json"
  done
  python3 "$PLAN" patch "$WORK/Ogevia-prd-ServiceVerificationApi.template.json" "$WORK/candidate.template.json"
  jq '.Parameters' "$WORK/Ogevia-prd-ServiceVerificationApi.stack.json" > "$WORK/previous-parameters.json"
  FN=$(A cloudformation list-stack-resources --stack-name Ogevia-prd-ServiceVerificationApi --output json | jq -er '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId|startswith("Handler")))] | if length==1 then .[0].PhysicalResourceId else error("Expected one production Handler") end')
  A lambda get-function-configuration --function-name "$FN" --query '{Function:FunctionName,CodeSha256:CodeSha256,Runtime:Runtime,Database:Environment.Variables.DB_NAME,Host:Environment.Variables.DB_HOST,Pool:Environment.Variables.COGNITO_USER_POOL_ID}' --output json > "$WORK/handler.before.json"
  jq -e --arg host "$HOST" '.Database=="ogevia_prd" and .Host==$host and .Pool=="us-west-2_FHJoX71ca" and .Runtime=="nodejs24.x"' "$WORK/handler.before.json" >/dev/null || stop 'production runtime differs'
  URL=$(A lambda get-function --function-name "$FN" --query Code.Location --output text)
  curl -fsS --connect-timeout 10 --max-time 120 "$URL" -o "$WORK/handler.before.zip"; unset URL
  A s3 cp "s3://$ASSETS/$KEY" "$WORK/handler.accepted.zip" --only-show-errors
  python3 "$PLAN" assets "$WORK"
  out_ux() { jq -er --arg key "$2" '.Outputs[] | select(.OutputKey==$key) | .OutputValue' "$WORK/$1.stack.json"; }
  BUCKET=$(out_ux Ogevia-prd-WebHosting SiteBucketName); DIST=$(out_ux Ogevia-prd-WebHosting DistributionId)
  WEB=$(out_ux Ogevia-prd-WebHosting WebOrigin); API=$(out_ux Ogevia-prd-ServiceVerificationApi ApiUrl)
  TEST_BUCKET=$(A cloudformation describe-stacks --stack-name Ogevia-prod-WebHosting --query 'Stacks[0].Outputs[?OutputKey==`SiteBucketName`].OutputValue' --output text)
  [[ "$BUCKET" != "$TEST_BUCKET" && "$BUCKET" == ogevia-prd-* && "$WEB" == https://*.cloudfront.net && "$API" == https://*.execute-api.us-west-2.amazonaws.com* ]] || stop 'web/API targets differ'
  A s3 sync "s3://$BUCKET" "$WORK/web-before" --only-show-errors
  test -s "$WORK/web-before/index.html"
  A s3api get-public-access-block --bucket "$ASSETS" --query PublicAccessBlockConfiguration --output json | jq -e '.BlockPublicAcls and .IgnorePublicAcls and .BlockPublicPolicy and .RestrictPublicBuckets' >/dev/null || stop 'backup bucket must be private'
  A s3api get-bucket-encryption --bucket "$ASSETS" --query 'ServerSideEncryptionConfiguration.Rules' --output json | jq -e 'length>0 and all(.[]; .ApplyServerSideEncryptionByDefault.SSEAlgorithm=="AES256" or .ApplyServerSideEncryptionByDefault.SSEAlgorithm=="aws:kms")' >/dev/null || stop 'backup bucket must be encrypted'
  stage '[3/6] Open the production tunnel and save a database backup'
  A rds describe-db-instances --db-instance-identifier ogevia-prod-postgres --query 'DBInstances[0].{host:Endpoint.Address,public:PubliclyAccessible,status:DBInstanceStatus,days:BackupRetentionPeriod,encrypted:StorageEncrypted,protected:DeletionProtection,master:MasterUserSecret.SecretArn}' --output json > "$WORK/rds.json"
  jq -e --arg host "$HOST" '.host==$host and .public==false and .status=="available" and .days>=7 and .encrypted and .protected' "$WORK/rds.json" >/dev/null || stop 'production RDS protections differ'
  [[ "$(A ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)" == "$ADMIN" ]] || stop 'admin host groups differ'
  curl -fsS --connect-timeout 10 --max-time 60 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o "$WORK/ca.pem"
  PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
  ATTACHED=1; A ec2 modify-instance-attribute --instance-id "$IID" --groups "$ADMIN" "$APP"
  sleep 5
  A ssm start-session --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters "{\"host\":[\"$HOST\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"$PORT\"]}" > "$WORK/tunnel.log" 2>&1 &
  TUNNEL=$!; UP=0
  for n in $(seq 1 30); do if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then UP=1; break; fi; kill -0 "$TUNNEL" 2>/dev/null || break; sleep 1; done
  [[ "$UP" == 1 ]] || stop 'production tunnel did not start'
  MASTER=$(A secretsmanager get-secret-value --secret-id "$(jq -er .master "$WORK/rds.json")" --query SecretString --output text)
  export PGUSER; PGUSER=$(jq -er .username <<<"$MASTER")
  export PGPASSWORD; PGPASSWORD=$(jq -er .password <<<"$MASTER"); unset MASTER
  unset PGSERVICE PGSERVICEFILE PGPASSFILE
  export PGHOST="$HOST" PGHOSTADDR=127.0.0.1 PGPORT="$PORT" PGSSLMODE=verify-full PGSSLROOTCERT="$WORK/ca.pem" PGCONNECT_TIMEOUT=15 PGDATABASE=ogevia_prd PGOPTIONS='-c search_path=pg_catalog -c statement_timeout=120000'
  psql -X -qAt --no-password -v ON_ERROR_STOP=1 -c "begin read only; select jsonb_agg(jsonb_build_object('version',version,'name',name,'checksum',checksum) order by version) from ogevia_meta.schema_migrations; rollback;" > "$WORK/ledger.before.json"
  python3 "$PLAN" ledger "$WORK/ledger.before.json"
  pg_dump --no-password --format=custom --file="$WORK/production-before.dump"
  pg_restore --list "$WORK/production-before.dump" > "$WORK/backup-toc.txt"
  grep -Eq '^;[[:space:]]*dbname: ogevia_prd$' "$WORK/backup-toc.txt" || stop 'backup is not production'
  sha256sum "$WORK/production-before.dump" > "$WORK/production-before.dump.sha256"
  printf '%s\n%s\n%s\n' "$BUCKET" "$DIST" "$FN" > "$WORK/rollback-targets.txt"
  printf '%s\n' "$PREFIX" > "$WORK/private-prefix.txt"
  cat > "$WORK/rollback-api-web.sh" <<'ROLLBACK_UX'
#!/usr/bin/env bash
# Restores API/web only. Retains additive database schema and all post-release data.
set -euo pipefail
set +x
export AWS_REGION=us-west-2 AWS_PAGER=''
cd "$(dirname "$0")"
[[ "$(aws sts get-caller-identity --query Account --output text)" == 300094796789 ]]
mapfile -t targets < rollback-targets.txt
PREFIX=$(cat private-prefix.txt)
aws s3 cp Ogevia-prd-ServiceVerificationApi.template.json "$PREFIX/rollback.template.json" --only-show-errors
URL="https://cdk-hnb659fds-assets-300094796789-us-west-2.s3.us-west-2.amazonaws.com/${PREFIX#s3://cdk-hnb659fds-assets-300094796789-us-west-2/}/rollback.template.json"
aws cloudformation get-template --stack-name Ogevia-prd-ServiceVerificationApi --template-stage Original --query TemplateBody --output json > rollback-current.json
if ! python3 -c 'import json; assert json.load(open("rollback-current.json"))==json.load(open("Ogevia-prd-ServiceVerificationApi.template.json"))'; then
  aws cloudformation update-stack --stack-name Ogevia-prd-ServiceVerificationApi --template-url "$URL" --parameters file://previous-parameters.json --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM
  aws cloudformation wait stack-update-complete --stack-name Ogevia-prd-ServiceVerificationApi
fi
aws s3 sync web-before "s3://${targets[0]}" --exclude index.html --only-show-errors
aws s3 cp web-before/index.html "s3://${targets[0]}/index.html" --cache-control no-cache --only-show-errors
aws cloudfront create-invalidation --distribution-id "${targets[1]}" --paths / /index.html >/dev/null
echo 'API/web rollback completed; database rows and additive migrations retained.'
ROLLBACK_UX
  cp "$SELF" "$WORK/operator.sh"; cp "$PLAN" "$WORK/production-ux-release.py"
  (cd "$WORK" && tar -czf before-update.tgz -- *.template.json *.stack.json previous-parameters.json handler.before.json handler.before.zip handler.accepted.zip web-before production-before.dump production-before.dump.sha256 backup-toc.txt ledger.before.json upgrade.sql rollback-targets.txt private-prefix.txt rollback-api-web.sh operator.sh production-ux-release.py rds.json)
  A s3 cp "$WORK/before-update.tgz" "$PREFIX/before-update.tgz" --only-show-errors
  A s3api head-object --bucket "$ASSETS" --key "ogevia-production-release/$(basename "$WORK")/before-update.tgz" --query ContentLength --output text | grep -Eq '^[1-9][0-9]*$'
  echo "PRIVATE BACKUP SAVED: $PREFIX/before-update.tgz"
  stage '[4/6] Apply only 0103–0107 and ledger rows in one transaction'
  psql -X -q --no-password -v ON_ERROR_STOP=1 -f "$WORK/upgrade.sql" > "$WORK/migration.log" 2>&1 || stop "migration failed; transaction rolled back; private log: $WORK/migration.log"
  DB_APPLIED=1
  psql -X -qAt --no-password -v ON_ERROR_STOP=1 -c "begin read only; select jsonb_agg(jsonb_build_object('version',version,'name',name,'checksum',checksum) order by version) from ogevia_meta.schema_migrations; rollback;" > "$WORK/ledger.after.json"
  python3 "$PLAN" ledger "$WORK/ledger.after.json" after
  unset PGPASSWORD
  stage '[5/6] Update production API code; preserve every existing route and setting'
  A cloudformation get-template --stack-name Ogevia-prd-ServiceVerificationApi --template-stage Original --query TemplateBody --output json > "$WORK/current.template.json"
  python3 "$PLAN" equal "$WORK/Ogevia-prd-ServiceVerificationApi.template.json" "$WORK/current.template.json"
  A s3 cp "$WORK/candidate.template.json" "$PREFIX/candidate.template.json" --only-show-errors
  CHANGE="ogevia-ux-$(date -u +%Y%m%dT%H%M%SZ)"
  A cloudformation create-change-set --stack-name Ogevia-prd-ServiceVerificationApi --change-set-name "$CHANGE" --change-set-type UPDATE --template-url "https://$ASSETS.s3.us-west-2.amazonaws.com/ogevia-production-release/$(basename "$WORK")/candidate.template.json" --parameters "file://$WORK/previous-parameters.json" --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM > "$WORK/change-set-created.json"
  A cloudformation wait change-set-create-complete --stack-name Ogevia-prd-ServiceVerificationApi --change-set-name "$CHANGE"
  A cloudformation describe-change-set --stack-name Ogevia-prd-ServiceVerificationApi --change-set-name "$CHANGE" --output json > "$WORK/change-set.json"
  python3 "$PLAN" changes "$WORK/change-set.json"
  A cloudformation execute-change-set --stack-name Ogevia-prd-ServiceVerificationApi --change-set-name "$CHANGE"
  A cloudformation wait stack-update-complete --stack-name Ogevia-prd-ServiceVerificationApi
  API_APPLIED=1
  URL=$(A lambda get-function --function-name "$FN" --query Code.Location --output text)
  curl -fsS --connect-timeout 10 --max-time 120 "$URL" -o "$WORK/handler.after.zip"; unset URL
  python3 "$PLAN" deployed "$WORK/handler.after.zip"
  stage '[6/6] Publish production web and verify live version'
  WEB_STARTED=1
  VITE_APP_VERSION="$SOURCE" OGEVIA_DEPLOY_APPROVAL=owner-production-ux-go bash "$REPO/infra/aws/scripts/deploy-production.sh" web
  [[ "$(curl -sS --connect-timeout 10 --max-time 30 -o /dev/null -w '%{http_code}' "${API%/}/v1/me")" == 401 ]] || stop 'API anonymous check failed'
  for n in $(seq 1 30); do
    curl -fsS --connect-timeout 10 --max-time 30 -D "$WORK/web.headers" "$WEB/?release=$SOURCE" -o "$WORK/web.live.html"
    if cmp -s "$WORK/web.live.html" "$REPO/apps/web/dist-aws-prd/index.html"; then break; fi
    sleep 5
  done
  cmp -s "$WORK/web.live.html" "$REPO/apps/web/dist-aws-prd/index.html" || stop 'new website has not reached CloudFront yet; do not redeploy'
  grep -qi '^content-security-policy:' "$WORK/web.headers" || stop 'web CSP missing'
  A cloudformation get-template --stack-name Ogevia-prod-ServiceVerificationApi --template-stage Original --query TemplateBody --output json > "$WORK/test.after.json"
  python3 "$PLAN" equal "$WORK/Ogevia-prod-ServiceVerificationApi.template.json" "$WORK/test.after.json"
  echo "PRODUCTION DEPLOYED: 107 verified ledger rows, accepted API code, production web; TEST API unchanged"
  echo "Open: $WEB"
  echo "Owner/caregiver production sign-in verification is next. Do not create a real visit just to test."
  exit 0
fi

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
  WEB=$(stack_output "$S_WEB" WebOrigin)
  BUCKET=$(stack_output "$S_WEB" SiteBucketName); DIST=$(stack_output "$S_WEB" DistributionId)
  API=$(stack_output "$S_API" ApiUrl)
  # The sign-in pool, client and domain of PRODUCTION come from the dedicated production Auth stack. They must never come from
  # existing.cognitoUserPoolId / TestAppClientId (the TEST pool): the 2026-11-01 production website was built that way and had to be rolled back.
  local TEST_POOL="$POOL" S_AUTH POOL_PRD DOMAIN_URL
  S_AUTH="Ogevia-$(cfg .envName)-Auth"
  POOL_PRD=$(stack_output "$S_AUTH" UserPoolId); CLIENT=$(stack_output "$S_AUTH" AppClientId); DOMAIN_URL=$(stack_output "$S_AUTH" ManagedLoginDomain)
  [[ "$POOL_PRD" =~ ^${REGION}_[A-Za-z0-9]{9}$ && "$POOL_PRD" != "$TEST_POOL" ]] || die "the production Auth stack $S_AUTH gave no valid dedicated pool (got '$POOL_PRD'; the TEST pool is $TEST_POOL). Not building."
  [[ -n "$CLIENT" && "$CLIENT" != "None" && "$DOMAIN_URL" =~ ^https://[a-z0-9-]+\.auth\.${REGION}\.amazoncognito\.com$ ]] || die "the production Auth stack $S_AUTH gave no valid client or domain. Not building."
  POOL="$POOL_PRD"
  (cd "$REPO/apps/web" && \
    VITE_APP_ENV=production VITE_AUTH_PROVIDER=cognito VITE_COGNITO_REGION=$REGION VITE_COGNITO_USER_POOL_ID=$POOL \
    VITE_COGNITO_CLIENT_ID="$CLIENT" VITE_COGNITO_DOMAIN="$DOMAIN_URL" \
    VITE_COGNITO_REDIRECT_URI="$WEB/auth/callback" VITE_COGNITO_LOGOUT_URI="$WEB/" VITE_COGNITO_REFRESH_PERSISTENCE=session \
    VITE_SV_API_BASE_URL="$API" npx vite build --outDir dist-aws-prd --emptyOutDir)
  # Fail closed BEFORE anything is uploaded: the bundle must carry the production sign-in configuration and nothing of the TEST pool.
  (cd "$HERE" && npx --no-install tsx scripts/assert-web-auth.ts "$REPO/apps/web/dist-aws-prd" "$POOL" "$DOMAIN_URL" "$CLIENT" "$TEST_POOL") || die "the built website does not carry the production sign-in configuration. Nothing was uploaded."
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
