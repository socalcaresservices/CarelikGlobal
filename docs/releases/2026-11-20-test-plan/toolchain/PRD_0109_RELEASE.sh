#!/usr/bin/env bash
# PRODUCTION release of PR #113 (application commit ef90a2a42c21e2c68e6fbf3f361e618806699b8d): migration 0109 plus the Handler code and the web, with the request-cleanup
# switch OFF. Owner authorization: "GO production, switch OFF" (2026-11-21). Derived line by line from the 2026-11-11 production promotion (deploy-production.sh ux-release / ux-resume):
# same temporary admin-host attachment (restored on exit), same logical backup to the private encrypted bucket, same one-transaction ledger, same reviewed change set
# (code-only template patch, production-0109-release.py), same dedicated-pool production web build. Changes vs that release: commit, asset, the single migration 0109, three extra route checks.
#   OGEVIA_DEPLOY_APPROVAL=owner-production-0109-go bash PRD_0109_RELEASE.sh            (release)
#   OGEVIA_DEPLOY_APPROVAL=owner-production-0109-go bash PRD_0109_RELEASE.sh resume <workspace>   (only after a verified stop, never reruns the migration)
set -euo pipefail
if [[ "${1:-release}" == resume ]]; then
  set -euo pipefail
  set +x +H
  umask 077
  export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER='' AWS_CLI_AUTO_PROMPT=off
  A() { aws --cli-connect-timeout 5 --cli-read-timeout 60 "$@"; }
  stop() { echo "STOP: $*"; exit 1; }
  [[ "${OGEVIA_DEPLOY_APPROVAL:-}" == owner-production-0109-go ]] || stop 'production authorization required'
  [[ "$(A sts get-caller-identity --query Account --output text)" == 300094796789 ]] || stop 'wrong account'
  exec 9>/tmp/ogevia-production-release.lock
  flock -n 9 || stop 'another production release is running'
  B="${2:?set the existing verified post-migration workspace}"
  [[ "$B" =~ ^/tmp/ogevia-production-release\.[A-Za-z0-9]+$ && -d "$B" && ! -L "$B" ]] || stop 'invalid saved workspace'
  SELF=$(readlink -f "${BASH_SOURCE[0]}"); PLAN="$(dirname "$SELF")/production-0109-release.py"
  SOURCE=ef90a2a42c21e2c68e6fbf3f361e618806699b8d
  ASSETS=cdk-hnb659fds-assets-300094796789-us-west-2
  PREFIX="s3://$ASSETS/ogevia-production-release/$(basename "$B")"
  exec > >(tee "$B/resume.log") 2>&1
  trap 'rc=$?; [[ "$rc" == 0 ]] || echo "RESUME STOPPED: keep this session open; no migration was run. Log: $B/resume.log"' EXIT
  for f in ledger.after.json handler.before.json handler.before.zip handler.accepted.zip candidate.template.json change-set.json previous-parameters.json production-before.dump.sha256 before-update.tgz; do
    [[ -s "$B/$f" ]] || stop "saved evidence missing: $f"
  done
  sha256sum --check "$B/production-before.dump.sha256"
  A s3api head-object --bucket "$ASSETS" --key "ogevia-production-release/$(basename "$B")/before-update.tgz" --query ContentLength --output text | grep -Eq '^[1-9][0-9]*$'
  for bin in /tmp/ogevia-*/node-v22.*-linux-*/bin; do [[ ! -x "$bin/node" ]] || { export PATH="$bin:$PATH"; break; }; done
  [[ "$(node -p 'process.versions.node.split(".")[0]')" == 22 ]] || stop 'saved Node 22 tools unavailable'
  REPO=''
  while IFS= read -r g; do
    r="${g%/.git}"
    if [[ "$(git -C "$r" rev-parse HEAD 2>/dev/null)" == "$SOURCE" && -z "$(git -C "$r" status --porcelain --untracked-files=no)" && -x "$r/apps/web/node_modules/.bin/vite" ]]; then REPO="$r"; break; fi
  done < <(find /tmp -maxdepth 5 -type d -name .git -print 2>/dev/null)
  [[ -n "$REPO" ]] || stop 'accepted checkout with installed web dependencies unavailable'
  export OGEVIA_UX_SOURCE_ROOT="$REPO"
  python3 "$PLAN" ledger "$B/ledger.after.json" after
  python3 "$PLAN" assets "$B"
  python3 "$PLAN" patch "$B/Ogevia-prd-ServiceVerificationApi.template.json" "$B/resume.expected.template.json"
  python3 "$PLAN" equal "$B/candidate.template.json" "$B/resume.expected.template.json"
  A cloudformation get-template --stack-name Ogevia-prd-ServiceVerificationApi --template-stage Original --query TemplateBody --output json > "$B/resume.live.template.json"
  python3 "$PLAN" equal "$B/Ogevia-prd-ServiceVerificationApi.template.json" "$B/resume.live.template.json"
  FN=$(jq -er .Function "$B/handler.before.json")
  [[ "$(A lambda get-function-configuration --function-name "$FN" --query CodeSha256 --output text)" == "$(jq -er .CodeSha256 "$B/handler.before.json")" ]] || stop 'production runtime code changed since the verified stop'
  CHANGE=$(jq -er '.ChangeSetId' "$B/change-set.json")
  [[ "$CHANGE" == arn:aws:cloudformation:us-west-2:300094796789:changeSet/ogevia-ux-* ]] || stop 'unexpected change-set ARN'
  A cloudformation describe-change-set --stack-name Ogevia-prd-ServiceVerificationApi --change-set-name "$CHANGE" --output json > "$B/resume.change-set.json"
  python3 "$PLAN" changes "$B/resume.change-set.json"
  A cloudformation get-template --stack-name Ogevia-prd-ServiceVerificationApi --change-set-name "$CHANGE" --template-stage Original --query TemplateBody --output json > "$B/resume.change-set.template.json"
  python3 "$PLAN" equal "$B/candidate.template.json" "$B/resume.change-set.template.json"
  A s3 cp "s3://$ASSETS/0877a461644480499fff3a5f2e80c0624b9692a2b15536643ff54bba25a6c739.zip" "$B/resume.accepted.zip" --only-show-errors
  python3 "$PLAN" deployed "$B/resume.accepted.zip"
  echo '[resume 1/2] Execute the reviewed production API change set; migrations are NOT rerun'
  A cloudformation execute-change-set --stack-name Ogevia-prd-ServiceVerificationApi --change-set-name "$CHANGE"
  A cloudformation wait stack-update-complete --stack-name Ogevia-prd-ServiceVerificationApi
  URL=$(A lambda get-function --function-name "$FN" --query Code.Location --output text)
  curl -fsS --connect-timeout 10 --max-time 120 "$URL" -o "$B/handler.after.zip"; unset URL
  python3 "$PLAN" deployed "$B/handler.after.zip"
  A cloudformation get-template --stack-name Ogevia-prd-ServiceVerificationApi --template-stage Original --query TemplateBody --output json > "$B/resume.after.template.json"
  python3 "$PLAN" equal "$B/candidate.template.json" "$B/resume.after.template.json"
  echo '[resume 2/2] Publish and verify the production website'
  [[ "$(A cloudformation describe-stacks --stack-name Ogevia-prd-Auth --query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text)" == us-west-2_FHJoX71ca ]] || stop 'dedicated production Auth pool differs'
  VITE_APP_VERSION="$SOURCE" OGEVIA_DEPLOY_APPROVAL=owner-production-0109-go bash "$REPO/infra/aws/scripts/deploy-production.sh" web
  out_ux_resume() { jq -er --arg key "$2" '.Outputs[] | select(.OutputKey==$key) | .OutputValue' "$B/$1.stack.json"; }
  WEB=$(out_ux_resume Ogevia-prd-WebHosting WebOrigin); API=$(out_ux_resume Ogevia-prd-ServiceVerificationApi ApiUrl)
  [[ "$(curl -sS --connect-timeout 10 --max-time 30 -o /dev/null -w '%{http_code}' "${API%/}/v1/me")" == 401 ]] || stop 'API anonymous check failed'
  for n in $(seq 1 30); do
    curl -fsS --connect-timeout 10 --max-time 30 -D "$B/resume.web.headers" "$WEB/?release=$SOURCE" -o "$B/resume.web.html"
    if cmp -s "$B/resume.web.html" "$REPO/apps/web/dist-aws-prd/index.html"; then break; fi
    sleep 5
  done
  cmp -s "$B/resume.web.html" "$REPO/apps/web/dist-aws-prd/index.html" || stop 'website still propagating; do not rerun migrations'
  grep -qi '^content-security-policy:' "$B/resume.web.headers" || stop 'web CSP missing'
  A cloudformation get-template --stack-name Ogevia-prod-ServiceVerificationApi --template-stage Original --query TemplateBody --output json > "$B/resume.test.after.json"
  python3 "$PLAN" equal "$B/Ogevia-prod-ServiceVerificationApi.template.json" "$B/resume.test.after.json"
  echo 'PRODUCTION DEPLOYED: 108 verified ledger rows retained (0109 applied); API/web live with the request-cleanup switch OFF; TEST API unchanged'
  echo "Open: $WEB"
  echo "Private rollback: $PREFIX/before-update.tgz"
  echo 'No database, security-group or account changes were made by this resume.'
  exit 0
fi
set -euo pipefail
set +x +H
umask 077
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER='' AWS_CLI_AUTO_PROMPT=off
A() { aws --cli-connect-timeout 5 --cli-read-timeout 60 "$@"; }
stop() { echo "STOP: $*"; exit 1; }
stage() { STEP="$1"; printf '\033[32m%s\033[0m\n' "$STEP"; }
[[ "${OGEVIA_DEPLOY_APPROVAL:-}" == owner-production-0109-go ]] || stop 'production owner authorization is required'
[[ "$(uname -s)" == Linux ]] || stop 'run in AWS CloudShell'
[[ "$(A sts get-caller-identity --query Account --output text)" == 300094796789 ]] || stop 'wrong account'
exec 9>/tmp/ogevia-production-release.lock
flock -n 9 || stop 'another production release is running'
WORK=$(mktemp -d /tmp/ogevia-production-release.XXXXXX)
exec > >(tee "$WORK/release.log") 2>&1
SELF=$(readlink -f "${BASH_SOURCE[0]}")
OPERATOR_DIR=$(dirname "$SELF")
PLAN="$OPERATOR_DIR/production-0109-release.py"
[[ -f "$PLAN" ]] || stop 'verified production-0109-release.py is required beside the operator'
SOURCE=ef90a2a42c21e2c68e6fbf3f361e618806699b8d
ASSETS=cdk-hnb659fds-assets-300094796789-us-west-2
KEY=0877a461644480499fff3a5f2e80c0624b9692a2b15536643ff54bba25a6c739.zip
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
confirm() { local got; echo; echo "$2"; if [[ "${OGEVIA_NO_CONFIRM:-}" == 1 ]]; then return 0; fi
  printf 'Type exactly  %s  to continue: ' "$1" > /dev/tty; read -r got < /dev/tty; [[ "$got" == "$1" ]] || stop "confirmation not given"; }
confirm GO-PRODUCTION-0109 "PRODUCTION CHANGE (owner GO, request-cleanup switch OFF): (1) temporarily attach the application security group to the admin host i-0ce8db2d7e5839dd5 and open a tunnel to ogevia-prod-postgres; (2) save a logical backup of ogevia_prd to the private encrypted assets bucket; (3) apply migration 0109 and its ledger row in one transaction; (4) change ONLY the Handler code of Ogevia-prd-ServiceVerificationApi through a reviewed change set; (5) publish the production web. The admin host's security groups are restored afterwards. TEST is not changed."
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
[[ -x "$REPO/apps/web/node_modules/.bin/vite" ]] || corepack pnpm@9.15.4 --dir "$REPO" install --frozen-lockfile --store-dir "$WORK/store" --prefer-offline
# The helper is operator tooling; its immutable SQL inputs come from the accepted checkout.
export OGEVIA_UX_SOURCE_ROOT="$REPO"
VERIFY="$REPO/docs/releases/2026-11-20-test-plan/toolchain/VERIFY_0109.sql"
verify0109() {  # expect, ledger: the 20 read-only object checks of migration 0109
  local out rows bad
  out="$(psql -X -At --no-password -F '|' -v ON_ERROR_STOP=1 -v expect="$1" -v ledger="$2" -f "$VERIFY" 2>&1)" || { echo "$out" | sed -E 's#postgres://[^ ]*#postgres://<redacted>#g'; return 1; }
  rows="$(echo "$out" | grep -c '|' || true)"; bad="$(echo "$out" | grep -c '|f|' || true)"
  echo "VERIFY_0109 ($1/$2): $rows checks, $bad failing"; [[ "$rows" -ge 20 && "$bad" -eq 0 ]]
}
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
verify0109 absent absent || stop 'migration 0109 objects already exist or the check failed'
SZ=$(psql -X -qAt --no-password -c 'select pg_database_size(current_database())'); FREE=$(df -Pk "$WORK" | awk 'NR==2{print $4*1024}')
echo "production database bytes: $SZ   free bytes: $FREE"; [[ "$FREE" -gt $((SZ + 200*1024*1024)) ]] || stop 'not enough free space for the backup'
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
cp "$SELF" "$WORK/operator.sh"; cp "$PLAN" "$WORK/production-0109-release.py"
(cd "$WORK" && tar -czf before-update.tgz -- *.template.json *.stack.json previous-parameters.json handler.before.json handler.before.zip handler.accepted.zip web-before production-before.dump production-before.dump.sha256 backup-toc.txt ledger.before.json upgrade.sql rollback-targets.txt private-prefix.txt rollback-api-web.sh operator.sh production-0109-release.py rds.json)
A s3 cp "$WORK/before-update.tgz" "$PREFIX/before-update.tgz" --only-show-errors
A s3api head-object --bucket "$ASSETS" --key "ogevia-production-release/$(basename "$WORK")/before-update.tgz" --query ContentLength --output text | grep -Eq '^[1-9][0-9]*$'
echo "PRIVATE BACKUP SAVED: $PREFIX/before-update.tgz"
stage '[4/6] Apply only migration 0109 and its ledger row in one transaction'
psql -X -q --no-password -v ON_ERROR_STOP=1 -f "$WORK/upgrade.sql" > "$WORK/migration.log" 2>&1 || stop "migration failed; transaction rolled back; private log: $WORK/migration.log"
DB_APPLIED=1
psql -X -qAt --no-password -v ON_ERROR_STOP=1 -c "begin read only; select jsonb_agg(jsonb_build_object('version',version,'name',name,'checksum',checksum) order by version) from ogevia_meta.schema_migrations; rollback;" > "$WORK/ledger.after.json"
python3 "$PLAN" ledger "$WORK/ledger.after.json" after
verify0109 present present || stop 'the 0109 post-state does not match; no API or web change was made'
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
VITE_APP_VERSION="$SOURCE" OGEVIA_DEPLOY_APPROVAL=owner-production-0109-go bash "$REPO/infra/aws/scripts/deploy-production.sh" web
[[ "$(curl -sS --connect-timeout 10 --max-time 30 -o /dev/null -w '%{http_code}' "${API%/}/v1/me")" == 401 ]] || stop 'API anonymous check failed'
for r in /v1/care-notifications/read /v1/documents/00000000-0000-4000-8000-000000000000/cancel /v1/document-types/00000000-0000-4000-8000-000000000000/retire; do
  [[ "$(curl -sS --connect-timeout 10 --max-time 30 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "${API%/}$r")" == 404 ]] || stop "the request-cleanup route $r must stay absent (404) in production"
done
echo 'PASS: the three request-cleanup routes are absent in production (switch OFF)'
for n in $(seq 1 30); do
  curl -fsS --connect-timeout 10 --max-time 30 -D "$WORK/web.headers" "$WEB/?release=$SOURCE" -o "$WORK/web.live.html"
  if cmp -s "$WORK/web.live.html" "$REPO/apps/web/dist-aws-prd/index.html"; then break; fi
  sleep 5
done
cmp -s "$WORK/web.live.html" "$REPO/apps/web/dist-aws-prd/index.html" || stop 'new website has not reached CloudFront yet; do not redeploy'
grep -qi '^content-security-policy:' "$WORK/web.headers" || stop 'web CSP missing'
A cloudformation get-template --stack-name Ogevia-prod-ServiceVerificationApi --template-stage Original --query TemplateBody --output json > "$WORK/test.after.json"
python3 "$PLAN" equal "$WORK/Ogevia-prod-ServiceVerificationApi.template.json" "$WORK/test.after.json"
echo "PRODUCTION DEPLOYED: migration 0109 applied (108 verified ledger rows), request-cleanup switch OFF, production web published; TEST API unchanged"
echo "Open: $WEB"
echo "Owner/caregiver production sign-in verification is next. Do not create a real visit just to test."
exit 0
