#!/usr/bin/env bash
# =============================================================================
# TEST rehearsal, STEP 5: READ-ONLY baseline and recovery capture. AWS verbs: sts get-caller-identity; cloudformation describe-stacks / list-stack-resources / get-template;
# lambda get-function-configuration / get-function; ec2 describe-vpc-endpoints; rds describe-db-instances; events list-rules; s3api head-object (the previous API code asset); s3 sync FROM the site bucket (download only);
# plus curl of the TEST web origin and the Lambda code URL. Nothing is created, changed or deleted in AWS. It writes files under $OGEVIA_BEFORE (default ~/ogevia-before).
#   bash baseline-capture.sh
# Exit 0 = baseline captured and every check passed; 1 = a check failed (STOP); 2 = usage.
# =============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACCOUNT=300094796789; REGION=us-west-2
TEST_STACKS=(Ogevia-prod-EvidenceStorage Ogevia-prod-NetworkEgress Ogevia-prod-WebHosting Ogevia-prod-ServiceVerificationApi Ogevia-prod-Observability)
API=Ogevia-prod-ServiceVerificationApi; WEB=Ogevia-prod-WebHosting; NET=Ogevia-prod-NetworkEgress
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION AWS_PAGER=""
B="${OGEVIA_BEFORE:-$HOME/ogevia-before}"
bad=0; ok() { echo "PASS $*"; }; nope() { echo "FAIL $*"; bad=1; }
A() { timeout --foreground -k 5 "${OGEVIA_AWS_TIMEOUT:-90}" aws "$@"; }
for t in aws jq curl python3 sha256sum openssl base64; do command -v "$t" >/dev/null 2>&1 || { echo "FAIL missing tool '$t'"; exit 1; }; done
mkdir -p "$B/live" && cd "$B" || { echo "FAIL cannot create $B"; exit 1; }

ID=$(A sts get-caller-identity --output json 2>/dev/null) || { echo "FAIL no valid AWS credentials (open CloudShell in $REGION and sign in again)"; exit 1; }
echo "identity: $(jq -r .Arn <<<"$ID")"
[[ "$(jq -r .Account <<<"$ID")" == "$ACCOUNT" ]] && ok "account $ACCOUNT" || { nope "wrong AWS account $(jq -r .Account <<<"$ID")"; exit 1; }
[[ "${AWS_REGION}" == "$REGION" && "${AWS_DEFAULT_REGION}" == "$REGION" ]] && ok "region $REGION" || nope "region is not $REGION"

: > stacks.txt
for S in "${TEST_STACKS[@]}"; do
  D=$(A cloudformation describe-stacks --stack-name "$S" --output json 2>/dev/null) || { nope "stack $S cannot be read"; continue; }
  ST=$(jq -r '.Stacks[0].StackStatus' <<<"$D")
  echo "$S $ST" | tee -a stacks.txt
  [[ "$ST" == CREATE_COMPLETE || "$ST" == UPDATE_COMPLETE ]] || nope "$S is $ST, not a settled status"
  jq -r '.Stacks[0].Outputs[]? | "   output " + .OutputKey + " = " + .OutputValue' <<<"$D" | grep -E "Url|Origin|Bucket|DistributionId|Endpoint|Name" | head -12
  jq '.Stacks[0].Outputs' <<<"$D" > "outputs-$S.json"
  A cloudformation get-template --stack-name "$S" --template-stage Original --query TemplateBody --output json > "live/$S.json" 2>/dev/null && jq -e 'has("Resources")' "live/$S.json" >/dev/null || nope "cannot capture the template of $S"
done
out() { jq -r --arg k "$2" '.[] | select(.OutputKey==$k) | .OutputValue' "outputs-$1.json" 2>/dev/null; }
API_URL=$(out $API ApiUrl); WEB_URL=$(out $WEB WebOrigin); BUCKET=$(out $WEB SiteBucketName); DIST=$(out $WEB DistributionId)
echo "TEST API url: ${API_URL:-UNKNOWN}"; echo "TEST web url: ${WEB_URL:-UNKNOWN}"
[[ -n "$API_URL" && -n "$WEB_URL" && -n "$BUCKET" && -n "$DIST" ]] || nope "an output (ApiUrl, WebOrigin, SiteBucketName, DistributionId) is missing"
printf '%s\n' "$API_URL" > api-url-before.txt; printf '%s\n' "$WEB_URL" > web-url-before.txt

echo "-- live stacks equal the recorded baseline (the earlier candidate d893276)?"
python3 -I -B "$HERE/assembly_check.py" --live-dir "$B/live" > baseline-check.txt; BRC=$?; cat baseline-check.txt
[[ $BRC == 0 ]] && ok "live baseline check" || nope "the live stacks are not the recorded baseline"

echo "-- Lambda"
FN=$(A cloudformation list-stack-resources --stack-name "$API" --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function' && starts_with(LogicalResourceId,'Handler')].PhysicalResourceId" --output text 2>/dev/null)
[[ -n "$FN" && "$FN" != None ]] || { nope "handler function not found"; exit 1; }
printf '%s\n' "$FN" > handler-function-name.txt; echo "handler: $FN"
A lambda get-function-configuration --function-name "$FN" --output json > lambda-config-before.json 2>/dev/null || { nope "cannot read the Lambda configuration"; exit 1; }
LIVE_SHA=$(jq -r .CodeSha256 lambda-config-before.json); echo "live CodeSha256 (before): $LIVE_SHA"
DBN=$(jq -r '.Environment.Variables.DB_NAME // empty' lambda-config-before.json); ENVN=$(jq -r '.Environment.Variables.OGEVIA_ENV // empty' lambda-config-before.json)
[[ "$DBN" == ogevia_sv_test && "$ENVN" != prd ]] && ok "the Lambda serves ogevia_sv_test (OGEVIA_ENV=$ENVN): this is TEST" || nope "the Lambda serves '$DBN' with OGEVIA_ENV='$ENVN': not TEST"
URL=$(A lambda get-function --function-name "$FN" --query 'Code.Location' --output text 2>/dev/null)
if [[ -n "$URL" && "$URL" != None ]] && curl -sS -o lambda-code-before.zip "$URL"; then
  ZIP=$(openssl dgst -sha256 -binary lambda-code-before.zip | base64)
  [[ "$ZIP" == "$LIVE_SHA" ]] && ok "captured code zip hash equals the live CodeSha256" || nope "captured zip hash $ZIP differs from CodeSha256 $LIVE_SHA"
else nope "cannot download the Lambda code"; fi

echo "-- the previous API code is still in the CDK asset bucket (the quick API rollback needs it)"
AB=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key|startswith("Handler"))) | .value.Properties.Code.S3Bucket][0] // empty' "live/$API.json" 2>/dev/null)
AK=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key|startswith("Handler"))) | .value.Properties.Code.S3Key][0] // empty' "live/$API.json" 2>/dev/null)
printf '%s\n%s\n' "$AB" "$AK" > previous-api-asset.txt
SZ=$(A s3api head-object --bucket "$AB" --key "$AK" --query ContentLength --output text 2>/dev/null)
[[ "$SZ" =~ ^[0-9]+$ ]] && ok "previous API code asset s3://$AB/$AK exists ($SZ bytes)" || nope "the previous API code asset s3://${AB:-?}/${AK:-?} cannot be read: the quick API rollback would not work (the captured zip is the fallback)"

echo "-- S3 gateway endpoint policy (shared with the PRODUCTION bucket)"
EP=$(A cloudformation list-stack-resources --stack-name "$NET" --query "StackResourceSummaries[?ResourceType=='AWS::EC2::VPCEndpoint' && starts_with(LogicalResourceId,'S3GatewayEndpoint')].PhysicalResourceId" --output text 2>/dev/null)
[[ "$EP" =~ ^vpce-[0-9a-f]+$ ]] && echo "$EP" > endpoint-id.txt || { nope "the S3 gateway endpoint was not found in $NET"; EP=""; }
if [[ -n "$EP" ]]; then
  A ec2 describe-vpc-endpoints --vpc-endpoint-ids "$EP" --query 'VpcEndpoints[0].PolicyDocument' --output text > endpoint-policy-before.json 2>/dev/null
  if jq -e '.Statement' endpoint-policy-before.json >/dev/null 2>&1; then
    N=$(jq '[.Statement[] | .Resource | if type=="array" then .[] else . end] | length' endpoint-policy-before.json)
    TESTN=$(jq -r '[.Statement[] | .Resource | if type=="array" then .[] else . end | select(contains("ogevia-prod-signature-evidence"))] | length' endpoint-policy-before.json)
    PRDN=$(jq -r '[.Statement[] | .Resource | if type=="array" then .[] else . end | select(contains("ogevia-prd-signature-evidence"))] | length' endpoint-policy-before.json)
    echo "endpoint $EP policy: $N resources ($TESTN for the TEST bucket, $PRDN for the PRODUCTION bucket)"
    [[ "$TESTN" -ge 1 && "$PRDN" -ge 1 ]] && ok "endpoint policy captured with entries for both buckets" || nope "the endpoint policy does not list both buckets: do not continue"
  else nope "the endpoint policy could not be read as JSON"; fi
fi

echo "-- RDS (read-only)"
R=$(A rds describe-db-instances --db-instance-identifier ogevia-prod-postgres --query 'DBInstances[0].[DBInstanceStatus,PubliclyAccessible,StorageEncrypted,Engine,EngineVersion,DBInstanceClass,MultiAZ,BackupRetentionPeriod]' --output text 2>/dev/null)
echo "ogevia-prod-postgres: $R"
awk -v r="$R" 'BEGIN{split(r,a,"\t"); exit !(a[1]=="available" && a[2]=="False" && a[3]=="True")}' && ok "RDS available, not publicly accessible, encrypted" || nope "RDS is not available / private / encrypted"

echo "-- web bucket capture (download only) and the live page"
rm -rf web-before && A s3 sync "s3://$BUCKET" web-before --only-show-errors && (cd web-before && find . -type f -print0 | sort -z | xargs -0 sha256sum > ../web-before.sha256) && echo "web files captured: $(wc -l < web-before.sha256)" || nope "cannot capture the site bucket"
echo "index.html sha256 (captured): $(sha256sum web-before/index.html 2>/dev/null | cut -d' ' -f1)"
LIVEIDX=$(curl -sS "$WEB_URL/index.html" | sha256sum | cut -d' ' -f1); echo "index.html sha256 (served):   $LIVEIDX"
echo "$LIVEIDX" > web-index-sha256-before.txt
echo "-- ComplianceSweep rule"
A events list-rules --query 'Rules[?contains(Name,`ComplianceSweep`)].[Name,State]' --output text 2>/dev/null | tee sweep-before.txt
grep -q ENABLED sweep-before.txt && ok "ComplianceSweep is ENABLED (expected: it is a verified no-op while enforcement is off)" || nope "ComplianceSweep is not ENABLED"
echo
if [[ $bad == 0 ]]; then echo "BASELINE CAPTURED: $B  (keep it until the release is accepted)"; exit 0; else echo "STOP: a baseline check failed. Nothing was changed."; exit 1; fi
