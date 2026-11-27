#!/usr/bin/env bash
# READ-ONLY deployment evidence for Ogevia TEST (stacks Ogevia-prod-*) and PRODUCTION (stacks Ogevia-prd-*). Run in CloudShell (account 300094796789, us-west-2).
# Only get/list/describe calls, public page fetches and one SELECT in a read-only transaction. It deploys nothing, applies nothing, changes no setting, sends no message.
# No secret, password or full email address is printed (addresses are masked). Production's database is NOT queried here: reading it needs the production admin-host procedure, which
# temporarily changes a security group, so it is outside a read-only pass.
set -u
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""
A() { aws "$@" 2>&1; }
mask() { sed -E 's/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9])[A-Za-z0-9.-]*(\.[A-Za-z]+)/\1***@\2***\3/g'; }
echo "account: $(A sts get-caller-identity --query Account --output text)"
# feature -> one sample route that exists only when the switch is ON
FEAT='notifications|GET /v1/notification-center
openShiftSms|GET /v1/sms-settings
serviceLocation|GET /v1/clients/{clientId}/service-location
invitationBranding|GET /v1/office-branding
importRollback|GET /v1/imports
bulkImport|POST /v1/imports/{kind}
staffDuplicates|GET /v1/staff/duplicates
operationsReadiness|GET /v1/operations-readiness
requestCleanup|POST /v1/care-notifications/read
offices|GET /v1/offices
officeAssignments|POST /v1/offices/{officeId}/update
assignmentHistory|GET /v1/assignment-history
signInOverride|POST /v1/caregivers/{caregiverRecordId}/signin-override
homeLabels(NFC/QR, PR 125)|GET /v1/clients/{clientId}/service-locations'
for E in test prd; do
  if [ "$E" = test ]; then P=prod; else P=prd; fi
  echo; echo "################ ${E^^} (stacks Ogevia-$P-*) ################"
  API="Ogevia-$P-ServiceVerificationApi"; WEB="Ogevia-$P-WebHosting"
  echo "--- web build"
  SITE=$(A cloudformation describe-stacks --stack-name "$WEB" --query "Stacks[0].Outputs[?OutputKey=='WebOrigin'].OutputValue" --output text)
  echo "origin: $SITE"
  curl -sI "$SITE/index.html" | grep -i '^last-modified' || echo "last-modified: unknown"
  JS=$(curl -s "$SITE/index.html" | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1); echo "bundle: $JS"
  curl -s "$SITE/$JS" | grep -oE 'VITE_APP_(VERSION|ENV):"[^"]*"' | head -3
  echo "--- API Lambda"
  FN=$(A cloudformation list-stack-resources --stack-name "$API" --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function' && starts_with(LogicalResourceId,'Handler')].PhysicalResourceId" --output text)
  echo "function: $FN"
  A lambda get-function-configuration --function-name "$FN" --query '{codeSha256:CodeSha256,lastModified:LastModified,runtime:Runtime,version:Version}' --output json
  A lambda get-function-configuration --function-name "$FN" --query 'Environment.Variables' --output json | python3 -c 'import json,sys
d=json.load(sys.stdin); keep=["SMS_MODE","SERVICE_LOCATION","COVER_ALERT_ADDRESS_RULES","EMAIL_FUNCTION_NAME","APP_ORIGIN"]
print("env switches:", {k:d[k] for k in keep if k in d}); print("env variable NAMES:", sorted(d))' 2>/dev/null
  echo "--- routes and switches (route present = switch ON in the deployed template)"
  A cloudformation get-template --stack-name "$API" --template-stage Original --query TemplateBody --output json > /tmp/ev-$E.json
  python3 - "/tmp/ev-$E.json" "$FEAT" <<'PY'
import json,sys
t=json.load(open(sys.argv[1])); r={x["Properties"]["RouteKey"] for x in t["Resources"].values() if x.get("Type")=="AWS::ApiGatewayV2::Route"}
print("route count:", len(r))
for line in sys.argv[2].split("\n"):
    f,k=line.split("|",1); print("  %-28s %s" % (f, "ON (route present)" if k in r else "off"))
PY
  echo "--- email function"
  A lambda get-function --function-name "Ogevia-$P-NotificationEmail" --query 'Configuration.[FunctionName,CodeSha256,LastModified]' --output text | mask
  A lambda get-function-configuration --function-name "Ogevia-$P-NotificationEmail" --query 'Environment.Variables.SES_ALLOWED_RECIPIENTS' --output text | tr ',' '\n' | mask | sed 's/^/  allowed: /'
  python3 - "/tmp/ev-$E.json" <<'PY' | sed -E 's/identity\/[^"]*@/identity\/(masked)@/g'
import json,sys
t=json.load(open(sys.argv[1]))
for k,v in t["Resources"].items():
    if v.get("Type")=="AWS::IAM::ManagedPolicy" and k.startswith("EmailPolicy"):
        for s in v["Properties"]["PolicyDocument"]["Statement"]:
            if s.get("Sid")=="SendFromOneIdentity":
                res=s["Resource"] if isinstance(s["Resource"],list) else [s["Resource"]]; print("  send permission names", len(res), "identities:", [x.split("identity/")[-1].split("@")[0][:3]+"***" if "@" in x else x.split("identity/")[-1] for x in res])
PY
done
echo; echo "################ Cognito sign-in pools (invitation branding = a CustomMessage trigger; sender type) ################"
for POOL in $(aws cognito-idp list-user-pools --max-results 20 --query 'UserPools[].Id' --output text 2>/dev/null); do
  A cognito-idp describe-user-pool --user-pool-id "$POOL" --query 'UserPool.{id:Id,name:Name,triggers:keys(LambdaConfig),emailSender:EmailConfiguration.EmailSendingAccount}' --output json | tr -d '\n '; echo
done
echo; echo "################ TEST database (read-only SELECTs through the TEST session tool) ################"
TC=$(ls -d /tmp/rt2n2/ogevia-rt2/docs/releases/2026-11-20-test-plan/toolchain 2>/dev/null)
if [ -z "$TC" ]; then echo "TEST toolchain checkout not found in /tmp: rebuild it (git init + fetch b2fe3944f538deaf17e6c28231ca556ff2536a5d) and rerun"; else
cd "$TC" && bash TEST_DB_SESSION.sh psql -X -A -F ' | ' <<'SQL'
begin read only;
select current_database() as db;
select version, name, applied_at from ogevia_meta.schema_migrations order by version desc limit 14;
select 'cover settings' as k, enabled, email_enabled, auto_notify, window_hours from ogevia.cover_notification_settings;
select 'sms settings' as k, enabled, provider from ogevia.sms_settings;
select 'email deliveries by outcome (all time)' as k, status, last_error_code, count(*) n, count(provider_message_id) with_provider_id, max(sent_at at time zone 'America/Los_Angeles') last_sent_pt from ogevia.notification_deliveries where channel = 'email' group by status, last_error_code order by status, last_error_code;
select 'NFC/QR tables present' as k, (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'ogevia' and c.relname in ('home_labels','visit_punches','client_service_locations')) as n_of_3;
rollback;
SQL
fi
