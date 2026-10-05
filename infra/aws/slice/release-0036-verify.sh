#!/usr/bin/env bash
# =============================================================================
# Ogevia AWS TEST release 0027-0036: VERIFY-ONLY rerun of the 14 live checks on
# a deployment that already finished (READ-ONLY: it deploys, migrates, rolls
# back and modifies nothing in AWS).
#
# Why it exists: the first run's check 6 compared the Lambda configuration
# without accounting for CodeSize, which changes with every code change, and
# REPORT.md stated "unchanged" whatever the checks found. Both are fixed in
# release-0036-live-checks.sh. Re-running the pinned deploy script would run the
# OLD checks again, so this script runs the corrected ones instead.
#
# Evidence is kept: the previous VERIFY.txt and REPORT.md are copied to
# VERIFY-<time>-before-rerun.txt / REPORT-<time>-before-rerun.md first.
#
# The build it compares against must be the approved one: the scope gate is
# re-run on it and its result must hash to the value recorded at DEPLOY.
#   OGEVIA_RELEASE_RUN_DIR  run folder (default ~/ogevia-release-0036-run)
#   OGEVIA_PINNED_REPO      checkout of the approved commit with its cdk.out
#                           (default /tmp/ogevia-release-0036), used when the
#                           run folder has no built-templates copy
# =============================================================================
set -Eeuo pipefail
export OGEVIA_PILOT_RUN_DIR="${OGEVIA_RELEASE_RUN_DIR:-$HOME/ogevia-release-0036-run}"
# shellcheck source=pilot-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/pilot-lib.sh"
NEW_ROUTE_COUNT=32
IDENTITY_FN=Ogevia-prod-IdentityAdmin
TS=$(date -u +%Y%m%dT%H%M%SZ)
LOG="$RUN/verify-$TS.log"
exec 3>&1
exec > >(tee -a "$LOG") 2>&1
trap '' PIPE
trap on_exit EXIT
trap 'die "unexpected error on line $LINENO (command: $BASH_COMMAND)"' ERR
export PYTHONDONTWRITEBYTECODE=1
VERIFY="$RUN/VERIFY.txt"

phase "1/4 The finished deployment (read-only)"
for t in aws python3 jq curl git; do command -v "$t" >/dev/null || die "missing tool: $t"; done
for f in APPROVAL.txt scope-gate.txt db-verify.txt records-compare.txt web-build/index.html; do
  [[ -f "$RUN/$f" ]] || die "$RUN/$f is missing: this script only verifies a finished release-0036 deployment"
done
for st in approved snapshot db-window api-deployed web-deployed; do
  is_done "$st" || die "deployment step '$st' is not complete; finish the deployment first (this script never deploys)"
done
COMMIT=$(grep '^commit=' "$RUN/APPROVAL.txt" | cut -d= -f2)
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT" ]] || die "wrong AWS account (expected $ACCOUNT)"
echo "Approved commit $COMMIT, approved at $(grep '^approved_at=' "$RUN/APPROVAL.txt" | cut -d= -f2)."

phase "2/4 The approved build"
if [[ -f "$RUN/built-templates/$API_STACK.template.json" ]]; then
  BUILD_DIR="$RUN/built-templates"
else
  PINNED_REPO="${OGEVIA_PINNED_REPO:-/tmp/ogevia-release-0036}"
  [[ "$(git -C "$PINNED_REPO" rev-parse HEAD 2>/dev/null)" == "$COMMIT" ]] \
    || die "$PINNED_REPO is not a checkout of the approved commit $COMMIT (run the rebuild step of the recovery block first)"
  BUILD_DIR="$PINNED_REPO/infra/aws/cdk.out"
  [[ -f "$BUILD_DIR/$API_STACK.template.json" ]] || die "$BUILD_DIR has no synthesized templates (run the rebuild step of the recovery block first)"
fi
python3 "$SLICE/release_0036_gate.py" --cdk-out "$BUILD_DIR" --deployed "$RB/templates" --summary "$RUN/verify-scope-gate-$TS.txt" >/dev/null \
  || die "the build in $BUILD_DIR is outside the approved scope; it cannot be used to verify the deployment"
[[ "scope_gate=$(sha256sum "$RUN/verify-scope-gate-$TS.txt" | cut -c1-16)" == "$(grep '^scope_gate=' "$RUN/APPROVAL.txt")" ]] \
  || die "the build in $BUILD_DIR does not reproduce the approved scope-gate result; it is not the approved build"
echo "Build $BUILD_DIR reproduces the approved scope exactly."

phase "3/4 Read-only inventory"
FN=$(aws cloudformation list-stack-resources --stack-name "$API_STACK" --output json | jq -r '[.StackResourceSummaries[] | select(.ResourceType == "AWS::Lambda::Function" and (.LogicalResourceId | startswith("Handler")))] | if length == 1 then .[0].PhysicalResourceId else "" end')
API_ID=$(aws cloudformation list-stack-resources --stack-name "$API_STACK" --output json | jq -r '[.StackResourceSummaries[] | select(.ResourceType == "AWS::ApiGatewayV2::Api" and (.LogicalResourceId | startswith("")))] | if length == 1 then .[0].PhysicalResourceId else "" end')
POLICY_ARN=$(aws cloudformation list-stack-resources --stack-name "$API_STACK" --output json | jq -r '[.StackResourceSummaries[] | select(.ResourceType == "AWS::IAM::ManagedPolicy" and (.LogicalResourceId | startswith("HandlerPolicy")))] | if length == 1 then .[0].PhysicalResourceId else "" end')
WEB=$(out Ogevia-prod-WebHosting WebOrigin); API=$(out "$API_STACK" ApiUrl)
SNAPSHOT_ID=$(jq -r .snapshot "$RB/MANIFEST.json")
# The admin host in any state (check 11 reads its security groups; it need not be running).
IID=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$ADMIN_TAG" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
for v in FN API_ID POLICY_ARN WEB API SNAPSHOT_ID IID; do [[ -n "${!v}" && "${!v}" != None && "${!v}" != null ]] || die "missing $v"; done
[[ "$FN" == "$(jq -r .lambda "$RB/MANIFEST.json")" ]] || die "the API Lambda is not the one captured before the deployment"
echo "Lambda $FN, API $API_ID, web $WEB, admin host $IID."

phase "4/4 Live verification (read-only, corrected checks)"
[[ -f "$VERIFY" ]] && cp "$VERIFY" "$RUN/VERIFY-$TS-before-rerun.txt"
[[ -f "$RUN/REPORT.md" ]] && cp "$RUN/REPORT.md" "$RUN/REPORT-$TS-before-rerun.md"
# shellcheck source=release-0036-live-checks.sh
source "$SLICE/release-0036-live-checks.sh"
live_checks
echo "Lambda configuration fields that differ from the pre-deployment capture (environment values hashed):"
sed 's/^/  /' "$RUN/handler-config-diff.txt"
write_report
[[ "$FAILS" == 0 ]] || die "live verification failed ($FAILS of $TOTAL). Nothing was changed; send $VERIFY and $RUN/handler-config-diff.txt to Claude"
done_ verified
done_ complete
cat <<EOF

==============================================
OGEVIA 0027-0036 VERIFIED (TEST): $PASSES/$TOTAL PASS
==============================================
Report: $RUN/REPORT.md   Verification: $VERIFY   Earlier result kept: $RUN/VERIFY-$TS-before-rerun.txt
EOF
