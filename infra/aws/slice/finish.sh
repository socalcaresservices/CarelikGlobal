#!/usr/bin/env bash
# =============================================================================
# Ogevia TEST SLICE: finish deployment, upload the web app, smoke-test.
# Owner-approved (owner-approved-2026-10-01-test-slice). TEST ONLY.
#
# Run from AWS CloudShell (us-west-2) with an AdministratorAccess session.
# The ONLY interaction: type  y  when CDK asks to confirm IAM / security-group
# changes. Everything else is automatic and safe to re-run.
#
# Never: --require-approval never, deletion/replacement, Netlify/Supabase/DNS,
# real data, changes to the ogevia-web client or RDS rules.
# =============================================================================
set -euo pipefail
# Explicit environment label for the web app's banner (never guessed): test | development | production.
APP_ENV="${OGEVIA_APP_ENV:-test}"
case "$APP_ENV" in test|development|production) ;; *) echo "OGEVIA_APP_ENV must be test, development or production (got '$APP_ENV')" >&2; exit 1;; esac
HERE="$(cd "$(dirname "$0")" && pwd)"
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 CDK_DISABLE_CLI_TELEMETRY=true AWS_PAGER=""
ACCOUNT=300094796789
POOL=us-west-2_849AYz5J7
COGNITO_DOMAIN=https://us-west-2849ayz5j7.auth.us-west-2.amazoncognito.com
CAREGIVER_EMAIL=ogemails+ogevia-caregiver@gmail.com
MANAGER_EMAIL=ogemails+ogevia-manager@gmail.com
STACKS=(Ogevia-prod-EvidenceStorage Ogevia-prod-NetworkEgress Ogevia-prod-WebHosting Ogevia-prod-ServiceVerificationApi Ogevia-prod-Observability)
CDK=(npx -y aws-cdk@2.1143.0)
SMOKE_LOG="$HOME/ogevia-smoke-$(date +%Y%m%d-%H%M%S).log"

STEP=0
step() { STEP=$((STEP + 1)); printf '\n\033[1m=== [%s/10] %s\033[0m\n' "$STEP" "$*"; }
die() { printf '\n\033[1;31mSTOPPED at step %s: %s\033[0m\nNothing was deleted. Fix the cause (or send this output to Claude) and re-run the same command.\n' "$STEP" "$*"; exit 1; }
trap 'die "unexpected error on line $LINENO"' ERR

step "Preflight: tools, account, region, role"
for t in aws node npx python3 curl; do command -v "$t" >/dev/null || die "missing tool: $t"; done
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[[ "$NODE_MAJOR" -ge 18 ]] || die "Node.js >= 18 required (found $(node -v))"
ARN=$(aws sts get-caller-identity --query Arn --output text)
ACCT=$(aws sts get-caller-identity --query Account --output text)
[[ "$ACCT" == "$ACCOUNT" ]] || die "signed in to account $ACCT, expected $ACCOUNT"
[[ "$ARN" == *AdministratorAccess* ]] || die "this needs the AdministratorAccess role (current: $ARN)"
echo "Account $ACCT, region $AWS_REGION, role AdministratorAccess: OK"

step "Static safety check of the templates being deployed"
python3 - "$HERE/cdk.out" <<'PY' || die "template safety check failed (see above); not deploying"
import glob, json, sys
bad = []
for f in glob.glob(sys.argv[1] + "/Ogevia-prod-*.template.json"):
    res = json.load(open(f)).get("Resources", {})
    for lid, r in res.items():
        if r["Type"] != "AWS::Lambda::Function" or "VpcConfig" not in r.get("Properties", {}):
            continue
        role = r["Properties"]["Role"]["Fn::GetAtt"][0]
        deps = r.get("DependsOn", [])
        deps = deps if isinstance(deps, list) else [deps]
        eni = [pid for pid, p in res.items() if p["Type"] in ("AWS::IAM::Policy", "AWS::IAM::ManagedPolicy")
               and role in json.dumps(p["Properties"].get("Roles", [])) and "ec2:CreateNetworkInterface" in json.dumps(p["Properties"]["PolicyDocument"])]
        if not eni or not any(e in deps for e in eni):
            bad.append("%s: %s must DependsOn its ENI policy %s" % (f.split("/")[-1], lid, eni))
for b in bad:
    print("  " + b)
print("VPC Lambda ENI-policy ordering: %s" % ("OK" if not bad else "BROKEN"))
sys.exit(1 if bad else 0)
PY

step "Existing state (nothing is recreated)"
BOOT=$(aws cloudformation describe-stacks --stack-name CDKToolkit --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo MISSING)
[[ "$BOOT" == *_COMPLETE && "$BOOT" != *ROLLBACK* ]] || die "CDK bootstrap (CDKToolkit) is $BOOT"
echo "CDK bootstrap: $BOOT"
sub_of() { aws cognito-idp admin-get-user --user-pool-id "$POOL" --username "$1" --query 'UserAttributes[?Name==`sub`].Value' --output text 2>/dev/null || true; }
CG_SUB=$(sub_of "$CAREGIVER_EMAIL"); MG_SUB=$(sub_of "$MANAGER_EMAIL")
[[ "$CG_SUB" =~ ^[0-9a-f-]{36}$ && "$MG_SUB" =~ ^[0-9a-f-]{36}$ ]] || die "the two test sign-ins are missing from Cognito"
echo "Test sign-ins: present (caregiver + manager)"
echo "Test database + synthetic seed: verified through the deployed API in step 8"
# Recovery for ONE known case only: Ogevia-prod-ServiceVerificationApi left in
# ROLLBACK_COMPLETE by a failed FIRST create. CloudFormation cannot update such
# a stack; it must be deleted and re-created. Allowed only when the owner set
# OGEVIA_APPROVE_FAILED_API_CLEANUP=yes AND nothing in the stack is live (every
# resource DELETE_COMPLETE; only retained, empty log groups DELETE_SKIPPED).
recover_failed_api() {
  local s=Ogevia-prod-ServiceVerificationApi
  [[ "${OGEVIA_APPROVE_FAILED_API_CLEANUP:-}" == yes ]] || die "$s is ROLLBACK_COMPLETE. Deleting this failed stack record needs the owner's explicit approval (OGEVIA_APPROVE_FAILED_API_CLEANUP=yes)."
  local live
  live=$(aws cloudformation list-stack-resources --stack-name "$s" \
    --query "StackResourceSummaries[?ResourceStatus!='DELETE_COMPLETE' && !(ResourceStatus=='DELETE_SKIPPED' && ResourceType=='AWS::Logs::LogGroup')].LogicalResourceId" --output text)
  [[ -z "$live" || "$live" == None ]] || die "$s still holds live resources ($live); not deleting it."
  echo "$s: failed first create with no live resources. Removing the failed stack record (approved)."
  aws cloudformation update-termination-protection --stack-name "$s" --no-enable-termination-protection >/dev/null
  aws cloudformation delete-stack --stack-name "$s"
  aws cloudformation wait stack-delete-complete --stack-name "$s"
  echo "$s: removed. Retained empty log groups are kept. CDK re-creates the stack (termination protection on)."
}
for s in "${STACKS[@]}"; do
  st=$(aws cloudformation describe-stacks --stack-name "$s" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo NOT_DEPLOYED)
  case "$st" in
    *_IN_PROGRESS) echo "$s: $st (waiting)"; while aws cloudformation describe-stacks --stack-name "$s" --query 'Stacks[0].StackStatus' --output text | grep -q IN_PROGRESS; do sleep 20; done ;;
    ROLLBACK_COMPLETE) [[ "$s" == Ogevia-prod-ServiceVerificationApi ]] && recover_failed_api || die "$s is ROLLBACK_COMPLETE: owner review needed (only the API stack has an approved recovery)" ;;
    *_FAILED|DELETE_COMPLETE) die "$s is $st: owner review needed before anything else" ;;
    NOT_DEPLOYED) echo "$s: not deployed yet (will be created)" ;;
    *) echo "$s: $st (reused)" ;;
  esac
done

step "Planned infrastructure changes (read-only diff)"
cd "$HERE"
"${CDK[@]}" diff --app cdk.out --method=template --no-notices "${STACKS[@]}" || true

step "Deploy the 5 approved stacks"
printf '\n\033[1;33m>>> Type y when CDK asks. <<<\033[0m\n(CDK asks once per stack that adds IAM permissions or security-group rules.)\n\n'
"${CDK[@]}" deploy --app cdk.out --require-approval broadening --no-notices --outputs-file "$HERE/cdk-outputs.json" "${STACKS[@]}"

step "Read deployment outputs"
out() { aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
WEB=$(out Ogevia-prod-WebHosting WebOrigin); CLIENT=$(out Ogevia-prod-WebHosting TestAppClientId)
BUCKET=$(out Ogevia-prod-WebHosting SiteBucketName); DIST=$(out Ogevia-prod-WebHosting DistributionId)
API=$(out Ogevia-prod-ServiceVerificationApi ApiUrl)
for v in WEB CLIENT BUCKET DIST API; do [[ -n "${!v}" && "${!v}" != None ]] || die "missing stack output $v"; done
python3 - "$HERE/outputs.json" <<PY
import json, sys
json.dump({"WebOrigin": "$WEB", "ApiUrl": "$API", "TestAppClientId": "$CLIENT", "SiteBucketName": "$BUCKET", "DistributionId": "$DIST"}, open(sys.argv[1], "w"), indent=2)
PY
echo "Web: $WEB"; echo "API: $API"

step "Upload the Ogevia web app"
python3 - "$HERE/web/config.json" <<PY
import json, sys
json.dump({
  "VITE_COGNITO_REGION": "us-west-2", "VITE_COGNITO_USER_POOL_ID": "$POOL", "VITE_COGNITO_CLIENT_ID": "$CLIENT",
  "VITE_COGNITO_DOMAIN": "$COGNITO_DOMAIN", "VITE_COGNITO_REDIRECT_URI": "$WEB/auth/callback",
  "VITE_COGNITO_LOGOUT_URI": "$WEB/", "VITE_COGNITO_SCOPES": "openid email",
  "VITE_COGNITO_REFRESH_PERSISTENCE": "session", "VITE_SV_API_BASE_URL": "$API", "VITE_APP_ENV": "$APP_ENV"}, open(sys.argv[1], "w"), indent=2)
PY
aws s3 sync "$HERE/web/assets" "s3://$BUCKET/assets" --only-show-errors --cache-control "public,max-age=31536000,immutable"
aws s3 sync "$HERE/web" "s3://$BUCKET" --only-show-errors --exclude "assets/*" --exclude "index.html" --exclude "config.json"
aws s3 cp "$HERE/web/config.json" "s3://$BUCKET/config.json" --only-show-errors --content-type application/json --cache-control "no-store"
aws s3 cp "$HERE/web/index.html" "s3://$BUCKET/index.html" --only-show-errors --content-type "text/html; charset=utf-8" --cache-control "no-cache"
INV=$(aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" --query Invalidation.Id --output text)
echo "Uploaded. Waiting for CloudFront (distribution + cache refresh)..."
aws cloudfront wait distribution-deployed --id "$DIST"
aws cloudfront wait invalidation-completed --distribution-id "$DIST" --id "$INV"

step "Wait until the site is reachable"
for i in $(seq 1 60); do
  if curl -fsS "$WEB/" 2>/dev/null | grep -q 'id="root"'; then echo "Reachable: $WEB"; break; fi
  [[ "$i" == 60 ]] && die "site not reachable after 20 minutes"
  sleep 20
done

step "Automated smoke tests (about 5 minutes; visits need real minutes on the server clock)"
trap - ERR
set +e
python3 "$HERE/smoke.py" --outputs "$HERE/outputs.json" --caregiver-sub "$CG_SUB" --manager-sub "$MG_SUB" 2>&1 | tee "$SMOKE_LOG"
SMOKE=${PIPESTATUS[0]}
set -e
[[ "$SMOKE" == 0 ]] || die "smoke tests failed (details above; log: $SMOKE_LOG)"

step "Done"
cat <<BANNER

========================================
OGEVIA TEST BUILD READY
========================================

Web URL:
$WEB

Caregiver:
$CAREGIVER_EMAIL

Manager:
$MANAGER_EMAIL

Automated smoke tests:
PASS

Ready for owner browser testing:
YES

(First sign-in: use the temporary password from the invitation email, choose a
new password, then set up an authenticator app. The smoke test left a few
"automated smoke (synthetic)" visits in the records.)
BANNER
