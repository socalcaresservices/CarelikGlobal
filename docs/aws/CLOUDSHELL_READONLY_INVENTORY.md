# CloudShell read-only inventory (Platform Restructuring, Phase 0)

Purpose: replace the UNVERIFIED rows in `PLATFORM_RESTRUCTURING_PHASE1_ASSESSMENT.md` with dated evidence.
Nothing here creates, changes or deletes anything. Run it in AWS CloudShell, region **us-west-2**, signed in as your administrator
(or a read-only role). Expected account: `300094796789`.

## Safety properties

- Only `describe-*`, `list-*`, `get-*` calls. Every call is a read.
- Deliberately **not** used: `secretsmanager get-secret-value`, `cognito-idp list-users` (contains emails), `lambda get-function` (returns a code download link), `s3 ls` of object keys, any `invoke`, `update-*`, `put-*`, `delete-*`.
- Secrets: only metadata (names, rotation, KMS key). Lambda environment: only variable **names** plus the five non-secret values named in the script.
- The output file has no passwords or tokens. It does contain AWS resource identifiers (account, pool, bucket names). Review it before pasting; send only what you are comfortable sharing. Do not paste anything that looks like a key.

## How to run

1. Open CloudShell (us-west-2). Paste the whole block below. It writes `~/ogevia-inventory-<UTC date>.txt` and prints a line count.
2. Run the self-check at the end (it greps the script for any non-read verb).
3. Download the file (Actions > Download file) or paste sections back. Sections are numbered to match the assessment.

```bash
# ---- Ogevia read-only inventory. Safe: describe/list/get only. ----
export AWS_PAGER="" AWS_DEFAULT_REGION=us-west-2
set +H   # interactive bash treats "!" in double quotes as history expansion and silently skips the line (it skipped Secrets Manager and SES on 2026-10-21)
OUT=~/ogevia-inventory-$(date -u +%Y%m%d-%H%M).txt
sec(){ printf '\n===== %s =====\n' "$1" >> "$OUT"; }
run(){ printf '\n$ %s\n' "$*" >> "$OUT"; "$@" >> "$OUT" 2>&1 || echo "(command failed or not permitted)" >> "$OUT"; }
: > "$OUT"

sec "0 identity and clock"
run date -u
run aws sts get-caller-identity
run aws configure get region

sec "1 CloudFormation stacks (status, termination protection, tags) and outputs"
run aws cloudformation describe-stacks --query "Stacks[?starts_with(StackName,'Ogevia') || starts_with(StackName,'ogevia')].{Name:StackName,Status:StackStatus,TermProt:EnableTerminationProtection,Updated:LastUpdatedTime,Tags:Tags}" --output json
run aws cloudformation describe-stacks --query "Stacks[?starts_with(StackName,'Ogevia') || starts_with(StackName,'ogevia')].{Name:StackName,Outputs:Outputs}" --output json

sec "2 Which Ogevia stacks exist (is there any dev / test / demo / staging stack?)"
run aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE ROLLBACK_COMPLETE --query "StackSummaries[].StackName" --output json

sec "3 RDS instances: engine, class, storage, encryption, public access, backups, deletion protection, Multi-AZ"
run aws rds describe-db-instances --query "DBInstances[].{Id:DBInstanceIdentifier,Status:DBInstanceStatus,Engine:Engine,Version:EngineVersion,Class:DBInstanceClass,Storage:AllocatedStorage,Encrypted:StorageEncrypted,Public:PubliclyAccessible,MultiAZ:MultiAZ,BackupDays:BackupRetentionPeriod,DelProt:DeletionProtection,LatestRestorable:LatestRestorableTime,SubnetGroup:DBSubnetGroup.DBSubnetGroupName,SGs:VpcSecurityGroups[].VpcSecurityGroupId,Tags:TagList}" --output json
run aws rds describe-db-snapshots --snapshot-type manual --query "DBSnapshots[].{Id:DBSnapshotIdentifier,Instance:DBInstanceIdentifier,Created:SnapshotCreateTime,Status:Status,Encrypted:Encrypted}" --output json
run aws rds describe-db-snapshots --snapshot-type automated --query "DBSnapshots[].{Id:DBSnapshotIdentifier,Instance:DBInstanceIdentifier,Created:SnapshotCreateTime}" --output json

sec "4 Cognito user pools, MFA, sign-up policy, deletion protection, domain"
run aws cognito-idp list-user-pools --max-results 20 --output json
POOL=us-west-2_849AYz5J7
run aws cognito-idp describe-user-pool --user-pool-id $POOL --query "UserPool.{Name:Name,Id:Id,Status:Status,Created:CreationDate,MFA:MfaConfiguration,DeletionProtection:DeletionProtection,Tier:UserPoolTier,AdminCreateOnly:AdminCreateUserConfig.AllowAdminCreateUserOnly,Domain:Domain,CustomDomain:CustomDomain,Policies:Policies,EmailSender:EmailConfiguration.EmailSendingAccount,LambdaTriggers:LambdaConfig,EstimatedUsers:EstimatedNumberOfUsers,Attributes:SchemaAttributes[?Mutable].Name}" --output json
run aws cognito-idp list-user-pool-clients --user-pool-id $POOL --max-results 20 --output json
# one describe per client (callback/logout URLs, flows, token lifetimes). No secrets are returned for public clients.
for c in $(aws cognito-idp list-user-pool-clients --user-pool-id $POOL --max-results 20 --query "UserPoolClients[].ClientId" --output text); do
  run aws cognito-idp describe-user-pool-client --user-pool-id $POOL --client-id "$c" --query "UserPoolClient.{Name:ClientName,Id:ClientId,HasSecret:ClientSecret!=null,Flows:AllowedOAuthFlows,Scopes:AllowedOAuthScopes,Callbacks:CallbackURLs,Logouts:LogoutURLs,AuthFlows:ExplicitAuthFlows,AccessMin:AccessTokenValidity,IdMin:IdTokenValidity,RefreshDays:RefreshTokenValidity,Units:TokenValidityUnits,Revocation:EnableTokenRevocation,PreventEnum:PreventUserExistenceErrors}" --output json
done
run aws cognito-idp get-user-pool-mfa-config --user-pool-id $POOL
run aws cognito-idp list-groups --user-pool-id $POOL --query "Groups[].GroupName" --output json

sec "5 API Gateway: APIs, authorizers (audience), stages, CORS, custom domains"
run aws apigatewayv2 get-apis --query "Items[].{Name:Name,Id:ApiId,Endpoint:ApiEndpoint,Cors:CorsConfiguration,Created:CreatedDate}" --output json
for a in $(aws apigatewayv2 get-apis --query "Items[].ApiId" --output text); do
  run aws apigatewayv2 get-authorizers --api-id "$a" --query "Items[].{Name:Name,Type:AuthorizerType,Issuer:JwtConfiguration.Issuer,Audience:JwtConfiguration.Audience}" --output json
  run aws apigatewayv2 get-stages --api-id "$a" --query "Items[].{Stage:StageName,Throttle:DefaultRouteSettings,AutoDeploy:AutoDeploy,LogDest:AccessLogSettings.DestinationArn}" --output json
done
run aws apigatewayv2 get-domain-names --output json

sec "6 Lambda: functions, runtime, last modified, VPC, env var NAMES and five non-secret values"
run aws lambda list-functions --query "Functions[?contains(FunctionName,'Ogevia') || contains(FunctionName,'ogevia')].{Name:FunctionName,Runtime:Runtime,Modified:LastModified,Mem:MemorySize,Timeout:Timeout,CodeSha:CodeSha256,Vpc:VpcConfig.VpcId,Role:Role}" --output json
for f in $(aws lambda list-functions --query "Functions[?contains(FunctionName,'Ogevia') || contains(FunctionName,'ogevia')].FunctionName" --output text); do
  run aws lambda get-function-configuration --function-name "$f" --query "{Name:FunctionName,EnvNames:keys(Environment.Variables),OGEVIA_ENV:Environment.Variables.OGEVIA_ENV,DB_NAME:Environment.Variables.DB_NAME,COGNITO_USER_POOL_ID:Environment.Variables.COGNITO_USER_POOL_ID,AppClientIds:Environment.Variables.COGNITO_APP_CLIENT_ID,DbSetRole:Environment.Variables.DB_SET_ROLE,ReservedConcurrency:ReservedConcurrentExecutions}" --output json
  run aws lambda get-function-concurrency --function-name "$f"
done

sec "7 CloudFront and web hosting (distributions, aliases, certificates)"
run aws cloudfront list-distributions --query "DistributionList.Items[].{Id:Id,Domain:DomainName,Aliases:Aliases.Items,Status:Status,Enabled:Enabled,Cert:ViewerCertificate.ACMCertificateArn,Origins:Origins.Items[].DomainName,Comment:Comment}" --output json

sec "8 DNS and certificates (is app.ogevia.com / demo.ogevia.com / ogevia.com in Route 53 or ACM?)"
run aws route53 list-hosted-zones --query "HostedZones[].{Name:Name,Id:Id,Private:Config.PrivateZone,Records:ResourceRecordSetCount}" --output json
for z in $(aws route53 list-hosted-zones --query "HostedZones[].Id" --output text); do
  run aws route53 list-resource-record-sets --hosted-zone-id "$z" --query "ResourceRecordSets[?Type=='A' || Type=='AAAA' || Type=='CNAME' || Type=='MX'].{Name:Name,Type:Type,Alias:AliasTarget.DNSName,Values:ResourceRecords[].Value}" --output json
done
run aws route53domains list-domains --region us-east-1
run aws acm list-certificates --region us-east-1 --query "CertificateSummaryList[].{Domain:DomainName,Arn:CertificateArn,Status:Status}" --output json
run aws acm list-certificates --region us-west-2 --query "CertificateSummaryList[].{Domain:DomainName,Arn:CertificateArn,Status:Status}" --output json

sec "9 S3 buckets (names, encryption, public-access block, versioning). No object listing."
for b in $(aws s3api list-buckets --query "Buckets[?contains(Name,'ogevia')].Name" --output text); do
  echo "--- bucket $b" >> "$OUT"
  run aws s3api get-bucket-encryption --bucket "$b" --query "ServerSideEncryptionConfiguration.Rules[].ApplyServerSideEncryptionByDefault" --output json
  run aws s3api get-public-access-block --bucket "$b" --output json
  run aws s3api get-bucket-versioning --bucket "$b" --output json
  run aws s3api get-bucket-lifecycle-configuration --bucket "$b" --query "Rules[].{Id:ID,Status:Status,Expire:Expiration,NoncurrentExp:NoncurrentVersionExpiration}" --output json
done

sec "10 KMS keys and aliases (metadata only)"
run aws kms list-aliases --query "Aliases[?contains(AliasName,'ogevia')].{Alias:AliasName,Key:TargetKeyId}" --output json
for k in $(aws kms list-aliases --query "Aliases[?contains(AliasName,'ogevia')].TargetKeyId" --output text); do
  run aws kms describe-key --key-id "$k" --query "KeyMetadata.{Id:KeyId,State:KeyState,Manager:KeyManager,Created:CreationDate}" --output json
  run aws kms get-key-rotation-status --key-id "$k"
done

sec "11 Secrets Manager (metadata only; NEVER values)"
run aws secretsmanager list-secrets --query "SecretList[?contains(Name,'ogevia') || starts_with(Name,'rds!')].{Name:Name,Rotation:RotationEnabled,Kms:KmsKeyId,Changed:LastChangedDate,Owner:OwningService}" --output json

sec "12 Network: VPC, subnets, NAT, endpoints, security group rules"
run aws ec2 describe-vpcs --vpc-ids vpc-0ee9df0c38297cbc1 --query "Vpcs[].{Id:VpcId,Cidr:CidrBlock,Tags:Tags}" --output json
run aws ec2 describe-nat-gateways --filter Name=vpc-id,Values=vpc-0ee9df0c38297cbc1 --query "NatGateways[].{Id:NatGatewayId,State:State}" --output json
run aws ec2 describe-vpc-endpoints --filters Name=vpc-id,Values=vpc-0ee9df0c38297cbc1 --query "VpcEndpoints[].{Id:VpcEndpointId,Service:ServiceName,Type:VpcEndpointType,State:State}" --output json
run aws ec2 describe-security-groups --filters Name=vpc-id,Values=vpc-0ee9df0c38297cbc1 --query "SecurityGroups[].{Id:GroupId,Name:GroupName,Inbound:IpPermissions[].{Port:FromPort,Cidr:IpRanges[].CidrIp,FromSG:UserIdGroupPairs[].GroupId}}" --output json
run aws ec2 describe-instances --filters Name=vpc-id,Values=vpc-0ee9df0c38297cbc1 --query "Reservations[].Instances[].{Id:InstanceId,State:State.Name,Type:InstanceType,Name:Tags[?Key=='Name']|[0].Value}" --output json

sec "13 Monitoring: alarms, SNS subscriptions (are alarms delivered to a person?), log retention"
run aws cloudwatch describe-alarms --query "MetricAlarms[?contains(AlarmName,'gevia')].{Name:AlarmName,State:StateValue,Actions:AlarmActions,Metric:MetricName}" --output json
run aws sns list-topics --output json
for t in $(aws sns list-topics --query "Topics[?contains(TopicArn,'gevia')].TopicArn" --output text); do
  run aws sns list-subscriptions-by-topic --topic-arn "$t" --query "Subscriptions[].{Protocol:Protocol,Status:SubscriptionArn}" --output json
done
run aws logs describe-log-groups --query "logGroups[?contains(logGroupName,'gevia')].{Name:logGroupName,RetentionDays:retentionInDays,Kms:kmsKeyId}" --output json

sec "14 Audit and threat controls"
run aws cloudtrail describe-trails --query "trailList[].{Name:Name,MultiRegion:IsMultiRegionTrail,LogValidation:LogFileValidationEnabled,Bucket:S3BucketName}" --output json
for t in $(aws cloudtrail describe-trails --query "trailList[].TrailARN" --output text); do run aws cloudtrail get-trail-status --name "$t" --query "{Logging:IsLogging,LastDelivery:LatestDeliveryTime}" --output json; done
run aws guardduty list-detectors
run aws wafv2 list-web-acls --scope REGIONAL
run aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1

sec "15 Cost guardrails"
ACCT=$(aws sts get-caller-identity --query Account --output text)
run aws budgets describe-budgets --account-id "$ACCT" --query "Budgets[].{Name:BudgetName,Limit:BudgetLimit,Type:TimeUnit}" --output json

sec "16 Email (SES) status. Confirms whether anything other than Cognito default email can send"
run aws sesv2 get-account --query "{Sandbox:!ProductionAccessEnabled,SendingEnabled:SendingEnabled,Quota:SendQuota}" --output json
run aws sesv2 list-email-identities --output json

echo "Wrote $OUT"; wc -l "$OUT"
```

## Self-check (run after, or before, the block above)

Run this against the saved script text to prove no write verb is present. It should print nothing but `OK`.

```bash
# paste the block above into ~/inv.sh first (cat > ~/inv.sh), then:
grep -nE "aws [a-z0-9-]+ (create|update|delete|put|modify|start|stop|reboot|invoke|attach|detach|admin-|set-|enable|disable|tag|untag|register|deregister|restore|reset|add-|remove-|associate|disassociate|authorize|revoke|run-|terminate|send-)|get-secret-value|list-users|lambda get-function( |$)" ~/inv.sh && echo "WRITE VERB FOUND" || echo OK
```

(`aws cognito-idp get-user-pool-mfa-config`, `describe-*`, `list-*` and `get-*` calls are expected and are reads.)

## What each section settles

| Section | Assessment row it settles |
|---|---|
| 1-2 | Which `Ogevia-prod-*` / `Ogevia-prd-*` stacks exist, whether any dev/test/demo/staging stack exists, termination protection |
| 3 | RDS: one or two instances, backups, encryption, public access, restorable time, snapshots (the pre-prd rollback anchor) |
| 4 | Cognito: one shared pool, MFA, clients and their callback URLs (does any client point at `app.ogevia.com`?), token lifetimes, revocation |
| 5 | JWT audience on each API (does the prd API still accept the legacy `ogevia-web` client?), CORS origins, custom API domains |
| 6 | Deployed Lambda: environment name, database name, code hash (compare with a local synth of a commit), whether the identity (email) function exists per environment |
| 7-8 | Whether `app.ogevia.com`, `demo.ogevia.com` or `ogevia.com` exist anywhere in Route 53 / ACM / CloudFront |
| 9-11 | Evidence buckets, KMS rotation, secrets metadata, and the RDS master-secret mapping question (instance vs secret) |
| 12 | Private networking, NAT (cost), security groups, leftover admin host |
| 13-14 | Alarm delivery, log retention, CloudTrail, GuardDuty, WAF |
| 15-16 | Budget vs estimated spend; whether SES is configured (it should not be) |

What this cannot tell us (needs a database session or Netlify, both separate steps): the applied migration ledger (`select count(*), max(version) from ogevia_meta.schema_migrations` in `ogevia_prd` and `ogevia_sv_test`), and what `app.ogevia.com`/`www.ogevia.com` currently serve (Netlify dashboard and a browser).
