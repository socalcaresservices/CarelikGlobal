#!/usr/bin/env bash
# RELEASE TRAIN 2, TEST STAGE 1 - COVER-SHIFT NOTIFICATIONS, IN-APP ONLY (switch features.notifications; migrations 0113-0116 are ALREADY applied to TEST and are only READ here).
# TEST ONLY (stacks Ogevia-prod-*, database ogevia_sv_test). Never touches Ogevia-prd-* or ogevia_prd. Email is NOT configured at this stage: no sender, no email function, no SES permission.
# One script, stopping at the first failure. It adds exactly: 10 routes, the 5-minute notification schedule and its invoke permission, the Handler variable COVER_ALERT_ADDRESS_RULES=on, plus the new code of the
# Handler and IdentityHandler functions. It never changes the other switches.
#   1 guards (commit, clean tree, account, approval reference) and tools
#   2 read-only capture of the live TEST API, Handler code and web files (the rollback reference); read-only check that the TEST ledger is 115/0116 (0113-0116 recorded with this checkout's checksums)
#   3 TWO assemblies are synthesized and gated BEFORE anything changes: "off" (switch off: only the code assets differ from live) and "on" (exactly the stage's additions, see diff_gate_rt2.py)
#   4 cdk deploy of the ONE API stack, post-deploy checks (the new routes require a sign-in, the schedule exists, nothing else changed)
#   5 web: build for TEST stamped with the commit, upload (no delete), invalidate CloudFront, verify what the site serves
#   REPO=<checkout at the release commit> OGEVIA_RELEASE_COMMIT=<full sha> WORK=<work dir> OGEVIA_DEPLOY_APPROVAL=<owner TEST authorization reference> bash TEST_RT2_N1_NOTIFICATIONS.sh [deploy]
#   OGEVIA_NO_CONFIRM=1 skips the typed confirmation (automated test only).
# Rollback modes (typed confirmation each; run in this order):  rollback-web | rollback-routes | rollback-api     (the database is rolled back separately: TEST_PENDING_LEDGER.sh rollback, reverse order)
set -euo pipefail
set +x +H
umask 077
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER="" CDK_DISABLE_CLI_TELEMETRY=true PYTHONDONTWRITEBYTECODE=1
stop() { echo "STOP: $*" >&2; exit 2; }
MODE="${1:-deploy}"
case "$MODE" in deploy|rollback-web|rollback-routes|rollback-api) ;; *) stop "usage: deploy | rollback-web | rollback-routes | rollback-api";; esac
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
STAGE=notifications
NEW_ROUTES=10
confirm() { local got; echo; echo "$2"; if [[ "${OGEVIA_NO_CONFIRM:-}" == 1 ]]; then return 0; fi
  printf 'Type exactly  %s  to continue: ' "$1" > /dev/tty; read -r got < /dev/tty; [[ "$got" == "$1" ]] || stop "confirmation not given"; }
out() { A cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
handler_fn() { A cloudformation list-stack-resources --stack-name "$STACK" --output json | jq -er '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId|startswith("Handler")))] | if length==1 then .[0].PhysicalResourceId else error("expected exactly one API Handler") end'; }
route_count() { python3 -c 'import json,sys; t=json.load(open(sys.argv[1])); t=t.get("TemplateBody",t); print(sum(1 for r in t["Resources"].values() if r.get("Type")=="AWS::ApiGatewayV2::Route"))' "$1"; }
OFFICE_ROUTES_GET="/v1/notification-center /v1/notification-preferences /v1/cover-notification-settings /v1/cover-notification-history /v1/cover-office-audiences"
OFFICE_ROUTES_POST="/v1/notification-center/mark /v1/notification-preferences /v1/cover-notification-settings /v1/shifts/00000000-0000-0000-0000-000000000000/notify-cover /v1/offices/00000000-0000-0000-0000-000000000000/cover-audience"
code_get() { curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$API_URL$1"; }
code_post() { curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST -H 'content-type: application/json' -d '{}' "$API_URL$1"; }
CONFIG="$REPO/infra/aws/lib/config.ts"
F_OLD='features: { staffManagement: true, signInOverride: true, bulkImport: true, staffDuplicates: false },'
# edit_config <notifications true|false>: the isolated-TEST features line only (exactly one match), synthesis only; the file is restored right after.
# Request cleanup, offices, officeAssignments and assignmentHistory are ON on TEST today and stay ON. bulkImport stays as it is; every other Release Train 2 switch stays OFF.
edit_config() { python3 - "$CONFIG" "$1" "$F_OLD" <<'PY'
import sys
p, on, old = sys.argv[1:]
s = open(p).read()
assert s.count(old) == 1, "the TEST features line was not found exactly once"
add = ", requestCleanup: true, offices: true, officeAssignments: true, assignmentHistory: true" + (", notifications: true" if on == "true" else "")
open(p, "w").write(s.replace(old, old[:-3] + add + " },"))
PY
}
restore_config() { git -C "$REPO" checkout -- infra/aws/lib/config.ts 2>/dev/null || true; }
# synth <outdir> <notifications>
synth() {
  local o="$1" on="$2" r=0
  rm -rf "$o"; trap restore_config EXIT
  edit_config "$on"
  (cd "$REPO" && pnpm --dir infra/aws exec cdk synth '*' --quiet --lookups=false -c env=prod -c mode=deploy -c liveTestBaseline=0102 \
    -c "liveQrParameterSpec=$QR_SPEC" -c "liveTestHandlerTags=$TAGS" -c testDatabase=isolated -c "testMasterSecretArn=$MASTER_ARN" --output "$o") || r=$?
  restore_config; trap - EXIT
  [[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop "the checkout was not restored to the release commit"
  [[ "$r" == 0 && -f "$o/$STACK.template.json" ]] || stop "synthesis failed. Nothing was changed."
}

# ---- rollback modes use the latest capture ----
CAP="${RT2N1_DIR:-$( { ls -d "$WORK"/rt2n1-2* 2>/dev/null | sort | tail -1; } || true)}"
if [[ "$MODE" != deploy ]]; then
  [[ -n "$CAP" && -d "$CAP" && "$(cat "$CAP/release-commit.txt" 2>/dev/null)" == "$COMMIT" ]] || stop "no RT2 stage-1 capture for this commit in $WORK"
  (cd "$CAP" && sha256sum --check --quiet SHA256SUMS) || stop "the RT2 stage-1 capture was modified or is incomplete"
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
    confirm "ROLLBACK-TEST-ROUTES" "Redeploys the saved notifications-OFF assembly to TEST: removes the 10 notification routes, the schedule and its permission, and the COVER_ALERT_ADDRESS_RULES variable (everything else stays as it was). The new Handler code stays until rollback-api."
    [[ -f "$CAP/deploy-off/$STACK.template.json" ]] || stop "the saved notifications-OFF assembly is missing"
    (cd "$REPO" && pnpm --dir infra/aws exec cdk deploy --app "$CAP/deploy-off" --exclusively "$STACK" --require-approval broadening --no-notices) || stop "cdk deploy failed"
    A cloudformation get-template --stack-name "$STACK" --template-stage Original --query TemplateBody --output json > "$CAP/rollback-routes-live.json"
    python3 "$TC/diff_gate_rt2.py" --stage "$STAGE" --live "$CAP/rollback-routes-live.json" --new "$CAP/deploy-off/$STACK.template.json" --expect post || stop "the rolled-back stack differs from the saved assembly"
    [[ "$(route_count "$CAP/rollback-routes-live.json")" == "$(cat "$CAP/routes-before.txt")" ]] || stop "the route count is not the pre-release count"
    API_URL="$(out "$STACK" ApiUrl)"
    for r in $OFFICE_ROUTES_GET; do c="$(code_get "$r")"; echo "GET $r: $c"; [[ "$c" == 404 ]] || stop "expected 404 after the routes rollback"; done
    for r in $OFFICE_ROUTES_POST; do c="$(code_post "$r")"; echo "POST $r: $c"; [[ "$c" == 404 ]] || stop "expected 404 after the routes rollback"; done
    echo "ROLLBACK-ROUTES OK: the notification routes are gone (404); the route count is back to $(cat "$CAP/routes-before.txt")";;
  rollback-api)
    confirm "ROLLBACK-TEST-API" "Puts the captured previous Handler code back on TEST (code only; the stack template differs from the live function until the next deploy). Run rollback-web and rollback-routes first."
    jq -e '.Database.name=="ogevia_sv_test"' "$CAP/test-lambda.json" >/dev/null || stop "the capture is not the TEST Handler"
    A lambda update-function-code --function-name "$FN" --zip-file "fileb://$CAP/test-lambda.zip" --query '[LastUpdateStatus,CodeSha256]' --output text
    A lambda wait function-updated --function-name "$FN"
    now="$(A lambda get-function-configuration --function-name "$FN" --query CodeSha256 --output text)"; want="$(jq -r .CodeSha256 "$CAP/test-lambda.json")"
    [[ "$now" == "$want" ]] && echo "ROLLBACK-API OK: the Handler code is the captured baseline again" || stop "the Handler code is not the baseline ($now)";;
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
for f in TEST_PENDING_LEDGER.sh VERIFY_PENDING.sql diff_gate_rt2.py TEST_DB_SESSION.sh; do [[ -f "$TC/$f" ]] || stop "the toolchain is missing $f"; done

B="${RT2N1_DIR:-$WORK/rt2n1-$(date -u +%Y%m%dT%H%M%SZ)}"
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
echo "live TEST API: $ROUTES_BEFORE routes (the earlier switches stay as they are). After this stage: $((ROUTES_BEFORE + NEW_ROUTES))."
API_URL="$(out "$STACK" ApiUrl)"; [[ "$API_URL" == https://* ]] || stop "no API URL"
for r in $OFFICE_ROUTES_GET; do c="$(code_get "$r")"; echo "GET $r (before): $c"; [[ "$c" == 404 ]] || stop "expected 404: the notification routes must not exist yet"; done
for r in $OFFICE_ROUTES_POST; do c="$(code_post "$r")"; echo "POST $r (before): $c"; [[ "$c" == 404 ]] || stop "expected 404: the notification routes must not exist yet"; done
echo "--- database (read-only): 0113-0116 recorded with this checkout's checksums and all object checks pass"
for m in 0113 0114 0115 0116; do bash "$TC/TEST_DB_SESSION.sh" bash "$TC/TEST_PENDING_LEDGER.sh" verify "$m" || stop "migration $m is not applied and verified in TEST. Nothing was changed."; done

echo; echo "=== 2. two assemblies, checked before anything is changed ==="
synth "$B/deploy-off" false
python3 "$TC/diff_gate_rt2.py" --stage "$STAGE" --live "$B/live-api.template.json" --new "$B/deploy-off/$STACK.template.json" --expect off | tee "$B/gate-off.txt" || stop "the notifications-OFF assembly differs from the live TEST API in more than the Handler code. Nothing was changed."
synth "$B/deploy-on" true
python3 "$TC/diff_gate_rt2.py" --stage "$STAGE" --live "$B/live-api.template.json" --new "$B/deploy-on/$STACK.template.json" --expect on | tee "$B/gate-on.txt" || stop "the notifications-ON assembly is not exactly this stage's additions plus the new function code. Nothing was changed."
CAND="$B/deploy-on/$STACK.template.json"
[[ "$(route_count "$CAND")" == "$((ROUTES_BEFORE + NEW_ROUTES))" ]] || stop "the assembly has the wrong route count"
find "$B" -type f -not -name SHA256SUMS -exec sha256sum {} + > "$B/SHA256SUMS"

confirm "DEPLOY-TEST-NOTIFICATIONS" "ABOUT TO CHANGE TEST ONLY (owner authorization $OGEVIA_DEPLOY_APPROVAL): deploy the code of $COMMIT to $STACK with the notifications switch ON (10 routes, the 5-minute schedule, no email), publish the web to the TEST site. The database is not changed (0113-0116 are already applied); the TEST snapshot ogevia-test-rt2-pre-0113 is the database restore point. Production is not touched."

echo; echo "=== 3. API deploy (notifications ON) ==="
(cd "$REPO" && pnpm --dir infra/aws exec cdk deploy --app "$B/deploy-on" --exclusively "$STACK" --require-approval broadening --no-notices) || stop "cdk deploy failed or was declined. The database is unchanged by this script. Send the output; decide on rollback with me."
st="$(A cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text)"; echo "$STACK: $st"; [[ "$st" == UPDATE_COMPLETE ]] || stop "stack status is $st"
A lambda wait function-updated --function-name "$FN"
A lambda get-function-configuration --function-name "$FN" --query '{CodeSha256:CodeSha256,Database:{host:Environment.Variables.DB_HOST,name:Environment.Variables.DB_NAME,secretArn:Environment.Variables.DB_SECRET_ARN}}' --output json > "$B/lambda-after.json"
[[ "$(jq -S .Database "$B/lambda-after.json")" == "$(jq -S .Database "$B/test-lambda.json")" ]] && echo "PASS Handler still targets ogevia_sv_test, same host and secret" || stop "the Handler database settings changed"
[[ "$(jq -r .CodeSha256 "$B/lambda-after.json")" != "$(jq -r .CodeSha256 "$B/test-lambda.json")" ]] && echo "PASS the Handler code changed" || stop "the Handler code did not change"
A cloudformation get-template --stack-name "$STACK" --template-stage Original --query TemplateBody --output json > "$B/after-live.json"
python3 "$TC/diff_gate_rt2.py" --stage "$STAGE" --live "$B/after-live.json" --new "$CAND" --expect post || stop "the deployed stack differs from the assembly"
[[ "$(route_count "$B/after-live.json")" == "$((ROUTES_BEFORE + NEW_ROUTES))" ]] && echo "PASS $((ROUTES_BEFORE + NEW_ROUTES)) routes live" || stop "unexpected live route count"
c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$API_URL/v1/me")"; echo "GET /v1/me without a token: $c"; [[ "$c" == 401 ]] || stop "expected 401"
for r in $OFFICE_ROUTES_GET; do c="$(code_get "$r")"; echo "GET $r without a token: $c"; [[ "$c" == 401 ]] || stop "expected 401: the route must exist and require a sign-in"; done
for r in $OFFICE_ROUTES_POST; do c="$(code_post "$r")"; echo "POST $r without a token: $c"; [[ "$c" == 401 ]] || stop "expected 401: the route must exist and require a sign-in"; done
for m in 0113 0114 0115 0116; do bash "$TC/TEST_DB_SESSION.sh" bash "$TC/TEST_PENDING_LEDGER.sh" verify "$m" || stop "the database check after the deploy failed ($m)"; done
rule="$(A events list-rules --name-prefix Ogevia-prod --query "Rules[?ScheduleExpression=='rate(5 minutes)'].Name" --output text)"; [[ -n "$rule" ]] && echo "PASS the 5-minute schedule rule exists" || stop "the notification schedule rule was not found"
echo "API OK: new Handler code live, $((ROUTES_BEFORE + NEW_ROUTES)) routes, notifications ON (in-app only)"

echo; echo "=== 4. web ==="
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
echo "RT2 STAGE 1 COMPLETE (TEST): notifications ON in-app only ($((ROUTES_BEFORE + NEW_ROUTES)) routes), 5-minute schedule live, web serves $COMMIT. Migrations were already applied; production was not touched."
echo "Rollback reference kept in $B. Next: the browser checks on $SITE (notification centre, Winchester shift coordinated by Temecula, office chooser, address block)."
