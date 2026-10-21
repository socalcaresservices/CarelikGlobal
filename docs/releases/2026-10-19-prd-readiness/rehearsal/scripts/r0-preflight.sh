#!/usr/bin/env bash
# R0 PREFLIGHT (READ-ONLY). Establishes the unknowns the rehearsal plan lists, from AWS describe calls only, and writes $OUT/r0.json (no secret values).
#   bash r0-preflight.sh
# Changes nothing. Exit 0 = facts recorded; exit 1 = a precondition failed (read the STOP line).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need aws jq psql sha256sum timeout
say "== R0 preflight $(date -u +%FT%TZ) =="; check_account
I=$(prod_instance) && [[ -n "$I" && "$I" != null ]] || stop "cannot describe $PROD_RDS"
[[ "$(jq -r .DBInstanceStatus <<<"$I")" == available ]] || stop "$PROD_RDS is not available"
[[ "$(jq -r .PubliclyAccessible <<<"$I")" == false ]] || stop "$PROD_RDS is publicly accessible: not an expected configuration"
[[ "$(jq -r .StorageEncrypted <<<"$I")" == true ]] || stop "$PROD_RDS is not encrypted: refusing to copy it"
[[ "$(jq -r '[.VpcSecurityGroups[].VpcSecurityGroupId] | join(" ")' <<<"$I")" == "$PROD_RDS_SG" ]] || stop "the production instance's security groups are not exactly $PROD_RDS_SG"
CLASS=$(jq -r .DBInstanceClass <<<"$I"); VPC=$(jq -r '.DBSubnetGroup.VpcId // empty' <<<"$I"); SUBNET=$(jq -r '.DBSubnetGroup.DBSubnetGroupName // empty' <<<"$I")
[[ -n "$CLASS" && -n "$VPC" && -n "$SUBNET" ]] || stop "class, VPC or subnet group could not be read"
PG=$(jq -r '[.DBParameterGroups[]?.DBParameterGroupName] | first // empty' <<<"$I")
say "production instance: $CLASS, engine $(jq -r .Engine <<<"$I") $(jq -r .EngineVersion <<<"$I"), storage $(jq -r .AllocatedStorage <<<"$I") GB ($(jq -r .StorageType <<<"$I")), multi-AZ $(jq -r .MultiAZ <<<"$I"), subnet group $SUBNET, parameter group ${PG:-none}"
H=$(A ec2 describe-instances --filters "Name=tag:Name,Values=$ADMIN_TAG" "Name=instance-state-name,Values=running" --output json 2>/dev/null) || stop "cannot look up the admin host"
[[ "$(jq '[.Reservations[].Instances[]] | length' <<<"$H")" == 1 ]] || stop "expected exactly one running admin host tagged $ADMIN_TAG"
ADM=$(jq -c '.Reservations[0].Instances[0]' <<<"$H")
[[ "$(jq '.NetworkInterfaces | length' <<<"$ADM")" == 1 && "$(jq '.NetworkInterfaces[0].PrivateIpAddresses | length' <<<"$ADM")" == 1 ]] || stop "the admin host must have exactly one interface and one private IP"
ADM_IP=$(jq -r .PrivateIpAddress <<<"$ADM"); ADM_ID=$(jq -r .InstanceId <<<"$ADM"); ADM_VPC=$(jq -r .VpcId <<<"$ADM")
[[ "$ADM_IP" =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.) ]] || stop "the admin host address '$ADM_IP' is not a private IPv4 address"
[[ "$ADM_VPC" == "$VPC" ]] || stop "the admin host is in $ADM_VPC, the database in $VPC"
say "admin host $ADM_ID at $ADM_IP in $ADM_VPC"
LEFT=$(A rds describe-db-instances --output json 2>/dev/null | jq -r '[.DBInstances[].DBInstanceIdentifier | select(startswith("ogevia-prd-rehearsal-"))] | join(",")') || stop "cannot list instances"
[[ -z "$LEFT" ]] || say "NOTE: rehearsal instance(s) already exist: $LEFT (the restore step will refuse a name clash)"
SN=$(A rds describe-db-snapshots --db-instance-identifier "$PROD_RDS" --snapshot-type manual --output json 2>/dev/null | jq -r '[.DBSnapshots[].DBSnapshotIdentifier] | length') || stop "cannot list snapshots"
say "manual snapshots of $PROD_RDS: $SN"
jq -n --arg class "$CLASS" --arg vpc "$VPC" --arg subnet "$SUBNET" --arg pg "$PG" --arg kms "$(jq -r '.KmsKeyId // empty' <<<"$I")" --arg secret "$(jq -r '.MasterUserSecret.SecretArn // empty' <<<"$I")" \
  --arg endpoint "$(jq -r .Endpoint.Address <<<"$I")" --arg admId "$ADM_ID" --arg admIp "$ADM_IP" --arg storage "$(jq -r .AllocatedStorage <<<"$I")" --arg engine "$(jq -r .EngineVersion <<<"$I")" \
  '{class:$class,vpc:$vpc,subnetGroup:$subnet,parameterGroup:$pg,kmsKeyId:$kms,masterSecretArn:$secret,endpoint:$endpoint,adminInstanceId:$admId,adminIp:$admIp,allocatedStorageGb:$storage,engineVersion:$engine}' > "$OUT/r0.json" || stop "cannot write r0.json"
chmod 600 "$OUT/r0.json"
say "cost (cost model rate \$0.022/hour for db.t4g.micro): $(awk 'BEGIN{printf "%.3f", 0.022*24}') USD per day of instance time; storage ($(jq -r .AllocatedStorage <<<"$I") GB) and snapshot charges are not included; check live pricing"
say "STILL TO CONFIRM BEFORE R2: (1) whether the restored instance accepts the source master credential (r2 verify reports it; if not, a new master password is a YELLOW step); (2) whether pg_dump is wanted (not used by this package)"
# The restore step's flags were written without a live CLI to check them: confirm the CLI's own parameter list knows every one (local, read-only; no AWS call is made by --generate-cli-skeleton).
SK=$(aws rds restore-db-instance-from-db-snapshot --generate-cli-skeleton input 2>/dev/null) || stop "the AWS CLI cannot describe restore-db-instance-from-db-snapshot"
for k in DBInstanceIdentifier DBSnapshotIdentifier DBInstanceClass DBSubnetGroupName MultiAZ PubliclyAccessible AutoMinorVersionUpgrade Tags VpcSecurityGroupIds DBParameterGroupName DeletionProtection; do
  jq -e --arg k "$k" 'has($k)' <<<"$SK" >/dev/null 2>&1 || stop "the installed AWS CLI has no parameter $k for restore-db-instance-from-db-snapshot: r2-restore.sh must be revised before use"
done
say "the installed AWS CLI knows all 11 restore parameters the package uses"
say "R0 PASSED: facts recorded in $OUT/r0.json. Nothing was changed."
