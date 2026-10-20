#!/usr/bin/env bash
# Mock aws for the production release package (stage A) tests. READ verbs only: any other verb exits 98 and is logged.
D="$MOCK_DIR"; echo "$*" >> "$D/aws-calls.log"
svc="$1"; verb="$2"; shift 2
arg() { local k="$1"; shift; while [[ $# -gt 0 ]]; do [[ "$1" == "$k" ]] && { echo "$2"; return; }; shift; done; }
FN=Ogevia-prd-ServiceVerificationApi-Handler886CB40B-MOCK; IDFN=Ogevia-prd-ServiceVerificationApi-IdentityHandler6F0A3417-MOCK
case "$svc $verb" in
  "sts get-caller-identity") echo '{"Account":"300094796789","Arn":"arn:aws:sts::300094796789:assumed-role/mock/operator"}' ;;
  "cloudformation describe-stacks")
    S=$(arg --stack-name "$@"); [[ -f "$D/templates/$S.json" ]] || { echo "does not exist" >&2; exit 254; }
    case "$S" in
      Ogevia-prd-WebHosting) O="[{\"OutputKey\":\"WebOrigin\",\"OutputValue\":\"file://$D/web\"},{\"OutputKey\":\"SiteBucketName\",\"OutputValue\":\"ogevia-prd-webhosting-mockbucket\"},{\"OutputKey\":\"DistributionId\",\"OutputValue\":\"EMOCK123\"}]" ;;
      Ogevia-prd-ServiceVerificationApi) O='[{"OutputKey":"ApiUrl","OutputValue":"https://zk527zk4ua.execute-api.us-west-2.amazonaws.com"}]' ;;
      *) O='[]' ;;
    esac
    echo "{\"Stacks\":[{\"StackName\":\"$S\",\"StackStatus\":\"${MOCK_STACK_STATUS:-UPDATE_COMPLETE}\",\"EnableTerminationProtection\":true,\"LastUpdatedTime\":\"2026-10-10T06:11:29.031Z\",\"Outputs\":$O,\"Parameters\":[]}]}" ;;
  "cloudformation get-template") S=$(arg --stack-name "$@"); echo "{\"TemplateBody\":$(cat "$D/templates/$S.json")}" ;;
  "cloudformation list-stack-resources")
    S=$(arg --stack-name "$@")
    case "$S" in
      Ogevia-prd-ServiceVerificationApi) echo "{\"StackResourceSummaries\":[{\"ResourceType\":\"AWS::Lambda::Function\",\"LogicalResourceId\":\"Handler886CB40B\",\"PhysicalResourceId\":\"$FN\"},{\"ResourceType\":\"AWS::Lambda::Function\",\"LogicalResourceId\":\"IdentityHandler6F0A3417\",\"PhysicalResourceId\":\"$IDFN\"},{\"ResourceType\":\"AWS::ApiGatewayV2::Api\",\"LogicalResourceId\":\"ApiF70053CD\",\"PhysicalResourceId\":\"zk527zk4ua\"}]}" ;;
      Ogevia-prod-NetworkEgress) echo '{"StackResourceSummaries":[{"ResourceType":"AWS::EC2::VPCEndpoint","LogicalResourceId":"S3GatewayEndpointE8BAF1BC","PhysicalResourceId":"vpce-0abc1234def567890"}]}' ;;
      *) echo '{"StackResourceSummaries":[]}' ;;
    esac ;;
  "lambda get-function-configuration")
    N=$(arg --function-name "$@"); SHA=$(openssl dgst -sha256 -binary "$D/code.zip" | base64); [[ -n "${MOCK_ZIP_MISMATCH:-}" ]] && SHA="AAAA$SHA"
    echo "{\"FunctionName\":\"$N\",\"Runtime\":\"nodejs24.x\",\"Handler\":\"index.handler\",\"MemorySize\":512,\"Timeout\":30,\"LastModified\":\"2026-10-10T06:11:29.031+0000\",\"LastUpdateStatus\":\"Successful\",\"State\":\"Active\",\"CodeSha256\":\"$SHA\",\"CodeSize\":1234,\"LoggingConfig\":{\"LogGroup\":\"mock-log-group\"},\"Architectures\":[\"arm64\"],\"Environment\":{\"Variables\":{\"DB_NAME\":\"${MOCK_LAMBDA_DB:-ogevia_prd}\",\"OGEVIA_ENV\":\"${MOCK_LAMBDA_ENV:-prd}\",\"SOME_SECRET_ARN\":\"arn:aws:secretsmanager:us-west-2:300094796789:secret:x\"}}}" ;;
  "lambda get-function") echo "{\"Code\":{\"Location\":\"file://$D/code.zip\"}}" ;;
  "s3api head-object") [[ -n "${MOCK_NO_ASSET:-}" ]] && { echo "Not Found" >&2; exit 254; }; echo '{"ContentLength":123456}' ;;
  "apigatewayv2 get-routes") jq -n '{Items: [range(0;228) | {RouteKey: ("GET /r" + tostring)}]}' ;;
  "events list-rules") echo '{"Rules":[{"Name":"Ogevia-prd-ServiceVerifica-ComplianceSweep51D1109D-MOCK","State":"ENABLED"},{"Name":"unrelated","State":"ENABLED"}]}' ;;
  "s3 sync") if [[ "$1" == s3://* ]]; then mkdir -p "$2"; cp -r "$D/web/." "$2"; else echo "mock aws: upload refused" >&2; echo "UNEXPECTED s3 sync upload" >> "$D/unexpected.log"; exit 98; fi ;;
  "ec2 describe-vpc-endpoints") jq -n --slurpfile p "$D/endpoint-policy.json" '{VpcEndpoints:[{PolicyDocument: ($p[0]|tostring)}]}' ;;
  "rds describe-db-instances") echo '{"DBInstances":[{"DBInstanceStatus":"available","PubliclyAccessible":false,"StorageEncrypted":true,"EngineVersion":"18.3","DBInstanceClass":"db.t4g.micro","MultiAZ":false,"BackupRetentionPeriod":7,"LatestRestorableTime":"2026-10-20T03:00:00Z","DeletionProtection":true,"VpcSecurityGroups":[{"VpcSecurityGroupId":"sg-00530a1f4f7648e65"}]}]}' ;;
  "rds describe-db-snapshots") echo '{"DBSnapshots":[{"DBSnapshotIdentifier":"ogevia-prod-postgres-pre-rehearsal-202610200131","SnapshotCreateTime":"2026-10-20T01:32:01Z"},{"DBSnapshotIdentifier":"ogevia-prod-postgres-pre-prd-20261010","SnapshotCreateTime":"2026-10-10T05:44:48Z"}]}' ;;
  "cognito-idp list-user-pools") echo '{"UserPools":[{"Id":"us-west-2_MOCKPOOL"}]}' ;;
  "cognito-idp describe-user-pool") echo '{"UserPool":{"MfaConfiguration":"ON"}}' ;;
  "secretsmanager describe-secret") echo '{"Name":"ogevia/prd/database/app","LastChangedDate":"2026-10-10T06:00:17Z","RotationEnabled":false}' ;;
  "s3api list-buckets") echo '{"Buckets":[{"Name":"ogevia-prd-signature-evidence-mock"},{"Name":"someone-elses-bucket"}]}' ;;
  "s3api get-bucket-versioning") echo '{"Status":"Enabled"}' ;;
  "s3api get-public-access-block") echo '{"PublicAccessBlockConfiguration":{"BlockPublicAcls":true,"IgnorePublicAcls":true,"BlockPublicPolicy":true,"RestrictPublicBuckets":true}}' ;;
  *) echo "mock aws: unexpected call: $svc $verb" >&2; echo "UNEXPECTED $svc $verb" >> "$D/unexpected.log"; exit 98 ;;
esac
