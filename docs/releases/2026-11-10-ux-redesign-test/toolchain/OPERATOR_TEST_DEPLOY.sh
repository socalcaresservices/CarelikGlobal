#!/usr/bin/env bash
# Phase C DEPLOYMENT script for the UX redesign release, TEST only (cdk diff, API deploy, web publish). Derived from STELLA_PHASE_C_DEPLOY.sh (2026-11-01). DRAFT. NOT RUN. NOT AUTHORIZED.
# Operator: whoever the owner names in the written Phase C statement. Deploys ONLY Ogevia-prod-ServiceVerificationApi and the TEST web site; never an Ogevia-prd-* stack,
# never NetworkEgress/WebHosting/EvidenceStorage/Observability, never the database (that is OPERATOR_TEST_DB.sh). Expected API change: exactly 5 new routes and the Handler code asset (diff_gate_ux.py).
#   export OGEVIA_WINDOW_START="YYYY-MM-DD HH:MM:SS" OGEVIA_WINDOW_END="YYYY-MM-DD HH:MM:SS"   (UTC, from the owner's statement; no default)
#   REPO=<checkout at the pinned SHA, deps installed> OGEVIA_DEPLOY_APPROVAL=<the owner's GO reference> bash OPERATOR_TEST_DEPLOY.sh <mode>
#   selftest     local only: assembly and gate checks (no AWS)
#   synth        build the CloudFormation assembly in /tmp (no AWS change) and check it against the pinned asset keys and 255 routes
#   capture      READ-ONLY baseline and rollback material (live API template, Lambda config and code ref, web bucket copy)
#   check        READ-ONLY: expected-only gate (live API template vs assembly) + the cdk diff text
#   deploy-api   [window only] re-checks, asks you to type DEPLOY-Ogevia-prod-ServiceVerificationApi, deploys that one stack, then post-api
#   post-api     READ-ONLY checks after the deployment (including 401 without a token on each of the 5 new routes)
#   web          [window only] build for TEST, upload (no delete), invalidate CloudFront, then web-verify
#   web-verify   READ-ONLY: what the TEST site serves (must carry the pinned commit)
#   rollback-web / rollback-api   only after a stop condition; allowed after the window to restore known-good
set +x +H
umask 077
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER="" CDK_DISABLE_CLI_TELEMETRY=true
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-}"
SHA=7f9483d39690ae94db2710465d6995cd0b82b271
ACCOUNT=300094796789; API=Ogevia-prod-ServiceVerificationApi; WEBSTACK=Ogevia-prod-WebHosting
ASSEMBLY="${ASSEMBLY:-/tmp/ogevia-cdk-ux.out}"; B="${OGEVIA_BEFORE:-$HOME/ogevia-before-ux}"
EXPECT_HANDLER_KEY=af1a87696ace52f31d40afa75121de98e893c1ae18124cde10a1f480973707bb.zip
EXPECT_IDENTITY_KEY=7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759.zip
EXPECT_ROUTES=255
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
    for p in /v1/me /v1/signin-overrides /v1/staff/duplicates; do c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$API_URL$p"); echo "GET $p without a token: $c"; [[ "$c" == 401 ]] || stop "expected 401 for $p"; done
    for p in /v1/imports/people /v1/staff/$Z/merge /v1/caregivers/$Z/signin-override; do c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST -H 'content-type: application/json' -d '{}' "$API_URL$p"); echo "POST $p without a token: $c"; [[ "$c" == 401 ]] || stop "expected 401 for $p"; done
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
