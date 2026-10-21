#!/usr/bin/env bash
# Shared library for the PRODUCTION database access window (sourced by d1-migrate-prd.sh; never run directly). YELLOW: it ADDS one temporary inbound rule to the SHARED RDS security group
# sg-00530a1f4f7648e65 (tcp 5432 from the admin host's own private IP as /32), opens a Session Manager tunnel, reads the RDS-managed master credential into shell memory, and ALWAYS
# removes the rule again and verifies that the complete rule set equals the recorded original (sha256 of a canonical form). Everything is bounded by `timeout`.
# The caller sets WIN_PHRASE and calls: win_preflight (read-only), win_propose, win_open; then uses RO / RW (psql) ; win_close runs from the caller's EXIT trap.
# AWS verbs used: sts get-caller-identity; cloudformation describe-stacks/list-stack-resources; lambda get-function-configuration; rds describe-db-instances; ec2 describe-instances,
# describe-network-interfaces, describe-security-groups, authorize-security-group-ingress, revoke-security-group-ingress; ssm start-session; secretsmanager get-secret-value.
EXPECT_RDS_SG=sg-00530a1f4f7648e65; ADMIN_SG=sg-00e01e2ca80442c1f; ADMIN_TAG=ogevia-db-admin-temp; RDS_ID=ogevia-prod-postgres; API_STACK=Ogevia-prd-ServiceVerificationApi; DB_EXPECT=ogevia_prd
WIN_DIR="${OGEVIA_WINDOW_STATE_DIR:-$B/window}"; WIN_OPEN="$WIN_DIR/OPEN"; mkdir -p "$WIN_DIR"; chmod 700 "$WIN_DIR"
MAX_SECONDS="${OGEVIA_WINDOW_MAX_SECONDS:-1800}"; KILL_AFTER=5; PSQL_TMO="${OGEVIA_PSQL_TIMEOUT:-60}"; CLEAN_TMO="${OGEVIA_CLEANUP_AWS_TIMEOUT:-20}"; LOCAL_PORT="${OGEVIA_MIGRATE_PORT:-15441}"
TUN=""; IID=""; CLOSED=0; OWNS=0; RC=0; HOST_CIDR=""; WIN_START_EPOCH=$(date +%s); AWS_T="${OGEVIA_AWS_TIMEOUT:-30}"; WIN_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
aws() { timeout --foreground -k "$KILL_AFTER" "$AWS_T" "$(type -P aws)" "$@"; }
tm() { if [[ "$1" == 124 || "$1" == 137 ]]; then printf ' [TIMED OUT]'; elif [[ "$1" == 99 ]]; then printf ' [time limit reached]'; fi; return 0; }
over_time() { (( $(date +%s) - WIN_START_EPOCH > MAX_SECONDS )); }
valid_private_ipv4() {
  local ip="$1" a b c d
  [[ "$ip" =~ ^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$ ]] || return 1
  a=${BASH_REMATCH[1]}; b=${BASH_REMATCH[2]}; c=${BASH_REMATCH[3]}; d=${BASH_REMATCH[4]}
  (( a <= 255 && b <= 255 && c <= 255 && d <= 255 )) || return 1
  (( a == 10 )) && return 0; (( a == 172 && b >= 16 && b <= 31 )) && return 0; (( a == 192 && b == 168 )) && return 0
  return 1
}
# canonical, order-independent form of a security group's rules; the 2nd argument (optional) is a CIDR to drop from the tcp/5432 rule (to compare "with the temporary rule" against the original)
sg_canonical() {
  aws ec2 describe-security-groups --group-ids "$1" --output json 2>/dev/null \
  | jq -cS --arg dropc "${2:-}" '
      def norm: map(.UserIdGroupPairs |= (map({GroupId, UserId}) | sort_by(.GroupId)) | .IpRanges |= (map({CidrIp}) | sort_by(.CidrIp)) | .Ipv6Ranges |= (map({CidrIpv6}) | sort_by(.CidrIpv6)) | .PrefixListIds |= (map({PrefixListId}) | sort_by(.PrefixListId))) | sort_by(.IpProtocol, (.FromPort // -1), (.ToPort // -1));
      .SecurityGroups[0] as $g | ($g.IpPermissions | norm) as $i
      | { i: (if $dropc == "" then $i else ($i | map(if (.IpProtocol=="tcp" and .FromPort==5432 and .ToPort==5432) then (.IpRanges |= map(select(.CidrIp != $dropc))) else . end) | map(select((.UserIdGroupPairs|length) > 0 or (.IpRanges|length) > 0 or (.Ipv6Ranges|length) > 0 or (.PrefixListIds|length) > 0))) end),
          e: ($g.IpPermissionsEgress | norm) }'
}
sg_hash() { local c; c=$(sg_canonical "$@") && [[ -n "$c" ]] && printf '%s\n' "$c" | sha256sum | cut -d' ' -f1; }
# 0 present, 1 absent (the describe succeeded), 2 unknown (never treated as absent)
cidr_present() {
  local out
  out=$(aws ec2 describe-security-groups --group-ids "$1" --output json 2>/dev/null) || return 2
  jq -e '.SecurityGroups[0].IpPermissions' <<<"$out" >/dev/null 2>&1 || return 2
  jq -e --arg c "$2" '[.SecurityGroups[0].IpPermissions[] | select(.FromPort==5432 and .ToPort==5432) | .IpRanges[]?.CidrIp] | index($c) != null' <<<"$out" >/dev/null 2>&1
  case $? in 0) return 0 ;; *) return 1 ;; esac
}
revoke_cidr() { aws ec2 revoke-security-group-ingress --group-id "$1" --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,IpRanges=[{CidrIp=$2}]" >/dev/null 2>&1; }
ledger_now() {
  [[ -n "${PGPASSWORD:-}" ]] || { echo "unknown (no database session)"; return; }
  PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=10000" timeout --foreground -k 3 15 psql -X -q -At -d "$DB_EXPECT" -c "select count(*) || ' migrations applied, latest ' || coalesce(max(version), 'none') from ogevia_meta.schema_migrations" 2>/dev/null || echo "unknown (could not read the ledger)"
}
win_close() {
  [[ "$CLOSED" == 1 ]] && return 0
  CLOSED=1
  if [[ "${MIGRATING:-0}" == 1 ]]; then say ""; say "== LEDGER at the moment of closing (best effort): $(ledger_now)"; fi
  [[ -n "$TUN" ]] && { pkill -P "$TUN" 2>/dev/null; kill "$TUN" 2>/dev/null; }
  [[ -n "$IID" ]] && pkill -f "session-manager-plugin.*$IID" 2>/dev/null
  unset PGPASSWORD PGUSER SEC OGEVIA_DATABASE_URL
  [[ -f "$WIN_OPEN" && "$OWNS" == 1 ]] || return 0
  local rds_sg before ok=0 rp val after i
  AWS_T="$CLEAN_TMO"
  rds_sg=$(jq -r .rds_sg "$WIN_OPEN"); before=$(jq -r .before_sha "$WIN_OPEN"); val=$(jq -r .cidr "$WIN_OPEN")
  say ""; say "== CLEANUP: removing the temporary rule (tcp 5432 from $val on $rds_sg) and verifying"
  for i in 1 2 3 4; do
    cidr_present "$rds_sg" "$val"; rp=$?
    if [[ "$rp" != 1 ]]; then revoke_cidr "$rds_sg" "$val"; sleep "${OGEVIA_SG_RETRY_SLEEP:-2}"; fi
    cidr_present "$rds_sg" "$val"; [[ $? == 1 ]] && { ok=1; break; }
  done
  after=$(sg_hash "$rds_sg")
  if [[ "$ok" == 1 && -n "$after" && "$after" == "$before" ]]; then
    say "RESTORED (verified): the temporary rule is gone and the RDS security group's complete rule set is identical to the recorded original (sha256 ${after:0:16}...)."
    rm -f "$WIN_OPEN"
  else
    RC=3; cidr_present "$rds_sg" "$val"; rp=$?
    say "NOT RESTORED (exit 3; access may still be open). Rule still present: $([[ $rp == 0 ]] && echo YES || { [[ $rp == 1 ]] && echo no || echo 'UNKNOWN (the check failed or timed out)'; }). Rule-set hash now ${after:0:16}... vs original ${before:0:16}..."
    say "DO THIS NOW in a SEPARATE session. First identify (read-only); the temporary rule is the ONE row with cidr $val, tcp, 5432, description beginning TEMP-prdmigrate-:"
    say "  aws ec2 describe-security-group-rules --region us-west-2 --filters Name=group-id,Values=$rds_sg --query 'SecurityGroupRules[?IsEgress==\`false\`].{rule:SecurityGroupRuleId,proto:IpProtocol,from:FromPort,to:ToPort,cidr:CidrIpv4,sourceSg:ReferencedGroupInfo.GroupId,desc:Description}' --output table"
    say "Then remove ONLY that rule by id (never a row whose source is an application security group):"
    say "  aws ec2 revoke-security-group-ingress --region us-west-2 --group-id $rds_sg --security-group-rule-ids sgr-<id of that one row>"
    say "Then re-run: bash d1-migrate-prd.sh --restore-only   (verifies against the recorded original). The marker $WIN_OPEN stays until restoration is verified."
  fi
}
win_restore_only() {
  if [[ -f "$WIN_OPEN" ]]; then CLOSED=0; say "An open-window marker exists ($(jq -r .stamp "$WIN_OPEN")). Restoring."; OWNS=1; win_close; else say "No open-window marker: nothing to restore. (Nothing was changed.)"; fi
}
# READ-ONLY identification of the environment, the RDS instance, the admin host and the security group. Sets CFG-derived variables. Every failure stops with nothing changed.
win_preflight() {
  local STATUS FN CFG L_DB L_ENV RDS HOST HOST_SGS ENIS HD VPC_ID HOST_ENI IPMAP rc
  say ""; say "== Environment (read-only): PRODUCTION; expected database $DB_EXPECT"
  STATUS=$(aws cloudformation describe-stacks --stack-name "$API_STACK" --output json 2>/dev/null | jq -r '.Stacks[0].StackStatus // empty'); [[ -n "$STATUS" ]] || stop "stack $API_STACK not found"
  FN=$(cat "$B/handler-function-name.txt" 2>/dev/null); [[ -n "$FN" ]] || stop "no captured handler function name: run p0-baseline-capture.sh"
  CFG=$(aws lambda get-function-configuration --function-name "$FN" --output json 2>/dev/null) || stop "cannot read Lambda $FN"
  L_DB=$(jq -r '.Environment.Variables.DB_NAME // empty' <<<"$CFG"); L_ENV=$(jq -r '.Environment.Variables.OGEVIA_ENV // empty' <<<"$CFG")
  say "stack $API_STACK: $STATUS; Lambda $FN: DB_NAME=${L_DB:-unset} OGEVIA_ENV=${L_ENV:-unset}"
  [[ "$L_DB" == "$DB_EXPECT" && "$L_ENV" == prd ]] || stop "the Lambda serves '${L_DB:-unset}' / '${L_ENV:-unset}', not $DB_EXPECT / prd. Not the production environment."
  RDS=$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --output json 2>/dev/null | jq -c '.DBInstances[0]') && [[ -n "$RDS" && "$RDS" != null ]] || stop "cannot describe RDS $RDS_ID"
  [[ "$(jq -r .DBInstanceStatus <<<"$RDS")" == available && "$(jq -r .PubliclyAccessible <<<"$RDS")" == false ]] || stop "RDS is not available and private"
  RDS_HOST=$(jq -r .Endpoint.Address <<<"$RDS"); MASTER_ARN=$(jq -r .MasterUserSecret.SecretArn <<<"$RDS")
  [[ "$(jq -r '[.VpcSecurityGroups[].VpcSecurityGroupId] | join(" ")' <<<"$RDS")" == "$EXPECT_RDS_SG" ]] || stop "RDS security groups are not exactly '$EXPECT_RDS_SG'. Review before changing anything."
  [[ "$MASTER_ARN" =~ ^arn:aws:secretsmanager:us-west-2:$ACCOUNT:secret:[A-Za-z0-9/_+=.@!-]+$ ]] || stop "the RDS master secret ARN is missing or malformed"
  HOST=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$ADMIN_TAG" "Name=instance-state-name,Values=running" --output json 2>/dev/null | jq -c '[.Reservations[].Instances[]][0] // empty')
  [[ -n "$HOST" ]] || stop "admin host '$ADMIN_TAG' is not running (starting it is a change this script will not make)"
  IID=$(jq -r .InstanceId <<<"$HOST"); HOST_SGS=$(jq -r '[.SecurityGroups[].GroupId] | join(" ")' <<<"$HOST")
  [[ "$HOST_SGS" == "$ADMIN_SG" ]] || stop "the admin host's groups are '$HOST_SGS', expected exactly '$ADMIN_SG'."
  ENIS=$(aws ec2 describe-network-interfaces --filters "Name=group-id,Values=$ADMIN_SG" --output json 2>/dev/null | jq -c '[.NetworkInterfaces[] | {eni:.NetworkInterfaceId, inst:.Attachment.InstanceId}]') || stop "cannot list network interfaces"
  say "admin host $IID: group $HOST_SGS (not modified); that group is used by $(jq length <<<"$ENIS") interface(s) (not granted anything: the rule names the admin host's own IP only)"
  [[ "$(jq --arg i "$IID" '[.[] | select(.inst == $i)] | length' <<<"$ENIS")" == 1 ]] || stop "the admin host $IID must appear exactly once among the group's interfaces"
  HOST_ENI=$(jq -r --arg i "$IID" '[.[] | select(.inst == $i)][0].eni' <<<"$ENIS")
  HD=$(jq -c '{ip:.PrivateIpAddress, vpc:.VpcId, state:.State.Name, enis:[.NetworkInterfaces[] | {eni:.NetworkInterfaceId, ips:[.PrivateIpAddresses[].PrivateIpAddress]}]}' <<<"$HOST")
  [[ "$(jq -r '.state // "running"' <<<"$HD")" == running ]] || stop "the admin host is not running"
  jq -e '(.enis | length) == 1 and (.enis[0].ips | length) == 1 and .enis[0].ips[0] == .ip' <<<"$HD" >/dev/null 2>&1 || stop "the admin host must have exactly ONE network interface with exactly ONE private IPv4 address; refusing ($(jq -c .enis <<<"$HD"))"
  [[ "$(jq -r '.enis[0].eni' <<<"$HD")" == "$HOST_ENI" ]] || stop "the host's interface does not match the interface in the admin group"
  HOST_IP=$(jq -r .ip <<<"$HD"); VPC_ID=$(jq -r .vpc <<<"$HD")
  valid_private_ipv4 "$HOST_IP" || stop "the admin host's address '$HOST_IP' is not a valid private (RFC 1918) IPv4 address"
  [[ "$HOST_IP" == "${OGEVIA_EXPECT_HOST_IP:-}" ]] || stop "the admin host's live IP is $HOST_IP but OGEVIA_EXPECT_HOST_IP is '${OGEVIA_EXPECT_HOST_IP:-unset}'. Not proceeding."
  IPMAP=$(aws ec2 describe-network-interfaces --filters "Name=addresses.private-ip-address,Values=$HOST_IP" "Name=vpc-id,Values=$VPC_ID" --output json 2>/dev/null | jq -c '[.NetworkInterfaces[] | {eni:.NetworkInterfaceId, inst:.Attachment.InstanceId}]') || stop "cannot map the IP to interfaces"
  [[ "$(jq length <<<"$IPMAP")" == 1 && "$(jq -r '.[0].eni' <<<"$IPMAP")" == "$HOST_ENI" && "$(jq -r '.[0].inst' <<<"$IPMAP")" == "$IID" ]] || stop "the IP $HOST_IP does not map to exactly one interface, the admin host's own ($IPMAP)"
  HOST_CIDR="$HOST_IP/32"
  BEFORE_JSON=$(sg_canonical "$EXPECT_RDS_SG"); [[ -n "$BEFORE_JSON" && "$BEFORE_JSON" != null ]] || stop "cannot read the RDS security group rules"
  BEFORE_SHA=$(printf '%s\n' "$BEFORE_JSON" | sha256sum | cut -d' ' -f1)
  printf '%s\n' "$BEFORE_JSON" > "$WIN_DIR/rds-sg-before-$WIN_STAMP.json"; chmod 600 "$WIN_DIR/rds-sg-before-$WIN_STAMP.json"
  say "admin host IP (live): $HOST_IP on $HOST_ENI, the only interface and address; it maps to no other interface in $VPC_ID"
  say "RDS security group $EXPECT_RDS_SG, ORIGINAL inbound rules:"
  jq -r '.i[] | "   " + .IpProtocol + " " + ((.FromPort // "all")|tostring) + "-" + ((.ToPort // "all")|tostring) + "  from " + (([.UserIdGroupPairs[].GroupId] + [.IpRanges[].CidrIp] + [.Ipv6Ranges[].CidrIpv6] + [.PrefixListIds[].PrefixListId]) | join(", "))' <<<"$BEFORE_JSON" | tee -a "$LOG"
  say "ORIGINAL rule-set sha256: $BEFORE_SHA   (full copy: $WIN_DIR/rds-sg-before-$WIN_STAMP.json)"
  cidr_present "$EXPECT_RDS_SG" "$HOST_CIDR"; case $? in
    0) stop "a rule allowing $HOST_CIDR on 5432 ALREADY exists on $EXPECT_RDS_SG. Investigate instead of changing anything." ;;
    2) stop "cannot read the RDS security group rules (failed or timed out). Nothing was changed." ;;
  esac
}
# prints the proposal and requires the typed phrase (WIN_PHRASE); `$1` is the sentence naming what will be done inside the window
win_propose() {
  local ans
  say ""; say "== PROPOSED CHANGES (YELLOW: changes PRODUCTION)"
  say "  1. ADD to the SHARED RDS security group $EXPECT_RDS_SG :  inbound tcp 5432 from $HOST_CIDR  (the admin host's own IP only; description 'TEMP-prdmigrate-$WIN_STAMP')"
  say "  2. Through that window, against $DB_EXPECT ONLY: $1"
  say "  3. REMOVE the rule again, then verify the complete rule set equals the original hash above."
  say "  Reaches: RDS instance $RDS_ID on 5432 from the admin host only. That instance ALSO holds ogevia_sv_test (TEST): this script never names, connects to or queries it."
  read -r -p "Type $WIN_PHRASE to open the window (anything else stops, nothing changed). Keep a SEPARATE recovery session ready: if this session is lost the rule is NOT removed automatically: " ans || ans=""
  [[ "$ans" == "$WIN_PHRASE" ]] || { say "Declined. Nothing was changed."; exit 0; }
}
win_open() {
  local rc
  say ""; say "== Window"
  WIN_START_EPOCH=$(date +%s)
  ( set -o noclobber; jq -n --arg rds "$EXPECT_RDS_SG" --arg stamp "$WIN_STAMP" --arg sha "$BEFORE_SHA" --arg cidr "$HOST_CIDR" '{rds_sg:$rds, stamp:$stamp, before_sha:$sha, kind:"cidr", cidr:$cidr}' > "$WIN_OPEN" ) 2>/dev/null || stop "another window was opened a moment ago ($WIN_OPEN exists). Nothing was changed by this run."
  OWNS=1; chmod 600 "$WIN_OPEN"
  aws ec2 authorize-security-group-ingress --group-id "$EXPECT_RDS_SG" --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,IpRanges=[{CidrIp=$HOST_CIDR,Description=TEMP-prdmigrate-$WIN_STAMP}]" >/dev/null 2>"$WIN_DIR/authorize.err" || { rc=$?; stop "could not add the rule$(tm $rc): $(tail -1 "$WIN_DIR/authorize.err")"; }
  cidr_present "$EXPECT_RDS_SG" "$HOST_CIDR" || stop "the rule did not appear after adding it (or the check failed or timed out)"
  [[ "$(sg_hash "$EXPECT_RDS_SG" "$HOST_CIDR")" == "$BEFORE_SHA" ]] || stop "the group changed in a way other than the single rule: aborting"
  say "window open: exactly one rule was added (verified: the group minus that rule equals the original)."
  over_time && stop "time limit ($MAX_SECONDS s) reached before the tunnel"
  AWS_T="$((MAX_SECONDS + 30))" aws ssm start-session --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters "host=$RDS_HOST,portNumber=5432,localPortNumber=$LOCAL_PORT" >/dev/null 2>&1 &
  TUN=$!
  for _ in $(seq 1 "${OGEVIA_TUNNEL_WAIT:-30}"); do (echo > "/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null && break; sleep 1; done
  (echo > "/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null || stop "the Session Manager tunnel did not open in time"
  SEC=$(aws secretsmanager get-secret-value --secret-id "$MASTER_ARN" --output json 2>/dev/null | jq -r .SecretString) && [[ -n "$SEC" && "$SEC" != null ]] || { rc=$?; stop "cannot read the RDS master secret$(tm $rc)"; }
  export PGHOST=127.0.0.1 PGPORT=$LOCAL_PORT PGSSLMODE=require PGCONNECT_TIMEOUT=15
  export PGUSER; PGUSER=$(jq -r .username <<<"$SEC"); export PGPASSWORD; PGPASSWORD=$(jq -r .password <<<"$SEC"); unset SEC
  local who
  who=$(RO -d "$DB_EXPECT" -c "select current_database() || ' | read_only=' || current_setting('transaction_read_only')") || { rc=$?; stop "cannot connect to $DB_EXPECT$(tm $rc)"; }
  say "connected: $who"
  [[ "${who%% |*}" == "$DB_EXPECT" ]] || stop "connected to '${who%% |*}', not '$DB_EXPECT'"
  [[ "$who" == *"read_only=on" ]] || stop "the read-only session is not read-only: refusing to run anything"
}
RO() { over_time && return 99; PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=60000" timeout --foreground -k "$KILL_AFTER" "$PSQL_TMO" psql -X -q -At -F $'\t' -v ON_ERROR_STOP=1 "$@"; }
RW() { over_time && return 99; PGOPTIONS="-c statement_timeout=0" timeout --foreground -k "$KILL_AFTER" "${OGEVIA_MIGRATE_FILE_TIMEOUT:-300}" psql -X -q -At -F $'\t' -v ON_ERROR_STOP=1 "$@"; }
