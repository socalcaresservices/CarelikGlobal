# Read-only AWS verification of TEST and PROD: operator instructions (2026-10-15)

**Status: PREPARED, NOT EXECUTED.** The owner approved this read-only verification on 2026-10-15. The Claude Code session has no working AWS access (credentials are proxy placeholders; `sts:GetCallerIdentity` returned `InvalidClientTokenId`), so nothing below has been run by Claude Code. Results are NOT VERIFIED until the operator sends the output.

Authorized: sections A and B below. **Not authorized:** deployment, code or configuration change, migration, any database connection (no `psql`, no SSM tunnel), infrastructure or DNS change, reading any secret value, production smoke test (`deploy-production.sh smoke`), real patient information, snapshot creation.

Where: AWS CloudShell, region us-west-2, administrator role. Account must be `300094796789`; stop if it is not.

## A. TEST (`Ogevia-prod-*`): existing read-only preflight, from `main`

```bash
git clone https://github.com/socalcaresservices/CarelikGlobal.git   # skip if already cloned
cd CarelikGlobal && git fetch origin main && git checkout main && git pull --ff-only origin main
git rev-parse HEAD            # record it; expect d82fefcd37407d837e7c94f6ac57a907ea286ed1 or later
bash infra/aws/slice/pilot-preflight-readonly.sh --probe-lambda
```
`--probe-lambda` sends only GET routes through the Lambda with the synthetic test identity (no database write). Send back `SUMMARY.txt`, `routes-to-add.txt`, `routes-live-only.txt` and `snapshots.txt` from the folder it creates. If it prints STOP, change nothing and send the summary.

## B. PROD (`Ogevia-prd-*`): read-only inventory (no script exists; the TEST script refuses production by design)

```bash
export AWS_REGION=us-west-2 AWS_PAGER=""
aws sts get-caller-identity --query Account --output text        # expect 300094796789; STOP otherwise

for s in DatabaseSecret EvidenceStorage WebHosting ServiceVerificationApi Observability; do
  aws cloudformation describe-stacks --stack-name Ogevia-prd-$s \
    --query 'Stacks[0].[StackName,StackStatus,LastUpdatedTime]' --output text
done

WEB=$(aws cloudformation describe-stacks --stack-name Ogevia-prd-WebHosting --query "Stacks[0].Outputs[?OutputKey=='WebOrigin'].OutputValue" --output text)
API=$(aws cloudformation describe-stacks --stack-name Ogevia-prd-ServiceVerificationApi --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)
BUCKET=$(aws cloudformation describe-stacks --stack-name Ogevia-prd-WebHosting --query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue" --output text)
echo "$WEB"; echo "$API"

# Lambda: only the code hash, last-modified time, state and the two environment names that matter (no other variables)
FN=$(aws cloudformation list-stack-resources --stack-name Ogevia-prd-ServiceVerificationApi --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function' && starts_with(LogicalResourceId,'Handler')].PhysicalResourceId" --output text)
aws lambda get-function-configuration --function-name "$FN" \
  --query '{sha:CodeSha256,modified:LastModified,state:State,db:Environment.Variables.DB_NAME,env:Environment.Variables.OGEVIA_ENV}'

# Live routes (main has 169) and three Wave 1 route probes (401 = route exists, 404 = not deployed)
API_ID=$(aws cloudformation list-stack-resources --stack-name Ogevia-prd-ServiceVerificationApi --query "StackResourceSummaries[?ResourceType=='AWS::ApiGatewayV2::Api'].PhysicalResourceId" --output text)
aws apigatewayv2 get-routes --api-id "$API_ID" --query 'length(Items)'
for r in visit-rules open-shifts accounts; do printf '%s ' $r; curl -s -o /dev/null -m 20 -w '%{http_code}\n' "$API/v1/$r"; done

# Frontend: loads? which API does it call? when published?
curl -s -m 20 -o /dev/null -w 'web / -> %{http_code}\n' "$WEB/"
curl -s -m 20 "$WEB/config.json"; echo
aws s3api head-object --bucket "$BUCKET" --key index.html --query '{LastModified:LastModified,VersionId:VersionId}'
for f in $(curl -s -m 20 "$WEB/" | grep -oE 'assets/[A-Za-z0-9._-]+\.js' | sort -u); do
  curl -s -m 30 "$WEB/$f" | grep -oE 'https://[a-z0-9]+\.execute-api\.us-west-2\.amazonaws\.com' | sort -u
done    # expect zk527zk4ua (PROD) and NOT s0epy5rgzb (TEST)

# RDS health and backups (describe only)
aws rds describe-db-instances --db-instance-identifier ogevia-prod-postgres \
  --query 'DBInstances[0].[DBInstanceStatus,BackupRetentionPeriod,StorageEncrypted,PubliclyAccessible,DeletionProtection,LatestRestorableTime]' --output text
aws rds describe-db-snapshots --db-instance-identifier ogevia-prod-postgres \
  --query 'reverse(sort_by(DBSnapshots,&SnapshotCreateTime))[:5].[DBSnapshotIdentifier,SnapshotType,Status,SnapshotCreateTime]' --output text
```
Also run the "Frontend" block against TEST (stack prefix `Ogevia-prod-`, expect `s0epy5rgzb`) and confirm the "TEST — synthetic data only" banner in a browser.

## What the output will and will not prove
- Proves: stack states, Lambda code hash and database name, live route count versus 169 on `main`, whether Wave 1 routes exist, which API the frontend bundle names, backups.
- Does **not** prove: the Git commit (no build stamp, Blocker B-14; use the last deploy log) or the exact migration ledger (needs a database connection, which is not authorized; the TEST probe gives a generation fingerprint only).

## Return to Claude Code
The text outputs above (they contain no secret values). Claude Code then records them in `BLOCKER_REGISTER.md` and the release checklist and produces the TEST-versus-`main` gap list.
