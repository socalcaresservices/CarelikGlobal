#!/usr/bin/env bash
# PRODUCTION release: OFFICES (migration 0110, six office routes, web) together with REQUEST CLEANUP (three routes; the switch goes ON), the error-message fix and the Active/History schedule view.
# Owner authorization: "All steps go" (2026-11-21). Derived line by line from PRD_0109_RELEASE.sh (the 2026-11-21 production release of PR #113) and production-request-cleanup-routes-deploy.sh:
# same temporary admin-host attachment (restored on exit), same logical backup to the private encrypted bucket, same one-transaction ledger, same reviewed change sets (code-only, then routes-only), same dedicated-pool web build.
# Order: database (0110) -> API code -> API routes (nine) -> web. Each step stops the run on any failed check. The Handler code is the code running on TEST (checked by source tree and by hash).
#   OGEVIA_DEPLOY_APPROVAL=owner-production-offices-go OGEVIA_RELEASE_COMMIT=<full sha> REPO=<checkout> bash PRD_OFFICES_RELEASE.sh                   (release)
#   OGEVIA_DEPLOY_APPROVAL=owner-production-offices-go bash PRD_OFFICES_RELEASE.sh rollback-api-web <workspace>   (API template and web back to the captured state; the database stays)
#   OGEVIA_DEPLOY_APPROVAL=owner-production-offices-go bash PRD_OFFICES_RELEASE.sh rollback-db <workspace>       (after rollback-api-web only: removes the 0110 objects and ledger row; office data is lost)
set -euo pipefail
set +x +H
umask 077
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER='' AWS_CLI_AUTO_PROMPT=off PYTHONDONTWRITEBYTECODE=1
A() { timeout --foreground -k 5 "${OGEVIA_AWS_TIMEOUT:-300}" aws --cli-connect-timeout 5 --cli-read-timeout 60 "$@"; }
stop() { echo "STOP: $*"; exit 1; }
stage() { STEP="$1"; printf '\033[32m%s\033[0m\n' "$STEP"; }
MODE="${1:-release}"; case "$MODE" in release|rollback-api-web|rollback-db) ;; *) stop 'usage: release | rollback-api-web <workspace> | rollback-db <workspace>';; esac
[[ "${OGEVIA_DEPLOY_APPROVAL:-}" == owner-production-offices-go ]] || stop 'production owner authorization is required (OGEVIA_DEPLOY_APPROVAL=owner-production-offices-go)'
[[ "$(A sts get-caller-identity --query Account --output text)" == 300094796789 ]] || stop 'wrong account'
STACK=Ogevia-prd-ServiceVerificationApi
ASSETS=cdk-hnb659fds-assets-300094796789-us-west-2
HOST=ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com
IID=i-0ce8db2d7e5839dd5; ADMIN=sg-00e01e2ca80442c1f; APP=sg-064ffce3bcbe8eb3b
TEST_CODE_COMMIT=9b0e55512a4910a06f4f3437d22ad6a40aa0e819      # the commit whose Handler code TEST runs (TEST_H6_CLEANUP.sh)
OLD_JS_HASH=a8b8387856d23e82d586a47113018fed84a1a2dccc6d61f1db6b3df3aa6336c6   # production's current Handler (the 0109 release code)
NIL=00000000-0000-4000-8000-000000000000
confirm() { local got; echo; echo "$2"; if [[ "${OGEVIA_NO_CONFIRM:-}" == 1 ]]; then return 0; fi
  printf 'Type exactly  %s  to continue: ' "$1" > /dev/tty; read -r got < /dev/tty; [[ "$got" == "$1" ]] || stop "confirmation not given"; }
exec 9>/tmp/ogevia-production-release.lock
flock -n 9 || stop 'another production release is running'
ATTACHED=0; TUNNEL=''; STEP=preparation; DB_APPLIED=0; API_CODE=0; API_ROUTES=0; WEB_STARTED=0; WORK=''
cleanup_prd() {
  rc=$?; trap - EXIT; unset PGPASSWORD MASTER PASSWORD
  if [[ -n "$TUNNEL" ]]; then pkill -P "$TUNNEL" 2>/dev/null || true; kill "$TUNNEL" 2>/dev/null || true; wait "$TUNNEL" 2>/dev/null || true; fi
  if [[ "$ATTACHED" == 1 ]]; then
    groups=$(A ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text | tr '\t' '\n' | sort | xargs) || groups=''
    both=$(printf '%s\n%s\n' "$ADMIN" "$APP" | sort | xargs)
    if [[ "$groups" == "$ADMIN" ]]; then echo 'ADMIN HOST RESTORED';
    elif [[ "$groups" == "$both" ]] && A ec2 modify-instance-attribute --instance-id "$IID" --groups "$ADMIN" && [[ "$(A ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)" == "$ADMIN" ]]; then echo 'ADMIN HOST RESTORED';
    else echo "RESTORE FAILED: restore $ADMIN only on $IID"; rc=1; fi
  fi
  echo "Release state: database=$DB_APPLIED api-code=$API_CODE api-routes=$API_ROUTES website-started=$WEB_STARTED"
  [[ -z "$WORK" ]] || echo "Private recovery: s3://$ASSETS/ogevia-production-release/$(basename "$WORK")/before-update.tgz"
  [[ "$rc" == 0 ]] || echo "STOPPED at $STEP. Keep this session open; do not rerun. Log: ${WORK:-/tmp}/release.log"
  exit "$rc"
}
trap cleanup_prd EXIT; trap 'exit 130' INT; trap 'exit 143' TERM

open_tunnel() {   # attaches the application DB group to the admin host (restored on exit), opens the tunnel, reads the master credential into memory only
  A rds describe-db-instances --db-instance-identifier ogevia-prod-postgres --query 'DBInstances[0].{host:Endpoint.Address,public:PubliclyAccessible,status:DBInstanceStatus,days:BackupRetentionPeriod,encrypted:StorageEncrypted,protected:DeletionProtection,master:MasterUserSecret.SecretArn}' --output json > "$WORK/rds.json"
  jq -e --arg host "$HOST" '.host==$host and .public==false and .status=="available" and .days>=7 and .encrypted and .protected' "$WORK/rds.json" >/dev/null || stop 'production RDS protections differ'
  [[ "$(A ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)" == "$ADMIN" ]] || stop 'admin host groups differ'
  curl -fsS --connect-timeout 10 --max-time 60 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o "$WORK/ca.pem"
  PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
  ATTACHED=1; A ec2 modify-instance-attribute --instance-id "$IID" --groups "$ADMIN" "$APP"
  sleep "${OGEVIA_SG_WAIT:-5}"
  A ssm start-session --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters "{\"host\":[\"$HOST\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"$PORT\"]}" > "$WORK/tunnel.log" 2>&1 &
  TUNNEL=$!; local UP=0 n
  for n in $(seq 1 30); do if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then UP=1; break; fi; kill -0 "$TUNNEL" 2>/dev/null || break; sleep 1; done
  [[ "$UP" == 1 ]] || stop 'production tunnel did not start'
  MASTER=$(A secretsmanager get-secret-value --secret-id "$(jq -er .master "$WORK/rds.json")" --query SecretString --output text)
  export PGUSER; PGUSER=$(jq -er .username <<<"$MASTER")
  export PGPASSWORD; PGPASSWORD=$(jq -er .password <<<"$MASTER"); unset MASTER
  unset PGSERVICE PGSERVICEFILE PGPASSFILE
  export PGHOST="$HOST" PGHOSTADDR=127.0.0.1 PGPORT="$PORT" PGSSLMODE=verify-full PGSSLROOTCERT="$WORK/ca.pem" PGCONNECT_TIMEOUT=15 PGDATABASE=ogevia_prd PGOPTIONS='-c search_path=pg_catalog -c statement_timeout=120000'
  [[ "$(psql -X -qAt --no-password -c 'select current_database()')" == ogevia_prd ]] || stop 'connected to the wrong database'
}
stack_template() { A cloudformation get-template --stack-name "$STACK" --template-stage Original --query TemplateBody --output json > "$1"; }
run_change_set() { # run_change_set <name> <template-key-in-prefix> <guard-command...>   creates, waits, describes, guards; leaves it ready to execute
  local name="$1" key="$2"; shift 2
  A cloudformation create-change-set --stack-name "$STACK" --change-set-name "$name" --change-set-type UPDATE --template-url "https://$ASSETS.s3.us-west-2.amazonaws.com/ogevia-production-release/$(basename "$WORK")/$key" \
    --parameters "file://$WORK/previous-parameters.json" --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM > "$WORK/$name.created.json"
  A cloudformation wait change-set-create-complete --stack-name "$STACK" --change-set-name "$name"
  A cloudformation describe-change-set --stack-name "$STACK" --change-set-name "$name" --output json > "$WORK/$name.json"
  if ! python3 "$PLAN" "$@" "$WORK/$name.json"; then A cloudformation delete-change-set --stack-name "$STACK" --change-set-name "$name" || true; stop "the change set $name is not exactly what was reviewed; it was deleted and nothing was applied"; fi
}
expect_code() { local label="$1" want="$2" code="" n; shift 2
  for n in $(seq 1 18); do code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 20 "$@" || true); [[ "$code" == "$want" ]] && { echo "   $label: $code"; return 0; }; sleep "${OGEVIA_SMOKE_SLEEP:-5}"; done
  echo "   $label: $code (wanted $want)"; return 1; }
smoke_routes() { local u="${API%/}" ok=0 want="$1"   # want = 401 (routes exist) or 404 (routes absent)
  for r in "POST /v1/care-notifications/read" "POST /v1/documents/$NIL/cancel" "POST /v1/document-types/$NIL/retire" "GET /v1/offices" "GET /v1/client-offices" "POST /v1/offices" "POST /v1/offices/$NIL/rename" "POST /v1/offices/$NIL/retire" "POST /v1/clients/$NIL/office"; do
    expect_code "${r%% *} ${r#* } no token" "$want" -X "${r%% *}" -H 'content-type: application/json' -d '{}' "$u${r#* }" || ok=1; done
  [[ "$want" == 401 ]] && { expect_code 'POST retire forged token' 401 -X POST -H 'authorization: Bearer forged.token.value' -H 'content-type: application/json' -d '{}' "$u/v1/document-types/$NIL/retire" || ok=1; }
  expect_code 'GET /v1/me no token (unchanged)' 401 "$u/v1/me" || ok=1
  return $ok; }

do_rollback_routes() {
  echo 'ROLLBACK: removing exactly the nine routes'
  local rb="ogevia-offices-routes-rollback-$(date -u +%Y%m%dT%H%M%SZ)"
  run_change_set "$rb" candidate-code.template.json changes-routes-remove
  A cloudformation execute-change-set --stack-name "$STACK" --change-set-name "$rb"
  A cloudformation wait stack-update-complete --stack-name "$STACK"
  stack_template "$WORK/live.rolledback-routes.json"; python3 "$PLAN" equal "$WORK/candidate-code.template.json" "$WORK/live.rolledback-routes.json"
  echo 'ROLLED BACK: the nine routes are gone again; the new Handler code stays (inert without the routes).'
}

if [[ "$MODE" != release ]]; then
  WORK="${2:?set the workspace printed by the release}"; [[ "$WORK" =~ ^/tmp/ogevia-production-release\.[A-Za-z0-9]+$ && -d "$WORK" && ! -L "$WORK" ]] || stop 'invalid workspace'
  exec > >(tee -a "$WORK/$MODE.log") 2>&1
  for bin in /tmp/ogevia-*/node-v22.*-linux-*/bin; do [[ ! -x "$bin/node" ]] || { export PATH="$bin:$PATH"; break; }; done
  REPO="${REPO:?set REPO to the release checkout}"; export OGEVIA_UX_SOURCE_ROOT="$REPO"; PLAN="$REPO/infra/aws/scripts/production-offices-release.py"
  [[ -f "$WORK/rollback-api-web.sh" ]] || stop 'saved rollback evidence missing'
  if [[ "$MODE" == rollback-api-web ]]; then
    confirm ROLLBACK-PRODUCTION-API-WEB "Puts the production API template (code and routes) and the production web files back to what they were before this release. The database (0110) stays."
    bash "$WORK/rollback-api-web.sh"; exit 0
  fi
  confirm ROLLBACK-PRODUCTION-0110 "Removes the 0110 objects (offices table, clients.responsible_office_id, six functions) and its ledger row from PRODUCTION. Office names and assignments are lost. Run rollback-api-web first."
  stack_template "$WORK/live.now.json"; python3 "$PLAN" routes "$WORK/live.now.json" absent || stop 'the office routes are still live; run rollback-api-web first'
  open_tunnel
  python3 "$PLAN" rollback-sql > "$WORK/rollback.sql"
  psql -X -q --no-password -v ON_ERROR_STOP=1 -f "$WORK/rollback.sql" || stop 'the database rollback failed; its transaction rolled back, nothing changed'
  echo 'ROLLED BACK: migration 0110 removed (ledger back to 108 rows).'; exit 0
fi

# ================= release =================
: "${REPO:?set REPO to the checkout at the release commit}"; : "${OGEVIA_RELEASE_COMMIT:?set OGEVIA_RELEASE_COMMIT to the full release commit}"
SOURCE="$OGEVIA_RELEASE_COMMIT"
[[ "$(git -C "$REPO" rev-parse HEAD)" == "$SOURCE" ]] || stop 'the checkout is not at the release commit'
[[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop 'tracked files in the checkout are modified'
WORK=$(mktemp -d /tmp/ogevia-production-release.XXXXXX); chmod 700 "$WORK"
exec > >(tee "$WORK/release.log") 2>&1
PLAN="$REPO/infra/aws/scripts/production-offices-release.py"; export OGEVIA_UX_SOURCE_ROOT="$REPO"
[[ -f "$PLAN" ]] || stop 'production-offices-release.py is missing from the checkout'
VERIFY="$REPO/docs/releases/2026-11-20-test-plan/toolchain/VERIFY_0110.sql"; [[ -f "$VERIFY" ]] || stop 'VERIFY_0110.sql is missing'
confirm GO-PRODUCTION-OFFICES "PRODUCTION CHANGE (owner GO 'All steps go'), release commit $SOURCE: (1) temporarily attach the application security group to the admin host $IID and open a tunnel to ogevia-prod-postgres; (2) save a logical backup of ogevia_prd to the private encrypted bucket; (3) apply migration 0110 (offices) in one transaction with its ledger row; (4) update the production API Handler code, then add nine routes (request cleanup ON, offices); (5) publish the production web. Rollback: rollback-api-web, then rollback-db. Nothing here touches TEST."
stage '[1/7] Check the release source and restore tools'
# The Handler code must be exactly the code TEST runs: the source trees that make the Handler bundle are identical to the TEST release commit's.
git -C "$REPO" fetch -q --depth 1 origin "$TEST_CODE_COMMIT" || stop 'could not fetch the TEST release commit to compare the code'
for p in apps/sv-api packages pnpm-lock.yaml; do
  [[ "$(git -C "$REPO" rev-parse "$SOURCE:$p")" == "$(git -C "$REPO" rev-parse "$TEST_CODE_COMMIT:$p")" ]] || stop "the release differs from the code accepted on TEST in $p"
done
echo "PASS: apps/sv-api, packages and the lockfile are identical to $TEST_CODE_COMMIT (the code running on TEST)"
export COREPACK_HOME="$WORK/corepack" XDG_CACHE_HOME="$WORK/cache" npm_config_cache="$WORK/npm-cache" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
major=$(pg_dump --version 2>/dev/null | sed -E 's/.* ([0-9]+)\..*/\1/' || true)
if [[ ! "$major" =~ ^[0-9]+$ || "$major" -lt 18 ]]; then
  if rpm -q postgresql16 >/dev/null 2>&1; then sudo dnf swap -y --releasever=latest postgresql16 postgresql18 </dev/null; else sudo dnf install -y --releasever=latest postgresql18 </dev/null; fi
  hash -r
fi
major=$(pg_dump --version | sed -E 's/.* ([0-9]+)\..*/\1/'); [[ "$major" =~ ^[0-9]+$ && "$major" -ge 18 ]] || stop 'PostgreSQL 18+ pg_dump required'
for bin in /tmp/ogevia-*/node-v22.*-linux-*/bin; do [[ ! -x "$bin/node" ]] || { export PATH="$bin:$PATH"; break; }; done
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" != 22 ]]; then
  case "$(uname -m)" in x86_64) arch=x64;; aarch64) arch=arm64;; *) stop 'unsupported CPU';; esac
  archive="node-v22.23.5-linux-$arch.tar.xz"
  curl -fsS --retry 3 --connect-timeout 10 --max-time 180 "https://nodejs.org/dist/v22.23.5/$archive" -o "$WORK/$archive"
  curl -fsS --connect-timeout 10 --max-time 60 https://nodejs.org/dist/v22.23.5/SHASUMS256.txt -o "$WORK/node-sums"
  awk -v f="$archive" '$2==f' "$WORK/node-sums" > "$WORK/node-check"; test -s "$WORK/node-check"; (cd "$WORK" && sha256sum --check node-check)
  tar -xJf "$WORK/$archive" -C "$WORK"; export PATH="$WORK/${archive%.tar.xz}/bin:$PATH"
fi
mkdir -p "$WORK/bin"; corepack enable --install-directory "$WORK/bin"; export PATH="$WORK/bin:$PATH"
[[ -x "$REPO/apps/web/node_modules/.bin/vite" ]] || corepack pnpm@9.15.4 --dir "$REPO" install --frozen-lockfile --store-dir "$WORK/store" --prefer-offline </dev/null
verify0110() {  # expect, ledger: the 37 read-only object checks of migration 0110
  local out rows bad
  out="$(psql -X -At --no-password -F '|' -v ON_ERROR_STOP=1 -v expect="$1" -v ledger="$2" -f "$VERIFY" 2>&1)" || { echo "$out" | sed -E 's#postgres://[^ ]*#postgres://<redacted>#g'; return 1; }
  rows="$(echo "$out" | grep -c '|' || true)"; bad="$(echo "$out" | grep -c '|f|' || true)"
  echo "VERIFY_0110 ($1/$2): $rows checks, $bad failing"; [[ "$rows" -ge 37 && "$bad" -eq 0 ]]
}
python3 "$PLAN" sql > "$WORK/upgrade.sql"

stage '[2/7] Capture the production rollback and verify the API changes before anything is applied'
for s in Ogevia-prd-ServiceVerificationApi Ogevia-prd-WebHosting Ogevia-prd-Auth Ogevia-prod-ServiceVerificationApi; do
  A cloudformation describe-stacks --stack-name "$s" --query 'Stacks[0].{Status:StackStatus,Outputs:Outputs,Parameters:Parameters[].{ParameterKey:ParameterKey,UsePreviousValue:`true`}}' --output json > "$WORK/$s.stack.json"
  jq -e '.Status=="UPDATE_COMPLETE" or .Status=="CREATE_COMPLETE" or .Status=="UPDATE_ROLLBACK_COMPLETE"' "$WORK/$s.stack.json" >/dev/null || stop "stack not settled: $s"
  A cloudformation get-template --stack-name "$s" --template-stage Original --query TemplateBody --output json > "$WORK/$s.template.json"
done
jq '.Parameters' "$WORK/Ogevia-prd-ServiceVerificationApi.stack.json" > "$WORK/previous-parameters.json"
python3 "$PLAN" routes "$WORK/Ogevia-prd-ServiceVerificationApi.template.json" absent
FN=$(A cloudformation list-stack-resources --stack-name "$STACK" --output json | jq -er '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId|startswith("Handler")))] | if length==1 then .[0].PhysicalResourceId else error("expected exactly one Handler") end')
A lambda get-function-configuration --function-name "$FN" --query '{Function:FunctionName,CodeSha256:CodeSha256,Runtime:Runtime,Database:Environment.Variables.DB_NAME,Host:Environment.Variables.DB_HOST,Pool:Environment.Variables.COGNITO_USER_POOL_ID}' --output json > "$WORK/handler.before.json"
jq -e --arg host "$HOST" '.Database=="ogevia_prd" and .Host==$host and .Pool=="us-west-2_FHJoX71ca" and .Runtime=="nodejs24.x"' "$WORK/handler.before.json" >/dev/null || stop 'production runtime differs'
URL=$(A lambda get-function --function-name "$FN" --query Code.Location --output text); curl -fsS --connect-timeout 10 --max-time 120 "$URL" -o "$WORK/handler.before.zip"; unset URL
[[ "$(python3 "$PLAN" hash "$WORK/handler.before.zip")" == "$OLD_JS_HASH" ]] || stop 'production is not running the expected 0109 release code; do not continue'
# the release code = the Handler asset TEST runs
KEY=$(jq -er '.Resources | to_entries[] | select(.key|startswith("Handler")) | select(.value.Type=="AWS::Lambda::Function") | .value.Properties.Code.S3Key' "$WORK/Ogevia-prod-ServiceVerificationApi.template.json")
[[ "$KEY" =~ ^[0-9a-f]{64}\.zip$ ]] || stop 'could not read the Handler asset key from the TEST stack'
A s3 cp "s3://$ASSETS/$KEY" "$WORK/handler.accepted.zip" --only-show-errors
NEW_JS_HASH=$(python3 "$PLAN" hash "$WORK/handler.accepted.zip"); [[ "$NEW_JS_HASH" != "$OLD_JS_HASH" ]] || stop 'the release code equals production code; nothing to release'
TFN=$(A cloudformation list-stack-resources --stack-name Ogevia-prod-ServiceVerificationApi --output json | jq -er '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId|startswith("Handler")))] | .[0].PhysicalResourceId')
TURL=$(A lambda get-function --function-name "$TFN" --query Code.Location --output text); curl -fsS --connect-timeout 10 --max-time 120 "$TURL" -o "$WORK/handler.test.zip"; unset TURL
python3 "$PLAN" deployed "$WORK/handler.test.zip" "$NEW_JS_HASH" || stop 'the code TEST runs is not the release asset'
echo "PASS: the release asset is the code running on TEST ($NEW_JS_HASH); production runs $OLD_JS_HASH"
python3 "$PLAN" patch-code "$WORK/Ogevia-prd-ServiceVerificationApi.template.json" "$WORK/candidate-code.template.json" "$KEY"
python3 "$PLAN" patch-routes "$WORK/candidate-code.template.json" "$WORK/candidate-routes.template.json"
out_prd() { jq -er --arg key "$2" '.Outputs[] | select(.OutputKey==$key) | .OutputValue' "$WORK/$1.stack.json"; }
BUCKET=$(out_prd Ogevia-prd-WebHosting SiteBucketName); DIST=$(out_prd Ogevia-prd-WebHosting DistributionId)
WEB=$(out_prd Ogevia-prd-WebHosting WebOrigin); API=$(out_prd Ogevia-prd-ServiceVerificationApi ApiUrl)
TEST_BUCKET=$(A cloudformation describe-stacks --stack-name Ogevia-prod-WebHosting --query 'Stacks[0].Outputs[?OutputKey==`SiteBucketName`].OutputValue' --output text)
[[ "$BUCKET" != "$TEST_BUCKET" && "$BUCKET" == ogevia-prd-* && "$WEB" == https://*.cloudfront.net && "$API" == https://*.execute-api.us-west-2.amazonaws.com* ]] || stop 'web/API targets differ'
A s3 sync "s3://$BUCKET" "$WORK/web-before" --only-show-errors; test -s "$WORK/web-before/index.html"
A s3api get-public-access-block --bucket "$ASSETS" --query PublicAccessBlockConfiguration --output json | jq -e '.BlockPublicAcls and .IgnorePublicAcls and .BlockPublicPolicy and .RestrictPublicBuckets' >/dev/null || stop 'backup bucket must be private'
A s3api get-bucket-encryption --bucket "$ASSETS" --query 'ServerSideEncryptionConfiguration.Rules' --output json | jq -e 'length>0 and all(.[]; .ApplyServerSideEncryptionByDefault.SSEAlgorithm=="AES256" or .ApplyServerSideEncryptionByDefault.SSEAlgorithm=="aws:kms")' >/dev/null || stop 'backup bucket must be encrypted'

stage '[3/7] Open the production tunnel, check the baseline and save a database backup'
open_tunnel
psql -X -qAt --no-password -v ON_ERROR_STOP=1 -c "begin read only; select jsonb_agg(jsonb_build_object('version',version,'name',name,'checksum',checksum) order by version) from ogevia_meta.schema_migrations; rollback;" > "$WORK/ledger.before.json"
python3 "$PLAN" ledger "$WORK/ledger.before.json"
verify0110 absent absent || stop 'migration 0110 objects already exist or the check failed'
SZ=$(psql -X -qAt --no-password -c 'select pg_database_size(current_database())'); FREE=$(df -Pk "$WORK" | awk 'NR==2{print $4*1024}')
echo "production database bytes: $SZ   free bytes: $FREE"; [[ "$FREE" -gt $((SZ + 200*1024*1024)) ]] || stop 'not enough free space for the backup'
pg_dump --no-password --format=custom --file="$WORK/production-before.dump"
pg_restore --list "$WORK/production-before.dump" > "$WORK/backup-toc.txt"
grep -Eq '^;[[:space:]]*dbname: ogevia_prd$' "$WORK/backup-toc.txt" || stop 'backup is not production'
sha256sum "$WORK/production-before.dump" > "$WORK/production-before.dump.sha256"
printf '%s\n%s\n%s\n' "$BUCKET" "$DIST" "$FN" > "$WORK/rollback-targets.txt"
PREFIX="s3://$ASSETS/ogevia-production-release/$(basename "$WORK")"; printf '%s\n' "$PREFIX" > "$WORK/private-prefix.txt"
cat > "$WORK/rollback-api-web.sh" <<'ROLLBACK_PRD'
#!/usr/bin/env bash
# Restores the production API template (code and routes) and the web files to the captured state. Retains the additive database schema and all post-release data.
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
ROLLBACK_PRD
cp "$0" "$WORK/operator.sh" 2>/dev/null || true; cp "$PLAN" "$WORK/production-offices-release.py"
(cd "$WORK" && tar -czf before-update.tgz -- *.template.json *.stack.json previous-parameters.json handler.before.json handler.before.zip handler.accepted.zip web-before production-before.dump production-before.dump.sha256 backup-toc.txt ledger.before.json upgrade.sql rollback-targets.txt private-prefix.txt rollback-api-web.sh)
A s3 cp "$WORK/before-update.tgz" "$PREFIX/before-update.tgz" --only-show-errors
A s3api head-object --bucket "$ASSETS" --key "ogevia-production-release/$(basename "$WORK")/before-update.tgz" --query ContentLength --output text | grep -Eq '^[1-9][0-9]*$'
echo "PRIVATE BACKUP SAVED: $PREFIX/before-update.tgz"

stage '[4/7] Apply only migration 0110 and its ledger row in one transaction'
psql -X -q --no-password -v ON_ERROR_STOP=1 -f "$WORK/upgrade.sql" > "$WORK/migration.log" 2>&1 || stop "migration failed; transaction rolled back; private log: $WORK/migration.log"
DB_APPLIED=1
psql -X -qAt --no-password -v ON_ERROR_STOP=1 -c "begin read only; select jsonb_agg(jsonb_build_object('version',version,'name',name,'checksum',checksum) order by version) from ogevia_meta.schema_migrations; rollback;" > "$WORK/ledger.after.json"
python3 "$PLAN" ledger "$WORK/ledger.after.json" after
verify0110 present present || stop 'the 0110 post-state does not match; no API or web change was made'
unset PGPASSWORD

stage '[5/7] Update the production API code (code only; every route and setting preserved)'
stack_template "$WORK/current.template.json"; python3 "$PLAN" equal "$WORK/Ogevia-prd-ServiceVerificationApi.template.json" "$WORK/current.template.json"
A s3 cp "$WORK/candidate-code.template.json" "$PREFIX/candidate-code.template.json" --only-show-errors
A s3 cp "$WORK/candidate-routes.template.json" "$PREFIX/candidate-routes.template.json" --only-show-errors
CHANGE="ogevia-offices-code-$(date -u +%Y%m%dT%H%M%SZ)"
run_change_set "$CHANGE" candidate-code.template.json changes-code
A cloudformation execute-change-set --stack-name "$STACK" --change-set-name "$CHANGE"
A cloudformation wait stack-update-complete --stack-name "$STACK"
API_CODE=1
URL=$(A lambda get-function --function-name "$FN" --query Code.Location --output text); curl -fsS --connect-timeout 10 --max-time 120 "$URL" -o "$WORK/handler.after.zip"; unset URL
python3 "$PLAN" deployed "$WORK/handler.after.zip" "$NEW_JS_HASH"
stack_template "$WORK/live.after-code.json"; python3 "$PLAN" equal "$WORK/candidate-code.template.json" "$WORK/live.after-code.json"
smoke_routes 404 || stop 'the routes must still be absent after the code-only change; rollback-api-web is available'

stage '[6/7] Add the nine routes: request cleanup ON and offices'
CHANGE2="ogevia-offices-routes-$(date -u +%Y%m%dT%H%M%SZ)"
run_change_set "$CHANGE2" candidate-routes.template.json changes-routes-add
A cloudformation execute-change-set --stack-name "$STACK" --change-set-name "$CHANGE2"
A cloudformation wait stack-update-complete --stack-name "$STACK"
API_ROUTES=1
stack_template "$WORK/live.after-routes.json"
if ! { python3 "$PLAN" equal "$WORK/candidate-routes.template.json" "$WORK/live.after-routes.json" && python3 "$PLAN" routes "$WORK/live.after-routes.json" present; }; then echo 'The live stack differs from the planned template: rolling the routes back.' >&2; do_rollback_routes; exit 1; fi
if ! smoke_routes 401; then echo 'SMOKE FAILED: rolling the routes back.' >&2; do_rollback_routes; exit 1; fi

stage '[7/7] Publish production web and verify the live version'
WEB_STARTED=1
[[ "$(A cloudformation describe-stacks --stack-name Ogevia-prd-Auth --query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text)" == us-west-2_FHJoX71ca ]] || stop 'dedicated production Auth pool differs'
VITE_APP_VERSION="$SOURCE" OGEVIA_DEPLOY_APPROVAL=owner-production-offices-go bash "$REPO/infra/aws/scripts/deploy-production.sh" web
for n in $(seq 1 30); do
  curl -fsS --connect-timeout 10 --max-time 30 -D "$WORK/web.headers" "$WEB/?release=$SOURCE" -o "$WORK/web.live.html"
  if cmp -s "$WORK/web.live.html" "$REPO/apps/web/dist-aws-prd/index.html"; then break; fi
  sleep 5
done
cmp -s "$WORK/web.live.html" "$REPO/apps/web/dist-aws-prd/index.html" || stop 'new website has not reached CloudFront yet; do not redeploy; check again in a minute'
grep -qi '^content-security-policy:' "$WORK/web.headers" || stop 'web CSP missing'
A cloudformation get-template --stack-name Ogevia-prod-ServiceVerificationApi --template-stage Original --query TemplateBody --output json > "$WORK/test.after.json"
python3 "$PLAN" equal "$WORK/Ogevia-prod-ServiceVerificationApi.template.json" "$WORK/test.after.json"
echo "PRODUCTION DEPLOYED: migration 0110 applied (109 verified ledger rows), Handler code $NEW_JS_HASH, nine routes live (request cleanup ON, offices), production web published at $SOURCE; TEST unchanged"
echo "Open: $WEB"
echo "Workspace for rollback: $WORK"
echo "Rollback order if ever needed:  ... rollback-api-web $WORK   then   ... rollback-db $WORK"
exit 0
