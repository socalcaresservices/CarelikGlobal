#!/usr/bin/env bash
# PRODUCTION deployment script for the release of 0086-0088: the API stack Ogevia-prd-ServiceVerificationApi and the production web site. DRAFT. NOT APPROVED. NOT RUN.
# Operator: Stella Okereke only. Authority: the owner's written GO for ONE commit and ONE window, named in the pins below, and the owner's approval of each YELLOW step.
# Every mode except selftest refuses to run while a pin placeholder remains (fill_pins_prd.py fills them from the owner's GO). Derived from the pilot script STELLA_PHASE_C_DEPLOY.sh
# (which ran on TEST on 2026-11-01); the differences are listed in PRD_DEPLOYMENT_DESIGN.md section 11.
# Deploys ONLY Ogevia-prd-ServiceVerificationApi and the production web site. Never the database (that is STELLA_PRD_DB.sh), never Ogevia-prd-Auth / DatabaseSecret / EvidenceStorage /
# Observability / WebHosting content, never the shared Ogevia-prod-NetworkEgress, never anything of TEST (Ogevia-prod-*).
#   REPO=<checkout at the pinned SHA, deps installed> OGEVIA_DEPLOY_APPROVAL=<the GO reference> bash STELLA_PRD_DEPLOY.sh <mode>
#   selftest     local only: window math, the production gate against the synthesized assembly (when present), the repo pin check (when REPO is set); no AWS
#   synth        build the production CloudFormation assembly (cdk synth, no AWS change) and check it
#   capture      READ-ONLY: the baseline and rollback material, and the DRIFT CHECK against the recorded production baseline (OGEVIA_PRD_BASELINE, default ~/ogevia-prd-baseline-20261101 as recorded in docs/aws/PRODUCTION_BASELINE_2026-11-01.md)
#   check        READ-ONLY: expected-only gate (live API template vs the assembly) + the cdk diff text
#   deploy-api   [window only] requires the database marker written by STELLA_PRD_DB.sh migrate; re-checks; asks you to type DEPLOY-PRD-Ogevia-prd-ServiceVerificationApi; deploys that one stack; then post-api
#   post-api     READ-ONLY checks after the deployment
#   web          [window only] build for production, upload (no delete), invalidate CloudFront (through infra/aws/scripts/deploy-production.sh web), then web-verify
#   web-verify   READ-ONLY: what the production site serves
#   smoke        READ-ONLY: infra/aws/scripts/deploy-production.sh smoke
#   rollback-web / rollback-api   only after a stop condition
set +x +H
umask 077
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER="" CDK_DISABLE_CLI_TELEMETRY=true
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-}"
ACCOUNT=300094796789; API=Ogevia-prd-ServiceVerificationApi; WEBSTACK=Ogevia-prd-WebHosting
PRD_STACKS="Ogevia-prd-Auth Ogevia-prd-DatabaseSecret Ogevia-prd-EvidenceStorage Ogevia-prd-Observability Ogevia-prd-ServiceVerificationApi Ogevia-prd-WebHosting"
BASELINE_STACKS="Ogevia-prd-Auth Ogevia-prd-DatabaseSecret Ogevia-prd-EvidenceStorage Ogevia-prd-Observability Ogevia-prd-ServiceVerificationApi Ogevia-prd-WebHosting Ogevia-prod-NetworkEgress"
ASSEMBLY="${ASSEMBLY:-/tmp/ogevia-cdk-prd-0088.out}"; B="${OGEVIA_PRD_BEFORE_0088:-$HOME/prd0088-before}"
BASE="${OGEVIA_PRD_BASELINE:-$HOME/ogevia-prd-baseline-20261101}"      # the recorded production baseline (docs/aws/PRODUCTION_BASELINE_2026-11-01.md)
MARKER="$HOME/.prd0088/db-at-0088.ok"                                  # written only by STELLA_PRD_DB.sh migrate after every check passed
EXPECT_ROUTES=250; BASE_ROUTES=228
ALLOW_CORS_ADD="https://admin.ogevia.com"      # the ONE non-release difference the dry run of 2026-11-01 found in production's API stack: the template lacks admin.ogevia.com (the live API already allows it) and the build before the dedupe fix listed app.ogevia.com twice (API Gateway rejected it on 2026-11-01); the owner decides whether to accept it (PHASE_E_PACKAGE.md)                                      # 228 recorded in production on 2026-11-01; 22 added by the release
# ---- pins: placeholders until the owner's GO (fill_pins_prd.py; the two asset keys come from the synthesized assembly) ----
SHA=fb8b7aa4eb73c0cfe4dd6f718930ea54e318cfd7                                                              # the one approved release commit
APPROVAL_REF=GO-PRD-0088-R2-20261101                                                  # the owner's approval reference
WIN_START_TXT="2026-11-01 19:30:00"; WIN_END_TXT="2026-11-01 22:30:00"         # UTC, "YYYY-MM-DD HH:MM:SS"
EXPECT_HANDLER_KEY=9e5a510ef7771fe0f70bb0db1a6b22bf2dbe313ab8f019c0c34ccd42686824b7.zip
EXPECT_IDENTITY_KEY=7c5f8eb676c93261fd7a80f34d40ba70379c040d94bb2e9bd80f2d007ebc9759.zip
WIN_START=$(date -u -d "$WIN_START_TXT" +%s 2>/dev/null); WIN_END=$(date -u -d "$WIN_END_TXT" +%s 2>/dev/null)
A() { timeout --foreground -k 5 "${OGEVIA_AWS_TIMEOUT:-120}" aws "$@"; }
stop() { echo "STOP: $*"; exit 2; }
in_window() { local n; n=$(date -u +%s); [[ -n "$WIN_START" && -n "$WIN_END" && "$n" -ge "$WIN_START" && "$n" -lt "$WIN_END" ]]; }
need_window() { in_window || stop "outside the authorized window ($WIN_START_TXT to $WIN_END_TXT UTC). No new deployment activity may begin."; STARTED=1; }
confirm() { local got; echo; echo "$2"; printf 'Type exactly  %s  to continue: ' "$1" > /dev/tty; read -r got < /dev/tty; [[ "$got" == "$1" ]] || stop "confirmation not given. Nothing was changed by this step."; }
left_placeholders() { local pat='__[A-Z0-9_]{3,}'; pat+='__'; grep -o -E "$pat" "${BASH_SOURCE[0]}" | sort -u | tr '\n' ' '; }
trap 'if [[ "${STARTED:-0}" == 1 && "$MODE" =~ ^(deploy-api|web)$ ]] && ! in_window; then echo "NOTE: this step finished after the window end. It was allowed to complete; start NO further step; report. Rollback to known-good only."; fi; echo "END (UTC): $(date -u +%FT%TZ)  mode=$MODE"' EXIT

check_repo() {
  [[ -n "${REPO:-}" && -d "$REPO/infra/aws" ]] || stop "set REPO to the checkout at $SHA with dependencies installed"
  [[ "$(git -C "$REPO" rev-parse HEAD 2>/dev/null)" == "$SHA" ]] || stop "REPO HEAD is not $SHA (the only approved commit)"
  [[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop "REPO has local changes"
  [[ -x "$REPO/infra/aws/node_modules/.bin/cdk" ]] || stop "dependencies are not installed in REPO (pnpm install --frozen-lockfile)"
}
need_approval() { [[ "${OGEVIA_DEPLOY_APPROVAL:-}" == "$APPROVAL_REF" ]] || stop "set OGEVIA_DEPLOY_APPROVAL=$APPROVAL_REF (the GO reference)"; }
aws_ok() { [[ "$(A sts get-caller-identity --query Account --output text 2>/dev/null)" == "$ACCOUNT" ]] || stop "no valid AWS credentials for account $ACCOUNT"; }
out() { A cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
need_marker() {   # the database must have been migrated by STELLA_PRD_DB.sh migrate, for THIS release, recently
  [[ -f "$MARKER" ]] || stop "the database marker $MARKER is missing: STELLA_PRD_DB.sh migrate has not completed every check. The API must not be deployed before the database."
  local v l snap ts msha t; IFS='|' read -r v l snap ts msha < "$MARKER"
  [[ "$v" == 88 && "$l" == 0088 && "$msha" == "$SHA" ]] || stop "the database marker is not for this release (found '$v|$l|...|$msha')"
  t=$(date -u -d "$ts" +%s 2>/dev/null) || stop "the marker time cannot be read"
  [[ $(( $(date -u +%s) - t )) -lt 43200 ]] || stop "the database marker is older than 12 hours: run STELLA_PRD_DB.sh final and rewrite it deliberately"
  echo "database marker ok: 88|0088 for $SHA, snapshot $snap, written $ts"
}

assembly_ok() {   # no AWS: is the synthesized assembly the release?
  python3 -I - "$ASSEMBLY" "$EXPECT_HANDLER_KEY" "$EXPECT_IDENTITY_KEY" "$EXPECT_ROUTES" "$PRD_STACKS" <<'PY' || return 1
import json, os, sys
d, hk, ik, nroutes, stacks = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sorted(sys.argv[5].split())
names = sorted(f[:-len(".template.json")] for f in os.listdir(d) if f.endswith(".template.json"))
ok = True
def chk(c, m):
    global ok; print(("PASS " if c else "FAIL ") + m); ok = ok and c
chk(names == stacks, "exactly the six Ogevia-prd-* stacks and no Ogevia-prod-*: %s" % names)
t = json.load(open(os.path.join(d, "Ogevia-prd-ServiceVerificationApi.template.json")))["Resources"]
fn = {k: v for k, v in t.items() if v["Type"] == "AWS::Lambda::Function"}
h = [v["Properties"]["Code"]["S3Key"] for k, v in fn.items() if k.startswith("Handler")]
i = [v["Properties"]["Code"]["S3Key"] for k, v in fn.items() if k.startswith("IdentityHandler")]
chk(h == [hk], "Handler code asset %s" % (h[0][:16] + "..." if h else "none"))
chk(i == [ik], "IdentityHandler code asset %s" % (i[0][:16] + "..." if i else "none"))
env = [v["Properties"].get("Environment", {}).get("Variables", {}) for k, v in fn.items() if k.startswith("Handler")]
chk(len(env) == 1 and env[0].get("DB_NAME") == "ogevia_prd" and env[0].get("OGEVIA_ENV") == "prd", "the Handler is configured for ogevia_prd with OGEVIA_ENV=prd")
chk(sum(1 for v in t.values() if v["Type"] == "AWS::ApiGatewayV2::Route") == nroutes, "%d API routes" % nroutes)
print("PASS all checks" if ok else "FAIL")
sys.exit(0 if ok else 1)
PY
}

if [[ "$MODE" == selftest ]]; then
  echo "selftest (local only)"; command -v python3 jq >/dev/null || stop "python3 and jq are needed"
  L="$(left_placeholders)"; if [[ -n "$L" ]]; then echo "placeholders still present (expected until the owner's GO): $L"; else echo "no placeholders remain"; fi
  [[ -f "$HERE/diff_gate_prd0088.py" ]] || stop "diff_gate_prd0088.py is missing next to this script"
  if [[ -n "$WIN_START" && -n "$WIN_END" ]]; then [[ "$WIN_END" -gt "$WIN_START" ]] && echo "window math ok: $WIN_START_TXT to $WIN_END_TXT UTC" || stop "the window end is not after the start"; else echo "window not filled in (expected before the GO)"; fi
  if [[ -f "$ASSEMBLY/$API.template.json" ]]; then
    if [[ -z "$L" ]]; then assembly_ok || stop "the assembly check failed"; else echo "assembly present, but the asset-key pins are not filled in: the assembly check is skipped"; fi
    python3 -I -B "$HERE/diff_gate_prd0088.py" --live "$ASSEMBLY/$API.template.json" --new "$ASSEMBLY/$API.template.json" --expect post || stop "gate self-compare failed"
  else echo "no assembly at $ASSEMBLY: run the synth mode (or cdk synth) first to include the assembly and gate checks"; fi
  if [[ -n "${REPO:-}" ]]; then if [[ -z "$L" ]]; then check_repo; echo "REPO ok: $SHA"; else echo "REPO given but placeholders remain: the repo check is skipped"; fi; else echo "REPO not set: repo check skipped"; fi
  echo "selftest done"; exit 0
fi
case "$MODE" in synth|capture|check|deploy-api|post-api|web|web-verify|smoke|rollback-web|rollback-api) ;; *) stop "usage: selftest | synth | capture | check | deploy-api | post-api | web | web-verify | smoke | rollback-web | rollback-api";; esac
# FIRST, before any tool check or AWS call: a draft script cannot touch AWS.
P="$(left_placeholders)"; [[ -z "$P" ]] || stop "placeholders remain ($P): the owner's GO has not been filled in. Only 'selftest' may run. Nothing was touched."
case "$MODE" in deploy-api|web) need_window;; esac
for c in aws jq curl python3 node; do command -v "$c" >/dev/null 2>&1 || stop "missing tool: $c"; done
check_repo

if [[ "$MODE" == synth ]]; then
  need_approval
  rm -rf "$ASSEMBLY"
  ( cd "$REPO/infra/aws" && PATH="$PWD/node_modules/.bin:$PATH" OGEVIA_DEPLOY_APPROVAL="$APPROVAL_REF" npx --no-install cdk synth --quiet --no-notices -c env=prd -c mode=deploy -o "$ASSEMBLY" ) || stop "synthesis failed"
  assembly_ok || stop "the assembly is not the release: do not deploy (a different asset key means different inputs)"
  exit 0
fi

aws_ok
[[ -f "$ASSEMBLY/$API.template.json" ]] || [[ "$MODE" == capture || "$MODE" == web* || "$MODE" == rollback-* || "$MODE" == post-api || "$MODE" == smoke ]] || stop "no assembly at $ASSEMBLY: run the synth mode first"

prd_env_guard() {   # the Lambda of the production API stack must serve ogevia_prd with OGEVIA_ENV=prd
  local fn cfg dbn envn
  fn=$(A cloudformation list-stack-resources --stack-name $API --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function' && starts_with(LogicalResourceId,'Handler')].PhysicalResourceId" --output text)
  [[ -n "$fn" && "$fn" != None ]] || stop "the handler function was not found in $API"
  cfg=$(A lambda get-function-configuration --function-name "$fn" --output json) || stop "cannot read the Lambda configuration"
  dbn=$(jq -r '.Environment.Variables.DB_NAME // empty' <<<"$cfg"); envn=$(jq -r '.Environment.Variables.OGEVIA_ENV // empty' <<<"$cfg")
  [[ "$dbn" == ogevia_prd && "$envn" == prd ]] || stop "the Lambda serves '$dbn' (OGEVIA_ENV='$envn'): this is not production"
  HANDLER_FN="$fn"; LAMBDA_CFG="$cfg"
}

if [[ "$MODE" == capture ]]; then
  mkdir -p "$B/live" || stop "cannot create $B"; chmod 700 "$B"; [[ "$(df --output=avail -k "$HOME" | tail -1)" -gt 150000 ]] || stop "less than 150 MB free in $HOME (the web capture needs room)"
  [[ -d "$BASE/live" && -f "$BASE/lambda-config-before.json" && -f "$BASE/web-before.sha256" && -f "$BASE/routes-before.json" ]] || stop "the recorded production baseline is not at $BASE (set OGEVIA_PRD_BASELINE): the drift check cannot run"
  bad=0; ok() { echo "PASS $*"; }; nope() { echo "FAIL $*"; bad=1; }
  echo "== drift check against the recorded baseline ($BASE)"
  for S in $BASELINE_STACKS; do
    st=$(A cloudformation describe-stacks --stack-name "$S" --query 'Stacks[0].StackStatus' --output text) || stop "cannot read $S"
    [[ "$st" == UPDATE_COMPLETE || "$st" == CREATE_COMPLETE || ( "$S" == "$API" && "$st" == UPDATE_ROLLBACK_COMPLETE ) ]] || { nope "$S is $st, not settled"; continue; }   # UPDATE_ROLLBACK_COMPLETE of the API stack is settled (CloudFormation allows the next update); its template must still equal the baseline below
    A cloudformation get-template --stack-name "$S" --template-stage Original --query TemplateBody --output json > "$B/live/$S.json" && jq -e 'has("Resources")' "$B/live/$S.json" >/dev/null || stop "cannot read the live template of $S"
    [[ -f "$BASE/live/$S.json" ]] || { nope "$S: no baseline file"; continue; }
    if [[ "$(jq -S . "$B/live/$S.json" | sha256sum)" == "$(jq -S '.TemplateBody // .' "$BASE/live/$S.json" | sha256sum)" ]]; then ok "$S equals the recorded baseline"; else nope "$S CHANGED since the recorded baseline"; fi
  done
  API_URL=$(out $API ApiUrl); WEB_URL=$(out $WEBSTACK WebOrigin); BUCKET=$(out $WEBSTACK SiteBucketName); DIST=$(out $WEBSTACK DistributionId)
  [[ -n "$API_URL" && -n "$WEB_URL" && -n "$BUCKET" && -n "$DIST" ]] || stop "a stack output is missing"
  printf '%s\n' "$API_URL" > "$B/api-url.txt"; printf '%s\n' "$WEB_URL" > "$B/web-url.txt"
  prd_env_guard; printf '%s\n' "$HANDLER_FN" > "$B/handler-function-name.txt"; printf '%s\n' "$LAMBDA_CFG" > "$B/lambda-config-before.json"
  echo "PRODUCTION confirmed: Lambda serves ogevia_prd with OGEVIA_ENV=prd; CodeSha256 before: $(jq -r .CodeSha256 "$B/lambda-config-before.json")"
  [[ "$(jq -r .CodeSha256 "$B/lambda-config-before.json")" == "$(jq -r .CodeSha256 "$BASE/lambda-config-before.json")" ]] && ok "the API Lambda code equals the baseline" || nope "the API Lambda code CHANGED since the baseline"
  AB=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key|startswith("Handler"))) | .value.Properties.Code.S3Bucket][0] // empty' "$B/live/$API.json")
  AK=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key|startswith("Handler"))) | .value.Properties.Code.S3Key][0] // empty' "$B/live/$API.json")
  printf '%s\n%s\n' "$AB" "$AK" > "$B/previous-api-asset.txt"
  SZ=$(A s3api head-object --bucket "$AB" --key "$AK" --query ContentLength --output text 2>/dev/null); [[ "$SZ" =~ ^[0-9]+$ ]] || stop "the previous API code asset s3://$AB/$AK cannot be read: the API rollback would not work"
  echo "previous API code asset exists: s3://$AB/$AK ($SZ bytes)"
  API_ID=$(sed -E 's#^https://([^.]+)\..*#\1#' <<<"$API_URL"); A apigatewayv2 get-routes --api-id "$API_ID" --query 'Items[].RouteKey' --output json > "$B/routes-before.json" || stop "cannot read the API routes"
  NR=$(jq 'length' "$B/routes-before.json"); echo "routes on the production API: $NR"
  [[ "$NR" == "$BASE_ROUTES" && "$(jq -S 'sort' "$B/routes-before.json" | sha256sum)" == "$(jq -S 'sort' "$BASE/routes-before.json" | sha256sum)" ]] && ok "the route list equals the baseline ($BASE_ROUTES routes)" || nope "the route list CHANGED since the baseline"
  rm -rf "$B/web-before"; A s3 sync "s3://$BUCKET" "$B/web-before" --only-show-errors || stop "web bucket capture failed"
  ( cd "$B/web-before" && find . -type f -print0 | sort -z | xargs -0 sha256sum > ../web-before.sha256 ); echo "web files captured: $(wc -l < "$B/web-before.sha256")"
  [[ "$(sort "$B/web-before.sha256" | sha256sum)" == "$(sort "$BASE/web-before.sha256" | sha256sum)" ]] && ok "the 83 production web files equal the baseline" || nope "the production web files CHANGED since the baseline"
  curl -fsS --max-time 60 "$WEB_URL/index.html" | sha256sum | cut -d' ' -f1 > "$B/web-index-sha256-before.txt"; echo "served index.html sha256: $(cat "$B/web-index-sha256-before.txt")"
  if [[ $bad == 0 ]]; then echo "CAPTURED to $B and no drift from the baseline (keep it until the release is accepted)"; exit 0; else echo "STOP: production differs from the recorded baseline (see FAIL lines). Do not release; capture a new baseline and review the difference first."; exit 2; fi
fi

[[ -f "$B/live/$API.json" ]] || stop "run the capture mode first ($B/live/$API.json is missing)"

gate() {
  local st; st=$(A cloudformation describe-stacks --stack-name $API --query 'Stacks[0].StackStatus' --output text) || stop "cannot read $API"
  [[ "$st" == UPDATE_COMPLETE || "$st" == CREATE_COMPLETE || "$st" == UPDATE_ROLLBACK_COMPLETE ]] || stop "$API is $st, not settled"   # UPDATE_ROLLBACK_COMPLETE: the first attempt of 2026-11-01 was rolled back; the live template is compared with the baseline by capture and by the gate
  prd_env_guard
  A cloudformation get-template --stack-name $API --template-stage Original --query TemplateBody --output json > "$B/gate-live.json" && jq -e 'has("Resources")' "$B/gate-live.json" >/dev/null || stop "cannot read the live template"
  assembly_ok || stop "the assembly is not the release"
  echo "-- cdk diff (read-only; for the human reader)"
  ( cd "$REPO/infra/aws" && timeout --foreground -k 5 300 npx --no-install cdk diff --app "$ASSEMBLY" $API --no-notices 2>&1 | tail -60 )
  echo "-- EXPECTED-ONLY gate (machine check of the live template vs the assembly)"
  python3 -I -B "$HERE/diff_gate_prd0088.py" --live "$B/gate-live.json" --new "$ASSEMBLY/$API.template.json" --expect "${1:-pre}" $([[ "${1:-pre}" == pre ]] && echo --allow-cors-add "$ALLOW_CORS_ADD") || stop "the difference is not exactly the release's allowed change. Do not deploy."
}

case "$MODE" in
  check) gate pre ;;
  deploy-api)
    need_approval; need_marker; gate pre
    confirm "DEPLOY-PRD-$API" "ABOUT TO RUN (YELLOW, PRODUCTION): npx cdk deploy --app $ASSEMBLY --exclusively $API --require-approval broadening --no-notices. CDK should NOT ask for an IAM approval; if it does, answer n and stop."
    ( cd "$REPO/infra/aws" && npx --no-install cdk deploy --app "$ASSEMBLY" --exclusively "$API" --require-approval broadening --no-notices ) || stop "cdk deploy failed or was declined. Decide on rollback only on a stop condition."
    bash "$0" post-api ;;
  post-api)
    FN=$(cat "$B/handler-function-name.txt"); API_URL=$(cat "$B/api-url.txt"); API_ID=$(sed -E 's#^https://([^.]+)\..*#\1#' <<<"$API_URL")
    st=$(A cloudformation describe-stacks --stack-name $API --query 'Stacks[0].StackStatus' --output text); echo "$API: $st"; [[ "$st" == UPDATE_COMPLETE ]] || stop "stack status is $st"
    A lambda wait function-updated --function-name "$FN" || stop "Lambda did not settle"
    A lambda get-function-configuration --function-name "$FN" --output json > "$B/lambda-config-after.json"
    [[ "$(jq -S .Environment.Variables "$B/lambda-config-before.json")" == "$(jq -S .Environment.Variables "$B/lambda-config-after.json")" ]] && echo "PASS Lambda environment unchanged" || stop "the Lambda environment changed"
    [[ "$(jq -r .CodeSha256 "$B/lambda-config-before.json")" != "$(jq -r .CodeSha256 "$B/lambda-config-after.json")" ]] && echo "PASS new CodeSha256 $(jq -r .CodeSha256 "$B/lambda-config-after.json")" || stop "CodeSha256 did not change"
    A cloudformation get-template --stack-name $API --template-stage Original --query TemplateBody --output json > "$B/gate-live-after.json"
    python3 -I -B "$HERE/diff_gate_prd0088.py" --live "$B/gate-live-after.json" --new "$ASSEMBLY/$API.template.json" --expect post || stop "the deployed stack differs from the assembly"
    A apigatewayv2 get-routes --api-id "$API_ID" --query 'Items[].RouteKey' --output json > "$B/routes-after.json" || stop "cannot read the API routes"
    NA=$(jq 'length' "$B/routes-after.json"); ADDED=$(comm -13 <(jq -r '.[]' "$B/routes-before.json" | sort) <(jq -r '.[]' "$B/routes-after.json" | sort) | wc -l); REMOVED=$(comm -23 <(jq -r '.[]' "$B/routes-before.json" | sort) <(jq -r '.[]' "$B/routes-after.json" | sort) | wc -l)
    echo "routes: $NA now; $ADDED added, $REMOVED removed"; [[ "$NA" == "$EXPECT_ROUTES" && "$ADDED" == $((EXPECT_ROUTES - BASE_ROUTES)) && "$REMOVED" == 0 ]] || stop "expected $EXPECT_ROUTES routes, $((EXPECT_ROUTES - BASE_ROUTES)) added and none removed"
    for p in /v1/me /v1/compliance/settings /v1/staff /v1/role-permissions; do c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$API_URL$p"); echo "GET $p without a token: $c"; [[ "$c" == 401 ]] || stop "expected 401 for $p"; done
    echo "POST-API OK" ;;
  web)
    need_approval; WEB_URL=$(cat "$B/web-url.txt"); need_marker
    confirm "PUBLISH-WEB-PRD" "ABOUT TO RUN (YELLOW, PRODUCTION): infra/aws/scripts/deploy-production.sh web at commit $SHA (build for production, upload without delete, invalidate CloudFront) to $WEB_URL. The API must already be deployed and post-api must have passed."
    ( cd "$REPO" && VITE_APP_VERSION="$SHA" OGEVIA_DEPLOY_APPROVAL="$APPROVAL_REF" bash infra/aws/scripts/deploy-production.sh web ) || stop "web publish failed"
    echo "waiting 60 s for CloudFront..."; sleep 60; bash "$0" web-verify ;;
  web-verify)
    SITE=$(cat "$B/web-url.txt"); API_HOST=$(sed -E 's#^https://([^/]+).*#\1#' "$B/api-url.txt"); DIST="$REPO/apps/web/dist-aws-prd"; [[ -f "$DIST/index.html" ]] || stop "no local build at $DIST (run the web mode first)"
    bad=0; ok() { echo "PASS $*"; }; nope() { echo "FAIL $*"; bad=1; }
    LOCAL=$(sha256sum "$DIST/index.html" | cut -d' ' -f1); IDXF=$(mktemp) && curl -fsS --max-time 60 -o "$IDXF" "$SITE/index.html" || { rm -f "$IDXF"; stop "cannot fetch $SITE/index.html"; }
    IDX=$(cat "$IDXF"); SERVED=$(sha256sum "$IDXF" | cut -d' ' -f1); rm -f "$IDXF"; echo "index.html sha256: served $SERVED  local $LOCAL"
    [[ "$SERVED" == "$LOCAL" ]] && ok "served index.html is the one just built (raw bytes)" || nope "served index.html differs (CloudFront lag: wait a minute and rerun once)"
    ASSET=$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' <<<"$IDX" | head -1); [[ -n "$ASSET" ]] && ok "main script $ASSET" || stop "index.html references no assets/index-*.js"
    JS=$(curl -fsS --max-time 60 "$SITE/$ASSET") || stop "cannot fetch $SITE/$ASSET"
    [[ "$(grep -o 'VITE_APP_VERSION:"[^"]*"' <<<"$JS" | head -1)" == "VITE_APP_VERSION:\"$SHA\"" ]] && ok "bundle carries the code SHA" || nope "bundle version is not $SHA"
    grep -q 'VITE_APP_ENV:"production"' <<<"$JS" && ok 'built for production (VITE_APP_ENV:"production")' || nope "bundle is not built for production"
    grep -q "${API_HOST%%.*}\.execute-api" <<<"$JS" && ok "the bundle references the production API host ${API_HOST%%.*}" || nope "the bundle does not reference the production API host"
    if [[ -f "$B/web-before/config.json" ]]; then [[ "$(curl -fsS "$SITE/config.json" | sha256sum | cut -d' ' -f1)" == "$(sha256sum "$B/web-before/config.json" | cut -d' ' -f1)" ]] && ok "config.json unchanged" || nope "config.json differs from the capture"; fi
    [[ $bad == 0 ]] && echo "WEB VERIFIED: $SITE serves $SHA" || stop "a web check failed (see rollback-web)" ;;
  smoke)
    need_approval; ( cd "$REPO" && OGEVIA_DEPLOY_APPROVAL="$APPROVAL_REF" bash infra/aws/scripts/deploy-production.sh smoke ) ;;
  rollback-web)
    confirm "ROLLBACK-WEB-PRD" "Restores the captured pre-release web files to the PRODUCTION bucket (never deletes, never touches config.json)."
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
    confirm "ROLLBACK-API-PRD" "Puts the previous Lambda code back (code only; CloudFormation will be out of step with the stack: tell the owner). Web must already be rolled back."
    FN=$(cat "$B/handler-function-name.txt")
    A lambda update-function-code --function-name "$FN" --s3-bucket "$(sed -n 1p "$B/previous-api-asset.txt")" --s3-key "$(sed -n 2p "$B/previous-api-asset.txt")" --query '[LastUpdateStatus,CodeSha256]' --output text || stop "update-function-code failed"
    A lambda wait function-updated --function-name "$FN"
    now=$(A lambda get-function-configuration --function-name "$FN" --query CodeSha256 --output text); before=$(jq -r .CodeSha256 "$B/lambda-config-before.json")
    echo "CodeSha256 now $now  before $before"; [[ "$now" == "$before" ]] && echo "ROLLBACK-API OK (code is the baseline again)" || stop "code is not the baseline" ;;
esac
