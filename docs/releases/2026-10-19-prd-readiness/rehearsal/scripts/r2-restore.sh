#!/usr/bin/env bash
# R2 RESTORE the verified snapshot to a NEW instance ogevia-prd-rehearsal-YYYYMMDD with its OWN security group. YELLOW (creates a security group, one ingress rule on THAT group only,
# and an RDS instance that costs money until deleted). Never modifies ogevia-prod-postgres or the shared security group $PROD_RDS_SG.
#   bash r2-restore.sh restore     create group + rule + instance, wait, verify
#   bash r2-restore.sh verify      read-only re-check of the rehearsal instance
# On any failure after the group exists nothing is deleted automatically: run r8-teardown.sh plan to see what exists (deleting is RED and separate).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
MODE="${1:-}"; [[ "$MODE" == restore || "$MODE" == verify ]] || { echo "usage: bash r2-restore.sh restore|verify" >&2; exit 2; }
need aws jq timeout date
check_account
[[ -s "$OUT/r0.json" ]] || stop "run r0-preflight.sh first"
R=$(cat "$OUT/r0.json"); CLASS=$(jq -r .class <<<"$R"); VPC=$(jq -r .vpc <<<"$R"); SUBNET=$(jq -r .subnetGroup <<<"$R"); PG=$(jq -r .parameterGroup <<<"$R"); KMS=$(jq -r .kmsKeyId <<<"$R"); ADM_IP=$(jq -r .adminIp <<<"$R"); PROD_EP=$(jq -r .endpoint <<<"$R")
SNAP=$(state_get SNAP_ID); [[ "$SNAP" =~ ^ogevia-prod-postgres-pre-rehearsal-[0-9]{12}$ ]] || stop "no verified rehearsal snapshot in $STATE: run r1-snapshot.sh verify"
if [[ "$MODE" == restore ]]; then
  REH="${OGEVIA_REHEARSAL_ID:-ogevia-prd-rehearsal-$(date -u +%Y%m%d)}"
  valid_reh_id "$REH" || stop "'$REH' is not a valid rehearsal identifier (ogevia-prd-rehearsal-YYYYMMDD)"
  [[ -z "$(state_get REH_ID)" || "$(state_get REH_ID)" == "$REH" ]] || stop "state already records $(state_get REH_ID): finish or tear that down first"
  if A rds describe-db-instances --db-instance-identifier "$REH" --output json >/dev/null 2>&1; then stop "an instance named $REH already exists"; fi
  say "PROPOSED CHANGES (and no others):"
  say "  1. create security group $REH-sg in $VPC (its own group; the shared group $PROD_RDS_SG is NOT touched)"
  say "  2. allow tcp 5432 on THAT group from $ADM_IP/32 only (the admin host)"
  say "  3. restore $SNAP to NEW instance $REH: class $CLASS, subnet group $SUBNET, ${PG:+parameter group $PG, }private, single-AZ, deletion protection off, tagged purpose=rehearsal-delete-after"
  say "  Cost: about 0.53 USD per day of instance time plus storage; delete the copy when finished (r8-teardown.sh)."
  confirm "RESTORE-$REH"
  state_set REH_ID "$REH"
  SG=$(A ec2 create-security-group --group-name "$REH-sg" --description "Ogevia production-upgrade rehearsal copy (temporary)" --vpc-id "$VPC" --tag-specifications "ResourceType=security-group,Tags=[{Key=purpose,Value=rehearsal-delete-after}]" --output json | jq -r .GroupId) && [[ "$SG" =~ ^sg-[0-9a-f]+$ ]] || stop "could not create the security group (nothing else was created)"
  state_set SG_ID "$SG"; say "created $SG"
  A ec2 authorize-security-group-ingress --group-id "$SG" --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,IpRanges=[{CidrIp=$ADM_IP/32,Description=rehearsal-admin-host}]" --output json >/dev/null || stop "could not add the rule to $SG (the group exists: see r8-teardown.sh plan)"
  ARGS=(rds restore-db-instance-from-db-snapshot --db-instance-identifier "$REH" --db-snapshot-identifier "$SNAP" --db-instance-class "$CLASS" --db-subnet-group-name "$SUBNET" --vpc-security-group-ids "$SG" --no-publicly-accessible --no-multi-az --no-deletion-protection --no-auto-minor-version-upgrade --tags "Key=purpose,Value=rehearsal-delete-after" "Key=source-snapshot,Value=$SNAP" --output json)
  [[ -n "$PG" ]] && ARGS+=(--db-parameter-group-name "$PG")
  A "${ARGS[@]}" >/dev/null || stop "restore-db-instance-from-db-snapshot failed (group $SG exists: see r8-teardown.sh plan)"
  say "waiting for $REH (can take 10-30 minutes)"
  timeout --foreground -k 5 3600 aws rds wait db-instance-available --db-instance-identifier "$REH" || stop "the instance did not become available (see r8-teardown.sh plan)"
else
  REH=$(state_get REH_ID); valid_reh_id "$REH" || stop "no rehearsal instance recorded in $STATE"; SG=$(state_get SG_ID)
fi
D=$(A rds describe-db-instances --db-instance-identifier "$REH" --output json 2>/dev/null | jq -c '.DBInstances[0]') && [[ -n "$D" && "$D" != null ]] || stop "cannot describe $REH"
EP=$(jq -r '.Endpoint.Address // empty' <<<"$D")
say "instance $REH: status=$(jq -r .DBInstanceStatus <<<"$D") class=$(jq -r .DBInstanceClass <<<"$D") public=$(jq -r .PubliclyAccessible <<<"$D") encrypted=$(jq -r .StorageEncrypted <<<"$D") endpoint=${EP:-none}"
[[ "$(jq -r .DBInstanceStatus <<<"$D")" == available ]] || stop "the copy is not available"
[[ "$(jq -r .PubliclyAccessible <<<"$D")" == false ]] || stop "the copy is publicly accessible"
[[ "$(jq -r .StorageEncrypted <<<"$D")" == true ]] || stop "the copy is not encrypted"
[[ "$(jq -r .DBInstanceClass <<<"$D")" == "$CLASS" ]] || stop "the copy's class differs from production's"
[[ "$(jq -r '[.VpcSecurityGroups[].VpcSecurityGroupId] | join(" ")' <<<"$D")" == "$SG" && "$SG" != "$PROD_RDS_SG" ]] || stop "the copy's security groups are not exactly its own group $SG"
[[ -n "$KMS" && "$(jq -r '.KmsKeyId // empty' <<<"$D")" == "$KMS" ]] || stop "the copy's KMS key differs from production's"
[[ -n "$EP" && "$EP" != "$PROD_EP" ]] || stop "the copy's endpoint is empty or equals production's: refusing"
[[ "$(jq -r '[.TagList[]? | select(.Key=="purpose") | .Value] | first // empty' <<<"$D")" == rehearsal-delete-after ]] || stop "the copy is not tagged purpose=rehearsal-delete-after"
state_set REH_ENDPOINT "$EP"
say "RESTORE VERIFIED: $REH at $EP (own security group $SG; production untouched)"
