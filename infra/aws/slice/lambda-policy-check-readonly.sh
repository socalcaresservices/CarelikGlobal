#!/usr/bin/env bash
# =============================================================================
# Ogevia TEST: READ-ONLY check of the API handler Lambda's resource policy: size AND principals.
#   bash lambda-policy-check-readonly.sh pre     before the API deployment
#   bash lambda-policy-check-readonly.sh post    after the API deployment
# AWS verbs used (all get-/list-, nothing is changed): sts get-caller-identity, cloudformation list-stack-resources,
#   lambda get-function-configuration, lambda get-policy. Every call is bounded by `timeout`. TEST stack only (Ogevia-prod-ServiceVerificationApi).
# The decision logic is lambda_policy_check.py (same folder; pinned by the procedure's checksum manifest).
# Exit 0 = PASS; 1 = a check failed or something could not be read; 2 = usage.
# =============================================================================
set -uo pipefail
MODE="${1:-}"; [[ "$MODE" == pre || "$MODE" == post ]] || { echo "usage: bash lambda-policy-check-readonly.sh pre|post" >&2; exit 2; }
ACCOUNT=300094796789; REGION=us-west-2; STACK=Ogevia-prod-ServiceVerificationApi
TMO="${OGEVIA_AWS_TIMEOUT:-30}"
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION AWS_PAGER=""
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
aws() { timeout --foreground -k 5 "$TMO" "$(type -P aws)" "$@"; }
fail() { echo "FAIL: $*"; echo "STOP: nothing was changed."; exit 1; }
for t in aws jq python3 timeout; do command -v "$t" >/dev/null 2>&1 || fail "missing tool '$t'"; done
[[ "$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" == "$ACCOUNT" ]] || fail "not signed in to account $ACCOUNT"
RES=$(aws cloudformation list-stack-resources --stack-name "$STACK" --output json 2>/dev/null) || fail "cannot read stack $STACK"
FN=$(jq -r '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId|startswith("Handler")))] | if length==1 then .[0].PhysicalResourceId else empty end' <<<"$RES")
[[ -n "$FN" ]] || fail "expected exactly one handler Lambda in $STACK"
API=$(jq -r '[.StackResourceSummaries[] | select(.ResourceType=="AWS::ApiGatewayV2::Api")] | if length==1 then .[0].PhysicalResourceId else empty end' <<<"$RES")
[[ -n "$API" ]] || fail "expected exactly one HTTP API in $STACK"
RULE=$(jq -r '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Events::Rule")] | if length==1 then .[0].PhysicalResourceId else empty end' <<<"$RES")
[[ "$MODE" == pre || -n "$RULE" ]] || fail "after the deployment the stack must contain exactly one EventBridge rule (ComplianceSweep)"
FNARN=$(aws lambda get-function-configuration --function-name "$FN" --query FunctionArn --output text 2>/dev/null) || fail "cannot read Lambda $FN"
POL=$(mktemp); trap 'rm -f "$POL"' EXIT
aws lambda get-policy --function-name "$FN" --query Policy --output text >"$POL" 2>/dev/null || fail "cannot read the resource policy of $FN (none exists, or access denied)"
echo "function: $FN | API id: $API | rule: ${RULE:-none yet} | mode: $MODE"
ARGS=(--mode "$MODE" --policy-file "$POL" --function-arn "$FNARN" --account "$ACCOUNT" --region "$REGION" --api-id "$API")
[[ -n "$RULE" ]] && ARGS+=(--rule-name "$RULE")
python3 "$HERE/lambda_policy_check.py" "${ARGS[@]}"
