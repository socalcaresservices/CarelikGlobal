#!/usr/bin/env bash
# DEPLOY GUARD for the production release: the ONLY way this package deploys. Exactly one stack is accepted: Ogevia-prd-ServiceVerificationApi (the only stack the release changes).
#   bash deploy-guard-prd.sh check  Ogevia-prd-ServiceVerificationApi   READ-ONLY: p2 gate (and the assembly check when OGEVIA_PRD_ASSEMBLY is set)
#   bash deploy-guard-prd.sh deploy Ogevia-prd-ServiceVerificationApi   [YELLOW, changes production] needs: OGEVIA_DEPLOY_APPROVAL, OGEVIA_PRD_ASSEMBLY (a deploy-mode synth made by the
#       operator package), OGEVIA_CDK_BIN (the pinned CDK CLI), OGEVIA_PREDEPLOY_SNAPSHOT_ID (a fresh verified snapshot), and the marker $B/db-at-0085.ok that the migration stage writes
#       (the new API code needs the 0085 schema; an API deployed before the migrations would fail). Repeats the gate, shows the exact command, requires you to type
#       DEPLOY-Ogevia-prd-ServiceVerificationApi, then runs exactly: <cdk> deploy --app <assembly> --exclusively <stack> --require-approval broadening --no-notices
#       CDK WILL ASK to approve IAM broadening: the only acceptable answer-yes case is exactly the two statements ClientDocumentObjects and SwitchSignInsOnOff (plus the ComplianceSweep rule
#       and its permission); anything else: answer n.
#   bash deploy-guard-prd.sh post   Ogevia-prd-ServiceVerificationApi   READ-ONLY checks after the deployment.
# It never deploys another stack, a glob, a list, --all, --force, --hotswap or --no-rollback. Exit: 0 ok; 1 refused/failed; 2 usage.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib.sh"
MODE="${1:-}"; STACK="${2:-}"; ALLOWED=Ogevia-prd-ServiceVerificationApi; CDK_VERSION=2.1143.0
refuse() { say "REFUSED: $*"; exit 1; }
[[ $# -eq 2 && ( "$MODE" == check || "$MODE" == deploy || "$MODE" == post ) ]] || { echo "usage: bash deploy-guard-prd.sh check|deploy|post $ALLOWED" >&2; exit 2; }
[[ "$STACK" == "$ALLOWED" ]] || refuse "'$STACK' is not $ALLOWED, the only stack this package may deploy (no other Ogevia-prd stack, no Ogevia-prod stack, no pattern, no list)"
need aws jq python3 timeout
ASSEMBLY="${OGEVIA_PRD_ASSEMBLY:-}"; CDK="${OGEVIA_CDK_BIN:-}"
DEPLOY_ARGV=("$CDK" deploy --app "$ASSEMBLY" --exclusively "$STACK" --require-approval broadening --no-notices)
deploy_argv_ok() {
  local stacks=0 a prev=""
  for a in "${DEPLOY_ARGV[@]:2}"; do
    case "$a" in -*) ;; *) [[ "$prev" == --app || "$prev" == --require-approval ]] || stacks=$((stacks + 1)) ;; esac
    [[ "$a" == *\** || "$a" == --all || "$a" == --concurrency* || "$a" == --force || "$a" == --hotswap* || "$a" == --no-rollback || "$a" == --exclusively=* ]] && return 1
    prev="$a"
  done
  [[ $stacks -eq 1 && " ${DEPLOY_ARGV[*]} " == *" --exclusively $STACK "* ]]
}
check_account
status() { A cloudformation describe-stacks --stack-name "$STACK" --output json 2>/dev/null | jq -r '.Stacks[0].StackStatus // empty'; }
gate() {
  bash "$HERE/p2-gate.sh" || refuse "the gate failed; nothing was deployed"
  if [[ -n "$ASSEMBLY" ]]; then python3 -I -B "$HERE/prd_assembly_check.py" --assembly "$ASSEMBLY" --release-templates "$PKG_ROOT/release-templates" || refuse "the assembly is not the approved release"; else say "NOTE: no assembly given (OGEVIA_PRD_ASSEMBLY); a deployment needs one"; fi
}
case "$MODE" in
  check) gate; say "CHECK PASSED for $STACK. Nothing was deployed." ;;
  deploy)
    [[ "${OGEVIA_DEPLOY_APPROVAL:-}" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || refuse "set OGEVIA_DEPLOY_APPROVAL to the owner's approval reference"
    [[ -n "$ASSEMBLY" && -d "$ASSEMBLY" ]] || refuse "set OGEVIA_PRD_ASSEMBLY to the verified deploy-mode synth directory"
    [[ -n "$CDK" && -x "$CDK" ]] || refuse "set OGEVIA_CDK_BIN to the pinned CDK CLI executable"
    "$CDK" --version 2>/dev/null | grep -q "^$CDK_VERSION" || refuse "the CDK CLI is not version $CDK_VERSION"
    deploy_argv_ok || refuse "the deploy command line failed its own check: ${DEPLOY_ARGV[*]}"
    [[ "$(cat "$B/db-at-0085.ok" 2>/dev/null)" == "85|0085" ]] || refuse "no $B/db-at-0085.ok containing 85|0085: the database must be migrated to 0085 BEFORE the API is deployed"
    SNAP="${OGEVIA_PREDEPLOY_SNAPSHOT_ID:-}"; [[ "$SNAP" =~ ^ogevia-prod-postgres-pre-prdrelease-[0-9]{12}$ ]] || refuse "set OGEVIA_PREDEPLOY_SNAPSHOT_ID to a snapshot named ogevia-prod-postgres-pre-prdrelease-YYYYMMDDHHMM"
    S=$(A rds describe-db-snapshots --db-snapshot-identifier "$SNAP" --output json 2>/dev/null | jq -c '.DBSnapshots[0]') && [[ -n "$S" && "$S" != null ]] || refuse "cannot read snapshot $SNAP"
    [[ "$(jq -r .Status <<<"$S")" == available && "$(jq -r .DBInstanceIdentifier <<<"$S")" == ogevia-prod-postgres && "$(jq -r .SnapshotType <<<"$S")" == manual && "$(jq -r .Encrypted <<<"$S")" == true ]] || refuse "snapshot $SNAP is not available, manual, encrypted and of ogevia-prod-postgres"
    AGE=$(( $(date -u +%s) - $(date -u -d "$(jq -r .SnapshotCreateTime <<<"$S")" +%s) )); (( AGE >= 0 && AGE <= ${OGEVIA_SNAPSHOT_MAX_AGE:-21600} )) || refuse "snapshot $SNAP is $AGE s old (limit ${OGEVIA_SNAPSHOT_MAX_AGE:-21600}); take a fresh one"
    gate
    echo; say "ABOUT TO RUN (YELLOW, changes PRODUCTION): ${DEPLOY_ARGV[*]}"
    say "Expect CDK to ask about IAM broadening: approve ONLY if it lists exactly the Handler's ClientDocumentObjects, the identity function's SwitchSignInsOnOff, and the ComplianceSweep rule and permission."
    read -r -p "Type DEPLOY-$STACK to deploy this one stack (anything else stops, nothing deployed): " ans
    [[ "$ans" == "DEPLOY-$STACK" ]] || { say "Declined. Nothing was deployed."; exit 0; }
    "${DEPLOY_ARGV[@]}"; RC=$?
    [[ $RC == 0 ]] || { say "STOP: cdk deploy exited $RC. Read the message; see recovery. Do not continue."; exit 1; }
    say "deploy command finished; now run: bash deploy-guard-prd.sh post $STACK" ;;
  post)
    st=$(status); [[ "$st" == UPDATE_COMPLETE ]] && ok "$STACK is UPDATE_COMPLETE" || nope "$STACK is '${st:-unreadable}', not UPDATE_COMPLETE"
    mkdir -p "$B/after"
    A cloudformation get-template --stack-name "$STACK" --template-stage Original --output json 2>/dev/null | jq '.TemplateBody // .' > "$B/after/$STACK.json"
    if python3 -I -B "$HERE/tpl_diff.py" "$B/after/$STACK.json" "$PKG_ROOT/release-templates/$STACK.json" >/dev/null; then ok "the live template now equals the release template (assets, policies, routes, ComplianceSweep)"; else nope "the live template still differs from the release template"; fi
    FN=$(cat "$B/handler-function-name.txt" 2>/dev/null); A lambda get-function-configuration --function-name "$FN" --output json 2>/dev/null | jq '{CodeSha256,LastUpdateStatus,Names:(.Environment.Variables|keys),DB_NAME:.Environment.Variables.DB_NAME,OGEVIA_ENV:.Environment.Variables.OGEVIA_ENV}' > "$B/lambda-config-after.json"
    [[ "$(jq -r .LastUpdateStatus "$B/lambda-config-after.json")" == Successful ]] && ok "Lambda LastUpdateStatus Successful" || nope "Lambda LastUpdateStatus is not Successful"
    OLD=$(jq -r .CodeSha256 "$B/lambda-config-before.json"); NEW=$(jq -r .CodeSha256 "$B/lambda-config-after.json"); say "Lambda CodeSha256: before $OLD  after $NEW"
    [[ -n "$NEW" && "$NEW" != null && "$NEW" != "$OLD" ]] && ok "the Lambda code changed" || nope "the Lambda CodeSha256 did not change"
    [[ "$(jq -r '.DB_NAME + "|" + .OGEVIA_ENV' "$B/lambda-config-after.json")" == "ogevia_prd|prd" ]] && ok "the Lambda still serves ogevia_prd with OGEVIA_ENV=prd" || nope "the Lambda's DB_NAME/OGEVIA_ENV changed"
    [[ "$(jq -c '.EnvironmentVariableNames' "$B/lambda-config-before.json")" == "$(jq -c .Names "$B/lambda-config-after.json")" ]] && ok "the Lambda's environment variable names are unchanged" || nope "the Lambda's environment variable names changed"
    APIID=$(A cloudformation list-stack-resources --stack-name "$STACK" --output json 2>/dev/null | jq -r '[.StackResourceSummaries[] | select(.ResourceType=="AWS::ApiGatewayV2::Api")][0].PhysicalResourceId // empty')
    NR=$(A apigatewayv2 get-routes --api-id "$APIID" --output json 2>/dev/null | jq '.Items | length'); [[ "$NR" == 228 ]] && ok "the API has 228 routes" || nope "the API has '${NR:-?}' routes, expected 228"
    RULE=$(A cloudformation list-stack-resources --stack-name "$STACK" --output json 2>/dev/null | jq -r '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Events::Rule")][0].PhysicalResourceId // empty')
    [[ -n "$RULE" && "$(A events describe-rule --name "$RULE" --output json 2>/dev/null | jq -r .State)" == ENABLED ]] && ok "the production ComplianceSweep rule exists and is ENABLED" || nope "no ENABLED ComplianceSweep rule in $STACK"
    [[ $bad == 0 ]] && { say "POST-CHECK PASSED for $STACK"; exit 0; } || { say "STOP: a post-deployment check failed. See recovery."; exit 1; } ;;
esac
