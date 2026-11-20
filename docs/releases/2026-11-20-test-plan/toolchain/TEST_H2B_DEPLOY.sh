#!/usr/bin/env bash
# PHASE H2b: TEST deployment of the release with the request-cleanup switch OFF. TEST ONLY (stacks Ogevia-prod-*, database ogevia_sv_test). Never touches Ogevia-prd-* or ogevia_prd.
# In order, stopping at the first failure:
#   1 guards (commit, clean tree, account, approval reference, the H2a capture and its gate result, the verified backup)
#   2 drift check: the live TEST API template and Handler are still exactly what H2a captured
#   3 synthesize the deploy assembly (switch OFF) and run the expected-only gate (only the Handler code asset differs): changes nothing
#   4 migration 0109 (TEST_0109_LEDGER.sh apply, one transaction with its ledger row) and its verify (ledger 108/0109, 20 object checks)
#   5 cdk deploy of the ONE API stack, then post-deploy checks
#   6 web: build for TEST stamped with the commit, upload (no delete), invalidate CloudFront, verify what the site serves
# The request-cleanup switch stays OFF: the three new routes must answer 404. Turning it on is a separate step (H2c).
#
#   REPO=<checkout at the release commit> OGEVIA_RELEASE_COMMIT=<full sha> WORK=<work dir> OGEVIA_DEPLOY_APPROVAL=<the owner TEST authorization reference> bash TEST_H2B_DEPLOY.sh [deploy]
#   optional: H2A=<capture dir from H2a> BACKUP=<the .dump taken in H1> OGEVIA_NO_CONFIRM=1 (skips the typed confirmation; used by the automated test only)
# Rollback modes (each asks for a typed confirmation):  rollback-api | rollback-web | rollback-db
set -euo pipefail
set +x +H
umask 077
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER="" CDK_DISABLE_CLI_TELEMETRY=true PYTHONDONTWRITEBYTECODE=1
stop() { echo "STOP: $*" >&2; exit 2; }
MODE="${1:-deploy}"
case "$MODE" in deploy|rollback-api|rollback-web|rollback-db) ;; *) stop "usage: deploy | rollback-api | rollback-web | rollback-db";; esac
: "${REPO:?set REPO to the checkout at the release commit}"
: "${OGEVIA_RELEASE_COMMIT:?set OGEVIA_RELEASE_COMMIT to the full release commit}"
: "${WORK:?set WORK to the work directory}"
: "${OGEVIA_DEPLOY_APPROVAL:?set OGEVIA_DEPLOY_APPROVAL to the owner TEST authorization reference}"
[[ "$OGEVIA_DEPLOY_APPROVAL" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || stop "OGEVIA_DEPLOY_APPROVAL must be 6 to 64 characters of A-Za-z0-9._-"
export OGEVIA_DEPLOY_APPROVAL
COMMIT="$OGEVIA_RELEASE_COMMIT"
[[ "$(git -C "$REPO" rev-parse HEAD)" == "$COMMIT" ]] || stop "the checkout is not at the release commit"
[[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop "tracked files in the checkout are modified"
A() { timeout --foreground -k 5 "${OGEVIA_AWS_TIMEOUT:-300}" aws --cli-connect-timeout 5 --cli-read-timeout 120 "$@"; }
[[ "$(A sts get-caller-identity --query Account --output text)" == 300094796789 ]] || stop "wrong AWS account (expected 300094796789 in us-west-2)"
export XDG_CACHE_HOME="$WORK/cache" XDG_DATA_HOME="$WORK/data" XDG_STATE_HOME="$WORK/state" COREPACK_HOME="$WORK/corepack"
for d in "$WORK"/node-v22.*-linux-*/bin; do [[ -d "$d" ]] && export PATH="$d:$PATH"; done
[[ -d "$WORK/bin" ]] && export PATH="$WORK/bin:$PATH"
TC="$REPO/docs/releases/2026-11-20-test-plan/toolchain"
STACK=Ogevia-prod-ServiceVerificationApi
confirm() { local got; echo; echo "$2"; if [[ "${OGEVIA_NO_CONFIRM:-}" == 1 ]]; then return 0; fi
  printf 'Type exactly  %s  to continue: ' "$1" > /dev/tty; read -r got < /dev/tty; [[ "$got" == "$1" ]] || stop "confirmation not given"; }

# ---- the H2a capture (the rollback reference) ----
H2A="${H2A:-$( { ls -d "$WORK"/h2a-2* 2>/dev/null | sort | tail -1; } || true)}"
[[ -n "$H2A" && -d "$H2A" ]] || stop "no H2a capture found in $WORK (run H2a first)"
[[ "$(cat "$H2A/release-commit.txt" 2>/dev/null)" == "$COMMIT" ]] || stop "the H2a capture was made for a different commit"
grep -q '^EXPECTED-ONLY: YES (off)$' "$H2A/gate-off.txt" 2>/dev/null || stop "the H2a gate did not pass in this capture"
(cd "$H2A" && sha256sum --check --quiet SHA256SUMS) || stop "the H2a capture was modified or is incomplete"
for f in live-api.template.json test-lambda.json test-lambda.zip qr-parameter-spec.json handler-tags.json candidate-master-arn.txt web-targets.txt; do [[ -s "$H2A/$f" ]] || stop "the H2a capture lacks $f"; done
[[ -d "$H2A/web-before" ]] || stop "the H2a capture lacks the web files"
SITE_BUCKET="$(sed -n 1p "$H2A/web-targets.txt")"; DIST_ID="$(sed -n 2p "$H2A/web-targets.txt")"
FN="$(A cloudformation list-stack-resources --stack-name "$STACK" --output json | jq -er '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId|startswith("Handler")))] | if length==1 then .[0].PhysicalResourceId else error("expected exactly one API Handler") end')"
echo "H2A capture: $H2A"; echo "TEST Handler: $FN"

# ---- rollback modes ----
if [[ "$MODE" == rollback-api ]]; then
  confirm "ROLLBACK-TEST-API" "Puts the captured previous Handler code back on TEST (code only; the stack template will differ from the live function until the next deploy). Run rollback-web first if the web was published."
  jq -e '.Database.name=="ogevia_sv_test"' "$H2A/test-lambda.json" >/dev/null || stop "the capture is not the TEST Handler"
  A lambda update-function-code --function-name "$FN" --zip-file "fileb://$H2A/test-lambda.zip" --query '[LastUpdateStatus,CodeSha256]' --output text
  A lambda wait function-updated --function-name "$FN"
  now="$(A lambda get-function-configuration --function-name "$FN" --query CodeSha256 --output text)"; want="$(jq -r .CodeSha256 "$H2A/test-lambda.json")"
  [[ "$now" == "$want" ]] && echo "ROLLBACK-API OK: the Handler code is the captured baseline again" || stop "the Handler code is not the baseline ($now)"
  exit 0
fi
if [[ "$MODE" == rollback-web ]]; then
  confirm "ROLLBACK-TEST-WEB" "Restores the captured pre-release web files to the TEST bucket (nothing is deleted; config.json is not touched)."
  (cd "$H2A/web-before" && for a in $(grep -o 'assets/[A-Za-z0-9._-]*' index.html | sort -u); do [[ -f "$a" ]] || { echo "STOP: $a is referenced by the captured index.html but is missing" >&2; exit 2; }; done)
  A s3 sync "$H2A/web-before/assets" "s3://$SITE_BUCKET/assets" --cache-control "public,max-age=31536000,immutable" --only-show-errors
  A s3 sync "$H2A/web-before" "s3://$SITE_BUCKET" --exclude "assets/*" --exclude index.html --exclude config.json --only-show-errors
  A s3 cp "$H2A/web-before/index.html" "s3://$SITE_BUCKET/index.html" --cache-control no-cache --only-show-errors
  A cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/index.html" "/" >/dev/null
  echo "ROLLBACK-WEB done: the captured index.html is back (allow a minute for CloudFront)"; exit 0
fi
if [[ "$MODE" == rollback-db ]]; then
  confirm "ROLLBACK-TEST-0109" "Removes the 0109 objects and its ledger row in one transaction (cancelled requests stay closed; the cancel reason and who cancelled go with the columns). Roll back the API and web first."
  bash "$TC/TEST_DB_SESSION.sh" bash "$TC/TEST_0109_LEDGER.sh" rollback
  exit 0
fi

# ---- the verified backup from H1 ----
BK="${BACKUP:-$( { ls "$WORK"/backup/ogevia_sv_test-pre-0109-*.dump 2>/dev/null | sort | tail -1; } || true)}"
[[ -n "$BK" && -f "$BK" && -f "$BK.sha256" ]] || stop "the verified TEST backup from H1 is missing (the .dump and its .sha256)"
(cd "$(dirname "$BK")" && sha256sum --check --quiet "$(basename "$BK").sha256") || stop "the backup does not match its checksum"
echo "backup verified: $BK"

# ---- drift: the live TEST API is still what H2a captured ----
A cloudformation get-template --stack-name "$STACK" --template-stage Original --query TemplateBody --output json > "$H2A/drift-live.json"
[[ "$(jq -S . "$H2A/drift-live.json" | sha256sum)" == "$(jq -S . "$H2A/live-api.template.json" | sha256sum)" ]] || stop "the live TEST API template changed since H2a was captured; redo H2a"
[[ "$(A lambda get-function-configuration --function-name "$FN" --query CodeSha256 --output text)" == "$(jq -r .CodeSha256 "$H2A/test-lambda.json")" ]] || stop "the live Handler code changed since H2a was captured; redo H2a"
echo "no drift since H2a"

confirm "DEPLOY-TEST" "ABOUT TO CHANGE TEST ONLY (owner authorization $OGEVIA_DEPLOY_APPROVAL): apply migration 0109 to ogevia_sv_test, deploy the Handler code of $COMMIT to $STACK (switch OFF), publish the web to the TEST site. Production is not touched."

# ---- 3 build and check the API assembly (no change to anything) ----
echo; echo "=== API assembly (switch OFF), checked before anything is changed ==="
MASTER_ARN="$(cat "$H2A/candidate-master-arn.txt")"; QR_SPEC="$(cat "$H2A/qr-parameter-spec.json")"; TAGS="$(cat "$H2A/handler-tags.json")"
OUTDIR="$H2A/deploy-off"; rm -rf "$OUTDIR"
(cd "$REPO" && pnpm --dir infra/aws exec cdk synth '*' --quiet --lookups=false -c env=prod -c mode=deploy -c liveTestBaseline=0102 \
  -c "liveQrParameterSpec=$QR_SPEC" -c "liveTestHandlerTags=$TAGS" -c testDatabase=isolated -c "testMasterSecretArn=$MASTER_ARN" --output "$OUTDIR") || stop "synthesis failed. Nothing was changed."
CAND="$OUTDIR/$STACK.template.json"; [[ -f "$CAND" ]] || stop "the deploy assembly was not produced"
python3 - "$CAND" "$H2A/candidate-off/$STACK.template.json" <<'PY' || stop "the deploy assembly is not the one H2a compared"
import json, sys
def body(p):
    t = json.load(open(p)); return t.get("TemplateBody", t)
dep, plan = body(sys.argv[1]), body(sys.argv[2])
routes = lambda t: sum(1 for r in t["Resources"].values() if r.get("Type") == "AWS::ApiGatewayV2::Route")
key = lambda t: t["Resources"]["Handler886CB40B"]["Properties"]["Code"]["S3Key"]
assert routes(dep) == 259, "route count %d" % routes(dep)
assert key(dep) == key(plan), "Handler asset differs from the H2a candidate"
print("deploy assembly: 259 routes; Handler asset", key(dep)[:16] + "...", "(same as H2a)")
PY
python3 "$TC/diff_gate_0109.py" --live "$H2A/drift-live.json" --new "$CAND" --expect off || stop "the expected-only gate failed on the deploy assembly. Nothing was changed."
# ---- 4 migration (the first change) ----
echo; echo "=== migration 0109 (TEST database) ==="
OGEVIA_TEST_BACKUP="$BK" bash "$TC/TEST_DB_SESSION.sh" bash "$TC/TEST_0109_LEDGER.sh" apply || stop "migration 0109 failed; it ran in one transaction, so the database is unchanged. Nothing else was deployed."
bash "$TC/TEST_DB_SESSION.sh" bash "$TC/TEST_0109_LEDGER.sh" verify || stop "the 0109 post-state does not match. Nothing else was deployed. Decide on rollback-db with me."

# ---- 5 API deploy ----
echo; echo "=== API deploy (switch OFF) ==="
(cd "$REPO" && pnpm --dir infra/aws exec cdk deploy --app "$OUTDIR" --exclusively "$STACK" --require-approval broadening --no-notices) || stop "cdk deploy failed or was declined. The database has 0109 (harmless). Send the output; decide on rollback with me."
st="$(A cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text)"; echo "$STACK: $st"; [[ "$st" == UPDATE_COMPLETE ]] || stop "stack status is $st"
A lambda wait function-updated --function-name "$FN"
A lambda get-function-configuration --function-name "$FN" --query '{CodeSha256:CodeSha256,Database:{host:Environment.Variables.DB_HOST,name:Environment.Variables.DB_NAME,secretArn:Environment.Variables.DB_SECRET_ARN}}' --output json > "$H2A/lambda-after.json"
[[ "$(jq -S .Database "$H2A/lambda-after.json")" == "$(jq -S .Database "$H2A/test-lambda.json")" ]] && echo "PASS Handler still targets ogevia_sv_test, same host and secret" || stop "the Handler database settings changed"
[[ "$(jq -r .CodeSha256 "$H2A/lambda-after.json")" != "$(jq -r .CodeSha256 "$H2A/test-lambda.json")" ]] && echo "PASS the Handler code changed" || stop "the Handler code did not change"
A cloudformation get-template --stack-name "$STACK" --template-stage Original --query TemplateBody --output json > "$H2A/after-live.json"
python3 "$TC/diff_gate_0109.py" --live "$H2A/after-live.json" --new "$CAND" --expect post || stop "the deployed stack differs from the assembly"
API_URL="$(A cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)"
[[ "$API_URL" == https://* ]] || stop "no API URL"
c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$API_URL/v1/me")"; echo "GET /v1/me without a token: $c"; [[ "$c" == 401 ]] || stop "expected 401"
for r in /v1/care-notifications/read /v1/documents/00000000-0000-4000-8000-000000000000/cancel /v1/document-types/00000000-0000-4000-8000-000000000000/retire; do
  c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST -H 'content-type: application/json' -d '{}' "$API_URL$r")"; echo "POST $r (switch OFF): $c"; [[ "$c" == 404 ]] || stop "expected 404 while the switch is off"
done
echo "API OK: new Handler code live, 259 routes, switch OFF"

# ---- 6 web ----
echo; echo "=== web ==="
(cd "$REPO" && VITE_APP_VERSION="$COMMIT" bash infra/aws/scripts/deploy-test-slice.sh web) || stop "the web publish failed. The API is deployed; run rollback-web, then send the output."
echo "waiting 60 s for CloudFront..."; sleep "${OGEVIA_CF_WAIT:-60}"
SITE="$(A cloudformation describe-stacks --stack-name Ogevia-prod-WebHosting --query "Stacks[0].Outputs[?OutputKey=='WebOrigin'].OutputValue" --output text)"
DIST="$REPO/apps/web/dist-aws"; [[ -f "$DIST/index.html" ]] || stop "no local web build"
bad=0; ok() { echo "PASS $*"; }; nope() { echo "FAIL $*"; bad=1; }
IDXF="$(mktemp)"; curl -fsS --max-time 60 -o "$IDXF" "$SITE/index.html" || stop "cannot fetch $SITE/index.html"
[[ "$(sha256sum "$IDXF" | cut -d' ' -f1)" == "$(sha256sum "$DIST/index.html" | cut -d' ' -f1)" ]] && ok "the served index.html is the one just built" || nope "the served index.html differs (CloudFront lag: wait a minute and rerun the checks only)"
ASSET="$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' "$IDXF" | head -1)"; rm -f "$IDXF"; [[ -n "$ASSET" ]] || stop "index.html references no main script"
JS="$(curl -fsS --max-time 60 "$SITE/$ASSET")" || stop "cannot fetch the main script"
[[ "$(grep -o 'VITE_APP_VERSION:"[^"]*"' <<<"$JS" | head -1)" == "VITE_APP_VERSION:\"$COMMIT\"" ]] && ok "the bundle carries commit $COMMIT" || nope "the bundle version is not $COMMIT"
grep -q 'VITE_APP_ENV:"test"' <<<"$JS" && ok 'built for TEST' || nope "the bundle is not built for TEST"
if [[ -f "$H2A/web-before/config.json" ]]; then
  [[ "$(curl -fsS --max-time 60 "$SITE/config.json" | sha256sum | cut -d' ' -f1)" == "$(sha256sum "$H2A/web-before/config.json" | cut -d' ' -f1)" ]] && ok "config.json unchanged" || nope "config.json differs from the capture"
fi
[[ "$bad" == 0 ]] || stop "a web check failed (see rollback-web)"
echo
echo "H2b COMPLETE (TEST): migration 0109 applied (ledger 108/0109), new Handler code live with the switch OFF (259 routes), web serves $COMMIT."
echo "Production was not touched. Rollback reference kept in $H2A. Next: the go-live smoke checks on $SITE, then H2c (switch ON)."
