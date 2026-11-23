#!/usr/bin/env bash
# PHASE H7: TEST release of OFFICE ASSIGNMENTS, SERVICE COUNTIES and CAREGIVER COLOR (migration 0111, eight API routes behind the officeAssignments switch, web). TEST ONLY (stacks Ogevia-prod-*, database ogevia_sv_test). Never touches Ogevia-prd-* or ogevia_prd.
# One script, stopping at the first failure. Starting point = the CURRENT TEST state: ledger 109/0110 and 268 routes (request cleanup ON, offices ON). The script only adds the eight new routes (276) and never changes the other switches.
#   1 guards (commit, clean tree, account, approval reference) and tools
#   2 read-only capture of the live TEST API, Handler code, web files and the 0110 ledger/objects (the rollback reference)
#   3 TWO assemblies are synthesized and gated BEFORE anything changes: "off" (the eight routes absent: the route rollback) and "on" (exactly eight routes added). Only the Handler code asset may differ otherwise.
#   4 verified TEST backup, migration 0111 (one transaction with its ledger row), verify (ledger 110/0111)
#   5 cdk deploy of the ONE API stack (officeAssignments ON), post-deploy checks (eight routes require a sign-in, nothing else changed)
#   6 web: build for TEST stamped with the commit, upload (no delete), invalidate CloudFront, verify what the site serves
#   REPO=<checkout at the release commit> OGEVIA_RELEASE_COMMIT=<full sha> WORK=<work dir> OGEVIA_DEPLOY_APPROVAL=<owner TEST authorization reference> bash TEST_H7_OFFICE_ASSIGNMENTS.sh [deploy]
#   OGEVIA_NO_CONFIRM=1 skips the typed confirmation (automated test only).
# Rollback modes (typed confirmation each; run in this order):  rollback-web | rollback-routes | rollback-api | rollback-db
set -euo pipefail
set +x +H
umask 077
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER="" CDK_DISABLE_CLI_TELEMETRY=true PYTHONDONTWRITEBYTECODE=1
stop() { echo "STOP: $*" >&2; exit 2; }
MODE="${1:-deploy}"
case "$MODE" in deploy|rollback-web|rollback-routes|rollback-api|rollback-db) ;; *) stop "usage: deploy | rollback-web | rollback-routes | rollback-api | rollback-db";; esac
: "${REPO:?set REPO to the checkout at the release commit}"
: "${OGEVIA_RELEASE_COMMIT:?set OGEVIA_RELEASE_COMMIT to the full release commit}"
: "${WORK:?set WORK to a private work directory with free space}"
: "${OGEVIA_DEPLOY_APPROVAL:?set OGEVIA_DEPLOY_APPROVAL to the owner TEST authorization reference}"
[[ "$OGEVIA_DEPLOY_APPROVAL" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || stop "OGEVIA_DEPLOY_APPROVAL must be 6 to 64 characters of A-Za-z0-9._-"
export OGEVIA_DEPLOY_APPROVAL
COMMIT="$OGEVIA_RELEASE_COMMIT"
[[ "$(git -C "$REPO" rev-parse HEAD)" == "$COMMIT" ]] || stop "the checkout is not at the release commit"
[[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop "tracked files in the checkout are modified"
A() { timeout --foreground -k 5 "${OGEVIA_AWS_TIMEOUT:-300}" aws --cli-connect-timeout 5 --cli-read-timeout 120 "$@"; }
[[ "$(A sts get-caller-identity --query Account --output text)" == 300094796789 ]] || stop "wrong AWS account (expected 300094796789 in us-west-2)"
export XDG_CACHE_HOME="$WORK/cache" XDG_DATA_HOME="$WORK/data" XDG_STATE_HOME="$WORK/state" COREPACK_HOME="$WORK/corepack"
mkdir -p "$WORK/bin" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"
for d in "$WORK"/node-v22.*-linux-*/bin; do [[ -d "$d" ]] && export PATH="$d:$PATH"; done
[[ -d "$WORK/bin" ]] && export PATH="$WORK/bin:$PATH"
TC="$REPO/docs/releases/2026-11-20-test-plan/toolchain"
STACK=Ogevia-prod-ServiceVerificationApi
confirm() { local got; echo; echo "$2"; if [[ "${OGEVIA_NO_CONFIRM:-}" == 1 ]]; then return 0; fi
  printf 'Type exactly  %s  to continue: ' "$1" > /dev/tty; read -r got < /dev/tty; [[ "$got" == "$1" ]] || stop "confirmation not given"; }
out() { A cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
handler_fn() { A cloudformation list-stack-resources --stack-name "$STACK" --output json | jq -er '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId|startswith("Handler")))] | if length==1 then .[0].PhysicalResourceId else error("expected exactly one API Handler") end'; }
route_count() { python3 -c 'import json,sys; t=json.load(open(sys.argv[1])); t=t.get("TemplateBody",t); print(sum(1 for r in t["Resources"].values() if r.get("Type")=="AWS::ApiGatewayV2::Route"))' "$1"; }
OFFICE_ROUTES_GET="/v1/people-facets"
Z=00000000-0000-4000-8000-000000000000
OFFICE_ROUTES_POST="/v1/offices/$Z/update /v1/offices/$Z/reactivate /v1/clients/$Z/offices /v1/clients/$Z/service-county /v1/caregivers/$Z/offices /v1/caregivers/$Z/service-counties /v1/caregivers/$Z/color"
code_get() { curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$API_URL$1"; }
code_post() { curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST -H 'content-type: application/json' -d '{}' "$API_URL$1"; }
CONFIG="$REPO/infra/aws/lib/config.ts"
F_OLD='features: { staffManagement: true, signInOverride: true, bulkImport: true, staffDuplicates: false },'
# edit_config <officeAssignments true|false>: the isolated-TEST features line only (exactly one match), synthesis only; the file is restored right after. Request cleanup and offices are ON on TEST today and stay ON.
edit_config() { python3 - "$CONFIG" "$1" "$F_OLD" <<'PY'
import sys
p, oa, old = sys.argv[1:]
s = open(p).read()
assert s.count(old) == 1, "the TEST features line was not found exactly once"
add = ", requestCleanup: true, offices: true" + (", officeAssignments: true" if oa == "true" else "")
open(p, "w").write(s.replace(old, old[:-3] + add + " },"))
PY
}
restore_config() { git -C "$REPO" checkout -- infra/aws/lib/config.ts 2>/dev/null || true; }
# synth <outdir> <officeAssignments>
synth() {
  local o="$1" oa="$2" r=0
  rm -rf "$o"; trap restore_config EXIT
  edit_config "$oa"
  (cd "$REPO" && pnpm --dir infra/aws exec cdk synth '*' --quiet --lookups=false -c env=prod -c mode=deploy -c liveTestBaseline=0102 \
    -c "liveQrParameterSpec=$QR_SPEC" -c "liveTestHandlerTags=$TAGS" -c testDatabase=isolated -c "testMasterSecretArn=$MASTER_ARN" --output "$o") || r=$?
  restore_config; trap - EXIT
  [[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop "the checkout was not restored to the release commit"
  [[ "$r" == 0 && -f "$o/$STACK.template.json" ]] || stop "synthesis failed. Nothing was changed."
}

# ---- rollback modes use the latest capture ----
CAP="${H7_DIR:-$( { ls -d "$WORK"/h7-2* 2>/dev/null | sort | tail -1; } || true)}"
if [[ "$MODE" != deploy ]]; then
  [[ -n "$CAP" && -d "$CAP" && "$(cat "$CAP/release-commit.txt" 2>/dev/null)" == "$COMMIT" ]] || stop "no H7 capture for this commit in $WORK"
  (cd "$CAP" && sha256sum --check --quiet SHA256SUMS) || stop "the H7 capture was modified or is incomplete"
  SITE_BUCKET="$(sed -n 1p "$CAP/web-targets.txt")"; DIST_ID="$(sed -n 2p "$CAP/web-targets.txt")"; FN="$(handler_fn)"
  case "$MODE" in
  rollback-web)
    confirm "ROLLBACK-TEST-WEB" "Restores the captured pre-release web files to the TEST bucket (nothing is deleted; config.json is not touched)."
    (cd "$CAP/web-before" && for a in $(grep -o 'assets/[A-Za-z0-9._-]*' index.html | sort -u); do [[ -f "$a" ]] || { echo "STOP: $a is referenced by the captured index.html but is missing" >&2; exit 2; }; done)
    A s3 sync "$CAP/web-before/assets" "s3://$SITE_BUCKET/assets" --cache-control "public,max-age=31536000,immutable" --only-show-errors
    A s3 sync "$CAP/web-before" "s3://$SITE_BUCKET" --exclude "assets/*" --exclude index.html --exclude config.json --only-show-errors
    A s3 cp "$CAP/web-before/index.html" "s3://$SITE_BUCKET/index.html" --cache-control no-cache --only-show-errors
    A cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/index.html" "/" >/dev/null
    echo "ROLLBACK-WEB done: the captured index.html is back (allow a minute for CloudFront)";;
  rollback-routes)
    confirm "ROLLBACK-TEST-ROUTES" "Redeploys the saved officeAssignments-OFF assembly to TEST: removes the eight office-assignment routes (every other route stays as it was). The new Handler code stays until rollback-api."
    [[ -f "$CAP/deploy-off/$STACK.template.json" ]] || stop "the saved officeAssignments-OFF assembly is missing"
    (cd "$REPO" && pnpm --dir infra/aws exec cdk deploy --app "$CAP/deploy-off" --exclusively "$STACK" --require-approval broadening --no-notices) || stop "cdk deploy failed"
    A cloudformation get-template --stack-name "$STACK" --template-stage Original --query TemplateBody --output json > "$CAP/rollback-routes-live.json"
    python3 "$TC/diff_gate_0111.py" --live "$CAP/rollback-routes-live.json" --new "$CAP/deploy-off/$STACK.template.json" --expect post || stop "the rolled-back stack differs from the saved assembly"
    [[ "$(route_count "$CAP/rollback-routes-live.json")" == "$(cat "$CAP/routes-before.txt")" ]] || stop "the route count is not the pre-release count"
    API_URL="$(out "$STACK" ApiUrl)"
    for r in $OFFICE_ROUTES_GET; do c="$(code_get "$r")"; echo "GET $r: $c"; [[ "$c" == 404 ]] || stop "expected 404 after the routes rollback"; done
    echo "ROLLBACK-ROUTES OK: the eight office-assignment routes are gone (404); the route count is back to $(cat "$CAP/routes-before.txt")";;
  rollback-api)
    confirm "ROLLBACK-TEST-API" "Puts the captured previous Handler code back on TEST (code only; the stack template differs from the live function until the next deploy). Run rollback-web and rollback-routes first."
    jq -e '.Database.name=="ogevia_sv_test"' "$CAP/test-lambda.json" >/dev/null || stop "the capture is not the TEST Handler"
    A lambda update-function-code --function-name "$FN" --zip-file "fileb://$CAP/test-lambda.zip" --query '[LastUpdateStatus,CodeSha256]' --output text
    A lambda wait function-updated --function-name "$FN"
    now="$(A lambda get-function-configuration --function-name "$FN" --query CodeSha256 --output text)"; want="$(jq -r .CodeSha256 "$CAP/test-lambda.json")"
    [[ "$now" == "$want" ]] && echo "ROLLBACK-API OK: the Handler code is the captured baseline again" || stop "the Handler code is not the baseline ($now)";;
  rollback-db)
    confirm "ROLLBACK-TEST-0111" "Removes the 0111 objects (office assignments, caregiver service counties, the new columns, seven functions) and its ledger row in one transaction, and restores the 0110 office functions. Assignments, counties and caregiver colors entered since are lost; each client keeps its primary office. Roll back the web, routes and API first."
    bash "$TC/TEST_DB_SESSION.sh" bash "$TC/TEST_0111_LEDGER.sh" rollback;;
  esac
  exit 0
fi

# ================= deploy =================
ensure_tools() {   # Node 22, pnpm 9.15.4 and the installed dependencies, all under $WORK
  if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" != 22 ]]; then
    case "$(uname -m)" in x86_64) arch=x64;; aarch64) arch=arm64;; *) stop "unsupported CPU";; esac
    archive="node-v22.23.5-linux-$arch.tar.xz"
    curl -fsS --connect-timeout 10 --max-time 180 "https://nodejs.org/dist/v22.23.5/$archive" -o "$WORK/$archive"
    curl -fsS --connect-timeout 10 --max-time 60 https://nodejs.org/dist/v22.23.5/SHASUMS256.txt -o "$WORK/node-sums"
    awk -v f="$archive" '$2==f' "$WORK/node-sums" > "$WORK/node-check"; [[ -s "$WORK/node-check" ]] || stop "no checksum for $archive"
    (cd "$WORK" && sha256sum --check node-check) || stop "the Node download does not match its published checksum"
    tar -xJf "$WORK/$archive" -C "$WORK"; export PATH="$WORK/${archive%.tar.xz}/bin:$PATH"
  fi
  corepack enable --install-directory "$WORK/bin"; export PATH="$WORK/bin:$PATH"
  [[ "$(cd "$REPO" && pnpm --version)" == 9.15.4 ]] || stop "pnpm 9.15.4 is required"
  if [[ ! -x "$REPO/infra/aws/node_modules/.bin/cdk" ]]; then
    echo "--- installing dependencies under $WORK (a few minutes)"
    (cd "$REPO" && pnpm install --frozen-lockfile --store-dir "$WORK/store" --prefer-offline) || stop "pnpm install failed"
  fi
  [[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop "the install modified tracked files"
}
ensure_tools
for f in TEST_0111_LEDGER.sh VERIFY_0111.sql diff_gate_0111.py TEST_DB_SESSION.sh; do [[ -f "$TC/$f" ]] || stop "the toolchain is missing $f"; done

B="${H7_DIR:-$WORK/h7-$(date -u +%Y%m%dT%H%M%SZ)}"
[[ "$B" == /* && ! -L "$B" ]] || stop "the capture directory must be an absolute path"
mkdir -p "$B"; [[ -z "$(find "$B" -mindepth 1 -maxdepth 1 -print -quit)" ]] || stop "use a new empty capture directory"
chmod 700 "$B"; echo "CAPTURE: $B"; echo "$COMMIT" > "$B/release-commit.txt"

echo "=== 1. read-only capture of the live TEST state ==="
SITE_BUCKET="$(out Ogevia-prod-WebHosting SiteBucketName)"; DIST_ID="$(out Ogevia-prod-WebHosting DistributionId)"
[[ -n "$SITE_BUCKET" && "$SITE_BUCKET" != None && -n "$DIST_ID" && "$DIST_ID" != None ]] || stop "missing TEST web targets"
[[ "$SITE_BUCKET" != "$(out Ogevia-prd-WebHosting SiteBucketName)" && "$DIST_ID" != "$(out Ogevia-prd-WebHosting DistributionId)" ]] || stop "the TEST web targets are shared with production"
printf '%s\n%s\n' "$SITE_BUCKET" "$DIST_ID" > "$B/web-targets.txt"
MASTER_ARN="$(A rds describe-db-instances --db-instance-identifier ogevia-postgres --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)"
[[ "$MASTER_ARN" == arn:aws:secretsmanager:us-west-2:300094796789:secret:rds!db-* ]] || stop "the managed master-secret ARN was not found"
printf '%s\n' "$MASTER_ARN" > "$B/candidate-master-arn.txt"
A cloudformation get-template --stack-name "$STACK" --template-stage Original --query TemplateBody --output json > "$B/live-api.template.json"
FN="$(handler_fn)"
A lambda get-function-configuration --function-name "$FN" --query '{FunctionName:FunctionName,CodeSha256:CodeSha256,LastModified:LastModified,Database:{host:Environment.Variables.DB_HOST,name:Environment.Variables.DB_NAME,secretArn:Environment.Variables.DB_SECRET_ARN}}' --output json > "$B/test-lambda.json"
jq -e '.Database.name=="ogevia_sv_test" and .Database.host=="ogevia-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com"' "$B/test-lambda.json" >/dev/null || stop "the live TEST Handler does not target the isolated TEST database"
LOCATION="$(A lambda get-function --function-name "$FN" --query 'Code.Location' --output text)"
curl -fsS --connect-timeout 5 --max-time 120 "$LOCATION" -o "$B/test-lambda.zip"; unset LOCATION
python3 - "$B" <<'PY'
import base64, hashlib, json, pathlib, sys
b = pathlib.Path(sys.argv[1])
assert base64.b64encode(hashlib.sha256((b / 'test-lambda.zip').read_bytes()).digest()).decode() == json.loads((b / 'test-lambda.json').read_text())['CodeSha256'], 'STOP: the rollback ZIP does not match the live Handler'
t = json.loads((b / 'live-api.template.json').read_text())
qr = t['Parameters']['ClientQrEncryptionKey']
assert qr.get('Type') == 'String' and qr.get('NoEcho') is True and qr.get('Default', '') == '', 'STOP: the QR parameter metadata is not safe to preserve'
(b / 'qr-parameter-spec.json').write_text(json.dumps(qr))
(b / 'handler-tags.json').write_text(json.dumps(t['Resources']['Handler886CB40B']['Properties'].get('Tags', [])))
PY
A s3 sync "s3://$SITE_BUCKET" "$B/web-before" --only-show-errors
echo "web files captured: $(find "$B/web-before" -type f | wc -l)"
QR_SPEC="$(cat "$B/qr-parameter-spec.json")"; TAGS="$(cat "$B/handler-tags.json")"
ROUTES_BEFORE="$(route_count "$B/live-api.template.json")"; echo "$ROUTES_BEFORE" > "$B/routes-before.txt"
[[ "$ROUTES_BEFORE" == 268 ]] || stop "the live TEST API has $ROUTES_BEFORE routes (expected 268: request cleanup ON and officeAssignments ON)"
echo "live TEST API: $ROUTES_BEFORE routes (request cleanup ON, officeAssignments ON; both stay that way). After this release: $((ROUTES_BEFORE + 8))."
API_URL="$(out "$STACK" ApiUrl)"; [[ "$API_URL" == https://* ]] || stop "no API URL"
for r in $OFFICE_ROUTES_GET; do c="$(code_get "$r")"; echo "GET $r (before): $c"; [[ "$c" == 404 ]] || stop "expected 404: the office routes must not exist yet"; done
echo "--- database (read-only): the baseline ledger 109/0110 and no 0111 objects"
bash "$TC/TEST_DB_SESSION.sh" bash "$TC/TEST_0111_LEDGER.sh" probe || stop "the TEST database is not the baseline this release was prepared for. Nothing was changed."

echo; echo "=== 2. two assemblies, checked before anything is changed ==="
synth "$B/deploy-off" false
python3 "$TC/diff_gate_0111.py" --live "$B/live-api.template.json" --new "$B/deploy-off/$STACK.template.json" --expect off | tee "$B/gate-off.txt" || stop "the officeAssignments-OFF assembly differs from the live TEST API in more than the Handler code. Nothing was changed."
synth "$B/deploy-on" true
python3 "$TC/diff_gate_0111.py" --live "$B/live-api.template.json" --new "$B/deploy-on/$STACK.template.json" --expect on | tee "$B/gate-on.txt" || stop "the officeAssignments-ON assembly is not exactly the eight office-assignment routes plus the Handler code. Nothing was changed."
CAND="$B/deploy-on/$STACK.template.json"
[[ "$(route_count "$CAND")" == "$((ROUTES_BEFORE + 8))" ]] || stop "the assembly has the wrong route count"
find "$B" -type f -not -name SHA256SUMS -exec sha256sum {} + > "$B/SHA256SUMS"

confirm "DEPLOY-TEST-OFFICE-ASSIGNMENTS" "ABOUT TO CHANGE TEST ONLY (owner authorization $OGEVIA_DEPLOY_APPROVAL): back up ogevia_sv_test, apply migration 0111 (office assignments, counties, caregiver colors), deploy the Handler code of $COMMIT to $STACK with the eight office-assignment routes, publish the web to the TEST site. Production is not touched."

echo; echo "=== 3. verified TEST backup ==="
export OGEVIA_TEST_BACKUP="$WORK/backup/ogevia_sv_test-pre-0111-$(date -u +%Y%m%dT%H%M%SZ).dump"; mkdir -p "$WORK/backup"
command -v pg_dump >/dev/null && [[ "$(pg_dump --version | sed -E 's/^[^0-9]*([0-9]+)\..*/\1/')" -ge 18 ]] || stop "the PostgreSQL 18 client (pg_dump) is required"
# the ledger was verified as 109/0110 in the probe above; this dumps the isolated TEST database only (TEST_DB_SESSION.sh pins PGDATABASE=ogevia_sv_test and the TEST host)
bash "$TC/TEST_DB_SESSION.sh" bash -c 'set -euo pipefail; [[ "$PGDATABASE" == ogevia_sv_test ]]; SZ=$(psql -X -At -c "select pg_database_size(current_database())"); FREE=$(df -Pk "$(dirname "$1")" | awk "NR==2{print \$4*1024}"); [[ "$FREE" -gt $((SZ + 20*1024*1024)) ]] || { echo "not enough free space for the backup"; exit 2; }; pg_dump --no-password --format=custom --dbname=ogevia_sv_test --file="$1"; (cd "$(dirname "$1")" && sha256sum "$(basename "$1")" > "$(basename "$1").sha256"); printf "ogevia-postgres|ogevia_sv_test|%s\n" "$(date -u +%FT%TZ)" > "$1.meta"; echo "TEST-only logical backup: $1"' _ "$OGEVIA_TEST_BACKUP" || stop "the TEST backup failed. Nothing was changed."
[[ -s "$OGEVIA_TEST_BACKUP" && -f "$OGEVIA_TEST_BACKUP.sha256" ]] || stop "the backup or its checksum file is missing"
(cd "$(dirname "$OGEVIA_TEST_BACKUP")" && sha256sum --check --quiet "$(basename "$OGEVIA_TEST_BACKUP").sha256") || stop "the backup does not match its checksum"
echo "backup verified: $OGEVIA_TEST_BACKUP"

echo; echo "=== 4. migration 0111 (TEST database) ==="
bash "$TC/TEST_DB_SESSION.sh" bash "$TC/TEST_0111_LEDGER.sh" apply || stop "migration 0111 failed; it ran in one transaction, so the database is unchanged. Nothing else was deployed."
bash "$TC/TEST_DB_SESSION.sh" bash "$TC/TEST_0111_LEDGER.sh" verify || stop "the 0111 post-state does not match. Nothing else was deployed. Decide on rollback-db with me."

echo; echo "=== 5. API deploy (officeAssignments ON) ==="
(cd "$REPO" && pnpm --dir infra/aws exec cdk deploy --app "$B/deploy-on" --exclusively "$STACK" --require-approval broadening --no-notices) || stop "cdk deploy failed or was declined. The database has 0111 (inert without the routes). Send the output; decide on rollback with me."
st="$(A cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text)"; echo "$STACK: $st"; [[ "$st" == UPDATE_COMPLETE ]] || stop "stack status is $st"
A lambda wait function-updated --function-name "$FN"
A lambda get-function-configuration --function-name "$FN" --query '{CodeSha256:CodeSha256,Database:{host:Environment.Variables.DB_HOST,name:Environment.Variables.DB_NAME,secretArn:Environment.Variables.DB_SECRET_ARN}}' --output json > "$B/lambda-after.json"
[[ "$(jq -S .Database "$B/lambda-after.json")" == "$(jq -S .Database "$B/test-lambda.json")" ]] && echo "PASS Handler still targets ogevia_sv_test, same host and secret" || stop "the Handler database settings changed"
[[ "$(jq -r .CodeSha256 "$B/lambda-after.json")" != "$(jq -r .CodeSha256 "$B/test-lambda.json")" ]] && echo "PASS the Handler code changed" || stop "the Handler code did not change"
A cloudformation get-template --stack-name "$STACK" --template-stage Original --query TemplateBody --output json > "$B/after-live.json"
python3 "$TC/diff_gate_0111.py" --live "$B/after-live.json" --new "$CAND" --expect post || stop "the deployed stack differs from the assembly"
[[ "$(route_count "$B/after-live.json")" == "$((ROUTES_BEFORE + 8))" ]] && echo "PASS $((ROUTES_BEFORE + 8)) routes live" || stop "unexpected live route count"
c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$API_URL/v1/me")"; echo "GET /v1/me without a token: $c"; [[ "$c" == 401 ]] || stop "expected 401"
for r in $OFFICE_ROUTES_GET; do c="$(code_get "$r")"; echo "GET $r without a token: $c"; [[ "$c" == 401 ]] || stop "expected 401: the route must exist and require a sign-in"; done
for r in $OFFICE_ROUTES_POST; do c="$(code_post "$r")"; echo "POST $r without a token: $c"; [[ "$c" == 401 ]] || stop "expected 401: the route must exist and require a sign-in"; done
bash "$TC/TEST_DB_SESSION.sh" bash "$TC/TEST_0111_LEDGER.sh" verify || stop "the database check after the deploy failed"
echo "API OK: new Handler code live, $((ROUTES_BEFORE + 8)) routes, officeAssignments ON"

echo; echo "=== 6. web ==="
(cd "$REPO" && VITE_APP_VERSION="$COMMIT" bash infra/aws/scripts/deploy-test-slice.sh web) || stop "the web publish failed. The API is deployed; run rollback-web, then send the output."
echo "waiting 60 s for CloudFront..."; sleep "${OGEVIA_CF_WAIT:-60}"
SITE="$(out Ogevia-prod-WebHosting WebOrigin)"
DIST="$REPO/apps/web/dist-aws"; [[ -f "$DIST/index.html" ]] || stop "no local web build"
bad=0; ok() { echo "PASS $*"; }; nope() { echo "FAIL $*"; bad=1; }
IDXF="$(mktemp)"; curl -fsS --max-time 60 -o "$IDXF" "$SITE/index.html" || stop "cannot fetch $SITE/index.html"
[[ "$(sha256sum "$IDXF" | cut -d' ' -f1)" == "$(sha256sum "$DIST/index.html" | cut -d' ' -f1)" ]] && ok "the served index.html is the one just built" || nope "the served index.html differs (CloudFront lag: wait a minute and recheck)"
ASSET="$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' "$IDXF" | head -1)"; rm -f "$IDXF"; [[ -n "$ASSET" ]] || stop "index.html references no main script"
JS="$(curl -fsS --max-time 60 "$SITE/$ASSET")" || stop "cannot fetch the main script"
[[ "$(grep -o 'VITE_APP_VERSION:"[^"]*"' <<<"$JS" | head -1)" == "VITE_APP_VERSION:\"$COMMIT\"" ]] && ok "the bundle carries commit $COMMIT" || nope "the bundle version is not $COMMIT"
grep -q 'VITE_APP_ENV:"test"' <<<"$JS" && ok 'built for TEST' || nope "the bundle is not built for TEST"
if [[ -f "$B/web-before/config.json" ]]; then
  [[ "$(curl -fsS --max-time 60 "$SITE/config.json" | sha256sum | cut -d' ' -f1)" == "$(sha256sum "$B/web-before/config.json" | cut -d' ' -f1)" ]] && ok "config.json unchanged" || nope "config.json differs from the capture"
fi
[[ "$bad" == 0 ]] || stop "a web check failed (see rollback-web)"
echo
echo "H7 COMPLETE (TEST): migration 0111 applied (ledger 110/0111), officeAssignments ON ($((ROUTES_BEFORE + 8)) routes), web serves $COMMIT. Production was not touched."
echo "Rollback reference kept in $B. Next: the browser checks on $SITE (Administrator, manager, caregiver)."
