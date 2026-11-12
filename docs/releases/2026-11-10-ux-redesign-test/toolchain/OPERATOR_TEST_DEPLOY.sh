#!/usr/bin/env bash
# Unified CloudShell entry point. Application source remains the green 6cbab00.
# The owner executes cloudshell-release to start the already-authorized TEST cutover.
# The standalone baseline mode reads local files only and keeps all functional checks.
if [[ "${1:-}" == cloudshell-baseline ]]; then
  python3 - "$2" "$3" <<'PY'
import pathlib, runpy, sys
b = pathlib.Path(sys.argv[1]); g = runpy.run_path(sys.argv[2])
def clean(p):
    t = g['norm'](g['load'](p))
    t['Resources'] = {k:v for k,v in t['Resources'].items() if v.get('Type') != 'AWS::CDK::Metadata'}
    return t
for stack in ['Ogevia-prod-NetworkEgress', 'Ogevia-prod-Observability']:
    name = stack + '.template.json'
    if clean(b/name) != clean(b/'shared'/name):
        raise SystemExit('STOP: functional live drift in ' + stack)
    print('LIVE BASELINE PASS:', stack)
PY
  exit "$?"
fi
if [[ "${1:-}" == cloudshell-release ]]; then
  set -euo pipefail
  set +x +H
  umask 077
  [[ "$(uname -s)" == Linux ]] || { echo 'STOP: run in AWS CloudShell'; exit 1; }
  SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER='' AWS_CLI_AUTO_PROMPT=off
  A() { aws --cli-connect-timeout 5 --cli-read-timeout 60 "$@"; }
  stop() { echo "STOP: $*"; exit 1; }
  stage() { CURRENT_STEP="$1"; printf '\033[32m%s\033[0m\n' "$CURRENT_STEP"; }
  test "$(A sts get-caller-identity --query Account --output text)" = 300094796789 || stop 'wrong AWS account'
  command -v flock >/dev/null || stop 'CloudShell flock is missing'
  exec 9>/tmp/ogevia-test-release.lock
  flock -n 9 || stop 'another copy of this TEST release is running'
  WORK=$(mktemp -d /tmp/ogevia-run.XXXXXX)
  exec > >(tee "$WORK/release.log") 2>&1
  CURRENT_STEP=preparation
  trap 'rc=$?; if [[ "$rc" != 0 ]]; then echo "STOPPED during: $CURRENT_STEP"; echo "Keep this session open. Log: $WORK/release.log"; echo "Do not rerun a partially completed initializer blindly."; fi' EXIT
  export COREPACK_HOME="$WORK/corepack" XDG_CACHE_HOME="$WORK/cache" npm_config_cache="$WORK/npm-cache" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  export OGEVIA_RELEASE_COMMIT=6cbab00b2795d0cfe42bf644adc6a559adda7c76
  export OGEVIA_DEPLOY_APPROVAL=owner-chat-20261111
  export OWNER_SUB=685183b0-f041-70fb-270e-d8ca934231d2
  export MANAGER_SUB=58d173c0-e0d1-709f-4288-116f2ed5dbfc
  export CAREGIVER_SUB=8861c310-9081-70d4-85f7-0a33f9a58a94
  stage '[1/8] Restore only missing local tools and the reviewed checkout'
  for sub in "$OWNER_SUB" "$MANAGER_SUB" "$CAREGIVER_SUB"; do
    result=$(A cognito-idp list-users --user-pool-id us-west-2_849AYz5J7 --filter "sub = \"$sub\"" --query 'Users[].{Enabled:Enabled,Status:UserStatus}' --output json)
    jq -e 'length==1 and .[0].Enabled==true and .[0].Status=="CONFIRMED"' <<<"$result" >/dev/null || stop "required TEST sign-in is not enabled and CONFIRMED: $sub"
  done
  statuses=$(A cloudformation describe-stacks --query "Stacks[?starts_with(StackName, 'Ogevia-prod-')].StackStatus" --output text)
  [[ "$statuses" != *IN_PROGRESS* && "$statuses" != *FAILED* ]] || stop 'a TEST stack is busy or failed; inspect its current operation'
  major=$(pg_dump --version 2>/dev/null | sed -E 's/.* ([0-9]+)\..*/\1/' || true)
  if [[ ! "$major" =~ ^[0-9]+$ || "$major" -lt 18 ]]; then
    if rpm -q postgresql16 >/dev/null 2>&1; then
      sudo dnf swap -y --releasever=latest postgresql16 postgresql18
    else
      sudo dnf install -y --releasever=latest postgresql18
    fi
    hash -r
  fi
  major=$(pg_dump --version | sed -E 's/.* ([0-9]+)\..*/\1/')
  [[ "$major" =~ ^[0-9]+$ && "$major" -ge 18 ]] || stop 'PostgreSQL 18+ backup client is required'
  for bin in /tmp/ogevia-*/node-v22.*-linux-*/bin; do
    [[ ! -x "$bin/node" ]] || { export PATH="$bin:$PATH"; break; }
  done
  if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" != 22 ]]; then
    case "$(uname -m)" in x86_64) arch=x64;; aarch64) arch=arm64;; *) stop 'unsupported CPU';; esac
    archive="node-v22.23.5-linux-$arch.tar.xz"
    curl -fsS --connect-timeout 10 --max-time 180 "https://nodejs.org/dist/v22.23.5/$archive" -o "$WORK/$archive"
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
  while IFS= read -r gitdir; do
    r="${gitdir%/.git}"
    if [[ "$(git -C "$r" rev-parse HEAD 2>/dev/null)" == "$OGEVIA_RELEASE_COMMIT" && -z "$(git -C "$r" status --porcelain --untracked-files=no)" ]]; then REPO="$r"; break; fi
  done < <(find /tmp -maxdepth 5 -type d -name .git -print 2>/dev/null)
  if [[ -z "$REPO" ]]; then
    REPO="$WORK/repo"
    git init -q "$REPO"
    git -C "$REPO" remote add origin https://github.com/socalcaresservices/CarelikGlobal.git
    git -C "$REPO" config remote.origin.promisor true
    git -C "$REPO" config remote.origin.partialclonefilter blob:none
    git -C "$REPO" fetch --filter=blob:none --depth=1 origin "$OGEVIA_RELEASE_COMMIT"
    git -C "$REPO" checkout --detach -q FETCH_HEAD
  fi
  export REPO
  cd "$REPO"
  if [[ ! -x node_modules/.bin/esbuild || ! -x infra/aws/node_modules/.bin/cdk || ! -x apps/web/node_modules/.bin/vite ]]; then
    pnpm install --frozen-lockfile --store-dir "$WORK/store" --prefer-offline
  fi
  TOOL="$REPO/docs/releases/2026-11-10-ux-redesign-test/toolchain"
  stage '[2/8] Capture current live rollback and compare the release'
  BASE=$(mktemp -d /tmp/ogevia-isolated-capture.XXXXXX)
  export OGEVIA_ISOLATED_CAPTURE="$BASE"
  # The pinned app's old caller compares raw CDK telemetry. Re-run every
  # strict comparison below, with only that telemetry resource excluded.
  if bash "$TOOL/OPERATOR_TEST_DEPLOY.sh" isolated-compare; then :; else
    echo 'Completing strict comparisons with the reviewed telemetry normalization.'
  fi
  python3 "$TOOL/diff_gate_ux.py" --live "$BASE/Ogevia-prod-ServiceVerificationApi.template.json" --new "$BASE/shared/Ogevia-prod-ServiceVerificationApi.template.json" --expect pre
  python3 "$TOOL/diff_gate_ux.py" --isolated-assemblies "$BASE/shared" "$BASE/isolated"
  bash "$SELF" cloudshell-baseline "$BASE" "$TOOL/diff_gate_ux.py"
  python3 - "$BASE" <<'PY'
import base64, hashlib, json, pathlib, zipfile, sys
b=pathlib.Path(sys.argv[1]); live=json.loads((b/'test-lambda.json').read_text())
assert base64.b64encode(hashlib.sha256((b/'test-lambda.zip').read_bytes()).digest()).decode()==live['CodeSha256'], 'rollback ZIP hash mismatch'
with zipfile.ZipFile(b/'test-lambda.zip') as z:
    assert z.getinfo('index.js').file_size <= 10_000_000
    assert hashlib.sha256(z.read('index.js')).hexdigest()=='51801cff1705dc6e1cc6b8a9ed3a02a28ef25f1ad94e568388a9d435a963a591'
t=json.loads((b/'shared/Ogevia-prod-ServiceVerificationApi.template.json').read_text())
assert t['Resources']['Handler886CB40B']['Properties']['Code']['S3Key']=='ed01f08a2df9d8870ed44c25912ce9c9d18f4e6dd73dba29594c954a538c983b.zip', 'reviewed Handler asset differs'
asset=t['Resources']['Handler886CB40B']['Metadata']['aws:asset:path']
assert hashlib.sha256((b/'shared'/asset/'index.js').read_bytes()).hexdigest()=='98e84618f6eeaf6472985db06db9132cf39d887d296d38301ee0137e3a6e991c'
print('LIVE ROLLBACK AND REVIEWED APPLICATION ASSET: verified')
PY
  export OGEVIA_WINDOW_START="$(date -u '+%F %T')"
  export OGEVIA_WINDOW_END="$(date -u -d '+60 minutes' '+%F %T')"
  window() { [[ "$(date -u +%s)" -lt "$(date -u -d "$OGEVIA_WINDOW_END" +%s)" ]] || stop 'execution window ended; start no further deployment step'; }
  export OGEVIA_ISOLATED_TEST_GO=initialize-ogevia-postgres
  pnpm --dir infra/aws exec cdk synth '*' --quiet --lookups=false -c env=prod -c mode=deploy -c liveTestBaseline=0102 -c "liveQrParameterSpec=$(cat "$BASE/qr-parameter-spec.json")" -c "liveTestHandlerTags=$(cat "$BASE/handler-tags.json")" -c testDatabase=isolated -c "testMasterSecretArn=$(cat "$BASE/candidate-master-arn.txt")" --output "$BASE/approved"
  python3 "$TOOL/diff_gate_ux.py" --isolated-assemblies "$BASE/shared" "$BASE/approved"
  ASSETS=cdk-hnb659fds-assets-300094796789-us-west-2
  A s3api get-public-access-block --bucket "$ASSETS" --query PublicAccessBlockConfiguration --output json | jq -e '.BlockPublicAcls and .IgnorePublicAcls and .BlockPublicPolicy and .RestrictPublicBuckets' >/dev/null || stop 'rollback bucket is not confirmed private'
  A s3api get-bucket-encryption --bucket "$ASSETS" --query 'ServerSideEncryptionConfiguration.Rules' --output json | jq -e 'length>0 and all(.[]; .ApplyServerSideEncryptionByDefault.SSEAlgorithm=="AES256" or .ApplyServerSideEncryptionByDefault.SSEAlgorithm=="aws:kms")' >/dev/null || stop 'rollback bucket encryption is not confirmed'
  BACKUP_PREFIX="s3://$ASSETS/ogevia-test-rollback/$(basename "$WORK")"
  save_evidence() {
    local label="$1"
    find "$BASE" -type f -not -name SHA256SUMS -exec sha256sum {} + > "$BASE/SHA256SUMS"
    tar -czf "$WORK/$label.tgz" -C "$BASE" .
    A s3 cp "$WORK/$label.tgz" "$BACKUP_PREFIX/$label.tgz" --only-show-errors
    echo "PERSISTENT PRIVATE ROLLBACK: $BACKUP_PREFIX/$label.tgz"
  }
  echo 'COMPARISON PASSED' > "$BASE/comparison-result.txt"
  save_evidence before-release
  stage '[3/8] Deploy dedicated TEST secret'
  window
  pnpm --dir infra/aws exec cdk deploy --app "$BASE/approved" --exclusively Ogevia-prod-DatabaseSecret --require-approval never
  stage '[4/8] Initialize and back up the fresh synthetic TEST database'
  window
  bash "$TOOL/OPERATOR_TEST_DB.sh" isolated-initialize
  bash "$TOOL/OPERATOR_TEST_DB.sh" isolated-verify
  export OGEVIA_TEST_BACKUP="$BASE/isolated-before-cutover.dump"
  bash "$TOOL/OPERATOR_TEST_DB.sh" isolated-backup
  save_evidence before-cutover
  stage '[5/8] Add reviewed TEST access on the shared endpoint'
  window
  pnpm --dir infra/aws exec cdk deploy --app "$BASE/approved" --exclusively Ogevia-prod-NetworkEgress --require-approval never
  stage '[6/8] Deploy TEST API and alarms'
  window
  pnpm --dir infra/aws exec cdk deploy --app "$BASE/approved" --exclusively Ogevia-prod-ServiceVerificationApi Ogevia-prod-Observability --previous-parameters --require-approval never
  stage '[7/8] Publish TEST website'
  window
  VITE_APP_VERSION="$OGEVIA_RELEASE_COMMIT" OGEVIA_APP_ENV=test bash infra/aws/scripts/deploy-test-slice.sh web
  stage '[8/8] Verify live TEST and unchanged production templates'
  bash "$TOOL/OPERATOR_TEST_DB.sh" isolated-verify
  bash infra/aws/scripts/deploy-test-slice.sh smoke
  FN=$(jq -er .FunctionName "$BASE/test-lambda.json")
  A lambda get-function-configuration --function-name "$FN" --query '{host:Environment.Variables.DB_HOST,database:Environment.Variables.DB_NAME}' --output json | jq -e '.host=="ogevia-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com" and .database=="ogevia_sv_test"' >/dev/null
  for stack in Ogevia-prd-ServiceVerificationApi Ogevia-prd-Observability; do
    A cloudformation get-template --stack-name "$stack" --template-stage Original --query TemplateBody --output json > "$BASE/$stack.after.json"
    python3 - "$BASE/$stack.template.json" "$BASE/$stack.after.json" <<'PY'
import json, sys
assert json.load(open(sys.argv[1])) == json.load(open(sys.argv[2])), 'production template changed'
PY
  done
  save_evidence verified-release
  stage 'TEST DEPLOYED: database/API/web smoke checks passed; production templates unchanged'
  A cloudformation describe-stacks --stack-name Ogevia-prod-WebHosting --query 'Stacks[0].Outputs[?OutputKey==`WebOrigin`].OutputValue' --output text
  echo "Release source: $OGEVIA_RELEASE_COMMIT"
  echo "Log: $WORK/release.log"
  echo 'Owner/caregiver live workflow acceptance is next. Production is not deployed by this command.'
  exit 0
fi

# Phase C DEPLOYMENT script for the UX redesign release, TEST only (cdk diff, API deploy, web publish). Derived from STELLA_PHASE_C_DEPLOY.sh (2026-11-01). DRAFT. NOT RUN. NOT AUTHORIZED.
# Operator: whoever the owner names in the written Phase C statement. Deploys ONLY Ogevia-prod-ServiceVerificationApi and the TEST web site; never an Ogevia-prd-* stack,
# never NetworkEgress/WebHosting/EvidenceStorage/Observability, never the database (that is OPERATOR_TEST_DB.sh). Expected API change: exactly 3 new routes and the Handler code asset (diff_gate_ux.py).
#   export OGEVIA_WINDOW_START="YYYY-MM-DD HH:MM:SS" OGEVIA_WINDOW_END="YYYY-MM-DD HH:MM:SS"   (UTC, from the owner's statement; no default)
#   REPO=<checkout at the pinned SHA, deps installed> OGEVIA_DEPLOY_APPROVAL=<the owner's GO reference> bash OPERATOR_TEST_DEPLOY.sh <mode>
#   selftest     local only: assembly and gate checks (no AWS)
#   synth        build the CloudFormation assembly in /tmp (no AWS change) and check it against the pinned asset keys and 253 routes
#   capture      READ-ONLY baseline and rollback material (live API template, Lambda config and code ref, web bucket copy)
#   check        READ-ONLY: expected-only gate (live API template vs assembly) + the cdk diff text
#   deploy-api   [window only] re-checks, asks you to type DEPLOY-Ogevia-prod-ServiceVerificationApi, deploys that one stack, then post-api
#   post-api     READ-ONLY checks after the deployment (including 401 without a token on each of the 3 new routes)
#   web          [window only] build for TEST, upload (no delete), invalidate CloudFront, then web-verify
#   web-verify   READ-ONLY: what the TEST site serves (must carry the pinned commit)
#   rollback-web / rollback-api   only after a stop condition; allowed after the window to restore known-good
# Current isolated TEST comparison: read-only AWS calls, no database connection.
# The legacy shared-release modes below remain historical and are not this cutover.
if [[ "${1:-}" == isolated-compare ]]; then
  set -euo pipefail
  set +x +H
  umask 077
  : "${REPO:?set the reviewed checkout}"
  : "${OGEVIA_RELEASE_COMMIT:?set the reviewed full commit}"
  [[ "$(git -C "$REPO" rev-parse HEAD)" == "$OGEVIA_RELEASE_COMMIT" ]] || { echo 'STOP: checkout differs'; exit 2; }
  [[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || { echo 'STOP: tracked checkout changes'; exit 2; }
  export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""
  A() { aws --cli-connect-timeout 5 --cli-read-timeout 60 "$@"; }
  [[ "$(A sts get-caller-identity --query Account --output text)" == 300094796789 ]] || { echo 'STOP: wrong account'; exit 2; }
  B="${OGEVIA_ISOLATED_CAPTURE:-$(mktemp -d /tmp/ogevia-isolated-capture.XXXXXX)}"
  [[ "$B" == /* && ! -L "$B" ]] || { echo 'STOP: capture directory must be absolute and private'; exit 2; }
  mkdir -p "$B"
  [[ -z "$(find "$B" -mindepth 1 -maxdepth 1 -print -quit)" ]] || { echo 'STOP: use a new empty capture directory'; exit 2; }
  chmod 700 "$B"
  echo "CAPTURE: $B"
  TOOL="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # Redact only the earlier known local capture, if explicitly supplied. Never print its contents.
  if [[ -n "${OGEVIA_PREVIOUS_CAPTURE:-}" ]]; then
    case "$OGEVIA_PREVIOUS_CAPTURE" in /tmp/ogevia-release.*/capture) ;; *) echo 'STOP: unexpected previous capture path'; exit 2;; esac
    python3 - "$OGEVIA_PREVIOUS_CAPTURE/test-lambda.json" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1])
if p.exists() and p.stat().st_size:
    data=json.loads(p.read_text())
    env=data.get('Environment',{}).get('Variables',{})
    if 'OGEVIA_QR_ENCRYPTION_KEY' in env:
        del env['OGEVIA_QR_ENCRYPTION_KEY']
        p.write_text(json.dumps(data,indent=2)+'\n')
        print('Previous local QR key capture redacted; no value displayed.')
PY
  fi
  out() { A cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
  TEST_BUCKET=$(out Ogevia-prod-WebHosting SiteBucketName)
  TEST_DIST=$(out Ogevia-prod-WebHosting DistributionId)
  [[ -n "$TEST_BUCKET" && "$TEST_BUCKET" != None && -n "$TEST_DIST" && "$TEST_DIST" != None ]] || { echo 'STOP: missing TEST web targets'; exit 2; }
  [[ "$TEST_BUCKET" != "$(out Ogevia-prd-WebHosting SiteBucketName)" && "$TEST_DIST" != "$(out Ogevia-prd-WebHosting DistributionId)" ]] || { echo 'STOP: web targets shared with production'; exit 2; }
  printf '%s\n%s\n' "$TEST_BUCKET" "$TEST_DIST" > "$B/web-targets.txt"
  git -C "$REPO" rev-parse HEAD > "$B/release-commit.txt"
  MASTER_ARN=$(A rds describe-db-instances --db-instance-identifier ogevia-postgres --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)
  printf '%s\n' "$MASTER_ARN" > "$B/candidate-master-arn.txt"
  for stack in Ogevia-prod-ServiceVerificationApi Ogevia-prod-Observability Ogevia-prod-NetworkEgress Ogevia-prd-ServiceVerificationApi Ogevia-prd-Observability; do
    A cloudformation get-template --stack-name "$stack" --template-stage Original --query TemplateBody --output json > "$B/$stack.template.json"
    A cloudformation describe-stacks --stack-name "$stack" --output json > "$B/$stack.stack.json"
  done
  FN=$(A cloudformation list-stack-resources --stack-name Ogevia-prod-ServiceVerificationApi --output json | jq -er '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId|startswith("Handler")))] | if length==1 then .[0].PhysicalResourceId else error("Expected one API Handler") end')
  # Only allowlisted metadata. The QR encryption-key value is never printed or persisted.
  A lambda get-function-configuration --function-name "$FN" --query '{FunctionName:FunctionName,CodeSha256:CodeSha256,LastModified:LastModified,RevisionId:RevisionId,Runtime:Runtime,VpcConfig:VpcConfig,Database:{host:Environment.Variables.DB_HOST,name:Environment.Variables.DB_NAME,secretArn:Environment.Variables.DB_SECRET_ARN}}' > "$B/test-lambda.json"
  LOCATION=$(A lambda get-function --function-name "$FN" --query 'Code.Location' --output text)
  curl -fsS --connect-timeout 5 --max-time 120 "$LOCATION" -o "$B/test-lambda.zip"
  unset LOCATION
  python3 - "$B" <<'PY'
import base64,hashlib,json,pathlib,sys,zipfile
b=pathlib.Path(sys.argv[1]); expected=json.loads((b/'test-lambda.json').read_text())['CodeSha256']
assert base64.b64encode(hashlib.sha256((b/'test-lambda.zip').read_bytes()).digest()).decode()==expected, 'STOP: rollback ZIP does not match the live Handler'
with zipfile.ZipFile(b/'test-lambda.zip') as z:
    info=z.getinfo('index.js')
    assert info.file_size <= 10_000_000, 'STOP: unexpected live Handler bundle size'
    assert hashlib.sha256(z.read(info)).hexdigest()=='51801cff1705dc6e1cc6b8a9ed3a02a28ef25f1ad94e568388a9d435a963a591', 'STOP: live Handler differs from the recovered accepted 0102 source artifact; reconcile it before deployment'
t=json.loads((b/'Ogevia-prod-ServiceVerificationApi.template.json').read_text())
qr=t['Parameters']['ClientQrEncryptionKey']
assert qr.get('Type')=='String' and qr.get('NoEcho') is True and qr.get('Default','')=='', 'STOP: QR parameter metadata is not safe to preserve'
assert set(qr)<=set('Type NoEcho Default Description AllowedPattern AllowedValues MinLength MaxLength ConstraintDescription'.split()), 'STOP: unexpected QR parameter fields'
(b/'qr-parameter-spec.json').write_text(json.dumps(qr))
(b/'handler-tags.json').write_text(json.dumps(t['Resources']['Handler886CB40B']['Properties'].get('Tags',[])))
print('Verified rollback ZIP; QR key stays in its existing NoEcho parameter.')
PY
  A s3 sync "s3://$TEST_BUCKET" "$B/web-before" --only-show-errors
  QR_SPEC=$(cat "$B/qr-parameter-spec.json"); TAGS=$(cat "$B/handler-tags.json")
  cd "$REPO"
  for target in shared isolated; do
    context=()
    [[ "$target" != isolated ]] || context=(-c testDatabase=isolated -c "testMasterSecretArn=$MASTER_ARN")
    pnpm --dir infra/aws exec cdk synth '*' --quiet --lookups=false -c env=prod -c mode=plan -c liveTestBaseline=0102 -c "liveQrParameterSpec=$QR_SPEC" -c "liveTestHandlerTags=$TAGS" "${context[@]}" --output "$B/$target"
  done
  python3 "$TOOL/diff_gate_ux.py" --live "$B/Ogevia-prod-ServiceVerificationApi.template.json" --new "$B/shared/Ogevia-prod-ServiceVerificationApi.template.json" --expect pre
  python3 "$TOOL/diff_gate_ux.py" --isolated-assemblies "$B/shared" "$B/isolated"
  python3 - "$B" "$TOOL" <<'PY'
import pathlib,runpy,sys
b=pathlib.Path(sys.argv[1]);g=runpy.run_path(str(pathlib.Path(sys.argv[2])/'diff_gate_ux.py'))
for s in ['Ogevia-prod-NetworkEgress','Ogevia-prod-Observability']:
    assert g['norm'](g['load'](b/(s+'.template.json')))==g['norm'](g['load'](b/'shared'/(s+'.template.json'))), 'STOP: live drift in '+s
print('LIVE SHARED BASELINES: match')
PY
  find "$B" -type f -not -name SHA256SUMS -exec sha256sum {} + > "$B/SHA256SUMS"
  printf '\033[32m%s\033[0m\n' 'COMPARISON PASSED — NOTHING DEPLOYED'
  echo "Keep this private rollback capture: $B"
  exit 0
fi

set +x +H
umask 077
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER="" CDK_DISABLE_CLI_TELEMETRY=true
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-}"
SHA=f4316c5f1a9a844dc7749152243271cee003e94c
ACCOUNT=300094796789; API=Ogevia-prod-ServiceVerificationApi; WEBSTACK=Ogevia-prod-WebHosting
ASSEMBLY="${ASSEMBLY:-/tmp/ogevia-cdk-ux.out}"; B="${OGEVIA_BEFORE:-$HOME/ogevia-before-ux}"
EXPECT_HANDLER_KEY=7baa45221daa410dec24424c55dd64605e5ce2fe36059165a4f5d958239346eb.zip
EXPECT_IDENTITY_KEY=7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759.zip
EXPECT_ROUTES=253
WIN_START_TXT="${OGEVIA_WINDOW_START:-}"; WIN_END_TXT="${OGEVIA_WINDOW_END:-}"   # UTC "YYYY-MM-DD HH:MM:SS", from the owner's written statement; unset = nothing may run
WIN_START=$(date -u -d "$WIN_START_TXT" +%s 2>/dev/null); WIN_END=$(date -u -d "$WIN_END_TXT" +%s 2>/dev/null)
A() { timeout --foreground -k 5 "${OGEVIA_AWS_TIMEOUT:-120}" aws "$@"; }
stop() { echo "STOP: $*"; exit 2; }
in_window() { local n; n=$(date -u +%s); [[ -n "$WIN_START" && "$n" -ge "$WIN_START" && "$n" -lt "$WIN_END" ]]; }
need_window() { in_window || stop "outside the authorized window ($WIN_START_TXT to $WIN_END_TXT UTC). No new deployment activity may begin."; }
confirm() { local got; echo; echo "$2"; printf 'Type exactly  %s  to continue: ' "$1" > /dev/tty; read -r got < /dev/tty; [[ "$got" == "$1" ]] || stop "confirmation not given"; }
trap '[[ "$MODE" =~ ^(deploy-api|web)$ ]] && ! in_window && echo "NOTE: this step finished after the window end (at the end of the authorized window). It was allowed to complete (A12 forbids BEGINNING new activity). Start NO further step; report. Rollback to known-good only."; echo "END (UTC): $(date -u +%FT%TZ)  mode=$MODE"' EXIT

check_repo() {
  [[ -n "${REPO:-}" && -d "$REPO/infra/aws" ]] || stop "set REPO to the checkout at $SHA with dependencies installed"
  [[ "$(git -C "$REPO" rev-parse HEAD 2>/dev/null)" == "$SHA" ]] || stop "REPO HEAD is not $SHA (the only approved commit)"
  [[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop "REPO has local changes"
  [[ -x "$REPO/infra/aws/node_modules/.bin/cdk" ]] || stop "dependencies are not installed in REPO (pnpm install --frozen-lockfile)"
}
need_approval() { [[ "${OGEVIA_DEPLOY_APPROVAL:-}" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || stop "set OGEVIA_DEPLOY_APPROVAL to the owner's GO reference from the written statement (6-64 chars A-Za-z0-9._-)"; }
aws_ok() { [[ "$(A sts get-caller-identity --query Account --output text 2>/dev/null)" == "$ACCOUNT" ]] || stop "no valid AWS credentials for account $ACCOUNT"; }
out() { A cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }

assembly_ok() {   # no AWS: is the synthesized assembly the release?
  python3 -I - "$ASSEMBLY" "$EXPECT_HANDLER_KEY" "$EXPECT_IDENTITY_KEY" "$EXPECT_ROUTES" <<'PY' || return 1
import json, os, sys
d, hk, ik, nroutes = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
names = sorted(f[:-len(".template.json")] for f in os.listdir(d) if f.endswith(".template.json"))
want = ["Ogevia-prod-EvidenceStorage","Ogevia-prod-NetworkEgress","Ogevia-prod-Observability","Ogevia-prod-ServiceVerificationApi","Ogevia-prod-WebHosting"]
ok = True
def chk(c, m):
    global ok; print(("PASS " if c else "FAIL ") + m); ok = ok and c
chk(names == want, "exactly the five Ogevia-prod-* stacks and no Ogevia-prd-*: %s" % names)
t = json.load(open(os.path.join(d, "Ogevia-prod-ServiceVerificationApi.template.json")))["Resources"]
fn = {k: v for k, v in t.items() if v["Type"] == "AWS::Lambda::Function"}
h = [v["Properties"]["Code"]["S3Key"] for k, v in fn.items() if k.startswith("Handler")]
i = [v["Properties"]["Code"]["S3Key"] for k, v in fn.items() if k.startswith("IdentityHandler")]
chk(h == [hk], "Handler code asset %s" % (h[0][:16] + "..." if h else "none"))
chk(i == [ik], "IdentityHandler code asset %s" % (i[0][:16] + "..." if i else "none"))
chk(sum(1 for v in t.values() if v["Type"] == "AWS::ApiGatewayV2::Route") == nroutes, "%d API routes" % nroutes)
print("PASS all checks" if ok else "FAIL")
sys.exit(0 if ok else 1)
PY
}

if [[ "$MODE" == selftest ]]; then
  echo "selftest (local only)"; command -v python3 jq >/dev/null || stop "python3 and jq are needed"
  [[ -f "$HERE/diff_gate_ux.py" ]] || stop "diff_gate_ux.py is missing next to this script"
  [[ -n "$WIN_START" && "$WIN_END" -gt "$WIN_START" ]] && echo "window math ok: $WIN_START_TXT to $WIN_END_TXT UTC" || stop "window math (the window constants are not filled in?)"
  if [[ -f "$ASSEMBLY/$API.template.json" ]]; then
    assembly_ok || stop "the assembly check failed"
    python3 -I -B "$HERE/diff_gate_ux.py" --live "$ASSEMBLY/$API.template.json" --new "$ASSEMBLY/$API.template.json" --expect post || stop "gate self-compare failed"
  else echo "no assembly at $ASSEMBLY: run the synth mode first to include the assembly and gate checks"; fi
  [[ -n "${REPO:-}" ]] && { check_repo; echo "REPO ok: $SHA"; } || echo "REPO not set: repo check skipped"
  echo "selftest done"; exit 0
fi
case "$MODE" in synth|capture|check|deploy-api|post-api|web|web-verify|rollback-web|rollback-api) ;; *) stop "usage: selftest | synth | capture | check | deploy-api | post-api | web | web-verify | rollback-web | rollback-api";; esac
case "$MODE" in deploy-api|web) need_window;; esac
for c in aws jq curl python3 node; do command -v "$c" >/dev/null 2>&1 || stop "missing tool: $c"; done
check_repo

if [[ "$MODE" == synth ]]; then
  need_approval
  rm -rf "$ASSEMBLY"
  ( cd "$REPO/infra/aws" && PATH="$PWD/node_modules/.bin:$PATH" npx --no-install cdk synth --quiet --no-notices -c env=prod -c mode=deploy -o "$ASSEMBLY" ) || stop "synthesis failed"
  assembly_ok || stop "the assembly is not the release: do not deploy (a different asset key means different inputs)"
  exit 0
fi

aws_ok
[[ -f "$ASSEMBLY/$API.template.json" ]] || [[ "$MODE" == capture || "$MODE" == web* || "$MODE" == rollback-* || "$MODE" == post-api ]] || stop "no assembly at $ASSEMBLY: run the synth mode first"

if [[ "$MODE" == capture ]]; then
  mkdir -p "$B/live" || stop "cannot create $B"; [[ "$(df --output=avail -k "$HOME" | tail -1)" -gt 300000 ]] || stop "less than 300 MB free in $HOME (the web capture needs room)"
  for S in $API $WEBSTACK; do
    st=$(A cloudformation describe-stacks --stack-name "$S" --query 'Stacks[0].StackStatus' --output text) || stop "cannot read $S"; echo "$S $st"
    [[ "$st" == UPDATE_COMPLETE || "$st" == CREATE_COMPLETE ]] || stop "$S is not settled"
  done
  A cloudformation get-template --stack-name $API --template-stage Original --query TemplateBody --output json > "$B/live/$API.json" && jq -e 'has("Resources")' "$B/live/$API.json" >/dev/null || stop "cannot read the live API template"
  API_URL=$(out $API ApiUrl); WEB_URL=$(out $WEBSTACK WebOrigin); BUCKET=$(out $WEBSTACK SiteBucketName); DIST=$(out $WEBSTACK DistributionId)
  [[ -n "$API_URL" && -n "$WEB_URL" && -n "$BUCKET" && -n "$DIST" ]] || stop "a stack output is missing"
  printf '%s\n' "$API_URL" > "$B/api-url.txt"; printf '%s\n' "$WEB_URL" > "$B/web-url.txt"
  FN=$(A cloudformation list-stack-resources --stack-name $API --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function' && starts_with(LogicalResourceId,'Handler')].PhysicalResourceId" --output text)
  [[ -n "$FN" && "$FN" != None ]] || stop "handler function not found"; printf '%s\n' "$FN" > "$B/handler-function-name.txt"
  A lambda get-function-configuration --function-name "$FN" --output json > "$B/lambda-config-before.json" || stop "cannot read the Lambda configuration"
  DBN=$(jq -r '.Environment.Variables.DB_NAME // empty' "$B/lambda-config-before.json"); ENVN=$(jq -r '.Environment.Variables.OGEVIA_ENV // empty' "$B/lambda-config-before.json")
  [[ "$DBN" == ogevia_sv_test && "$ENVN" != prd ]] || stop "the Lambda serves '$DBN' (OGEVIA_ENV='$ENVN'): this is not TEST"
  echo "TEST confirmed: Lambda serves $DBN; CodeSha256 before: $(jq -r .CodeSha256 "$B/lambda-config-before.json")"
  AB=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key|startswith("Handler"))) | .value.Properties.Code.S3Bucket][0] // empty' "$B/live/$API.json")
  AK=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key|startswith("Handler"))) | .value.Properties.Code.S3Key][0] // empty' "$B/live/$API.json")
  printf '%s\n%s\n' "$AB" "$AK" > "$B/previous-api-asset.txt"
  SZ=$(A s3api head-object --bucket "$AB" --key "$AK" --query ContentLength --output text 2>/dev/null); [[ "$SZ" =~ ^[0-9]+$ ]] || stop "the previous API code asset s3://$AB/$AK cannot be read: the API rollback would not work"
  echo "previous API code asset exists: s3://$AB/$AK ($SZ bytes)"
  rm -rf "$B/web-before"; A s3 sync "s3://$BUCKET" "$B/web-before" --only-show-errors || stop "web bucket capture failed"
  ( cd "$B/web-before" && find . -type f -print0 | sort -z | xargs -0 sha256sum > ../web-before.sha256 ) ; echo "web files captured: $(wc -l < "$B/web-before.sha256")"
  curl -fsS --max-time 60 "$WEB_URL/index.html" | sha256sum | cut -d' ' -f1 > "$B/web-index-sha256-before.txt"; echo "served index.html sha256: $(cat "$B/web-index-sha256-before.txt")"
  echo "CAPTURED to $B (keep it until the release is accepted)"; exit 0
fi

[[ -f "$B/live/$API.json" ]] || stop "run the capture mode first ($B/live/$API.json is missing)"

gate() {
  local st; st=$(A cloudformation describe-stacks --stack-name $API --query 'Stacks[0].StackStatus' --output text) || stop "cannot read $API"
  [[ "$st" == UPDATE_COMPLETE || "$st" == CREATE_COMPLETE ]] || stop "$API is $st, not settled"
  A cloudformation get-template --stack-name $API --template-stage Original --query TemplateBody --output json > "$B/gate-live.json" && jq -e 'has("Resources")' "$B/gate-live.json" >/dev/null || stop "cannot read the live template"
  assembly_ok || stop "the assembly is not the release"
  echo "-- cdk diff (read-only; for the human reader)"
  ( cd "$REPO/infra/aws" && timeout --foreground -k 5 300 npx --no-install cdk diff --app "$ASSEMBLY" $API --no-notices 2>&1 | tail -60 )
  echo "-- EXPECTED-ONLY gate (machine check of the live template vs the assembly)"
  python3 -I -B "$HERE/diff_gate_ux.py" --live "$B/gate-live.json" --new "$ASSEMBLY/$API.template.json" --expect "${1:-pre}" || stop "the difference is not exactly the release's allowed change. Do not deploy."
}

case "$MODE" in
  check) gate pre ;;
  deploy-api)
    need_approval; gate pre
    confirm "DEPLOY-$API" "ABOUT TO RUN (YELLOW): npx cdk deploy --app $ASSEMBLY --exclusively $API --require-approval broadening --no-notices   (TEST only). CDK should NOT ask for an IAM approval; if it does, answer n and stop."
    ( cd "$REPO/infra/aws" && npx --no-install cdk deploy --app "$ASSEMBLY" --exclusively "$API" --require-approval broadening --no-notices ) || stop "cdk deploy failed or was declined. Decide on rollback only on a stop condition."
    bash "$0" post-api ;;
  post-api)
    FN=$(cat "$B/handler-function-name.txt"); API_URL=$(cat "$B/api-url.txt")
    st=$(A cloudformation describe-stacks --stack-name $API --query 'Stacks[0].StackStatus' --output text); echo "$API: $st"; [[ "$st" == UPDATE_COMPLETE ]] || stop "stack status is $st"
    A lambda wait function-updated --function-name "$FN" || stop "Lambda did not settle"
    A lambda get-function-configuration --function-name "$FN" --output json > "$B/lambda-config-after.json"
    [[ "$(jq -S .Environment.Variables "$B/lambda-config-before.json")" == "$(jq -S .Environment.Variables "$B/lambda-config-after.json")" ]] && echo "PASS Lambda environment unchanged" || stop "the Lambda environment changed"
    [[ "$(jq -r .CodeSha256 "$B/lambda-config-before.json")" != "$(jq -r .CodeSha256 "$B/lambda-config-after.json")" ]] && echo "PASS new CodeSha256 $(jq -r .CodeSha256 "$B/lambda-config-after.json")" || stop "CodeSha256 did not change"
    A cloudformation get-template --stack-name $API --template-stage Original --query TemplateBody --output json > "$B/gate-live-after.json"
    python3 -I -B "$HERE/diff_gate_ux.py" --live "$B/gate-live-after.json" --new "$ASSEMBLY/$API.template.json" --expect post || stop "the deployed stack differs from the assembly"
    Z=00000000-0000-4000-8000-000000000000
    for p in /v1/me /v1/signin-overrides; do c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$API_URL$p"); echo "GET $p without a token: $c"; [[ "$c" == 401 ]] || stop "expected 401 for $p"; done
    for p in /v1/imports/people /v1/caregivers/$Z/signin-override; do c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST -H 'content-type: application/json' -d '{}' "$API_URL$p"); echo "POST $p without a token: $c"; [[ "$c" == 401 ]] || stop "expected 401 for $p"; done
    c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -H "authorization: Bearer forged.token.value" "$API_URL/v1/signin-overrides"); echo "GET /v1/signin-overrides with a forged token: $c"; [[ "$c" == 401 ]] || stop "expected 401 for a forged token"
    echo "POST-API OK" ;;
  web)
    need_approval; WEB_URL=$(cat "$B/web-url.txt")
    confirm "PUBLISH-WEB" "ABOUT TO RUN (YELLOW): infra/aws/scripts/deploy-test-slice.sh web at commit $SHA  (build for TEST, upload without delete, invalidate CloudFront) to $WEB_URL"
    ( cd "$REPO" && VITE_APP_VERSION="$SHA" OGEVIA_DEPLOY_APPROVAL="$OGEVIA_DEPLOY_APPROVAL" bash infra/aws/scripts/deploy-test-slice.sh web ) || stop "web publish failed"
    echo "waiting 60 s for CloudFront..."; sleep 60; bash "$0" web-verify ;;
  web-verify)
    SITE=$(cat "$B/web-url.txt"); DIST="$REPO/apps/web/dist-aws"; [[ -f "$DIST/index.html" ]] || stop "no local build at $DIST (run the web mode first)"
    bad=0; ok() { echo "PASS $*"; }; nope() { echo "FAIL $*"; bad=1; }
    LOCAL=$(sha256sum "$DIST/index.html" | cut -d' ' -f1); IDXF=$(mktemp) && curl -fsS --max-time 60 -o "$IDXF" "$SITE/index.html" || { rm -f "$IDXF"; stop "cannot fetch $SITE/index.html"; }
    IDX=$(cat "$IDXF"); SERVED=$(sha256sum "$IDXF" | cut -d' ' -f1); rm -f "$IDXF"; echo "index.html sha256: served $SERVED  local $LOCAL"
    [[ "$SERVED" == "$LOCAL" ]] && ok "served index.html is the one just built" || nope "served index.html differs (CloudFront lag: wait a minute and rerun once)"
    ASSET=$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' <<<"$IDX" | head -1); [[ -n "$ASSET" ]] && ok "main script $ASSET" || stop "index.html references no assets/index-*.js"
    JS=$(curl -fsS --max-time 60 "$SITE/$ASSET") || stop "cannot fetch $SITE/$ASSET"
    [[ "$(grep -o 'VITE_APP_VERSION:"[^"]*"' <<<"$JS" | head -1)" == "VITE_APP_VERSION:\"$SHA\"" ]] && ok "bundle carries the code SHA" || nope "bundle version is not $SHA"
    grep -q 'VITE_APP_ENV:"test"' <<<"$JS" && ok 'built for TEST (VITE_APP_ENV:"test")' || nope "bundle is not built for TEST"
    if [[ -f "$B/web-before/config.json" ]]; then [[ "$(curl -fsS "$SITE/config.json" | sha256sum | cut -d' ' -f1)" == "$(sha256sum "$B/web-before/config.json" | cut -d' ' -f1)" ]] && ok "config.json unchanged" || nope "config.json differs from the capture"; fi
    [[ $bad == 0 ]] && echo "WEB VERIFIED: $SITE serves $SHA" || stop "a web check failed (see rollback-web)" ;;
  rollback-web)
    confirm "ROLLBACK-WEB" "Restores the captured pre-release web files to the TEST bucket (never deletes, never touches config.json). Allowed after the window only to restore known-good."
    BUCKET=$(out $WEBSTACK SiteBucketName); DIST=$(out $WEBSTACK DistributionId); cd "$B" || stop "no capture"
    (cd web-before && sha256sum -c ../web-before.sha256 --quiet) && echo "capture intact" || stop "the capture is not intact"
    for a in $(grep -o 'assets/[A-Za-z0-9._-]*' web-before/index.html | sort -u); do [[ -f "web-before/$a" ]] || stop "$a is referenced by the captured index.html but is not in the capture"; done
    rm -f restore-assets.txt; touch restore-assets.txt
    (cd web-before && find . -type f ! -name index.html ! -name config.json -printf '%P\t%s\n') | while IFS=$'\t' read -r key size; do
      live=$(A s3api head-object --bucket "$BUCKET" --key "$key" --query ContentLength --output text 2>/dev/null || echo missing); [[ "$live" == "$size" ]] || echo "$key" >> restore-assets.txt; done
    echo "files to restore from the capture: $(wc -l < restore-assets.txt)"
    while read -r key; do case "$key" in assets/*) CC="public,max-age=31536000,immutable";; *) CC="no-cache";; esac; A s3 cp "web-before/$key" "s3://$BUCKET/$key" --cache-control "$CC" --only-show-errors && echo "restored $key"; done < restore-assets.txt
    A s3 cp web-before/index.html "s3://$BUCKET/index.html" --cache-control no-cache && A cloudfront create-invalidation --distribution-id "$DIST" --paths "/index.html" "/" >/dev/null
    echo "served index.html must equal $(cat "$B/web-index-sha256-before.txt"): $(curl -fsS "$(cat "$B/web-url.txt")/index.html" | sha256sum | cut -d' ' -f1)" ;;
  rollback-api)
    confirm "ROLLBACK-API" "Puts the previous Lambda code back (code only; CloudFormation will be out of step with the stack: tell the owner). Web must already be rolled back. Allowed after the window only to restore known-good."
    FN=$(cat "$B/handler-function-name.txt")
    A lambda update-function-code --function-name "$FN" --s3-bucket "$(sed -n 1p "$B/previous-api-asset.txt")" --s3-key "$(sed -n 2p "$B/previous-api-asset.txt")" --query '[LastUpdateStatus,CodeSha256]' --output text || stop "update-function-code failed"
    A lambda wait function-updated --function-name "$FN"
    now=$(A lambda get-function-configuration --function-name "$FN" --query CodeSha256 --output text); before=$(jq -r .CodeSha256 "$B/lambda-config-before.json")
    echo "CodeSha256 now $now  before $before"; [[ "$now" == "$before" ]] && echo "ROLLBACK-API OK (code is the baseline again)" || stop "code is not the baseline" ;;
esac
