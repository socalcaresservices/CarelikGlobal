#!/usr/bin/env bash
# Mock aws for the production release package EXECUTION scripts (stages C1, D1-D3, E1). Stateful: security group rules ($D/sg.json), snapshots ($D/snaps.txt), the web bucket ($D/web, also the served origin).
# Every call is logged; WRITE verbs are logged separately in $D/writes.log; anything unknown exits 98.
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
      Ogevia-prd-ServiceVerificationApi) echo "{\"StackResourceSummaries\":[{\"ResourceType\":\"AWS::Events::Rule\",\"LogicalResourceId\":\"ComplianceSweep51D1109D\",\"PhysicalResourceId\":\"Ogevia-prd-ServiceVerifica-ComplianceSweep-MOCK\"},{\"ResourceType\":\"AWS::Lambda::Function\",\"LogicalResourceId\":\"Handler886CB40B\",\"PhysicalResourceId\":\"$FN\"},{\"ResourceType\":\"AWS::Lambda::Function\",\"LogicalResourceId\":\"IdentityHandler6F0A3417\",\"PhysicalResourceId\":\"$IDFN\"},{\"ResourceType\":\"AWS::ApiGatewayV2::Api\",\"LogicalResourceId\":\"ApiF70053CD\",\"PhysicalResourceId\":\"zk527zk4ua\"}]}" ;;
      Ogevia-prod-NetworkEgress) echo '{"StackResourceSummaries":[{"ResourceType":"AWS::EC2::VPCEndpoint","LogicalResourceId":"S3GatewayEndpointE8BAF1BC","PhysicalResourceId":"vpce-0abc1234def567890"}]}' ;;
      *) echo '{"StackResourceSummaries":[]}' ;;
    esac ;;
  "lambda get-function-configuration")
    N=$(arg --function-name "$@"); SHA=$(openssl dgst -sha256 -binary "$D/code.zip" | base64); [[ -n "${MOCK_ZIP_MISMATCH:-}" ]] && SHA="AAAA$SHA"
    echo "{\"FunctionName\":\"$N\",\"Runtime\":\"nodejs24.x\",\"Handler\":\"index.handler\",\"MemorySize\":512,\"Timeout\":30,\"LastModified\":\"2026-10-10T06:11:29.031+0000\",\"LastUpdateStatus\":\"Successful\",\"State\":\"Active\",\"CodeSha256\":\"$SHA\",\"CodeSize\":1234,\"LoggingConfig\":{\"LogGroup\":\"mock-log-group\"},\"Architectures\":[\"arm64\"],\"Environment\":{\"Variables\":{\"DB_NAME\":\"${MOCK_LAMBDA_DB:-ogevia_prd}\",\"OGEVIA_ENV\":\"${MOCK_LAMBDA_ENV:-prd}\",\"SOME_SECRET_ARN\":\"arn:aws:secretsmanager:us-west-2:300094796789:secret:x\"}}}" ;;
  "lambda get-function") echo "{\"Code\":{\"Location\":\"file://$D/code.zip\"}}" ;;
  "s3api head-object") [[ -n "${MOCK_NO_ASSET:-}" ]] && { echo "Not Found" >&2; exit 254; }; echo '{"ContentLength":123456}' ;;
  "apigatewayv2 get-routes") jq -n --argjson n "${MOCK_ROUTES:-228}" '{Items: [range(0;$n) | {RouteKey: ("GET /r" + tostring)}]}' ;;
  "events describe-rule") echo "{\"Name\":\"$(arg --name "$@")\",\"State\":\"${MOCK_RULE_STATE:-ENABLED}\"}" ;;
  "events list-rules") echo '{"Rules":[{"Name":"Ogevia-prd-ServiceVerifica-ComplianceSweep51D1109D-MOCK","State":"ENABLED"},{"Name":"unrelated","State":"ENABLED"}]}' ;;
  "s3 sync")
    if [[ "$1" == s3://* ]]; then mkdir -p "$2"; cp -r "$D/web/." "$2"
    else
      src="$1"; dst="${2#s3://}"; prefix="${dst#*/}"; [[ "$dst" == */* ]] || prefix=""; ex=(); shift 2
      while [[ $# -gt 0 ]]; do case "$1" in --exclude) ex+=("$2"); shift 2 ;; --delete) echo "UNEXPECTED s3 sync --delete" >> "$D/unexpected.log"; exit 97 ;; *) shift ;; esac; done
      echo "s3 sync $src -> $2 (exclude: ${ex[*]})" >> "$D/writes.log"
      (cd "$src" && find . -type f | sed 's|^\./||') | while read -r f; do skip=0; for e in "${ex[@]}"; do case "$f" in $e) skip=1 ;; esac; done; [[ $skip == 1 ]] && continue
        t="$D/web/${prefix:+$prefix/}$f"; mkdir -p "$(dirname "$t")"; cp "$src/$f" "$t"; done
    fi ;;
  "s3 cp") src="$1"; dst="${2#s3://}"; key="${dst#*/}"; echo "s3 cp $src -> $2 $*" >> "$D/writes.log"; mkdir -p "$(dirname "$D/web/$key")"; cp "$src" "$D/web/$key" ;;
  "s3api list-objects-v2") (cd "$D/web" && find . -type f | sed 's|^\./||' | while read -r f; do printf '%s\t%s\n' "$f" "$(stat -c %s "$f")"; done) | jq -Rn '{IsTruncated:false, Contents:[inputs | split("\t") | {Key:.[0], Size:(.[1]|tonumber)}]}' ;;
  "cloudfront create-invalidation") echo "cloudfront create-invalidation $*" >> "$D/writes.log"; echo '{"Invalidation":{"Id":"IMOCK"}}' ;;
  "logs filter-log-events") jq -n --argjson n "${MOCK_LOG_ERRORS:-0}" '{events:[range(0;$n) | {message:"x"}]}' ;;
  "ec2 describe-instances") cat "$D/admin.json" ;;
  "ec2 describe-network-interfaces") if [[ "$*" == *addresses.private-ip-address* ]]; then cat "$D/nic-by-ip.json"; else cat "$D/nic-by-group.json"; fi ;;
  "ec2 describe-security-groups") [[ -n "${MOCK_SG_FAIL:-}" ]] && { echo "throttled" >&2; exit 254; }; cat "$D/sg.json" ;;
  "ec2 authorize-security-group-ingress")
    spec=$(arg --ip-permissions "$@"); cidr=$(sed -n 's/.*CidrIp=\([0-9./]*\).*/\1/p' <<<"$spec"); desc=$(sed -n 's/.*Description=\([^}]*\)}.*/\1/p' <<<"$spec"); echo "authorize $(arg --group-id "$@") $cidr $desc" >> "$D/writes.log"
    jq --arg c "$cidr" --arg d "$desc" '.SecurityGroups[0].IpPermissions |= (if any(.[]; .IpProtocol=="tcp" and .FromPort==5432 and .ToPort==5432) then map(if (.IpProtocol=="tcp" and .FromPort==5432 and .ToPort==5432) then .IpRanges += [{CidrIp:$c,Description:$d}] else . end) else . + [{IpProtocol:"tcp",FromPort:5432,ToPort:5432,IpRanges:[{CidrIp:$c,Description:$d}],Ipv6Ranges:[],PrefixListIds:[],UserIdGroupPairs:[]}] end)' "$D/sg.json" > "$D/sg.tmp" && mv "$D/sg.tmp" "$D/sg.json"; echo '{}' ;;
  "ec2 revoke-security-group-ingress")
    spec=$(arg --ip-permissions "$@"); cidr=$(sed -n 's/.*CidrIp=\([0-9./]*\).*/\1/p' <<<"$spec"); echo "revoke $(arg --group-id "$@") $cidr" >> "$D/writes.log"; [[ -n "${MOCK_REVOKE_FAIL:-}" ]] && { echo "RequestLimitExceeded" >&2; exit 254; }
    jq --arg c "$cidr" '.SecurityGroups[0].IpPermissions |= (map(if (.IpProtocol=="tcp" and .FromPort==5432 and .ToPort==5432) then .IpRanges |= map(select(.CidrIp != $c)) else . end) | map(select((.IpRanges|length)>0 or (.UserIdGroupPairs|length)>0)))' "$D/sg.json" > "$D/sg.tmp" && mv "$D/sg.tmp" "$D/sg.json"; echo '{}' ;;
  "ssm start-session") port=$(arg --parameters "$@" | sed -n 's/.*localPortNumber=\([0-9]*\).*/\1/p'); echo "ssm start-session $port" >> "$D/writes.log"; exec node "$D/proxy.js" "$port" ;;
  "secretsmanager get-secret-value") echo "secret read" >> "$D/writes.log"; echo "{\"SecretString\":\"{\\\"username\\\":\\\"postgres\\\",\\\"password\\\":\\\"localtest\\\"}\"}" ;;
  "cognito-idp admin-get-user") u=$(arg --username "$@"); jq -e --arg u "$u" '.[$u]' "$D/cognito-users.json" > "$D/cog.tmp" 2>/dev/null || { echo "UserNotFoundException" >&2; exit 254; }; jq -n --slurpfile x "$D/cog.tmp" '{Username:"u", UserStatus:$x[0].status, Enabled:$x[0].enabled, UserAttributes:[{Name:"sub",Value:$x[0].sub},{Name:"email",Value:"x"}]}' ;;
  "rds create-db-snapshot") id=$(arg --db-snapshot-identifier "$@"); echo "rds create-db-snapshot $*" >> "$D/writes.log"; echo "$id $(date -u +%s)" >> "$D/snaps.txt"; echo '{"DBSnapshot":{"Status":"creating"}}' ;;
  "ec2 describe-vpc-endpoints") jq -n --slurpfile p "$D/endpoint-policy.json" '{VpcEndpoints:[{PolicyDocument: ($p[0]|tostring)}]}' ;;
  "rds describe-db-instances") echo '{"DBInstances":[{"DBInstanceStatus":"available","PubliclyAccessible":false,"StorageEncrypted":true,"EngineVersion":"18.3","DBInstanceClass":"db.t4g.micro","MultiAZ":false,"BackupRetentionPeriod":7,"LatestRestorableTime":"2026-10-20T03:00:00Z","DeletionProtection":true,"VpcSecurityGroups":[{"VpcSecurityGroupId":"sg-00530a1f4f7648e65"}],"Endpoint":{"Address":"prod.example.internal"},"MasterUserSecret":{"SecretArn":"arn:aws:secretsmanager:us-west-2:300094796789:secret:rds!db-abc-123"}}]}' ;;
  "rds describe-db-snapshots")
    id=$(arg --db-snapshot-identifier "$@")
    if [[ -n "$id" ]]; then
      line=$(grep "^$id " "$D/snaps.txt" 2>/dev/null | tail -1); [[ -n "$line" ]] || { echo "DBSnapshotNotFound" >&2; exit 254; }
      T=$(date -u -d "@$(( ${line#* } - ${MOCK_SNAP_AGE:-0} ))" +%Y-%m-%dT%H:%M:%SZ)
      echo "{\"DBSnapshots\":[{\"DBSnapshotIdentifier\":\"$id\",\"Status\":\"${MOCK_SNAP_STATUS:-available}\",\"DBInstanceIdentifier\":\"ogevia-prod-postgres\",\"SnapshotType\":\"manual\",\"Encrypted\":${MOCK_SNAP_ENC:-true},\"SnapshotCreateTime\":\"$T\"}]}"
    else echo '{"DBSnapshots":[{"DBSnapshotIdentifier":"ogevia-prod-postgres-pre-rehearsal-202610200131","SnapshotCreateTime":"2026-10-20T01:32:01Z"},{"DBSnapshotIdentifier":"ogevia-prod-postgres-pre-prd-20261010","SnapshotCreateTime":"2026-10-10T05:44:48Z"}]}'; fi ;;
  "cognito-idp list-user-pools") echo '{"UserPools":[{"Id":"us-west-2_MOCKPOOL"}]}' ;;
  "cognito-idp describe-user-pool") echo '{"UserPool":{"MfaConfiguration":"ON"}}' ;;
  "secretsmanager describe-secret") echo '{"Name":"ogevia/prd/database/app","LastChangedDate":"2026-10-10T06:00:17Z","RotationEnabled":false}' ;;
  "s3api list-buckets") echo '{"Buckets":[{"Name":"ogevia-prd-signature-evidence-mock"},{"Name":"someone-elses-bucket"}]}' ;;
  "s3api get-bucket-versioning") echo '{"Status":"Enabled"}' ;;
  "s3api get-public-access-block") echo '{"PublicAccessBlockConfiguration":{"BlockPublicAcls":true,"IgnorePublicAcls":true,"BlockPublicPolicy":true,"RestrictPublicBuckets":true}}' ;;
  *) echo "mock aws: unexpected call: $svc $verb" >&2; echo "UNEXPECTED $svc $verb" >> "$D/unexpected.log"; exit 98 ;;
esac
