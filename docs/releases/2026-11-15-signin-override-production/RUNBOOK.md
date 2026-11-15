# Runbook: enable the sign-in override routes in production

**Status: PREPARED, NOT EXECUTED.** It needs the owner to run it in AWS CloudShell (us-west-2, account `300094796789`): this repository's tooling has no AWS access. The change is exactly two API Gateway routes. Everything that decides "go or stop" is in two scripts that are tested against a fake AWS (`infra/aws/test/production-signin-override-deploy.test.ts`, 29 tests, and `infra/aws/test/production-signin-override-release.test.ts`, 26 tests).

**Never run `cdk deploy` for this stack.** The CDK code does not synthesize six routes production serves today (business documents, missing visits, QR check-in); a `cdk deploy` would remove them. The script patches the captured **live** template and nothing else.

## What you run, in order
| # | In AWS | Changes anything? |
|---|---|---|
| 1 | Check the RDS security group has only its original rule (leftover window from 2026-11-14) | No (read-only); closes a leftover rule only if you find one |
| 2 | Open the temporary read window, run `VERIFY_PRODUCTION_DB.sql`, save the output, close the window | Opens and closes one security-group rule |
| 3 | `plan` script | No. Creates an un-executed change set and uploads rollback inputs to the private assets bucket |
| 4 | `apply` script | **Yes: adds the two routes.** Rolls itself back if its smoke check fails |
| 5 | Owner acceptance in the app | One real approval, by the owner |
`rollback` is a script mode, used only if you want to undo.

Work in `/tmp` (CloudShell's home volume is small). Do not use `set -e` in your own terminal.

## 0. Set up
```bash
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=''
export OGEVIA_RELEASE_SHA=PASTE_THE_40_CHARACTER_SHA_THE_OWNER_APPROVED
cd ~/CarelikGlobal
git fetch origin claude/keen-hawking-e9o2jg
git checkout --detach "$OGEVIA_RELEASE_SHA"
test "$(git rev-parse HEAD)" = "$OGEVIA_RELEASE_SHA" && test -z "$(git status --porcelain --untracked-files=no)" && echo CHECKOUT-CLEAN-AT-SHA
```
CI must be green on that SHA and no other production release may be running.

## 1. The RDS security group must have only its original rule
```bash
aws ec2 describe-security-group-rules --filters Name=group-id,Values=sg-00530a1f4f7648e65 --query "SecurityGroupRules[?IsEgress==\`false\`].[SecurityGroupRuleId,ReferencedGroupInfo.GroupId,CidrIpv4]" --output text
```
Expected: one row, source `sg-064ffce3bcbe8eb3b`, no CIDR. If a row with a CIDR (for example `10.20.132.179/32`, description `TEMP-…`) is listed, remove exactly that rule and list again:
```bash
aws ec2 revoke-security-group-ingress --group-id sg-00530a1f4f7648e65 --security-group-rule-ids sgr-THE_ID_OF_THAT_ROW
```

## 2. Verify the production database (read-only)
Open the temporary window (same guards as 2026-11-14; a second CloudShell open first for recovery):
```bash
GROUP=$(aws rds describe-db-instances --db-instance-identifier ogevia-prod-postgres --query "DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId" --output text)
IP=$(aws ec2 describe-instances --instance-ids i-0ce8db2d7e5839dd5 --query "Reservations[0].Instances[0].PrivateIpAddress" --output text)
echo "$GROUP $IP"
```
The line must read `sg-00530a1f4f7648e65 10.20.132.179`. Then:
```bash
[ "$GROUP" = sg-00530a1f4f7648e65 ] && [ "$IP" = 10.20.132.179 ] && RULE=$(aws ec2 authorize-security-group-ingress --group-id "$GROUP" --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,IpRanges=[{CidrIp=$IP/32,Description=TEMP-signin-override-verify}]" --query "SecurityGroupRules[0].SecurityGroupRuleId" --output text) && echo "RULE=$RULE"
```
Write down `RULE`. Tunnel (wait 8 seconds), then connect; the secret is read into memory and never printed:
```bash
aws ssm start-session --target i-0ce8db2d7e5839dd5 --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters "host=ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com,portNumber=5432,localPortNumber=15433" >/dev/null &
```
```bash
export PGHOST=127.0.0.1 PGPORT=15433 PGSSLMODE=require
SECRET=$(aws secretsmanager get-secret-value --secret-id 'arn:aws:secretsmanager:us-west-2:300094796789:secret:rds!db-ceb5276c-c146-4b3d-9ce6-dab7b70e0cfa-PRte3a' --query SecretString --output text)
export PGUSER=$(jq -r .username <<<"$SECRET") PGPASSWORD=$(jq -r .password <<<"$SECRET"); unset SECRET
psql -X -d ogevia_prd -f docs/releases/2026-11-15-signin-override-production/VERIFY_PRODUCTION_DB.sql | tee /tmp/verify-before.txt
```
The last lines must be `VERDICT: PASS`. Close the window (always, pass or fail):
```bash
unset PGPASSWORD
kill %1
aws ec2 revoke-security-group-ingress --group-id sg-00530a1f4f7648e65 --security-group-rule-ids "$RULE"
aws ec2 describe-security-group-rules --filters Name=group-id,Values=sg-00530a1f4f7648e65 --query "SecurityGroupRules[?IsEgress==\`false\`].[SecurityGroupRuleId,ReferencedGroupInfo.GroupId,CidrIpv4]" --output text
```
The last command must list one row (`sg-064ffce3bcbe8eb3b`, no CIDR). If the verdict was `VERDICT: FAIL`, **stop**: the line after it names what failed (a missing grant, wrong owner, missing permission row, ledger mismatch). Send me `/tmp/verify-before.txt`; do not continue. The check also covers the class of defect behind the 2026-11-14 production 500s.

## 3. Plan (changes nothing in production)
```bash
export OGEVIA_DEPLOY_APPROVAL=owner-signin-override-go
bash infra/aws/scripts/production-signin-override-deploy.sh plan /tmp/verify-before.txt
```
The script refuses unless: the owner approval variable is set; the account is `300094796789`; this checkout is exactly `OGEVIA_RELEASE_SHA` with clean tracked files; the verification file is under 2 hours old, names `ogevia_prd` and says `VERDICT: PASS`; the stack is settled; the Handler is production's (`ogevia_prd`, `prd`); the API is `zk527zk4ua`; neither override route is live; the candidate adds only the two routes and keeps bulk import and duplicate-staff review off; nobody changed the stack meanwhile; and the change set holds **exactly two `AWS::ApiGatewayV2::Route` additions**. A change set with anything else is deleted. It ends with `PLAN READY. Nothing is changed yet.` and prints the exact `apply` command with the workspace path.

## 4. Apply
Run the command that `plan` printed (it has the workspace path):
```bash
OGEVIA_DEPLOY_APPROVAL=owner-signin-override-go bash infra/aws/scripts/production-signin-override-deploy.sh apply /tmp/ogevia-signin-override.XXXXXX
```
It re-checks the stack and the change set, executes the change set, confirms the live template equals the planned one, then checks without a token that `GET /v1/signin-overrides`, the same call with a forged token, and `POST …/signin-override` all answer **401** (they answered 404 before), and that both routes use `JWT`. If any check fails it rolls itself back and exits non-zero. If CloudFormation itself fails the update it tells you to send `describe-stack-events` and run nothing else (CloudFormation rolls an update back by itself). Success ends with `SIGN-IN OVERRIDE ROUTES ARE LIVE IN PRODUCTION.`

## 5. Owner acceptance (production, the owner's own account)
1. Open **Care Team**, then a caregiver who has a clear background check and has not signed in. **Approve by override** is shown for an owner or administrator, and not for a manager or scheduler.
2. A blank reason is refused in the browser and sends nothing. A reason of 5 or more characters records; the sign-in row reads "Approved by override: not signed in" and the badge shows on the Care Team list and the Schedule.
3. A caregiver whose background check is not clear shows the hard-block message and no action.
4. Browser console: no CORS or 404 errors for the two routes. The `notifications` and `attention` requests are 200.
5. Do not create a throw-away record in production: approve one caregiver the agency really means to approve, or approve nobody.

## 6. Rollback (about 3 minutes; removes exactly the two routes)
```bash
OGEVIA_DEPLOY_APPROVAL=owner-signin-override-go bash infra/aws/scripts/production-signin-override-deploy.sh rollback /tmp/ogevia-signin-override.XXXXXX
```
It creates a change set from the captured live template, refuses anything but exactly two route removals, executes it, and confirms the stack equals the captured template. Triggers: any check in step 4 fails and the script has not already rolled back; a new 5xx on any route; the owner calls it.
**What rollback does not undo:** override records and approvals already written (append-only, kept on purpose); the web action then returns 404, as today. Do not run the database `down` script after real use: it is BACKUP REQUIRED and would send approved caregivers back to "not ready".

## 7. Close out
Write `DEPLOYED_RECORD_PRD.md` from the pasted outputs of steps 2 to 5 and tick `CHECKLIST.md` section F. The workspace under `/tmp` holds no secret value; keep it until the monitoring period ends (it has the rollback inputs; a copy of them is also in the private assets bucket under `ogevia-production-release/signin-override-…/`).
