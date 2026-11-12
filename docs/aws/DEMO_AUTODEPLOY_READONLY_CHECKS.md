# Read-only checks before approving demo auto-deploy (U1–U4)

Run in **AWS CloudShell**, region **us-west-2**, signed in to account 300094796789. Every command only *reads*. None prints a secret, a password or any data from a database. Paste the whole output back.

```bash
export AWS_REGION=us-west-2 AWS_PAGER=""
echo "### 0 who am I";            aws sts get-caller-identity --query '{account:Account,arn:Arn}' --output json
echo "### U1 database instances"; aws rds describe-db-instances --query 'DBInstances[].{id:DBInstanceIdentifier,class:DBInstanceClass,status:DBInstanceStatus,engine:EngineVersion,storageGiB:AllocatedStorage,multiAZ:MultiAZ,public:PubliclyAccessible,backupDays:BackupRetentionPeriod,deletionProtection:DeletionProtection}' --output table
echo "### U2 admin host role";    aws iam list-attached-role-policies --role-name OgeviaDBAdminSSMRole --output table; aws iam list-role-policies --role-name OgeviaDBAdminSSMRole --output table
echo "### U2 admin host";         aws ec2 describe-instances --filters "Name=tag:Name,Values=ogevia-db-admin*" --query 'Reservations[].Instances[].{id:InstanceId,state:State.Name,type:InstanceType,profile:IamInstanceProfile.Arn}' --output table
echo "### U3 stacks";             aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE --query "StackSummaries[?contains(StackName,'Ogevia') || contains(StackName,'ogevia')].StackName" --output text
echo "### U3 web hosting outputs"; for s in $(aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE --query "StackSummaries[?contains(StackName,'WebHosting')].StackName" --output text); do echo "-- $s"; aws cloudformation describe-stacks --stack-name "$s" --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text; done
echo "### U3 distributions";      aws cloudfront list-distributions --query 'DistributionList.Items[].{id:Id,domain:DomainName,aliases:Aliases.Items,origin:Origins.Items[0].DomainName}' --output json
echo "### U3 OIDC providers (does one for GitHub already exist?)"; aws iam list-open-id-connect-providers --output text
```

## What each output tells us

| Block | Question | How to read it |
|---|---|---|
| 0 | Right account? | Must say 300094796789. If not, stop and re-sign-in. |
| **U1** | **Do demo and production share one database server?** | Records say test (`ogevia_sv_test`) and production (`ogevia_prd`) databases both live on `ogevia-prod-postgres` (docs/releases/2026-10-30-caregiver-readiness/DEPLOYED_RECORD_0088_TEST.md). One row = shared server (confirmed). Two rows = a second server exists and the records are out of date. Also shows class, size, public access (must be `False`), backups and deletion protection. See `DEMO_PROD_DATABASE_SEPARATION_PROPOSAL.md`. |
| U2 | What can the admin host reach? | It decides whether demo migrations can be applied from the host with no new credential. We need the policy *names* only. |
| U2 host | Is it running? | `stopped` or no rows means the migration path needs a start step (or Option C). |
| U3 | Bucket and distribution ids for the demo site | I need the demo bucket name and CloudFront distribution id, and need to see that demo and production are **different** buckets and distributions. If only one WebHosting stack appears, the demo site may share production's hosting: tell me and I will stop and flag it. |
| U3 OIDC | Is there already a GitHub provider? | Empty = we create one (free). One listed = reuse it, add a role only. |
| U4 | GitHub Actions minutes | Not an AWS fact. GitHub → organization **Settings → Billing and plans → Usage** (Actions minutes included in the plan, and whether private-repo minutes are enabled). Send a screenshot or the plan name. |

Nothing here creates, changes or deletes anything.
