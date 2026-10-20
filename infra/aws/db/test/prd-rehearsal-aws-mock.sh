#!/usr/bin/env bash
D="$MOCK_DIR"; echo "$*" >> "$D/aws-calls.log"
svc="$1"; verb="$2"; shift 2
arg() { local k="$1"; shift; while [[ $# -gt 0 ]]; do [[ "$1" == "$k" ]] && { echo "$2"; return; }; shift; done; }
iso() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }
case "$svc $verb" in
  "sts get-caller-identity") echo '{"Account":"300094796789"}' ;;
  "rds describe-db-instances")
    id=$(arg --db-instance-identifier "$@")
    if [[ -z "$id" ]]; then
      if [[ -f "$D/reh.env" ]]; then source "$D/reh.env"; echo "{\"DBInstances\":[{\"DBInstanceIdentifier\":\"ogevia-prod-postgres\"},{\"DBInstanceIdentifier\":\"$REH\"}]}"; else echo '{"DBInstances":[{"DBInstanceIdentifier":"ogevia-prod-postgres"}]}'; fi
    elif [[ "$id" == ogevia-prod-postgres ]]; then jq -c '{DBInstances:[.]}' "$D/prod.json"
    elif [[ -f "$D/reh.env" ]]; then source "$D/reh.env"; [[ "$id" == "$REH" ]] || { echo DBInstanceNotFound >&2; exit 254; }
      tags="[{\"Key\":\"purpose\",\"Value\":\"rehearsal-delete-after\"},{\"Key\":\"source-snapshot\",\"Value\":\"$SNAP\"}]"; [[ -n "${MOCK_NO_TAG:-}" ]] && tags="[]"
      jq -c --arg id "$REH" --arg sg "$SG" --argjson tags "$tags" --arg ep "${MOCK_REH_ENDPOINT:-rehearsal.example.internal}" '{DBInstances:[. + {DBInstanceIdentifier:$id, VpcSecurityGroups:[{VpcSecurityGroupId:$sg}], TagList:$tags, Endpoint:{Address:$ep}}]}' "$D/prod.json"
    else echo DBInstanceNotFound >&2; exit 254; fi ;;
  "rds describe-db-snapshots")
    id=$(arg --db-snapshot-identifier "$@")
    if [[ -f "$D/snap.env" ]]; then source "$D/snap.env"; fi
    if [[ -n "$id" ]]; then [[ -f "$D/snap.env" && "$id" == "$SNAP" ]] || { echo DBSnapshotNotFound >&2; exit 254; }
      echo "{\"DBSnapshots\":[{\"DBSnapshotIdentifier\":\"$SNAP\",\"Status\":\"available\",\"DBInstanceIdentifier\":\"${MOCK_SNAP_INSTANCE:-ogevia-prod-postgres}\",\"SnapshotType\":\"manual\",\"Encrypted\":${MOCK_SNAP_ENC:-true},\"SnapshotCreateTime\":\"$CREATED\"}]}"
    elif [[ -f "$D/snap.env" ]]; then echo "{\"DBSnapshots\":[{\"DBSnapshotIdentifier\":\"$SNAP\"}]}"; else echo '{"DBSnapshots":[]}'; fi ;;
  "rds create-db-snapshot") echo "SNAP=$(arg --db-snapshot-identifier "$@")" > "$D/snap.env"; echo "CREATED=$(iso)" >> "$D/snap.env"; echo '{"DBSnapshot":{"Status":"creating"}}' ;;
  "rds delete-db-snapshot") rm -f "$D/snap.env"; echo '{}' ;;
  "rds wait") exit 0 ;;
  "rds restore-db-instance-from-db-snapshot")
    if [[ " $* " == *" --generate-cli-skeleton "* ]]; then echo '{"DBInstanceIdentifier":"","DBSnapshotIdentifier":"","DBInstanceClass":"","DBSubnetGroupName":"","MultiAZ":false,"PubliclyAccessible":false,"AutoMinorVersionUpgrade":false,"Tags":[],"VpcSecurityGroupIds":[],"DBParameterGroupName":"","DeletionProtection":false}'; exit 0; fi
    { echo "REH=$(arg --db-instance-identifier "$@")"; echo "SG=$(arg --vpc-security-group-ids "$@")"; echo "SNAP=$(arg --db-snapshot-identifier "$@")"; } > "$D/reh.env"; echo '{}' ;;
  "rds delete-db-instance") rm -f "$D/reh.env"; echo '{}' ;;
  "ec2 describe-instances") cat "$D/admin.json" ;;
  "ec2 create-security-group") echo "GROUPNAME=$(arg --group-name "$@")" > "$D/sg.env"; echo '{"GroupId":"sg-0a1b2c3d4e5f60718"}' ;;
  "ec2 authorize-security-group-ingress") echo '{}' ;;
  "ec2 describe-security-groups") [[ -f "$D/sg.env" ]] || { echo InvalidGroup.NotFound >&2; exit 254; }; source "$D/sg.env"; echo "{\"SecurityGroups\":[{\"GroupId\":\"sg-0a1b2c3d4e5f60718\",\"GroupName\":\"$GROUPNAME\"}]}" ;;
  "ec2 delete-security-group") n=$(cat "$D/sg-busy" 2>/dev/null || echo 0); if (( n > 0 )); then echo $((n-1)) > "$D/sg-busy"; echo DependencyViolation >&2; exit 254; fi; rm -f "$D/sg.env"; echo '{}' ;;
  "ssm start-session") echo "$(arg --parameters "$@")" >> "$D/ssm-params.log"; port=$(arg --parameters "$@" | sed -n 's/.*localPortNumber=\([0-9]*\).*/\1/p'); exec node "$D/proxy.js" "$port" ;;
  "secretsmanager get-secret-value") echo "{\"SecretString\":\"{\\\"username\\\":\\\"${MOCK_USERNAME:-postgres}\\\",\\\"password\\\":\\\"${MOCK_PASSWORD:-localtest}\\\"}\"}" ;;
  *) echo "mock aws: unexpected call: $svc $verb" >&2; echo "UNEXPECTED $svc $verb" >> "$D/unexpected.log"; exit 98 ;;
esac
