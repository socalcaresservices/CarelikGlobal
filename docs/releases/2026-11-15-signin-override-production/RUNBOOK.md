# Runbook: enable the sign-in override routes in production (NOT EXECUTED; needs the owner's explicit GO on one commit SHA)

Operator: CloudShell, region `us-west-2`, account `300094796789`. One change in the whole release: two API Gateway routes. Estimated 30 minutes; the change itself takes about 3.
**Never run `cdk deploy` for this stack.** The CDK code does not synthesize six routes that production serves today (business documents, missing visits, QR check-in); a `cdk deploy` would remove them. This release patches the captured **live** template and nothing else.

Every command block is separate. Stop at the first failure and report it. CloudShell's home volume is small: work in `/tmp`.

## 0. Preconditions
```bash
set +H   # do not use `set -e` in CloudShell: an error would close the terminal
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=''
A() { aws --cli-connect-timeout 5 --cli-read-timeout 60 "$@"; }
[[ "$(A sts get-caller-identity --query Account --output text)" == 300094796789 ]] && echo ACCOUNT-OK
SHA=PASTE_THE_40_CHARACTER_SHA_FROM_THE_GO_RECORD
STACK=Ogevia-prd-ServiceVerificationApi
ASSETS=cdk-hnb659fds-assets-300094796789-us-west-2
WORK=$(mktemp -d /tmp/ogevia-signin-override.XXXXXX); echo "WORK=$WORK"
```
```bash
cd ~/CarelikGlobal
git fetch origin claude/keen-hawking-e9o2jg
git checkout --detach "$SHA"
test "$(git rev-parse HEAD)" = "$SHA" && test -z "$(git status --porcelain --untracked-files=no)" && echo CHECKOUT-CLEAN-AT-SHA
PLAN=$PWD/infra/aws/scripts/production-signin-override-release.py
SQL=$PWD/docs/releases/2026-11-15-signin-override-production/VERIFY_PRODUCTION_DB.sql
```
Required before continuing: CI is green on `$SHA`; no other production release is running; the owner is available.

## 1. Synthesize the candidate to a scratch folder (the repository's `cdk.out` is tracked: never write into it)
```bash
corepack pnpm@9.15.4 install --frozen-lockfile --filter @carelik/infra-aws...
(cd infra/aws && npx cdk synth --quiet -c env=prd -c mode=plan --output "$WORK/cdk.out")
test -s "$WORK/cdk.out/Ogevia-prd-ServiceVerificationApi.template.json" && echo CANDIDATE-OK
```

## 2. Read-only database verification (needs the temporary database window)
Open the window exactly as on 2026-11-14: a second CloudShell open first for recovery; the rule is one inbound TCP 5432 `/32` from the admin host on the RDS group, and it is closed in step 2d. The guards refuse anything unexpected.
```bash
GROUP=$(A rds describe-db-instances --db-instance-identifier ogevia-prod-postgres --query "DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId" --output text)
IP=$(A ec2 describe-instances --instance-ids i-0ce8db2d7e5839dd5 --query "Reservations[0].Instances[0].PrivateIpAddress" --output text)
echo "$GROUP $IP"
```
The line must read `sg-00530a1f4f7648e65 10.20.132.179`. Then:
```bash
[ "$GROUP" = sg-00530a1f4f7648e65 ] && [ "$IP" = 10.20.132.179 ] && RULE=$(A ec2 authorize-security-group-ingress --group-id "$GROUP" --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,IpRanges=[{CidrIp=$IP/32,Description=TEMP-signin-override-verify}]" --query "SecurityGroupRules[0].SecurityGroupRuleId" --output text) && echo "RULE=$RULE"
```
Write down `RULE`. Tunnel, then connect (the secret is read into memory and never printed):
```bash
A ssm start-session --target i-0ce8db2d7e5839dd5 --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters "host=ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com,portNumber=5432,localPortNumber=15433" >/dev/null &
sleep 8
export PGHOST=127.0.0.1 PGPORT=15433 PGSSLMODE=require
SECRET=$(A secretsmanager get-secret-value --secret-id 'arn:aws:secretsmanager:us-west-2:300094796789:secret:rds!db-ceb5276c-c146-4b3d-9ce6-dab7b70e0cfa-PRte3a' --query SecretString --output text)
export PGUSER=$(jq -r .username <<<"$SECRET") PGPASSWORD=$(jq -r .password <<<"$SECRET"); unset SECRET
```
2a. Run the verification (read-only; add `-v org=<uuid> -v admin_sub=<sub>` to also run section 9):
```bash
psql -X -d ogevia_prd -f "$SQL" | tee "$WORK/verify-before.txt"
```
2b. Required result: section 1 `pass_is_prd`, `pass_107`, `pass_0103_checksum` all `t`; section 2 all `t`; section 3 every owner `ogevia_owner`, `rls_on t`, `rls_forced f`; section 4 all `t`; section 5 every `pass_*` `t`; section 6 one row `organization_admin, organization_owner`; section 7 shows who gets the action (confirm with the owner that these are the intended administrators); section 8 `override_rows_now` 0 before the first approval.
2c. **Any other result: STOP.** Close the window (2d), do not change the API, send me the output.
2d. Close the window (always):
```bash
kill %1 || true
A ec2 revoke-security-group-ingress --group-id sg-00530a1f4f7648e65 --security-group-rule-ids "$RULE"
A ec2 describe-security-group-rules --filters Name=group-id,Values=sg-00530a1f4f7648e65 --query "SecurityGroupRules[?IsEgress==\`false\`].[SecurityGroupRuleId,ReferencedGroupInfo.GroupId,CidrIpv4]" --output text
```
The last command must list one row, sourced from `sg-064ffce3bcbe8eb3b`, with no CIDR row. If CloudShell is lost, revoke by rule id from a new session.

## 3. Capture the rollback inputs (read-only)
```bash
cd "$WORK"
A cloudformation describe-stacks --stack-name $STACK --query "Stacks[0].StackStatus" --output text
A cloudformation get-template --stack-name $STACK --template-stage Original --query TemplateBody --output json > live.before.json
A cloudformation describe-stacks --stack-name $STACK --query "Stacks[0].Parameters[].ParameterKey" --output json | jq 'map({ParameterKey: ., UsePreviousValue: true})' > previous-parameters.json
FN=$(A cloudformation describe-stack-resources --stack-name $STACK --query "StackResources[?starts_with(LogicalResourceId,'Handler') && ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text)
A lambda get-function-configuration --function-name "$FN" --query "[CodeSha256,Environment.Variables.DB_NAME,Environment.Variables.OGEVIA_ENV]" --output text | tee handler.before.txt
API_ID=$(A cloudformation describe-stack-resources --stack-name $STACK --query "StackResources[?ResourceType=='AWS::ApiGatewayV2::Api'].PhysicalResourceId" --output text); echo "API_ID=$API_ID"
python3 "$PLAN" routes live.before.json absent
```
Required: stack status `UPDATE_COMPLETE` or `CREATE_COMPLETE`; `DB_NAME ogevia_prd`, `OGEVIA_ENV prd`; `API_ID` is `zk527zk4ua` (the production API in `docs/aws/URL_REGISTRY_AND_LAUNCH_CHECKLIST.md`); the last line prints `PASS: both override routes are absent`. Anything else: STOP.

## 4. Build the candidate: live template plus exactly two routes
```bash
python3 "$PLAN" patch live.before.json "$WORK/cdk.out/Ogevia-prd-ServiceVerificationApi.template.json" candidate.template.json
PREFIX=ogevia-production-release/signin-override-$(date -u +%Y%m%dT%H%M%SZ)
A s3 cp live.before.json "s3://$ASSETS/$PREFIX/rollback.template.json" --only-show-errors
A s3 cp candidate.template.json "s3://$ASSETS/$PREFIX/candidate.template.json" --only-show-errors
A s3 cp previous-parameters.json "s3://$ASSETS/$PREFIX/previous-parameters.json" --only-show-errors
echo "PREFIX=$PREFIX"
```
`patch` must print `PASS: the live production template plus exactly two JWT routes`. Anything else: STOP.

## 5. Create and check the change set (nothing is applied yet)
```bash
A cloudformation get-template --stack-name $STACK --template-stage Original --query TemplateBody --output json > live.recheck.json
python3 "$PLAN" equal live.before.json live.recheck.json
CHANGE=ogevia-signin-override-$(date -u +%Y%m%dT%H%M%SZ)
A cloudformation create-change-set --stack-name $STACK --change-set-name "$CHANGE" --change-set-type UPDATE --template-url "https://$ASSETS.s3.us-west-2.amazonaws.com/$PREFIX/candidate.template.json" --parameters file://previous-parameters.json --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM > change-set-created.json
A cloudformation wait change-set-create-complete --stack-name $STACK --change-set-name "$CHANGE"
A cloudformation describe-change-set --stack-name $STACK --change-set-name "$CHANGE" --output json > change-set.json
python3 "$PLAN" changes change-set.json
```
`changes` must print `PASS: the change set adds exactly the two sign-in override routes`. If it fails: `A cloudformation delete-change-set --stack-name $STACK --change-set-name "$CHANGE"`, then STOP. Nothing was changed.

## 6. Execute, then verify
```bash
A cloudformation execute-change-set --stack-name $STACK --change-set-name "$CHANGE"
A cloudformation wait stack-update-complete --stack-name $STACK
A cloudformation get-template --stack-name $STACK --template-stage Original --query TemplateBody --output json > live.after.json
python3 "$PLAN" equal candidate.template.json live.after.json
python3 "$PLAN" routes live.after.json present
```
If `wait` reports a failure or the stack is not `UPDATE_COMPLETE`: go to section 8 at once.
```bash
URL=https://$API_ID.execute-api.us-west-2.amazonaws.com
curl -s -o /dev/null -w 'no token:     %{http_code}\n' "$URL/v1/signin-overrides?organizationId=00000000-0000-4000-8000-000000000000"
curl -s -o /dev/null -w 'forged token: %{http_code}\n' -H 'authorization: Bearer forged.token.value' "$URL/v1/signin-overrides?organizationId=00000000-0000-4000-8000-000000000000"
curl -s -o /dev/null -w 'POST no token: %{http_code}\n' -X POST -H 'content-type: application/json' -d '{}' "$URL/v1/caregivers/00000000-0000-4000-8000-000000000000/signin-override"
A apigatewayv2 get-routes --api-id "$API_ID" --query "Items[?contains(RouteKey,'signin-override')].[RouteKey,AuthorizationType]" --output text
```
Required: all three curl lines print `401` (they printed `404` before the change); the route list shows both routes with `JWT`. Then the log check (read-only, last 30 minutes):
```bash
LG=Ogevia-prd-ServiceVerificationApi-HandlerLogGroup881018CA-SPB7CscZPXJI
A logs filter-log-events --log-group-name "$LG" --start-time $(( ($(date +%s) - 1800) * 1000 )) --filter-pattern '"internal_error"' --max-items 5 --query "events[].message" --output text | cut -c1-300
```
Required: nothing new. The `notifications` and `attention` requests must also be 200 in the browser (they were failing on 2026-11-14).

## 7. Owner acceptance (production, owner's own account)
1. Open Care Team and a caregiver who has a clear background check and has not signed in. The action **Approve by override** shows for an owner or administrator and **not** for a manager or scheduler.
2. Without a reason, **Record override** is refused and sends nothing; with a reason of 5 or more characters it records, the sign-in row reads "Approved by override: not signed in", and the badge shows on the Care Team list and the Schedule.
3. A caregiver whose background check is not clear shows the hard-block message and no action.
4. Browser console: no CORS or 404 error for the two routes.
5. Do not create a throw-away record in production. Use one caregiver the agency really means to approve, with a real reason, or do not approve anyone during the check.
Save the evidence (IDs only, no names) in `DEPLOYED_RECORD_PRD.md`.

## 8. Rollback (about 3 minutes; removes exactly the two routes)
```bash
cd "$WORK"
RB=ogevia-signin-override-rollback-$(date -u +%Y%m%dT%H%M%SZ)
A cloudformation create-change-set --stack-name $STACK --change-set-name "$RB" --change-set-type UPDATE --template-url "https://$ASSETS.s3.us-west-2.amazonaws.com/$PREFIX/rollback.template.json" --parameters file://previous-parameters.json --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM > rollback-created.json
A cloudformation wait change-set-create-complete --stack-name $STACK --change-set-name "$RB"
A cloudformation describe-change-set --stack-name $STACK --change-set-name "$RB" --output json > rollback-change-set.json
python3 "$PLAN" rollback-changes rollback-change-set.json
```
`rollback-changes` must print `PASS: the rollback change set removes exactly the two sign-in override routes`. If it does not, stop and call the owner; do not improvise. Then:
```bash
A cloudformation execute-change-set --stack-name $STACK --change-set-name "$RB"
A cloudformation wait stack-update-complete --stack-name $STACK
A cloudformation get-template --stack-name $STACK --template-stage Original --query TemplateBody --output json > live.rolledback.json
python3 "$PLAN" equal live.before.json live.rolledback.json
python3 "$PLAN" routes live.rolledback.json absent
```
Rollback triggers: step 6 fails or the stack is not `UPDATE_COMPLETE`; any curl line is not `401`; a new 5xx on any route in the 30-minute check; the owner calls it. If the stack is stuck in `UPDATE_ROLLBACK_FAILED`, do not run anything else: send me `describe-stack-events` for the stack.

What the rollback does **not** undo: override records and approvals already written (append-only, kept on purpose). After rollback the web action returns 404, as today. Do not run the database `down` script after real use: it is BACKUP REQUIRED and would send approved caregivers back to "not ready".

## 9. Close out
Write `DEPLOYED_RECORD_PRD.md` from pasted evidence (outputs of 2b, 4, 5, 6, 7), tick `CHECKLIST.md` section F, and keep `$WORK` until the monitoring period ends. The workspace holds no secret values.
