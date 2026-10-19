#!/usr/bin/env bash
# =============================================================================
# TEST rehearsal: the ONLY way this procedure deploys a stack. One stack per call; only Ogevia-prod-NetworkEgress and Ogevia-prod-ServiceVerificationApi are accepted.
#   bash deploy-guard.sh check  <stack>    READ-ONLY. Fetches the LIVE template of the stack, runs the synthesized assembly check and the EXPECTED-ONLY diff gate
#                                          (diff_gate.py) and shows the read-only `cdk diff`. Exit 0 only if the difference is exactly the release's allowed change.
#   bash deploy-guard.sh deploy <stack>    [YELLOW] repeats `check`, asks you to type DEPLOY-<stack>, then runs exactly
#                                          npx cdk deploy --app $ASSEMBLY --exclusively <stack> --require-approval broadening --no-notices
#                                          PATH B (read from $OGEVIA_BEFORE/path.txt): NetworkEgress may only be checked, and must show NO difference; the API stack may change only its Handler code asset.
#   bash deploy-guard.sh post   <stack>    READ-ONLY checks after the deployment (stack status; NetworkEgress: the endpoint policy is ADDITIVE-ONLY against the capture,
#                                          production's entries intact; API: Lambda environment unchanged, new CodeSha256, ClientDocumentObjects present, sweep ENABLED).
# Environment: ASSEMBLY (the verified synth output, default /tmp/ogevia-cdk.out), OGEVIA_BEFORE (default ~/ogevia-before), OGEVIA_DEPLOY_APPROVAL (deploy only).
# It never deploys an Ogevia-prd-* stack, never more than one stack, never a glob, never without the gate. Exit: 0 ok; 1 refused/failed; 2 usage.
# =============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-}"; STACK="${2:-}"
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER="" CDK_DISABLE_CLI_TELEMETRY=true
ACCOUNT=300094796789
ALLOWED=(Ogevia-prod-NetworkEgress Ogevia-prod-ServiceVerificationApi)
ASSEMBLY="${ASSEMBLY:-/tmp/ogevia-cdk.out}"; B="${OGEVIA_BEFORE:-$HOME/ogevia-before}"
A() { timeout --foreground -k 5 "${OGEVIA_AWS_TIMEOUT:-90}" aws "$@"; }
refuse() { echo "REFUSED: $*"; exit 1; }
[[ $# -eq 2 ]] || { echo "usage: bash deploy-guard.sh check|deploy|post <stack>   (exactly one stack: ${ALLOWED[*]})" >&2; exit 2; }
[[ "$MODE" == check || "$MODE" == deploy || "$MODE" == post ]] || { echo "usage: bash deploy-guard.sh check|deploy|post <stack>" >&2; exit 2; }
# the stack argument: exact match against the two-name allow-list. A glob, a list, an Ogevia-prd name or anything else is refused.
ok=0; for s in "${ALLOWED[@]}"; do [[ "$STACK" == "$s" ]] && ok=1; done
[[ $ok == 1 ]] || refuse "'$STACK' is not one of the two stacks this procedure may deploy (${ALLOWED[*]}). No Ogevia-prd-* stack, no pattern, no list."
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
# PATH A (live TEST is the recorded baseline, ledger 77/0077) or PATH B (TEST already runs the earlier package, ledger 85/0085): decided by the read-only baseline capture
# (Step 5 writes $B/path.txt) and confirmed by the ledger recheck (Step 6). No path file, no guard.
RPATH="$(tr -d '[:space:]' < "$B/path.txt" 2>/dev/null)"
[[ "$RPATH" == A || "$RPATH" == B ]] || refuse "no valid $B/path.txt (A or B): run the baseline capture (Step 5) first"
[[ "$RPATH" == B && "$STACK" == Ogevia-prod-NetworkEgress && "$MODE" != check ]] && refuse "PATH B: Ogevia-prod-NetworkEgress is never deployed or post-checked here (TEST already carries the client-documents entries); only 'check' is allowed and it must show NO difference"
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
  python3 -I -B "$HERE/diff_gate.py" template --stack "$STACK" --live "$live" --new "$ASSEMBLY/$STACK.template.json" --path "$RPATH" || refuse "the difference is NOT the release's expected change. STOP and report; nothing was deployed."
}

case "$MODE" in
  check) gate; echo "CHECK PASSED for $STACK: the difference is exactly the expected change. Nothing was deployed." ;;
  deploy)
    [[ "${OGEVIA_DEPLOY_APPROVAL:-}" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || refuse "set OGEVIA_DEPLOY_APPROVAL to the owner's approval reference"
    gate
    echo; echo "ABOUT TO RUN (YELLOW): ${DEPLOY_ARGV[*]}"
    read -r -p "Type DEPLOY-$STACK to deploy this one stack (anything else stops, nothing deployed): " ans
    [[ "$ans" == "DEPLOY-$STACK" ]] || { echo "Declined. Nothing was deployed."; exit 0; }
    cd "$HERE/../../../../infra/aws" && "${DEPLOY_ARGV[@]}"; RC=$?
    [[ $RC == 0 ]] || { echo "STOP: cdk deploy exited $RC. Read the message; see Recovery in the procedure. Do not deploy the next stack."; exit 1; }
    echo "deploy command finished; now run: bash deploy-guard.sh post $STACK" ;;
  post)
    bad=0; okk() { echo "PASS $*"; }; nope() { echo "FAIL $*"; bad=1; }
    st=$(status); [[ "$st" == UPDATE_COMPLETE ]] && okk "$STACK is UPDATE_COMPLETE" || nope "$STACK is '$st', not UPDATE_COMPLETE"
    if [[ "$STACK" == Ogevia-prod-NetworkEgress ]]; then
      EP=$(cat "$B/endpoint-id.txt" 2>/dev/null)
      [[ "$EP" =~ ^vpce-[0-9a-f]+$ ]] || nope "no captured endpoint id (run the baseline capture first)"
      A ec2 describe-vpc-endpoints --vpc-endpoint-ids "$EP" --query 'VpcEndpoints[0].PolicyDocument' --output text > "$B/endpoint-policy-after.json" 2>/dev/null
      if python3 -I -B "$HERE/diff_gate.py" endpoint-policy --before "$B/endpoint-policy-before.json" --after "$B/endpoint-policy-after.json"; then okk "the endpoint policy kept every earlier entry for the TEST and the PRODUCTION bucket and gained only the two client-documents entries"; else nope "the endpoint policy is not additive-only: see Recovery 'endpoint policy'"; fi
      echo "resources now: $(jq '[.Statement[] | .Resource | if type=="array" then .[] else . end] | length' "$B/endpoint-policy-after.json" 2>/dev/null) (before: $(jq '[.Statement[] | .Resource | if type=="array" then .[] else . end] | length' "$B/endpoint-policy-before.json" 2>/dev/null))"
    else
      FN=$(cat "$B/handler-function-name.txt" 2>/dev/null)
      A lambda get-function-configuration --function-name "$FN" --output json > "$B/lambda-config-after.json" 2>/dev/null || nope "cannot read the Lambda configuration"
      if diff <(jq -S .Environment "$B/lambda-config-before.json") <(jq -S .Environment "$B/lambda-config-after.json") >/dev/null 2>&1; then okk "Lambda environment unchanged"; else nope "Lambda environment CHANGED"; fi
      NEW=$(jq -r .CodeSha256 "$B/lambda-config-after.json"); OLD=$(jq -r .CodeSha256 "$B/lambda-config-before.json")
      echo "Lambda CodeSha256: before $OLD  after $NEW"
      [[ -n "$NEW" && "$NEW" != null && "$NEW" != "$OLD" ]] && okk "the Lambda code changed" || nope "the Lambda CodeSha256 did not change"
      [[ "$(jq -r .LastUpdateStatus "$B/lambda-config-after.json")" == Successful ]] && okk "LastUpdateStatus Successful" || nope "Lambda LastUpdateStatus is not Successful"
      PARN=$(A cloudformation list-stack-resources --stack-name "$STACK" --query "StackResourceSummaries[?ResourceType=='AWS::IAM::ManagedPolicy' && starts_with(LogicalResourceId,'HandlerPolicy')].PhysicalResourceId" --output text 2>/dev/null)
      VER=$(A iam get-policy --policy-arn "$PARN" --query 'Policy.DefaultVersionId' --output text 2>/dev/null)
      if A iam get-policy-version --policy-arn "$PARN" --version-id "$VER" --query 'PolicyVersion.Document' --output json 2>/dev/null | jq -e '[.Statement[] | select(.Sid=="ClientDocumentObjects")] | length == 1' >/dev/null; then okk "the handler policy has the ClientDocumentObjects statement"; else nope "ClientDocumentObjects is not in the handler policy"; fi
      A events list-rules --query 'Rules[?contains(Name,`ComplianceSweep`)].[Name,State]' --output text 2>/dev/null | grep -q ENABLED && okk "ComplianceSweep still ENABLED" || nope "ComplianceSweep is not ENABLED"
    fi
    [[ $bad == 0 ]] && { echo "POST-CHECK PASSED for $STACK"; exit 0; } || { echo "STOP: a post-deployment check failed. See Recovery."; exit 1; } ;;
esac
