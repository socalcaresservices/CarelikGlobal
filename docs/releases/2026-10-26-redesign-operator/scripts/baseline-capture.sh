#!/usr/bin/env bash
# =============================================================================
# TEST release 2026-10-26-redesign, STEP 5: READ-ONLY baseline and recovery capture. AWS verbs: sts get-caller-identity; cloudformation describe-stacks / list-stack-resources / get-template;
# lambda get-function-configuration / get-function; apigatewayv2 get-routes / get-api; cloudfront get-distribution-config; cognito-idp describe-user-pool-client; rds describe-db-instances; events list-rules; s3api head-object (the previous API code asset); s3 sync FROM the site bucket (download only);
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

echo "-- what is TEST running? The live templates are compared with this release's synthesized assembly (ASSEMBLY, default /tmp/ogevia-cdk.out). This is information for the owner: the authoritative gate is Step 8 (deploy-guard.sh check)."
ASM="${ASSEMBLY:-/tmp/ogevia-cdk.out}"
if [[ -d "$ASM" ]]; then
  for S in "${TEST_STACKS[@]}"; do
    python3 -I -B "$HERE/diff_gate.py" template --stack "$S" --live "live/$S.json" --new "$ASM/$S.template.json" > "gate-baseline-$S.txt" 2>&1; GRC=$?
    echo "$S: $(grep -E '^EXPECTED-ONLY' "gate-baseline-$S.txt" | head -1)  (details: gate-baseline-$S.txt)"
    [[ $GRC == 0 ]] || echo "   WARN the live $S is not 'this release minus its allowed difference'; Step 8 will stop on it"
  done
else echo "NOTE no assembly at $ASM yet (Step 4): the live-versus-release comparison is made in Step 8"; fi

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

echo "-- API routes, CORS (rollback and post-check inputs)"
API_ID=$(A cloudformation list-stack-resources --stack-name "$API" --query "StackResourceSummaries[?ResourceType=='AWS::ApiGatewayV2::Api'].PhysicalResourceId" --output text 2>/dev/null)
[[ "$API_ID" =~ ^[a-z0-9]{6,12}$ ]] && echo "$API_ID" > api-id.txt && ok "API id $API_ID" || { nope "the HTTP API was not found in $API"; API_ID=""; }
if [[ -n "$API_ID" ]]; then
  A apigatewayv2 get-routes --api-id "$API_ID" --max-items 1000 --query 'Items[].RouteKey' --output json > routes-before.json 2>/dev/null && jq -e 'type=="array" and length>0' routes-before.json >/dev/null && ok "$(jq 'length' routes-before.json) API routes captured" || nope "cannot capture the API routes"
  [[ "$(jq '[.[] | select(startswith("GET /v1/staff") or startswith("POST /v1/staff") or contains("role-permissions"))] | length' routes-before.json 2>/dev/null)" == 0 ]] && ok "no staff route exists yet (this release adds them)" || echo "NOTE some staff routes already exist on TEST: the gate in Step 8 decides whether that is acceptable"
  A apigatewayv2 get-api --api-id "$API_ID" --query CorsConfiguration --output json > cors-before.json 2>/dev/null && jq -e . cors-before.json >/dev/null && ok "CORS origins: $(jq -r '.AllowOrigins | join(", ")' cors-before.json)" || nope "cannot capture the CORS configuration"
fi
echo "-- hostnames (decision D2: the code expects them to be live already; recorded, not changed)"
DIST_CFG=$(A cloudfront get-distribution-config --id "$DIST" --output json 2>/dev/null) && jq '{aliases:.DistributionConfig.Aliases.Items, certificate:.DistributionConfig.ViewerCertificate.ACMCertificateArn}' <<<"$DIST_CFG" > cloudfront-before.json && echo "CloudFront aliases/certificate: $(jq -c . cloudfront-before.json)" || nope "cannot read the CloudFront distribution configuration"
CLIENT=$(A cloudformation list-stack-resources --stack-name "$WEB" --query "StackResourceSummaries[?ResourceType=='AWS::Cognito::UserPoolClient'].PhysicalResourceId" --output text 2>/dev/null)
POOL=us-west-2_849AYz5J7
if [[ -n "$CLIENT" && "$CLIENT" != None ]]; then
  A cognito-idp describe-user-pool-client --user-pool-id "$POOL" --client-id "$CLIENT" --query 'UserPoolClient.{callbacks:CallbackURLs,logouts:LogoutURLs}' --output json > cognito-client-before.json 2>/dev/null && echo "TEST app client callbacks: $(jq -c . cognito-client-before.json)" || nope "cannot read the TEST app client"
else echo "NOTE no Cognito app client in $WEB"; fi

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
