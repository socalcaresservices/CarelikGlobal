#!/usr/bin/env bash
# P0 PRODUCTION BASELINE CAPTURE (READ-ONLY). Captures what the production environment (Ogevia-prd-* plus the shared Ogevia-prod-NetworkEgress) is running today, so the release
# gate can be written against facts and so every part of the release has a recovery source. Writes $B (default ~/ogevia-prd-before). Prints no secret value.
#   bash p0-baseline-capture.sh
# Captured: the live CloudFormation templates of the five Ogevia-prd-* stacks and Ogevia-prod-NetworkEgress; stack status, termination protection, outputs, parameters; the production
# Lambda's configuration (environment VARIABLE NAMES, and the values of DB_NAME and OGEVIA_ENV only), its code zip (download) and the previous code asset in the CDK asset bucket; the
# whole production web bucket (download) and what the served page and bundle say (version, environment, API host); API route count; the ComplianceSweep rule; RDS facts and snapshot
# names; the S3 gateway endpoint policy; Cognito MFA; secret METADATA; evidence-bucket protections.
# Exit 0 = every read worked and no check failed; 1 = a check failed (read the FAIL lines); other output is information for the release plan.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need aws jq curl python3 sha256sum openssl base64 timeout
say "== P0 production baseline $(date -u +%FT%TZ) =="; check_account
STACKS=(Ogevia-prd-DatabaseSecret Ogevia-prd-EvidenceStorage Ogevia-prd-WebHosting Ogevia-prd-ServiceVerificationApi Ogevia-prd-Observability Ogevia-prod-NetworkEgress)
API=Ogevia-prd-ServiceVerificationApi; WEB=Ogevia-prd-WebHosting; NET=Ogevia-prod-NetworkEgress
mkdir -p "$B/live"; cd "$B" || stop "cannot enter $B"
: > stacks.txt
for S in "${STACKS[@]}"; do
  D=$(A cloudformation describe-stacks --stack-name "$S" --output json 2>/dev/null) || { nope "stack $S cannot be read"; continue; }
  ST=$(jq -r '.Stacks[0].StackStatus' <<<"$D"); TP=$(jq -r '.Stacks[0].EnableTerminationProtection' <<<"$D"); LU=$(jq -r '.Stacks[0].LastUpdatedTime // .Stacks[0].CreationTime' <<<"$D")
  echo "$S status=$ST termination_protection=$TP last_updated=$LU" | tee -a stacks.txt
  [[ "$ST" == CREATE_COMPLETE || "$ST" == UPDATE_COMPLETE ]] || nope "$S is $ST, not a settled status"
  jq '.Stacks[0].Outputs // []' <<<"$D" > "outputs-$S.json"; jq '.Stacks[0].Parameters // []' <<<"$D" > "params-$S.json"
  A cloudformation get-template --stack-name "$S" --template-stage Original --output json 2>/dev/null | jq '.TemplateBody // .' > "live/$S.json" && jq -e 'has("Resources")' "live/$S.json" >/dev/null 2>&1 || nope "cannot capture the template of $S"
  A cloudformation list-stack-resources --stack-name "$S" --output json 2>/dev/null > "resources-$S.json" || nope "cannot list the resources of $S"
done
out() { jq -r --arg k "$2" '.[] | select(.OutputKey==$k) | .OutputValue' "outputs-$1.json" 2>/dev/null; }
API_URL=$(out $API ApiUrl); WEB_URL=$(out $WEB WebOrigin); BUCKET=$(out $WEB SiteBucketName); DIST=$(out $WEB DistributionId)
info "production API url: ${API_URL:-UNKNOWN}"; info "production web url: ${WEB_URL:-UNKNOWN}"
[[ -n "$API_URL" && -n "$WEB_URL" && -n "$BUCKET" && -n "$DIST" ]] || nope "an output (ApiUrl, WebOrigin, SiteBucketName, DistributionId) is missing"
printf '%s\n' "$API_URL" > api-url-before.txt; printf '%s\n' "$WEB_URL" > web-url-before.txt

say "-- Lambda (handler and identity)"
FN=$(jq -r '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId|startswith("Handler")))][0].PhysicalResourceId // empty' "resources-$API.json" 2>/dev/null)
IDFN=$(jq -r '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId|startswith("IdentityHandler")))][0].PhysicalResourceId // empty' "resources-$API.json" 2>/dev/null)
[[ -n "$FN" ]] || { nope "handler function not found in $API"; FN=""; }
if [[ -n "$FN" ]]; then
  printf '%s\n' "$FN" > handler-function-name.txt
  A lambda get-function-configuration --function-name "$FN" --output json > lambda-config-raw.json 2>/dev/null || nope "cannot read the Lambda configuration"
  jq '{FunctionName,Runtime,Handler,MemorySize,Timeout,LastModified,LastUpdateStatus,State,CodeSha256,CodeSize,LoggingConfig,Architectures,EnvironmentVariableNames:(.Environment.Variables|keys),DB_NAME:.Environment.Variables.DB_NAME,OGEVIA_ENV:.Environment.Variables.OGEVIA_ENV}' lambda-config-raw.json > lambda-config-before.json 2>/dev/null; rm -f lambda-config-raw.json
  LIVE_SHA=$(jq -r .CodeSha256 lambda-config-before.json); DBN=$(jq -r '.DB_NAME // empty' lambda-config-before.json); ENVN=$(jq -r '.OGEVIA_ENV // empty' lambda-config-before.json)
  info "handler $FN: CodeSha256 $LIVE_SHA, last modified $(jq -r .LastModified lambda-config-before.json), runtime $(jq -r .Runtime lambda-config-before.json)"
  [[ "$DBN" == ogevia_prd && "$ENVN" == prd ]] && ok "the Lambda serves ogevia_prd with OGEVIA_ENV=prd: this is PRODUCTION" || nope "the Lambda serves '$DBN' with OGEVIA_ENV='$ENVN': not production"
  URL=$(A lambda get-function --function-name "$FN" --output json 2>/dev/null | jq -r '.Code.Location // empty')
  if [[ -n "$URL" ]] && curl -sS -o lambda-code-before.zip "$URL"; then
    ZIP=$(openssl dgst -sha256 -binary lambda-code-before.zip | base64)
    [[ "$ZIP" == "$LIVE_SHA" ]] && ok "the downloaded code zip hash equals the live CodeSha256 (a recovery copy exists: lambda-code-before.zip)" || nope "the downloaded zip hash $ZIP differs from CodeSha256 $LIVE_SHA"
  else nope "cannot download the Lambda code"; fi
  AB=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key|startswith("Handler"))) | .value.Properties.Code.S3Bucket][0] // empty' "live/$API.json" 2>/dev/null)
  AK=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key|startswith("Handler"))) | .value.Properties.Code.S3Key][0] // empty' "live/$API.json" 2>/dev/null)
  printf '%s\n%s\n' "$AB" "$AK" > previous-api-asset.txt
  info "the live handler's code asset key (the build the stack was last deployed with): ${AK:-UNKNOWN}"
  SZ=$(A s3api head-object --bucket "$AB" --key "$AK" --output json 2>/dev/null | jq -r '.ContentLength // empty')
  [[ "$SZ" =~ ^[0-9]+$ ]] && ok "the previous code asset s3://$AB/$AK exists ($SZ bytes): the quick API rollback works" || nope "the previous code asset cannot be read: only the downloaded zip is a recovery copy"
fi
if [[ -n "$IDFN" ]]; then A lambda get-function-configuration --function-name "$IDFN" --output json 2>/dev/null | jq '{FunctionName,Runtime,LastModified,CodeSha256}' > identity-config-before.json && info "identity function: CodeSha256 $(jq -r .CodeSha256 identity-config-before.json)"; fi

say "-- API routes and schedule"
APIID=$(jq -r '[.StackResourceSummaries[] | select(.ResourceType=="AWS::ApiGatewayV2::Api")][0].PhysicalResourceId // empty' "resources-$API.json" 2>/dev/null)
if [[ -n "$APIID" ]]; then
  NR=$(A apigatewayv2 get-routes --api-id "$APIID" --output json 2>/dev/null | jq '.Items | length') && info "routes on the production API: $NR (the release has 228)" || nope "cannot count the routes"
fi
A events list-rules --output json 2>/dev/null | jq -r '.Rules[]? | select(.Name | test("ComplianceSweep")) | .Name + " " + .State' | tee sweep-before.txt >/dev/null
[[ -s sweep-before.txt ]] && info "ComplianceSweep rule(s): $(tr '\n' ';' < sweep-before.txt)" || nope "no ComplianceSweep rule found"

say "-- production web (the served page, direct hashes)"
if [[ -n "$BUCKET" ]]; then
  rm -rf web-before && A s3 sync "s3://$BUCKET" web-before --only-show-errors && (cd web-before && find . -type f -print0 | sort -z | xargs -0 sha256sum > ../web-before.sha256) && info "web files captured: $(wc -l < web-before.sha256) (recovery copy: web-before/)" || nope "cannot download the web bucket"
fi
if [[ -n "$WEB_URL" ]]; then
  curl -fsS "$WEB_URL/index.html" -o served-index.html 2>/dev/null && { SH=$(sha256sum served-index.html | cut -d' ' -f1); info "served index.html sha256 $SH"; [[ -f web-before/index.html && "$(sha256sum web-before/index.html | cut -d' ' -f1)" == "$SH" ]] && ok "the served index.html equals the bucket's (direct byte hash)" || info "the served index.html differs from the bucket's (CloudFront may lag, or the bucket changed)"; } || nope "cannot fetch the served page"
  MAIN=$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' served-index.html 2>/dev/null | head -1)
  if [[ -n "$MAIN" ]] && curl -fsS "$WEB_URL/$MAIN" -o served-main.js 2>/dev/null; then
    V=$(grep -o 'VITE_APP_VERSION:"[^"]*"' served-main.js | head -1); E=$(grep -o 'VITE_APP_ENV:"[^"]*"' served-main.js | head -1)
    HOSTS=$(grep -o '[a-z0-9]*\.execute-api\.[a-z0-9.-]*' served-main.js | sort -u | tr '\n' ' ')
    info "main bundle $MAIN: version string: ${V:-NONE (the build carries no version string)}; environment: ${E:-none}; API host(s) in the bundle: ${HOSTS:-none}"
    PRD_API_ID=$(sed -E 's#^https://([a-z0-9]+)\..*#\1#' <<<"$API_URL")
    if grep -q "${PRD_API_ID}\.execute-api" served-main.js; then ok "the production web references the production API host (${PRD_API_ID}.execute-api...)"; else nope "the production web does NOT reference the production API host ${PRD_API_ID}: it may call another API"; fi
    OTHER=$(tr ' ' '\n' <<<"$HOSTS" | grep -v "^${PRD_API_ID}\." | grep . | tr '\n' ' '); [[ -z "$OTHER" ]] || info "the bundle also names other API host(s): $OTHER"
  else nope "cannot fetch the main bundle"; fi
  curl -sS -o /dev/null -w '%{http_code}' "$WEB_URL/config.json" > config-http.txt 2>/dev/null; info "config.json HTTP $(cat config-http.txt)"
fi

say "-- shared S3 gateway endpoint policy (owned by $NET)"
EP=$(jq -r '[.StackResourceSummaries[] | select(.ResourceType=="AWS::EC2::VPCEndpoint" and (.LogicalResourceId|startswith("S3GatewayEndpoint")))][0].PhysicalResourceId // empty' "resources-$NET.json" 2>/dev/null)
if [[ "$EP" =~ ^vpce-[0-9a-f]+$ ]]; then
  A ec2 describe-vpc-endpoints --vpc-endpoint-ids "$EP" --output json 2>/dev/null | jq -c '.VpcEndpoints[0].PolicyDocument | if type=="string" then fromjson else . end' > endpoint-policy-before.json
  if jq -e '.Statement' endpoint-policy-before.json >/dev/null 2>&1; then
    TESTN=$(jq -r '[.Statement[] | .Resource | if type=="array" then .[] else . end | select(contains("ogevia-prod-signature-evidence"))] | length' endpoint-policy-before.json); PRDN=$(jq -r '[.Statement[] | .Resource | if type=="array" then .[] else . end | select(contains("ogevia-prd-signature-evidence"))] | length' endpoint-policy-before.json)
    CDN=$(jq -r '[.Statement[] | .Resource | if type=="array" then .[] else . end | select(contains("client-documents"))] | length' endpoint-policy-before.json)
    info "endpoint $EP policy: $TESTN entries for the TEST bucket, $PRDN for the PRODUCTION bucket, $CDN client-documents entries"
    [[ "$PRDN" -ge 1 ]] && ok "the endpoint policy admits the production evidence bucket" || nope "the endpoint policy has no entry for the production evidence bucket"
  else nope "the endpoint policy could not be read as JSON"; fi
else nope "the S3 gateway endpoint was not found in $NET"; fi

say "-- RDS, identity pool, secret metadata, evidence bucket (read-only)"
R=$(A rds describe-db-instances --db-instance-identifier ogevia-prod-postgres --output json 2>/dev/null | jq -c '.DBInstances[0] | {status:.DBInstanceStatus,public:.PubliclyAccessible,encrypted:.StorageEncrypted,engine:.EngineVersion,class:.DBInstanceClass,multiAz:.MultiAZ,backupDays:.BackupRetentionPeriod,restorable:.LatestRestorableTime,deletionProtection:.DeletionProtection,securityGroups:[.VpcSecurityGroups[].VpcSecurityGroupId]}')
info "ogevia-prod-postgres: $R"
jq -e '.status=="available" and .public==false and .encrypted==true' <<<"$R" >/dev/null 2>&1 && ok "RDS available, private, encrypted" || nope "RDS is not available / private / encrypted"
A rds describe-db-snapshots --db-instance-identifier ogevia-prod-postgres --snapshot-type manual --output json 2>/dev/null | jq -r '.DBSnapshots | sort_by(.SnapshotCreateTime) | reverse | .[] | .DBSnapshotIdentifier + " " + .SnapshotCreateTime' > snapshots-before.txt; info "manual snapshots: $(wc -l < snapshots-before.txt) (newest: $(head -1 snapshots-before.txt))"
POOL=$(jq -r '[.[] | select(.OutputKey|test("UserPool"))][0].OutputValue // empty' "outputs-$WEB.json" 2>/dev/null)
for p in $(A cognito-idp list-user-pools --max-results 20 --output json 2>/dev/null | jq -r '.UserPools[].Id'); do info "Cognito pool $p MFA: $(A cognito-idp describe-user-pool --user-pool-id "$p" --output json 2>/dev/null | jq -r '.UserPool.MfaConfiguration')"; done
A secretsmanager describe-secret --secret-id ogevia/prd/database/app --output json 2>/dev/null | jq -c '{Name,LastChangedDate,RotationEnabled,DeletedDate}' | tee secret-meta-before.json >/dev/null; info "production app secret metadata: $(cat secret-meta-before.json) (no value read)"
for b in $(A s3api list-buckets --output json 2>/dev/null | jq -r '.Buckets[].Name | select(startswith("ogevia-prd"))'); do
  info "bucket $b: versioning $(A s3api get-bucket-versioning --bucket "$b" --output json 2>/dev/null | jq -r '.Status // "none"'), public-access block $(A s3api get-public-access-block --bucket "$b" --output json 2>/dev/null | jq -c '[.PublicAccessBlockConfiguration[]] | all')"
done
echo
if [[ $bad == 0 ]]; then say "BASELINE CAPTURED: $B  (keep it until the release is accepted). Nothing was changed in AWS."; exit 0; else say "STOP: a baseline check failed (see FAIL lines). Nothing was changed in AWS."; exit 1; fi
