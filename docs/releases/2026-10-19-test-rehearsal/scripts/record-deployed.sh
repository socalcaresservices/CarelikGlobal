#!/usr/bin/env bash
# =============================================================================
# TEST rehearsal, STEP 16: READ-ONLY record of what is DEPLOYED, for the owner. Writes $OGEVIA_BEFORE/DEPLOYED_RECORD.txt and prints it.
#   OGEVIA_EXPECT_COMMIT=<40-hex> OGEVIA_TARBALL_SHA256=<64-hex> bash record-deployed.sh
# Maps the deployed artifacts to the tarball's BUILD_INFO commit: the live Lambda CodeSha256 (read back with `aws lambda get-function-configuration`), the CDK asset key of the
# Handler in the DEPLOYED stack template (must be the release's pinned key), the web bundle's version string, the stack statuses, the TEST URLs. AWS verbs: sts, cloudformation
# describe-stacks/get-template/list-stack-resources, lambda get-function-configuration. Exit 0 = every artifact maps to the commit; 1 = it does not.
# =============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ROOT="$(cd "$HERE/../../../.." && pwd)"
. "$HERE/pkg-lib.sh"
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""
B="${OGEVIA_BEFORE:-$HOME/ogevia-before}"
RELEASE_KEY=eab95a809b3b95b7479cfe6a572e1be0ea068ef6f12751419669443397fe7eda.zip
A() { timeout --foreground -k 5 "${OGEVIA_AWS_TIMEOUT:-60}" aws "$@"; }
[[ "${OGEVIA_EXPECT_COMMIT:-}" =~ ^[0-9a-f]{40}$ && "${OGEVIA_TARBALL_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] || { echo "usage: set OGEVIA_EXPECT_COMMIT (40 hex) and OGEVIA_TARBALL_SHA256 (64 hex)" >&2; exit 2; }
bad=0; ok() { echo "PASS $*"; }; nope() { echo "FAIL $*"; bad=1; }
BI=$(pkg_code_commit) || BI=""; [[ "$BI" == "$OGEVIA_EXPECT_COMMIT" ]] && ok "BUILD_INFO code commit $BI" || nope "BUILD_INFO commit '${BI:-unreadable}' is not $OGEVIA_EXPECT_COMMIT"
FN=$(cat "$B/handler-function-name.txt" 2>/dev/null); [[ -n "$FN" ]] || nope "no captured handler function name"
CFG=$(A lambda get-function-configuration --function-name "$FN" --output json 2>/dev/null) || { nope "cannot read the Lambda configuration"; CFG='{}'; }
B64=$(jq -r '.CodeSha256 // empty' <<<"$CFG"); OLD=$(jq -r '.CodeSha256 // empty' "$B/lambda-config-before.json" 2>/dev/null)
HEX=$(printf '%s' "$B64" | base64 -d 2>/dev/null | od -An -tx1 | tr -d ' \n')
[[ -n "$B64" && "$B64" != "$OLD" ]] && ok "Lambda CodeSha256 $B64 (before: ${OLD:-unknown})" || nope "the Lambda CodeSha256 is empty or equals the one before the rehearsal"
TPL=$(A cloudformation get-template --stack-name Ogevia-prod-ServiceVerificationApi --template-stage Original --query TemplateBody --output json 2>/dev/null) || TPL='{}'
KEY=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key|startswith("Handler"))) | .value.Properties.Code.S3Key][0] // empty' <<<"$TPL")
[[ "$KEY" == "$RELEASE_KEY" ]] && ok "the DEPLOYED stack's Handler asset is the release's pinned build $KEY" || nope "the deployed Handler asset is '$KEY', not $RELEASE_KEY"
[[ "$(jq -r .LastUpdateStatus <<<"$CFG")" == Successful ]] && ok "Lambda LastUpdateStatus Successful" || nope "Lambda LastUpdateStatus is not Successful"
WEBURL=$(cat "$B/web-url-before.txt" 2>/dev/null); APIURL=$(cat "$B/api-url-before.txt" 2>/dev/null)
WV=$(OGEVIA_EXPECT_COMMIT="$OGEVIA_EXPECT_COMMIT" OGEVIA_BEFORE="$B" bash "$HERE/web-verify.sh" "$WEBURL" 2>&1); [[ $? == 0 ]] && ok "web bundle version string = $OGEVIA_EXPECT_COMMIT" || { nope "web verification failed"; echo "$WV" | tail -4; }
ST=""; for s in Ogevia-prod-EvidenceStorage Ogevia-prod-NetworkEgress Ogevia-prod-WebHosting Ogevia-prod-ServiceVerificationApi Ogevia-prod-Observability; do ST+="$s $(A cloudformation describe-stacks --stack-name "$s" --query 'Stacks[0].StackStatus' --output text 2>/dev/null)"$'\n'; done
{
  echo "DEPLOYED SHA          : $OGEVIA_EXPECT_COMMIT"
  echo "recorded (UTC)        : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "tarball sha256        : $OGEVIA_TARBALL_SHA256"
  echo "BUILD_INFO            : $(jq -c . "$PKG_ROOT/BUILD_INFO.json" 2>/dev/null)"
  echo "TEST web URL          : $WEBURL"
  echo "TEST API URL          : $APIURL"
  echo "Lambda function       : $FN"
  echo "Lambda CodeSha256 (b64): $B64"
  echo "Lambda CodeSha256 (hex): $HEX"
  echo "Lambda LastModified   : $(jq -r .LastModified <<<"$CFG")"
  echo "Handler asset in stack: $KEY"
  echo "web bundle version    : VITE_APP_VERSION:\"$OGEVIA_EXPECT_COMMIT\" (verified by web-verify.sh)"
  echo "stacks:"; printf '%s' "$ST" | sed 's/^/  /'
} | tee "$B/DEPLOYED_RECORD.txt"
[[ $bad == 0 ]] && { echo "RECORDED: every deployed artifact maps to $OGEVIA_EXPECT_COMMIT"; exit 0; } || { echo "STOP: an artifact does not map to the approved commit."; exit 1; }
