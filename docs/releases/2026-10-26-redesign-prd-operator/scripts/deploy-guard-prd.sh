#!/usr/bin/env bash
# =============================================================================
# PRODUCTION release 2026-10-26-redesign: the ONLY way this procedure deploys a stack. `check` (read-only) accepts the six Ogevia-prd-* stacks and the shared Ogevia-prod-NetworkEgress;
# `deploy` and `post` accept exactly one of TWO stacks per call: Ogevia-prd-Auth (the web app client gains the app./admin. sign-in URLs) or Ogevia-prd-ServiceVerificationApi (13 staff routes,
# the Handler code, two CORS origins). Every other stack can only be `check`ed and must show no difference (WebHosting: only its one removed export; it is never deployed).
#   bash deploy-guard-prd.sh check  <stack>   READ-ONLY. Fetches the LIVE template of the stack, runs the assembly check and the EXPECTED-ONLY diff gate (diff_gate_prd.py) and shows the read-only
#                                             `cdk diff`. Exit 0 only if the difference is exactly the release's allowed change (Auth and API: DELTA; WebHosting: EXPORT-ONLY; the rest: NONE).
#   bash deploy-guard-prd.sh deploy <stack>   [YELLOW, changes PRODUCTION] Auth or API only. Needs: OGEVIA_DEPLOY_APPROVAL, ASSEMBLY (the verified deploy-mode synthesis), a verified fresh snapshot
#                                             (OGEVIA_PREDEPLOY_SNAPSHOT_ID, named ogevia-prod-postgres-pre-0086-prd-YYYYMMDDHHMM, at most 6 hours old) and the marker $B/db-0086.ok written by the
#                                             migration step. Repeats `check` (it must say DELTA: nothing to deploy is a refusal), shows the exact command, asks you to type DEPLOY-<stack>, runs exactly
#                                             npx cdk deploy --app $ASSEMBLY --exclusively <stack> --require-approval broadening --no-notices
#                                             Deploying the API stack also requires the Auth stack to have been deployed first (marker $B/auth-at-release.ok).
#   bash deploy-guard-prd.sh post   <stack>   READ-ONLY checks after the deployment.
# It never deploys an Ogevia-prod-* stack, never more than one stack, never a glob, never without the gate. Exit: 0 ok; 1 refused/failed; 2 usage.
# =============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib.sh"
MODE="${1:-}"; STACK="${2:-}"
export CDK_DISABLE_CLI_TELEMETRY=true
AUTH=Ogevia-prd-Auth; API=Ogevia-prd-ServiceVerificationApi; WEB=Ogevia-prd-WebHosting
ALLOWED=(Ogevia-prd-Auth Ogevia-prd-DatabaseSecret Ogevia-prd-EvidenceStorage Ogevia-prd-Observability Ogevia-prd-ServiceVerificationApi Ogevia-prd-WebHosting Ogevia-prod-NetworkEgress)
DEPLOYABLE=("$AUTH" "$API")
ASSEMBLY="${ASSEMBLY:-/tmp/ogevia-prd-cdk.out}"
REL="$PKG_ROOT/release-templates"
refuse() { say "REFUSED: $*"; exit 1; }
[[ $# -eq 2 ]] || { echo "usage: bash deploy-guard-prd.sh check|deploy|post <stack>   (exactly one stack: ${ALLOWED[*]})" >&2; exit 2; }
[[ "$MODE" == check || "$MODE" == deploy || "$MODE" == post ]] || { echo "usage: bash deploy-guard-prd.sh check|deploy|post <stack>" >&2; exit 2; }
need aws jq python3 timeout
ok=0; for s in "${ALLOWED[@]}"; do [[ "$STACK" == "$s" ]] && ok=1; done
[[ $ok == 1 ]] || refuse "'$STACK' is not one of the stacks this procedure may read (${ALLOWED[*]}). No pattern, no list, no other stack."
dok=0; for s in "${DEPLOYABLE[@]}"; do [[ "$STACK" == "$s" ]] && dok=1; done
[[ "$MODE" == check || $dok == 1 ]] || refuse "only $AUTH and $API may be deployed or post-checked by this procedure; '$STACK' can only be checked (it must show no difference, or for WebHosting only its one removed export)"
# the exact argument vector the deployment would use, validated before it is ever run
DEPLOY_ARGV=(npx cdk deploy --app "$ASSEMBLY" --exclusively "$STACK" --require-approval broadening --no-notices)
deploy_argv_ok() {
  local stacks=0 a prev=""
  for a in "${DEPLOY_ARGV[@]:3}"; do
    case "$a" in -*) ;; *) [[ "$prev" == --app || "$prev" == --require-approval ]] || stacks=$((stacks + 1)) ;; esac
    [[ "$a" == *Ogevia-prod-* || "$a" == *\** || "$a" == --all || "$a" == --concurrency* || "$a" == --force || "$a" == --hotswap* || "$a" == --no-rollback || "$a" == --exclusively=* ]] && return 1
    prev="$a"
  done
  [[ $stacks -eq 1 && " ${DEPLOY_ARGV[*]} " == *" --exclusively $STACK "* ]]
}
[[ "$MODE" != deploy ]] || deploy_argv_ok || refuse "the deploy command line failed its own check: ${DEPLOY_ARGV[*]}"
# the template the gate compares the live stack with: the deploy-mode assembly when it holds the stack, else the bundled release template (NetworkEgress is not part of the prd assembly)
if [[ -f "$ASSEMBLY/$STACK.template.json" ]]; then NEWTPL="$ASSEMBLY/$STACK.template.json"; elif [[ "$MODE" == check && -f "$REL/$STACK.json" ]]; then NEWTPL="$REL/$STACK.json"; else refuse "no synthesized template $ASSEMBLY/$STACK.template.json (run the synthesis step first)"; fi
check_account
status() { A cloudformation describe-stacks --stack-name "$STACK" --output json 2>/dev/null | jq -r '.Stacks[0].StackStatus // empty'; }

gate() {
  local st live="$B/gate-live-$STACK.json"
  st=$(status); [[ "$st" == UPDATE_COMPLETE || "$st" == CREATE_COMPLETE ]] || refuse "$STACK is '${st:-unreadable}', not settled"
  say "$STACK: $st"
  A cloudformation get-template --stack-name "$STACK" --template-stage Original --output json 2>/dev/null | jq '.TemplateBody // .' > "$live" && jq -e 'has("Resources")' "$live" >/dev/null 2>&1 || refuse "cannot read the live template of $STACK"
  if [[ -d "$ASSEMBLY" ]]; then
    ASM_OUT=$(python3 -I -B "$HERE/assembly_check_prd.py" --assembly "$ASSEMBLY" --release-templates "$REL" ${OGEVIA_DEPLOY_APPROVAL:+--approval "$OGEVIA_DEPLOY_APPROVAL"}); ARC=$?
    printf '%s\n' "$ASM_OUT" | tee -a "$LOG"
    [[ $ARC == 0 ]] || refuse "the synthesized assembly is not the approved release"
  else say "NOTE: no assembly at $ASSEMBLY; a deployment needs one"; fi
  if [[ -d "$ASSEMBLY" && -d "$HERE/../../../../infra/aws" && "$NEWTPL" == "$ASSEMBLY"/* ]]; then
    say "-- cdk diff (read-only; for the human reader)"
    (cd "$HERE/../../../../infra/aws" && timeout --foreground -k 5 300 npx --no-install cdk diff --app "$ASSEMBLY" "$STACK" --no-notices 2>&1 | tail -60) | tee -a "$LOG"
  fi
  say "-- EXPECTED-ONLY gate (machine check of the live template against the release)"
  GATE_OUT=$(python3 -I -B "$HERE/diff_gate_prd.py" template --stack "$STACK" --live "$live" --new "$NEWTPL"); GRC=$?
  printf '%s\n' "$GATE_OUT" | tee -a "$LOG"
  [[ $GRC == 0 ]] || refuse "the difference is NOT the release's expected change. STOP and report; nothing was deployed."
  GATE_RESULT=$(grep -o 'EXPECTED-ONLY: YES ([A-Z-]*)' <<<"$GATE_OUT" | grep -o '(.*)' | tr -d '()')
}

case "$MODE" in
  check) gate; say "CHECK PASSED for $STACK ($GATE_RESULT): the difference is exactly the expected change. Nothing was deployed." ;;
  deploy)
    [[ "$(cut -d' ' -f1 "$B/release-record.state" 2>/dev/null)" != DEPLOYED-RECORD-* ]] || refuse "$B/release-record.state says the release has already taken effect ($(cut -d' ' -f1 "$B/release-record.state")): nothing is deployed twice automatically. Re-run record-deployed-prd.sh (read-only) to finish the record; a deliberate second deployment needs the Owner's new written instruction"
    [[ "${OGEVIA_DEPLOY_APPROVAL:-}" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || refuse "set OGEVIA_DEPLOY_APPROVAL to the owner's approval reference"
    [[ "${OGEVIA_DEPLOY_APPROVAL}" != APPROVAL-REF-PENDING-OWNER ]] || refuse "the approval reference is still the placeholder"
    [[ -d "$ASSEMBLY" ]] || refuse "no assembly at $ASSEMBLY"
    [[ "$(cat "$B/db-0086.ok" 2>/dev/null)" == "85|0085|0086" ]] || refuse "no $B/db-0086.ok containing 85|0085|0086: migration 0086 must be applied and verified BEFORE any stack is deployed"
    [[ "$STACK" != "$API" || -s "$B/auth-at-release.ok" ]] || refuse "no $B/auth-at-release.ok: deploy $AUTH and run its post check first"
    SNAP="${OGEVIA_PREDEPLOY_SNAPSHOT_ID:-}"; [[ "$SNAP" =~ ^ogevia-prod-postgres-pre-0086-prd-[0-9]{12}$ ]] || refuse "set OGEVIA_PREDEPLOY_SNAPSHOT_ID to a snapshot named ogevia-prod-postgres-pre-0086-prd-YYYYMMDDHHMM"
    S=$(A rds describe-db-snapshots --db-snapshot-identifier "$SNAP" --output json 2>/dev/null | jq -c '.DBSnapshots[0]') && [[ -n "$S" && "$S" != null ]] || refuse "cannot read snapshot $SNAP"
    [[ "$(jq -r .Status <<<"$S")" == available && "$(jq -r .DBInstanceIdentifier <<<"$S")" == ogevia-prod-postgres && "$(jq -r .SnapshotType <<<"$S")" == manual && "$(jq -r .Encrypted <<<"$S")" == true ]] || refuse "snapshot $SNAP is not available, manual, encrypted and of ogevia-prod-postgres"
    AGE=$(( $(date -u +%s) - $(date -u -d "$(jq -r .SnapshotCreateTime <<<"$S")" +%s) )); (( AGE >= 0 && AGE <= ${OGEVIA_SNAPSHOT_MAX_AGE:-21600} )) || refuse "snapshot $SNAP is $AGE s old (limit ${OGEVIA_SNAPSHOT_MAX_AGE:-21600}); take a fresh one"
    gate
    [[ "$GATE_RESULT" == DELTA ]] || refuse "the gate result for $STACK is '$GATE_RESULT', not DELTA: there is nothing to deploy (or it is not this release). Nothing was deployed."
    echo; say "ABOUT TO RUN (YELLOW, changes PRODUCTION): ${DEPLOY_ARGV[*]}"
    say "CDK should NOT ask for approval (no IAM or security-group change). If it shows an 'IAM Statement Changes' or 'Security Group Changes' table, answer n and stop."
    read -r -p "Type DEPLOY-$STACK to deploy this one stack (anything else stops, nothing deployed): " ans || ans=""
    [[ "$ans" == "DEPLOY-$STACK" ]] || { say "Declined. Nothing was deployed."; exit 0; }
    (cd "$HERE/../../../../infra/aws" && PATH="$PWD/node_modules/.bin:$PATH" OGEVIA_DEPLOY_APPROVAL="$OGEVIA_DEPLOY_APPROVAL" "${DEPLOY_ARGV[@]}"); RC=$?
    [[ $RC == 0 ]] || { say "STOP: cdk deploy exited $RC. Read the message; see Recovery in the procedure. Do not deploy the next stack."; exit 1; }
    say "deploy command finished; now run: bash deploy-guard-prd.sh post $STACK" ;;
  post)
    if [[ "$STACK" == "$AUTH" ]]; then rm -f "$B/auth-at-release.ok"; else rm -f "$B/api-at-release.ok"; fi
    st=$(status); [[ "$st" == UPDATE_COMPLETE ]] && ok "$STACK is UPDATE_COMPLETE" || nope "$STACK is '${st:-unreadable}', not UPDATE_COMPLETE"
    mkdir -p "$B/after"
    A cloudformation get-template --stack-name "$STACK" --template-stage Original --output json 2>/dev/null | jq '.TemplateBody // .' > "$B/after/$STACK.json"
    if python3 -I -B "$HERE/tpl_diff.py" "$B/after/$STACK.json" "$REL/$STACK.json" >/dev/null; then ok "the live template now equals the release template"; else nope "the live template still differs from the release template"; fi
    if [[ "$STACK" == "$AUTH" ]]; then
      POOL=$(A cloudformation list-stack-resources --stack-name "$AUTH" --output json 2>/dev/null | jq -r '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Cognito::UserPool")][0].PhysicalResourceId // empty')
      CLIENT=$(A cloudformation list-stack-resources --stack-name "$AUTH" --output json 2>/dev/null | jq -r '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Cognito::UserPoolClient")][0].PhysicalResourceId // empty')
      [[ "$POOL" == us-west-2_FHJoX71ca ]] && ok "the production user pool is unchanged ($POOL)" || nope "the user pool in $AUTH is '${POOL:-unreadable}', not us-west-2_FHJoX71ca"
      A cognito-idp describe-user-pool-client --user-pool-id "$POOL" --client-id "$CLIENT" --output json 2>/dev/null | jq '{callbacks:.UserPoolClient.CallbackURLs, logouts:.UserPoolClient.LogoutURLs}' > "$B/cognito-client-after.json"
      if jq -e '(.callbacks | index("https://app.ogevia.com/auth/callback")) != null and (.callbacks | index("https://admin.ogevia.com/auth/callback")) != null and (.logouts | index("https://app.ogevia.com/")) != null and (.logouts | index("https://admin.ogevia.com/")) != null' "$B/cognito-client-after.json" >/dev/null 2>&1; then ok "the app client allows the app. and admin. sign-in and sign-out URLs"; else nope "the app client does not list the app. and admin. URLs"; fi
      if [[ -s "$B/cognito-client-before.json" ]] && jq -e --slurpfile a "$B/cognito-client-after.json" '(.callbacks - $a[0].callbacks | length) == 0 and (.logouts - $a[0].logouts | length) == 0' "$B/cognito-client-before.json" >/dev/null 2>&1; then ok "no earlier callback or sign-out URL was lost"; else nope "an earlier callback or sign-out URL is missing (or the baseline has no cognito-client-before.json)"; fi
      [[ $bad == 0 ]] && { date -u +%FT%TZ > "$B/auth-at-release.ok"; say "POST-CHECK PASSED for $STACK (marker $B/auth-at-release.ok written: the API deployment requires it)"; exit 0; } || { say "STOP: a post-deployment check failed. See Recovery."; exit 1; }
    fi
    FN=$(cat "$B/handler-function-name.txt" 2>/dev/null); A lambda get-function-configuration --function-name "$FN" --output json 2>/dev/null | jq '{CodeSha256,LastUpdateStatus,Names:(.Environment.Variables|keys),DB_NAME:.Environment.Variables.DB_NAME,OGEVIA_ENV:.Environment.Variables.OGEVIA_ENV}' > "$B/lambda-config-after.json"
    [[ "$(jq -r .LastUpdateStatus "$B/lambda-config-after.json")" == Successful ]] && ok "Lambda LastUpdateStatus Successful" || nope "Lambda LastUpdateStatus is not Successful"
    OLD=$(jq -r .CodeSha256 "$B/lambda-config-before.json"); NEW=$(jq -r .CodeSha256 "$B/lambda-config-after.json"); say "Lambda CodeSha256: before $OLD  after $NEW"
    [[ -n "$NEW" && "$NEW" != null && "$NEW" != "$OLD" ]] && ok "the Lambda code changed" || nope "the Lambda CodeSha256 did not change"
    [[ "$(jq -r '.DB_NAME + "|" + .OGEVIA_ENV' "$B/lambda-config-after.json")" == "ogevia_prd|prd" ]] && ok "the Lambda still serves ogevia_prd with OGEVIA_ENV=prd" || nope "the Lambda's DB_NAME/OGEVIA_ENV changed"
    [[ "$(jq -c '.EnvironmentVariableNames' "$B/lambda-config-before.json")" == "$(jq -c .Names "$B/lambda-config-after.json")" ]] && ok "the Lambda's environment variable names are unchanged" || nope "the Lambda's environment variable names changed"
    API_ID=$(cat "$B/api-id.txt" 2>/dev/null)
    ROUTES_AFTER=$(A apigatewayv2 get-routes --api-id "$API_ID" --max-items 1000 --output json 2>/dev/null | jq -c '[.Items[].RouteKey]') || ROUTES_AFTER='[]'
    NB=$(jq 'length' "$B/routes-before.json" 2>/dev/null || echo -1); NA=$(jq 'length' <<<"$ROUTES_AFTER" 2>/dev/null || echo 0)
    say "API routes: before $NB  after $NA"
    [[ "$NB" -ge 0 && "$NA" == "$((NB + 13))" ]] && ok "the API gained exactly 13 routes" || nope "the route count is $NA, not $NB + 13"
    MISSING=$(jq -r --slurpfile k "$HERE/new-route-keys.json" '$k[0] - . | .[]' <<<"$ROUTES_AFTER" 2>/dev/null)
    [[ -z "$MISSING" && "$NA" -gt 0 ]] && ok "all 13 staff routes exist" || nope "staff routes missing: $(tr '\n' ';' <<<"$MISSING")"
    LOST=$(jq -r --argjson after "$ROUTES_AFTER" '. - $after | .[]' "$B/routes-before.json" 2>/dev/null)
    [[ -z "$LOST" ]] && ok "no earlier route was lost" || nope "routes lost: $(tr '\n' ';' <<<"$LOST")"
    A apigatewayv2 get-api --api-id "$API_ID" --output json 2>/dev/null | jq '.CorsConfiguration' > "$B/cors-after.json"
    if jq -e --slurpfile a "$B/cors-after.json" '. as $b | (($a[0] | del(.AllowOrigins)) == ($b | del(.AllowOrigins))) and (($a[0].AllowOrigins | unique) == (($b.AllowOrigins + ["https://app.ogevia.com","https://admin.ogevia.com"]) | unique))' "$B/cors-before.json" >/dev/null 2>&1; then ok "CORS: only the app. and admin. origins were added (or were already there); every other CORS setting is unchanged"; else nope "the API's CORS configuration changed in another way (compare cors-before.json and cors-after.json)"; fi
    RULE=$(A cloudformation list-stack-resources --stack-name "$STACK" --output json 2>/dev/null | jq -r '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Events::Rule")][0].PhysicalResourceId // empty')
    [[ -n "$RULE" && "$(A events describe-rule --name "$RULE" --output json 2>/dev/null | jq -r .State)" == ENABLED ]] && ok "the production ComplianceSweep rule $RULE is ENABLED" || nope "no ENABLED ComplianceSweep rule in $STACK"
    [[ $bad == 0 ]] && { printf '%s\n' "$NEW" > "$B/api-at-release.ok"; say "POST-CHECK PASSED for $STACK (marker $B/api-at-release.ok written: the web publish requires it)"; exit 0; } || { say "STOP: a post-deployment check failed. See Recovery."; exit 1; } ;;
esac
