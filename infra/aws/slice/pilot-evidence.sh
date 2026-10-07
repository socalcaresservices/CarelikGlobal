#!/usr/bin/env bash
# =============================================================================
# READ-ONLY evidence: did the SCS pilot deployment run, and what is live now?
# Changes nothing in AWS (describe/get/list/lookup calls only; no DB window,
# no smoke suite, no deploy). Writes its output to ~/ogevia-pilot-run/evidence-*.txt.
# Pilot email addresses are masked.
# =============================================================================
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
SHELL_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-unset}}"
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""
RUN="${OGEVIA_PILOT_RUN_DIR:-$HOME/ogevia-pilot-run}"; RB="$RUN/rollback"
API_STACK=Ogevia-prod-ServiceVerificationApi; POOL=us-west-2_849AYz5J7; RDS_ID=ogevia-prod-postgres
SINCE=2026-10-03T00:00:00Z
mkdir -p "$RUN"; OUT="$RUN/evidence-$(date -u +%Y%m%dT%H%M%SZ).txt"
mask() { sed -E 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/<email>/g'; }
plain() { sed -E 's/\x1b\[[0-9;]*m//g'; }
ts() { local f; for f in "$@"; do if [[ -e "$f" ]]; then echo "$(date -u -r "$f" +%FT%TZ) $f"; else echo "MISSING $f"; fi; done; }
entry_js() { grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1; }

{
echo "Evidence collected $(date -u +%FT%TZ); CloudShell region: $SHELL_REGION (CloudShell \$HOME is separate per region)"

echo; echo "== 1. Did the strict recovery reach pilot-deploy.sh? (CloudShell files)"
echo "-- recovery script and strict gate (expected gate sha256 484b7dfcf74a...):"
ts ~/ogevia-recover-scope.sh "$RUN/tools/pilot_diff_gate.py"
echo "gate sha256: $(sha256sum "$RUN/tools/pilot_diff_gate.py" 2>/dev/null | cut -c1-12)"
echo "-- checkout /tmp/ogevia-pilot (CloudShell does NOT keep /tmp after the session ends):"
git -C /tmp/ogevia-pilot rev-parse HEAD 2>&1 | head -1
git -C /tmp/ogevia-pilot status --short 2>&1 | head -5
echo "-- deploy logs (pilot-deploy.sh creates one per start; the recovery's own checks print to the terminal only):"
ts "$RUN"/deploy-*.log
for L in "$RUN"/deploy-*.log; do
  [[ -e "$L" ]] || continue
  echo "## $(basename "$L")"
  plain < "$L" | grep -E '^=== |Deployment scope gate|Scope gate: PASS|STOP|EXITED|Type DEPLOY|Snapshot |Pilot seed|DB window closed|API and web deployed|DEPLOYED TO AWS TEST' | tail -n 14 | mask
done
echo "-- state markers:"; ls -1 "$RUN/state" 2>&1
echo "-- APPROVAL.txt:"; { mask < "$RUN/APPROVAL.txt"; } 2>/dev/null || echo "MISSING (no DEPLOY was recorded)"
echo "-- report / smoke files:"; ts "$RUN/REPORT.md" "$RUN/smoke.log" "$RUN/pilot-smoke.log" "$RUN/scope-gate.txt"
echo "-- shell history:"; grep -nE 'ogevia-recover|pilot-deploy|pilot-recover' ~/.bash_history 2>/dev/null | tail -n 5 || echo "(none recorded)"

echo; echo "== 2. Live AWS, read-only"
aws sts get-caller-identity --query '[Account,Arn]' --output text 2>&1 | mask
echo "-- API stack:"
aws cloudformation describe-stacks --stack-name "$API_STACK" --query 'Stacks[0].[StackStatus,LastUpdatedTime]' --output text 2>&1
aws cloudformation describe-stack-events --stack-name "$API_STACK" --max-items 6 \
  --query 'StackEvents[].[Timestamp,LogicalResourceId,ResourceStatus]' --output text 2>&1 | grep -v '^None$'
echo "-- Lambda (now vs captured before approval):"
FN=$(aws cloudformation list-stack-resources --stack-name "$API_STACK" --output json | jq -r '[.StackResourceSummaries[] | select(.ResourceType == "AWS::Lambda::Function" and (.LogicalResourceId | startswith("Handler")))] | if length == 1 then .[0].PhysicalResourceId else "" end' 2>&1)
aws lambda get-function-configuration --function-name "$FN" \
  --query '[CodeSha256,LastModified,Version,Environment.Variables.DB_NAME]' --output text 2>&1
jq -r '"captured:   \(.CodeSha256)  \(.LastModified)  \(.DB_NAME)"' "$RB/lambda.json" 2>&1
echo "-- API routes:"
API_ID=$(aws cloudformation list-stack-resources --stack-name "$API_STACK" --output json | jq -r '[.StackResourceSummaries[] | select(.ResourceType == "AWS::ApiGatewayV2::Api" and (.LogicalResourceId | startswith("")))] | if length == 1 then .[0].PhysicalResourceId else "" end' 2>&1)
NOW=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query 'Items[].[RouteKey,AuthorizationType]' --output json 2>&1)
echo "now: $(jq length <<<"$NOW") routes ($(jq '[.[]|select(.[1]=="NONE")]|length' <<<"$NOW") public); captured before: $(jq length "$RB/routes.json" 2>&1)"
echo "POST /v1/visits/{visitId}/close: $(jq -r 'if any(.[]; .[0]=="POST /v1/visits/{visitId}/close") then "LIVE" else "not live" end' <<<"$NOW")"
echo "-- Web build (entry script identifies the build):"
BUCKET=$(aws cloudformation describe-stacks --stack-name Ogevia-prod-WebHosting \
  --query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue" --output text 2>&1)
aws s3api head-object --bucket "$BUCKET" --key index.html --query '[LastModified,ETag]' --output text 2>&1
echo "live entry:            $(aws s3 cp "s3://$BUCKET/index.html" - 2>/dev/null | entry_js)"
echo "captured before:       $({ entry_js < "$RB/web/index.html"; } 2>/dev/null)"
echo "built in this run:     $({ entry_js < "$RUN/web-build/index.html"; } 2>/dev/null)"
echo "-- RDS manual snapshots (phase 9 creates ogevia-prod-postgres-pre-pilot-<date>):"
aws rds describe-db-snapshots --db-instance-identifier "$RDS_ID" --snapshot-type manual \
  --query 'DBSnapshots[].[DBSnapshotIdentifier,SnapshotCreateTime,Status]' --output text 2>&1
echo "-- Cognito users created today (phase 10 creates 3; addresses not shown):"
aws cognito-idp list-users --user-pool-id "$POOL" --query 'Users[].[UserCreateDate,UserStatus,Enabled]' --output text 2>&1 \
  | awk -v d="${SINCE:0:10}" 'index($1,d)==1 {n++; print} END {if (!n) print "none"}'
echo "-- Admin host security groups (now; sg-064ffce3bcbe8eb3b must NOT be attached):"
aws ec2 describe-instances --filters Name=tag:Name,Values=ogevia-db-admin-temp \
  --query 'Reservations[].Instances[].[InstanceId,State.Name,join(`,`,SecurityGroups[].GroupId)]' --output text 2>&1
echo "-- CloudTrail since $SINCE (mutations this workflow would make):"
for ev in ExecuteChangeSet UpdateStack UpdateFunctionCode CreateDBSnapshot ModifyInstanceAttribute AdminCreateUser StartSession; do
  n=$(aws cloudtrail lookup-events --start-time "$SINCE" --lookup-attributes "AttributeKey=EventName,AttributeValue=$ev" \
    --query 'Events[].EventTime' --output text 2>&1)
  echo "$ev: ${n:-none}"
done
echo "CreateInvalidation (CloudFront, us-east-1): $(aws cloudtrail lookup-events --region us-east-1 --start-time "$SINCE" \
  --lookup-attributes AttributeKey=EventName,AttributeValue=CreateInvalidation --query 'Events[].EventTime' --output text 2>&1)"
echo
echo "Not collected (would not be read-only): the migration ledger needs the DB window (attaches a security group);"
echo "the smoke suites write test visits. Their only evidence is the files listed in section 1."
} 2>&1 | tee "$OUT"
echo "Saved: $OUT"
