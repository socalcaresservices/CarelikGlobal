#!/usr/bin/env bash
# =============================================================================
# TEST release 2026-10-26-redesign: the ONLY way this procedure deploys a stack. `check` (read-only) accepts any of the five Ogevia-prod-* stacks and requires NO difference
# for four of them; `deploy` and `post` accept exactly one stack, Ogevia-prod-ServiceVerificationApi, whose only allowed difference is the one added staff route and the Handler code.
#   bash deploy-guard.sh check  <stack>    READ-ONLY. Fetches the LIVE template of the stack, runs the synthesized assembly check and the EXPECTED-ONLY diff gate
#                                          (diff_gate.py) and shows the read-only `cdk diff`. Exit 0 only if the difference is exactly the release's allowed change
#                                          (API: DELTA; the other four: NONE).
#   bash deploy-guard.sh deploy <stack>    [YELLOW] API stack only. Repeats `check` (it must say DELTA: nothing to deploy is a refusal), asks you to type DEPLOY-<stack>, runs exactly
#                                          npx cdk deploy --app $ASSEMBLY --exclusively <stack> --require-approval broadening --no-notices
#   bash deploy-guard.sh post   <stack>    READ-ONLY checks after the deployment (API stack only: status, Lambda environment unchanged, new CodeSha256, the added route present and
#                                          the route count = before + 1, CORS unchanged, ComplianceSweep still ENABLED).
# Environment: ASSEMBLY (the verified synth output, default /tmp/ogevia-cdk.out), OGEVIA_BEFORE (default ~/ogevia-before), OGEVIA_DEPLOY_APPROVAL (deploy only).
# It never deploys an Ogevia-prd-* stack, never more than one stack, never a glob, never without the gate. Exit: 0 ok; 1 refused/failed; 2 usage.
# =============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-}"; STACK="${2:-}"
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER="" CDK_DISABLE_CLI_TELEMETRY=true
ACCOUNT=300094796789
ALLOWED=(Ogevia-prod-EvidenceStorage Ogevia-prod-NetworkEgress Ogevia-prod-WebHosting Ogevia-prod-ServiceVerificationApi Ogevia-prod-Observability)
DEPLOYABLE=Ogevia-prod-ServiceVerificationApi
ASSEMBLY="${ASSEMBLY:-/tmp/ogevia-cdk.out}"; B="${OGEVIA_BEFORE:-$HOME/ogevia-before}"
A() { timeout --foreground -k 5 "${OGEVIA_AWS_TIMEOUT:-90}" aws "$@"; }
refuse() { echo "REFUSED: $*"; exit 1; }
[[ $# -eq 2 ]] || { echo "usage: bash deploy-guard.sh check|deploy|post <stack>   (exactly one stack: ${ALLOWED[*]})" >&2; exit 2; }
[[ "$MODE" == check || "$MODE" == deploy || "$MODE" == post ]] || { echo "usage: bash deploy-guard.sh check|deploy|post <stack>" >&2; exit 2; }
# the stack argument: exact match against the five-name allow-list. A glob, a list, an Ogevia-prd name or anything else is refused.
ok=0; for s in "${ALLOWED[@]}"; do [[ "$STACK" == "$s" ]] && ok=1; done
[[ $ok == 1 ]] || refuse "'$STACK' is not one of the five TEST stacks this procedure may read (${ALLOWED[*]}). No Ogevia-prd-* stack, no pattern, no list."
[[ "$MODE" == check || "$STACK" == "$DEPLOYABLE" ]] || refuse "only $DEPLOYABLE may be deployed or post-checked by this procedure; '$STACK' can only be checked (it must show no difference)"
# the exact argument vector the deployment would use, validated before it is ever run
DEPLOY_ARGV=(npx cdk deploy --app "$ASSEMBLY" --exclusively "$STACK" --require-approval broadening --no-notices)
deploy_argv_ok() {
  local stacks=0 a prev=""
  for a in "${DEPLOY_ARGV[@]:3}"; do
    case "$a" in -*) ;; *) [[ "$prev" == --app || "$prev" == --require-approval ]] || stacks=$((stacks + 1)) ;; esac
    [[ "$a" == *prd* || "$a" == *\** || "$a" == --all || "$a" == --concurrency* || "$a" == --force || "$a" == --hotswap* || "$a" == --no-rollback ]] && return 1
    prev="$a"
  done
  [[ $stacks -eq 1 && " ${DEPLOY_ARGV[*]} " == *" --exclusively $STACK "* ]]
}
deploy_argv_ok || refuse "the deploy command line failed its own check: ${DEPLOY_ARGV[*]}"
[[ -f "$ASSEMBLY/$STACK.template.json" ]] || refuse "no synthesized template $ASSEMBLY/$STACK.template.json (run the synthesis step first)"
ID=$(A sts get-caller-identity --output json 2>/dev/null) || refuse "no valid AWS credentials"
[[ "$(jq -r .Account <<<"$ID")" == "$ACCOUNT" ]] || refuse "wrong AWS account"
status() { A cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>/dev/null; }

gate() {
  local st live="$B/gate-live-$STACK.json"
  mkdir -p "$B" || refuse "cannot create $B"
  st=$(status) || refuse "cannot read stack $STACK"
  [[ "$st" == UPDATE_COMPLETE || "$st" == CREATE_COMPLETE ]] || refuse "$STACK is $st, not settled"
  echo "$STACK: $st"
  A cloudformation get-template --stack-name "$STACK" --template-stage Original --query TemplateBody --output json > "$live" 2>/dev/null && jq -e 'has("Resources")' "$live" >/dev/null || refuse "cannot read the live template of $STACK"
  python3 -I -B "$HERE/assembly_check.py" --assembly "$ASSEMBLY" || refuse "the synthesized assembly is not the approved release"
  echo "-- cdk diff (read-only; for the human reader)"
  (cd "$HERE/../../../../infra/aws" && timeout --foreground -k 5 300 npx --no-install cdk diff --app "$ASSEMBLY" "$STACK" --no-notices 2>&1 | tail -60)
  echo "-- EXPECTED-ONLY gate (machine check of live template vs synthesized template)"
  GATE_OUT=$(python3 -I -B "$HERE/diff_gate.py" template --stack "$STACK" --live "$live" --new "$ASSEMBLY/$STACK.template.json"); GRC=$?
  printf '%s\n' "$GATE_OUT"
  [[ $GRC == 0 ]] || refuse "the difference is NOT the release's expected change. STOP and report; nothing was deployed."
  GATE_RESULT=$(grep -o 'EXPECTED-ONLY: YES ([A-Z]*)' <<<"$GATE_OUT" | grep -o '(.*)' | tr -d '()')
}

case "$MODE" in
  check) gate; echo "CHECK PASSED for $STACK ($GATE_RESULT): the difference is exactly the expected change. Nothing was deployed." ;;
  deploy)
    [[ "${OGEVIA_DEPLOY_APPROVAL:-}" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || refuse "set OGEVIA_DEPLOY_APPROVAL to the owner's approval reference"
    gate
    [[ "$GATE_RESULT" == DELTA ]] || refuse "the gate result for $STACK is '$GATE_RESULT', not DELTA: there is nothing to deploy (or it is not this release). Nothing was deployed."
    echo; echo "ABOUT TO RUN (YELLOW): ${DEPLOY_ARGV[*]}"
    read -r -p "Type DEPLOY-$STACK to deploy this one stack (anything else stops, nothing deployed): " ans
    [[ "$ans" == "DEPLOY-$STACK" ]] || { echo "Declined. Nothing was deployed."; exit 0; }
    cd "$HERE/../../../../infra/aws" && "${DEPLOY_ARGV[@]}"; RC=$?
    [[ $RC == 0 ]] || { echo "STOP: cdk deploy exited $RC. Read the message; see Recovery in the procedure. Do not deploy the next stack."; exit 1; }
    echo "deploy command finished; now run: bash deploy-guard.sh post $STACK" ;;
  post)
    bad=0; okk() { echo "PASS $*"; }; nope() { echo "FAIL $*"; bad=1; }
    st=$(status); [[ "$st" == UPDATE_COMPLETE ]] && okk "$STACK is UPDATE_COMPLETE" || nope "$STACK is '$st', not UPDATE_COMPLETE"
    FN=$(cat "$B/handler-function-name.txt" 2>/dev/null)
    A lambda get-function-configuration --function-name "$FN" --output json > "$B/lambda-config-after.json" 2>/dev/null || nope "cannot read the Lambda configuration"
    if diff <(jq -S .Environment "$B/lambda-config-before.json") <(jq -S .Environment "$B/lambda-config-after.json") >/dev/null 2>&1; then okk "Lambda environment unchanged"; else nope "Lambda environment CHANGED"; fi
    NEW=$(jq -r .CodeSha256 "$B/lambda-config-after.json"); OLD=$(jq -r .CodeSha256 "$B/lambda-config-before.json")
    echo "Lambda CodeSha256: before $OLD  after $NEW"
    [[ -n "$NEW" && "$NEW" != null && "$NEW" != "$OLD" ]] && okk "the Lambda code changed" || nope "the Lambda CodeSha256 did not change"
    [[ "$(jq -r .LastUpdateStatus "$B/lambda-config-after.json")" == Successful ]] && okk "LastUpdateStatus Successful" || nope "Lambda LastUpdateStatus is not Successful"
    API_ID=$(cat "$B/api-id.txt" 2>/dev/null)
    ROUTES_AFTER=$(A apigatewayv2 get-routes --api-id "$API_ID" --max-items 1000 --query 'Items[].RouteKey' --output json 2>/dev/null) || ROUTES_AFTER='[]'
    NB=$(jq 'length' "$B/routes-before.json" 2>/dev/null || echo -1); NA=$(jq 'length' <<<"$ROUTES_AFTER")
    echo "API routes: before $NB  after $NA"
    [[ "$NB" -ge 0 && "$NA" == "$((NB + 1))" ]] && okk "the API gained exactly 1 route" || nope "the route count is $NA, not $NB + 1"
    MISSING=$(jq -r --slurpfile k "$HERE/new-route-keys.json" '$k[0] - . | .[]' <<<"$ROUTES_AFTER" 2>/dev/null)
    [[ -z "$MISSING" && "$NA" -gt 0 ]] && okk "the added staff route exists" || nope "staff routes missing: $(tr '\n' ';' <<<"$MISSING")"
    LOST=$(jq -r --argjson after "$ROUTES_AFTER" '. - $after | .[]' "$B/routes-before.json" 2>/dev/null)
    [[ -z "$LOST" ]] && okk "no earlier route was lost" || nope "routes lost: $(tr '\n' ';' <<<"$LOST")"
    A apigatewayv2 get-api --api-id "$API_ID" --query CorsConfiguration --output json > "$B/cors-after.json" 2>/dev/null
    if diff <(jq -S . "$B/cors-before.json") <(jq -S . "$B/cors-after.json") >/dev/null 2>&1; then okk "CORS configuration unchanged"; else nope "CORS configuration CHANGED"; fi
    A events list-rules --query 'Rules[?contains(Name,`ComplianceSweep`)].[Name,State]' --output text 2>/dev/null | grep -q ENABLED && okk "ComplianceSweep still ENABLED" || nope "ComplianceSweep is not ENABLED"
    [[ $bad == 0 ]] && { echo "POST-CHECK PASSED for $STACK"; exit 0; } || { echo "STOP: a post-deployment check failed. See Recovery."; exit 1; } ;;
esac
