#!/usr/bin/env bash
# =============================================================================
# TEST REHEARSAL (release e80b770) COPY of slice/ledger-check-temp-access.sh v3 (sha256 f96c06f2... as reviewed). Changes from v3, and ONLY these:
#   1. the expected ledger is given by OGEVIA_EXPECT_LEDGER_COUNT and OGEVIA_EXPECT_LEDGER_LATEST (77 / 0077 before the rehearsal, 85 / 0085 after it) and the rows
#      listed are those ABOVE that version (v3 listed everything from 0053);
#   2. the result is a VERDICT: exit 0 only when the ledger summary is exactly "<count> migrations applied, latest <latest>" AND no row is above it AND the number of
#      agencies with enforcement activated equals OGEVIA_EXPECT_ENFORCEMENT_ACTIVE (default 0; read-only select); any other ledger (or a missing database) is reported with STOP
#      and exits 1 after the temporary rule has been removed and verified (v3 always exited 0 on a read);
#   3. the production mode and the production database name are removed (this copy can only read TEST, and only as 'test --host-ip'); the script's own name in its messages. Everything else (the /32 rule, timeouts, cleanup with a rule-set hash, marker file, phrase) is unchanged v3 text.
# Run:  OGEVIA_EXPECT_LEDGER_COUNT=77 OGEVIA_EXPECT_LEDGER_LATEST=0077 OGEVIA_EXPECT_HOST_IP=<admin host private IP> bash ledger-recheck.sh test --host-ip
# =============================================================================
# Ogevia: migration-ledger check WITH A TEMPORARY, NARROW DATABASE-ACCESS WINDOW. FOR OWNER REVIEW. NOT YET RUN AGAINST AWS.
# (v2: every command that can hang is bounded by `timeout`; a timeout is a failure and goes through cleanup.)
# (v3: optional `test --host-ip` mode: the temporary rule names ONLY the admin host's own private IP as /32, not the shared group.)
#   bash ledger-recheck.sh test|prod        one environment per run (same environment checks as ledger-check-readonly.sh)
#   bash ledger-recheck.sh test --host-ip   TEST only. Use when the admin security group is SHARED with other interfaces (the default
#                                                     mode refuses in that case). Rule source = the admin host's live private IP /32.
#   bash ledger-recheck.sh --restore-only   after an interrupted run: remove the temporary rule and verify (idempotent)
#
# WHY: the read-only variant stops because the admin host's security group (ogevia-db-admin-sg) is not allowed to reach the RDS
# security group on 5432 (the RDS group accepts 5432 from the application group only). There is no existing read path that avoids a
# change: the API exposes no ledger route, pilot_preflight_probe.py stops at generation 0051 and says the ledger needs the database.
#
# THE ONLY CHANGE (and it is temporary):
#   ADD to the RDS security group ONE inbound rule:  tcp 5432 FROM the admin host's security group (nothing else).
#   It is REMOVED on every exit path, then the script proves the group is byte-for-byte what it was (canonical hash of ALL inbound
#   and outbound rules before and after). It does not touch the admin host, the application group, any stack, Lambda or secret.
#   Compared with the repository's older "DB window" (attach the application group to the admin host), this grants the host NOTHING
#   else: the application group also carries the Secrets Manager endpoint's 443 allowance.
#
# --host-ip MODE (TEST only; `prod --host-ip` is refused): the shared-group guard of the default mode is NOT removed or relaxed; the default mode
#   still refuses a shared group. In this mode the rule does not reference the group at all, so sharing cannot widen it. Instead the script reads
#   the admin host's IP LIVE and requires: host running; exactly ONE network interface with exactly ONE private IPv4; a valid private
#   (RFC 1918) address; (if OGEVIA_EXPECT_HOST_IP is set) equal to it; that IP maps to exactly ONE interface in the VPC and it is the host's own,
#   attached to the host; the host's security groups still exactly the expected one; the /32 rule not already present. The only source ever
#   written is "$HOST_IP/32" built from that live value; never a wider prefix, never 0.0.0.0/0, never a group.
#
# SAFEGUARDS
#   * Preconditions are READ-ONLY and must all hold or nothing is changed: right account, right environment, RDS private/available,
#     the RDS group is the expected one, the admin host's groups are EXACTLY the expected one, no other network interface uses that
#     group, the rule does not already exist, no earlier window is marked open.
#   * You must type OPEN-5432-WINDOW after seeing the exact change.
#   * Cleanup runs on success, on any failure, and on INT/TERM/HUP/EXIT. A marker file (~/.ogevia-ledger-window/OPEN) survives a killed
#     session; this script refuses to start while it exists, and --restore-only clears it only after verified restoration.
#   * The window should last seconds: the rule is added after everything else is ready and removed immediately after the queries.
#     TIME BOUNDS (all enforced inside this process): every aws/psql call and the tunnel run under `timeout` (OGEVIA_AWS_TIMEOUT, default
#     30 s; OGEVIA_PSQL_TIMEOUT, default 45 s; cleanup calls OGEVIA_CLEANUP_AWS_TIMEOUT, default 20 s). OGEVIA_WINDOW_MAX_SECONDS
#     (default 300) is checked BEFORE EACH STEP after the rule is added; when exceeded the run stops and cleans up. It is not a timer that
#     fires during a step; a step is bounded only by its own timeout above. A timeout counts as a failure and triggers cleanup.
#   * LIMIT, NOT SOLVED HERE: if the CloudShell session is destroyed or this process receives SIGKILL, no trap runs and nothing else
#     removes the rule. It stays open until someone revokes it (see --restore-only, or the rule-id procedure in the review document).
#   * Database session: read-only, one read-only transaction, rolled back. The master credential is held in shell memory only, never
#     printed or written. CloudTrail records the secret read, the SG authorize/revoke and the Session Manager session.
# AWS verbs used: sts/cloudformation/lambda/rds/ec2 describe-/list-/get-; ec2 authorize-security-group-ingress and
#   revoke-security-group-ingress (the single temporary rule); ssm start-session; secretsmanager get-secret-value.
# EXIT CODES: 0 completed (or declined / nothing to restore); 1 stopped (cleanup verified if a window had opened); 2 usage;
#   3 the temporary rule could NOT be verified removed (access may still be open: act on the printed command); 130 interrupted.
# =============================================================================
set -uo pipefail
ARG="${1:-}"; MODE2="${2:-}"; USE_IP=0; HOST_IP=""; HOST_CIDR=""
ACCOUNT=300094796789
REGION=us-west-2
RDS_ID=ogevia-prod-postgres
ADMIN_TAG=ogevia-db-admin-temp
EXPECT_RDS_SG=sg-00530a1f4f7648e65      # ogevia-prod-data-layer-RDSSecurityGroup (infra/aws/lib/config.ts securityGroups.prodRds)
ADMIN_SG=sg-00e01e2ca80442c1f           # ogevia-db-admin-sg (config.ts securityGroups.dbAdmin)
MAX_SECONDS="${OGEVIA_WINDOW_MAX_SECONDS:-300}"
STATE_DIR="${OGEVIA_LEDGER_STATE_DIR:-$HOME/.ogevia-ledger-window}"
OPEN="$STATE_DIR/OPEN"
LOCAL_PORT=${OGEVIA_LEDGER_PORT:-15439}
AWS_TMO="${OGEVIA_AWS_TIMEOUT:-30}"; PSQL_TMO="${OGEVIA_PSQL_TIMEOUT:-45}"; CLEAN_TMO="${OGEVIA_CLEANUP_AWS_TIMEOUT:-20}"
KILL_AFTER=5
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION AWS_PAGER=""
EXP_COUNT="${OGEVIA_EXPECT_LEDGER_COUNT:-}"; EXP_LATEST="${OGEVIA_EXPECT_LEDGER_LATEST:-}"; EXP_ACT="${OGEVIA_EXPECT_ENFORCEMENT_ACTIVE:-0}"
if [[ "${1:-}" != "--restore-only" ]]; then
  [[ "$EXP_COUNT" =~ ^[0-9]{2}$ && "$EXP_LATEST" =~ ^00[0-9]{2}$ && "$EXP_COUNT" == "$((10#$EXP_LATEST))" && "$EXP_ACT" =~ ^[0-9]+$ ]] || { echo "set OGEVIA_EXPECT_LEDGER_COUNT (e.g. 77) and OGEVIA_EXPECT_LEDGER_LATEST (e.g. 0077; the count must equal the number). Nothing was changed." >&2; exit 2; }
fi
mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"

case "$ARG" in
  test) LABEL="TEST / pilot (synthetic data)";         API_STACK=Ogevia-prod-ServiceVerificationApi; DB_EXPECT=ogevia_sv_test; ENV_MUST_BE_PRD=no ;;
  --restore-only) LABEL="restore only" ;;
  *) echo "usage: bash ledger-recheck.sh test --host-ip   |   --restore-only   (TEST only: production is not available in this copy)" >&2; exit 2 ;;
esac
case "$MODE2" in
  "") ;;
  --host-ip) [[ "$ARG" == test ]] || { echo "--host-ip is TEST-only: use it as 'test --host-ip'. Nothing was changed." >&2; exit 2; }; USE_IP=1; LABEL="TEST / pilot (synthetic data), admin-host-IP /32 rule" ;;
  *) echo "usage: bash ledger-recheck.sh test --host-ip   |   --restore-only   (TEST only: production is not available in this copy)" >&2; exit 2 ;;
esac
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="${OGEVIA_LEDGER_DIR:-$HOME/ogevia-ledger-window-${ARG#--}-$STAMP}"; mkdir -p "$OUT"; chmod 700 "$OUT"
RESULT="$OUT/RESULT.txt"; : > "$RESULT"
TUN=""; IID=""; CLOSED=0; OWNS=0; RC=0; LEDGER_TEXT=""; START_EPOCH=$(date +%s)
say() { printf '%s\n' "$*" | tee -a "$RESULT"; }

# ---- bounded commands ---------------------------------------------------------------------------------------------------------
# Every aws call runs under `timeout --foreground` (so Ctrl+C still reaches the command and the trap runs promptly); exit 124 (or 137 after the kill grace) means it hung. Cleanup switches to the shorter bound.
AWS_T="$AWS_TMO"
aws() { timeout --foreground -k "$KILL_AFTER" "$AWS_T" "$(type -P aws)" "$@"; }
tm() { if [[ "$1" == 124 || "$1" == 137 ]]; then printf ' [TIMED OUT]'; elif [[ "$1" == 99 ]]; then printf ' [time limit reached]'; fi; return 0; }
valid_private_ipv4() {
  local ip="$1" a b c d
  [[ "$ip" =~ ^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$ ]] || return 1
  a=${BASH_REMATCH[1]}; b=${BASH_REMATCH[2]}; c=${BASH_REMATCH[3]}; d=${BASH_REMATCH[4]}
  (( a <= 255 && b <= 255 && c <= 255 && d <= 255 )) || return 1
  (( a == 10 )) && return 0
  (( a == 172 && b >= 16 && b <= 31 )) && return 0
  (( a == 192 && b == 168 )) && return 0
  return 1
}
# ---- helpers -----------------------------------------------------------------------------------------------------------------
# Canonical snapshot of ALL inbound and outbound rules of the RDS group (order-independent), optionally without the temporary rule.
sg_canonical() {
  aws ec2 describe-security-groups --group-ids "$1" --query 'SecurityGroups[0].{i:IpPermissions,e:IpPermissionsEgress}' --output json 2>/dev/null \
  | jq -cS --arg drop "${2:-}" --arg dropc "${3:-}" '
      def norm: map(.UserIdGroupPairs |= (map({GroupId, UserId}) | sort_by(.GroupId)) | .IpRanges |= (map({CidrIp}) | sort_by(.CidrIp)) | .Ipv6Ranges |= (map({CidrIpv6}) | sort_by(.CidrIpv6)) | .PrefixListIds |= (map({PrefixListId}) | sort_by(.PrefixListId))) | sort_by(.IpProtocol, (.FromPort // -1), (.ToPort // -1));
      (.i | norm) as $i
      | { i: (if ($drop == "" and $dropc == "") then $i else ($i | map(if (.IpProtocol=="tcp" and .FromPort==5432 and .ToPort==5432) then (.UserIdGroupPairs |= map(select(.GroupId != $drop))) | (.IpRanges |= map(select(.CidrIp != $dropc))) else . end) | map(select((.UserIdGroupPairs|length) > 0 or (.IpRanges|length) > 0 or (.Ipv6Ranges|length) > 0 or (.PrefixListIds|length) > 0))) end),
          e: (.e | norm) }'
}
sg_hash() { sg_canonical "$@" | sha256sum | cut -d' ' -f1; }
# 0 = rule present, 1 = rule absent (the describe succeeded), 2 = unknown (the describe failed or timed out: never treated as absent).
rule_present() {
  local out
  out=$(aws ec2 describe-security-groups --group-ids "$1" --query 'SecurityGroups[0].IpPermissions[?FromPort==`5432` && ToPort==`5432`].UserIdGroupPairs[].GroupId' --output text 2>/dev/null) || return 2
  tr '\t' '\n' <<<"$out" | grep -qx "$2"
}
revoke_rule() {
  aws ec2 revoke-security-group-ingress --group-id "$1" --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,UserIdGroupPairs=[{GroupId=$2}]" >/dev/null 2>&1
}
# The /32 variant. Same tri-state: 0 present, 1 absent, 2 unknown.
cidr_present() {
  local out
  out=$(aws ec2 describe-security-groups --group-ids "$1" --query 'SecurityGroups[0].IpPermissions[?FromPort==`5432` && ToPort==`5432`].IpRanges[].CidrIp' --output text 2>/dev/null) || return 2
  tr '\t' '\n' <<<"$out" | grep -qx "$2"
}
revoke_cidr() {
  aws ec2 revoke-security-group-ingress --group-id "$1" --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,IpRanges=[{CidrIp=$2}]" >/dev/null 2>&1
}
src_present() { if [[ "$2" == cidr ]]; then cidr_present "$1" "$3"; else rule_present "$1" "$3"; fi; }
src_revoke() { if [[ "$2" == cidr ]]; then revoke_cidr "$1" "$3"; else revoke_rule "$1" "$3"; fi; }
# Runs on EVERY exit path. Re-entrant guarded. Restores, then VERIFIES; prints exact manual commands if it cannot.
close_window() {
  [[ "$CLOSED" == 1 ]] && return 0
  CLOSED=1
  # $TUN is the background subshell; its child is the timeout/aws tunnel. End the child first, then the subshell.
  [[ -n "$TUN" ]] && { pkill -P "$TUN" 2>/dev/null; kill "$TUN" 2>/dev/null; }
  [[ -n "$IID" ]] && pkill -f "session-manager-plugin.*$IID" 2>/dev/null
  unset PGPASSWORD PGUSER SEC
  # Only the run that opened the window (or --restore-only, on purpose) may remove its rule: a refused or concurrent run must not touch it.
  [[ -f "$OPEN" && "$OWNS" == 1 ]] || return 0
  local rds_sg admin_sg before i ok=0 rp kind val
  AWS_T="$CLEAN_TMO"
  rds_sg=$(jq -r .rds_sg "$OPEN"); admin_sg=$(jq -r .admin_sg "$OPEN"); before=$(jq -r .before_sha "$OPEN")
  kind=$(jq -r '.kind // "sg"' "$OPEN"); val=$(jq -r 'if (.kind // "sg") == "cidr" then .cidr else .admin_sg end' "$OPEN")
  say ""; say "== CLEANUP: removing the temporary rule (tcp 5432 from $val on $rds_sg) and verifying"
  for i in 1 2 3 4; do
    src_present "$rds_sg" "$kind" "$val"; rp=$?
    if [[ "$rp" != 1 ]]; then src_revoke "$rds_sg" "$kind" "$val"; sleep 2; fi   # present, or UNKNOWN: try the revoke (idempotent)
    src_present "$rds_sg" "$kind" "$val"; [[ $? == 1 ]] && { ok=1; break; }
  done
  local after; after=$(sg_hash "$rds_sg")
  if [[ "$ok" == 1 && "$after" == "$before" ]]; then
    say "RESTORED (verified): the temporary rule is gone and the RDS security group's complete rule set is identical to the recorded original (sha256 ${after:0:16}...)."
    rm -f "$OPEN"
  else
    RC=3
    src_present "$rds_sg" "$kind" "$val"; rp=$?
    say "NOT RESTORED (exit 3; access may still be open). Rule still present: $([[ $rp == 0 ]] && echo YES || { [[ $rp == 1 ]] && echo no || echo 'UNKNOWN (the check failed or timed out)'; }). Rule-set hash now ${after:0:16}... vs original ${before:0:16}..."
    if [[ "$kind" == cidr ]]; then
      say "DO THIS NOW in a SEPARATE session. First identify (read-only); the temporary rule is the ONE row with cidr $val, tcp, 5432:"
      say "  aws ec2 describe-security-group-rules --region $REGION --filters Name=group-id,Values=$rds_sg --query 'SecurityGroupRules[?IsEgress==\`false\`].{rule:SecurityGroupRuleId,proto:IpProtocol,from:FromPort,to:ToPort,cidr:CidrIpv4,sourceSg:ReferencedGroupInfo.GroupId,desc:Description}' --output table"
      say "Then remove ONLY that rule by id (never the row whose sourceSg is the application group):"
    else
      say "DO THIS NOW in a SEPARATE session. First identify (read-only); the temporary rule is the ONE row with source $admin_sg, tcp, 5432:"
      say "  aws ec2 describe-security-group-rules --region $REGION --filters Name=group-id,Values=$rds_sg --query 'SecurityGroupRules[?IsEgress==\`false\`].{rule:SecurityGroupRuleId,proto:IpProtocol,from:FromPort,to:ToPort,source:ReferencedGroupInfo.GroupId,desc:Description}' --output table"
      say "Then remove ONLY that rule by id (never the row whose source is the application group):"
    fi
    say "  aws ec2 revoke-security-group-ingress --region $REGION --group-id $rds_sg --security-group-rule-ids sgr-<id of that one row>"
    say "Then re-run: bash ledger-recheck.sh --restore-only   (verifies against the recorded original)"
    say "  The marker $OPEN stays in place until restoration is verified."
  fi
}
on_exit() { local rc=$?; close_window; [[ $RC != 0 ]] && exit "$RC"; exit "$rc"; }
trap on_exit EXIT
trap 'say "Interrupted: cleaning up."; exit 130' INT TERM HUP
stop() { say ""; say "STOPPED: $*"; say "Before any change was made nothing is different; after the window opened, the cleanup above has restored and verified it."; exit 1; }
over_time() { (( $(date +%s) - START_EPOCH > MAX_SECONDS )); }
for t in aws jq psql session-manager-plugin sha256sum timeout; do
  command -v "$t" >/dev/null 2>&1 || stop "missing tool '$t'. Install the PostgreSQL 15 client and the AWS Session Manager plugin yourself; this script installs nothing."
done

say "================================================================"
say "MODE                   : $ARG  =  $LABEL"
say "UTC time              : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "================================================================"
IDENT=$(aws sts get-caller-identity --output json 2>/dev/null) || stop "no valid AWS credentials: sign in again and reopen CloudShell in us-west-2"
[[ "$(jq -r .Account <<<"$IDENT")" == "$ACCOUNT" ]] || stop "wrong AWS account $(jq -r .Account <<<"$IDENT") (expected $ACCOUNT)"
say "account $ACCOUNT, region $REGION: OK"

if [[ "$ARG" == "--restore-only" ]]; then
  if [[ -f "$OPEN" ]]; then CLOSED=0; say "An open-window marker exists ($(jq -r .stamp "$OPEN")). Restoring."; OWNS=1; close_window; else say "No open-window marker: nothing to restore. (Nothing was changed.)"; fi
  exit "$RC"
fi
[[ ! -f "$OPEN" ]] || stop "an earlier window is marked OPEN ($OPEN, started $(jq -r .stamp "$OPEN")). Run: bash ledger-recheck.sh --restore-only"

say ""; say "== 1. Environment (read-only): $LABEL; expected database $DB_EXPECT"
STATUS=$(aws cloudformation describe-stacks --stack-name "$API_STACK" --query 'Stacks[0].StackStatus' --output text 2>/dev/null) || stop "stack $API_STACK not found. Missing information: the real stack name, or whether this environment exists."
say "stack $API_STACK: $STATUS"
FN=$(aws cloudformation list-stack-resources --stack-name "$API_STACK" --output json 2>/dev/null | jq -r '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId|startswith("Handler")))][0].PhysicalResourceId // empty')
[[ -n "$FN" ]] || stop "API handler Lambda not found in $API_STACK"
CFG=$(aws lambda get-function-configuration --function-name "$FN" --output json 2>/dev/null) || stop "cannot read Lambda $FN"
L_DB=$(jq -r '.Environment.Variables.DB_NAME // empty' <<<"$CFG"); L_ENV=$(jq -r '.Environment.Variables.OGEVIA_ENV // empty' <<<"$CFG")
say "Lambda $FN: DB_NAME=${L_DB:-unset}  OGEVIA_ENV=${L_ENV:-unset}"
[[ "$L_DB" == "$DB_EXPECT" ]] || stop "the Lambda serves database '${L_DB:-unset}', not '$DB_EXPECT'. Not the requested environment."
if [[ "$ENV_MUST_BE_PRD" == yes ]]; then [[ "$L_ENV" == prd ]] || stop "production stack but OGEVIA_ENV is '$L_ENV'"; else [[ "$L_ENV" != prd ]] || stop "TEST run but OGEVIA_ENV=prd"; fi
say "Environment identified: $LABEL."

say ""; say "== 2. ORIGINAL CONFIGURATION (recorded before any change)"
RDS=$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0]' --output json 2>/dev/null) || stop "cannot describe RDS $RDS_ID"
[[ "$(jq -r .DBInstanceStatus <<<"$RDS")" == available && "$(jq -r .PubliclyAccessible <<<"$RDS")" == false ]] || stop "RDS is not available and private"
RDS_HOST=$(jq -r .Endpoint.Address <<<"$RDS"); RDS_SGS=$(jq -r '[.VpcSecurityGroups[].VpcSecurityGroupId] | join(" ")' <<<"$RDS")
[[ "$RDS_SGS" == "$EXPECT_RDS_SG" ]] || stop "RDS security groups are '$RDS_SGS', expected exactly '$EXPECT_RDS_SG'. Review before changing anything."
HOST=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$ADMIN_TAG" "Name=instance-state-name,Values=running" --query 'Reservations[0].Instances[0].[InstanceId,SecurityGroups[].GroupId]' --output json 2>/dev/null)
[[ -n "$HOST" && "$HOST" != null && "$HOST" != "[null,null]" ]] || stop "admin host '$ADMIN_TAG' is not running (starting it is a change this script will not make)"
IID=$(jq -r '.[0]' <<<"$HOST"); HOST_SGS=$(jq -r '.[1] | join(" ")' <<<"$HOST")
say "admin host $IID: security groups [$HOST_SGS]  (NOT modified by this script)"
[[ "$HOST_SGS" == "$ADMIN_SG" ]] || stop "the admin host's groups are '$HOST_SGS', expected exactly '$ADMIN_SG'. Review before changing anything."
ENIS=$(aws ec2 describe-network-interfaces --filters "Name=group-id,Values=$ADMIN_SG" --query 'NetworkInterfaces[].[NetworkInterfaceId,Attachment.InstanceId]' --output json 2>/dev/null) || stop "cannot list network interfaces"
if [[ "$USE_IP" == 1 ]]; then
  # --host-ip: the rule does not name the group, so sharing cannot widen it. The group is reported, and the host must be in it exactly once.
  say "group $ADMIN_SG is used by $(jq 'length' <<<"$ENIS") network interface(s): $(jq -c '[.[] | {eni: .[0], instance: .[1]}]' <<<"$ENIS")"
  say "  (not granted anything: the rule below names the admin host's own IP only, not this group)"
  [[ "$(jq --arg i "$IID" '[.[] | select(.[1] == $i)] | length' <<<"$ENIS")" == 1 ]] || stop "the admin host $IID must appear exactly once among the group's interfaces ($ENIS)"
  HOST_ENI=$(jq -r --arg i "$IID" '[.[] | select(.[1] == $i)][0][0]' <<<"$ENIS")
  HD=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].{state:State.Name,ip:PrivateIpAddress,vpc:VpcId,enis:NetworkInterfaces[].{eni:NetworkInterfaceId,ips:PrivateIpAddresses[].PrivateIpAddress}}' --output json 2>/dev/null) || { rc=$?; stop "cannot read the admin host's network details$(tm $rc)"; }
  [[ "$(jq -r .state <<<"$HD")" == running ]] || stop "the admin host is not running"
  jq -e '(.enis | length) == 1 and (.enis[0].ips | length) == 1 and .enis[0].ips[0] == .ip' <<<"$HD" >/dev/null 2>&1 || stop "the admin host must have exactly ONE network interface with exactly ONE private IPv4 address; refusing ($(jq -c '.enis' <<<"$HD"))"
  HOST_IP=$(jq -r .ip <<<"$HD"); VPC_ID=$(jq -r .vpc <<<"$HD")
  valid_private_ipv4 "$HOST_IP" || stop "the admin host's address '$HOST_IP' is not a valid private (RFC 1918) IPv4 address"
  [[ -z "${OGEVIA_EXPECT_HOST_IP:-}" || "$HOST_IP" == "$OGEVIA_EXPECT_HOST_IP" ]] || stop "the admin host's live IP is $HOST_IP but OGEVIA_EXPECT_HOST_IP is ${OGEVIA_EXPECT_HOST_IP:-}. Not proceeding."
  [[ "$(jq -r '.enis[0].eni' <<<"$HD")" == "$HOST_ENI" ]] || stop "the host's interface does not match the interface in the admin group"
  IPMAP=$(aws ec2 describe-network-interfaces --filters "Name=addresses.private-ip-address,Values=$HOST_IP" "Name=vpc-id,Values=$VPC_ID" --query 'NetworkInterfaces[].[NetworkInterfaceId,Attachment.InstanceId]' --output json 2>/dev/null) || { rc=$?; stop "cannot map the IP to interfaces$(tm $rc)"; }
  [[ "$(jq 'length' <<<"$IPMAP")" == 1 && "$(jq -r '.[0][0]' <<<"$IPMAP")" == "$HOST_ENI" && "$(jq -r '.[0][1]' <<<"$IPMAP")" == "$IID" ]] || stop "the IP $HOST_IP does not map to exactly one interface, the admin host's own ($IPMAP)"
  HOST_CIDR="$HOST_IP/32"
  say "admin host IP (live): $HOST_IP on $HOST_ENI, the only interface and the only address; it maps to no other interface in $VPC_ID"
else
[[ "$(jq 'length' <<<"$ENIS")" == 1 && "$(jq -r '.[0][1]' <<<"$ENIS")" == "$IID" ]] || stop "the group $ADMIN_SG is used by more than the admin host ($ENIS): the rule would grant others access. If the group is deliberately shared, the TEST-only 'test --host-ip' mode names the host's own IP instead."
say "group $ADMIN_SG is used by exactly one network interface, on the admin host: the new rule can only ever apply to it"
fi
BEFORE_JSON=$(sg_canonical "$EXPECT_RDS_SG"); [[ -n "$BEFORE_JSON" && "$BEFORE_JSON" != null ]] || stop "cannot read the RDS security group rules"
BEFORE_SHA=$(sha256sum <<<"$BEFORE_JSON" | cut -d' ' -f1)
printf '%s\n' "$BEFORE_JSON" > "$OUT/rds-sg-before.json"; chmod 600 "$OUT/rds-sg-before.json"
say "RDS security group $EXPECT_RDS_SG, ORIGINAL inbound rules:"
jq -r '.i[] | "   " + .IpProtocol + " " + ((.FromPort // "all")|tostring) + "-" + ((.ToPort // "all")|tostring) + "  from " + (([.UserIdGroupPairs[].GroupId] + [.IpRanges[].CidrIp] + [.Ipv6Ranges[].CidrIpv6] + [.PrefixListIds[].PrefixListId]) | join(", "))' <<<"$BEFORE_JSON" | tee -a "$RESULT"
say "   outbound rules: $(jq '.e | length' <<<"$BEFORE_JSON") (recorded in the hash)"
say "ORIGINAL rule-set sha256: $BEFORE_SHA   (full copy: $OUT/rds-sg-before.json)"
if [[ "$USE_IP" == 1 ]]; then SRC_KIND=cidr; SRC_VAL="$HOST_CIDR"; else SRC_KIND=sg; SRC_VAL="$ADMIN_SG"; fi
src_present "$EXPECT_RDS_SG" "$SRC_KIND" "$SRC_VAL"; case $? in
  0) stop "a rule allowing $SRC_VAL on 5432 ALREADY exists on $EXPECT_RDS_SG. Then the read-only script should have worked; investigate instead of changing anything." ;;
  2) stop "cannot read the RDS security group rules (failed or timed out). Nothing was changed." ;;
esac

say ""; say "== 3. PROPOSED CHANGE (the only one)"
if [[ "$USE_IP" == 1 ]]; then
  say "  ADD to $EXPECT_RDS_SG :  inbound tcp 5432 from $HOST_CIDR  (the admin host's own IP only; description 'TEMP-ledger-check-$STAMP')"
else
  say "  ADD to $EXPECT_RDS_SG :  inbound tcp 5432 from $ADMIN_SG  (description 'TEMP-ledger-check-$STAMP')"
fi
say "  REMOVE it again within seconds, then verify the complete rule set equals the original hash above."
say "  Reaches: RDS instance $RDS_ID on 5432 from the admin host only. That instance holds BOTH ogevia_sv_test and ogevia_prd."
read -r -p "Type OPEN-5432-WINDOW to open the window for the $ARG check (anything else stops, with nothing changed). Keep a SEPARATE recovery session ready: if this session is lost the rule is NOT removed automatically: " ans
[[ "$ans" == OPEN-5432-WINDOW ]] || { say "Declined. Nothing was changed."; exit 0; }

say ""; say "== 4. Window"
START_EPOCH=$(date +%s)
( set -o noclobber; jq -n --arg rds "$EXPECT_RDS_SG" --arg adm "$ADMIN_SG" --arg stamp "$STAMP" --arg sha "$BEFORE_SHA" --arg kind "$SRC_KIND" --arg cidr "$HOST_CIDR" '{rds_sg:$rds, admin_sg:$adm, stamp:$stamp, before_sha:$sha, kind:$kind, cidr:$cidr}' > "$OPEN" ) 2>/dev/null || stop "another window was opened a moment ago ($OPEN exists). Nothing was changed by this run."
OWNS=1; chmod 600 "$OPEN"
if [[ "$USE_IP" == 1 ]]; then
aws ec2 authorize-security-group-ingress --group-id "$EXPECT_RDS_SG" --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,IpRanges=[{CidrIp=$HOST_CIDR,Description=TEMP-ledger-check-$STAMP}]" >/dev/null 2>"$OUT/authorize.err" || { rc=$?; stop "could not add the rule$(tm $rc): $(tail -1 "$OUT/authorize.err")"; }
cidr_present "$EXPECT_RDS_SG" "$HOST_CIDR" || stop "the rule did not appear after adding it (or the check failed or timed out)"
[[ "$(sg_hash "$EXPECT_RDS_SG" "" "$HOST_CIDR")" == "$BEFORE_SHA" ]] || stop "the group changed in a way other than the single rule: aborting"
else
aws ec2 authorize-security-group-ingress --group-id "$EXPECT_RDS_SG" --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,UserIdGroupPairs=[{GroupId=$ADMIN_SG,Description=TEMP-ledger-check-$STAMP}]" >/dev/null 2>"$OUT/authorize.err" || { rc=$?; stop "could not add the rule$(tm $rc): $(tail -1 "$OUT/authorize.err")"; }
rule_present "$EXPECT_RDS_SG" "$ADMIN_SG" || stop "the rule did not appear after adding it (or the check failed or timed out)"
[[ "$(sg_hash "$EXPECT_RDS_SG" "$ADMIN_SG")" == "$BEFORE_SHA" ]] || stop "the group changed in a way other than the single rule: aborting"
fi
say "window open: exactly one rule was added (verified: the group minus that rule equals the original)."

over_time && stop "time limit ($MAX_SECONDS s) reached before the tunnel"
AWS_T="$((MAX_SECONDS + 30))" aws ssm start-session --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$RDS_HOST,portNumber=5432,localPortNumber=$LOCAL_PORT" >/dev/null 2>&1 &
TUN=$!
for _ in $(seq 1 "${OGEVIA_TUNNEL_WAIT:-30}"); do (echo > "/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null && break; sleep 1; done
(echo > "/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null || stop "the Session Manager tunnel did not open in time"
over_time && stop "time limit ($MAX_SECONDS s) reached"
SEC=$(aws secretsmanager get-secret-value --secret-id "$(jq -r .MasterUserSecret.SecretArn <<<"$RDS")" --query SecretString --output text 2>/dev/null) || { rc=$?; stop "cannot read the RDS master secret$(tm $rc) (permission, not RDS-managed, or timed out)"; }
export PGHOST=127.0.0.1 PGPORT=$LOCAL_PORT PGSSLMODE=require PGCONNECT_TIMEOUT=15
export PGUSER; PGUSER=$(jq -r .username <<<"$SEC")
export PGPASSWORD; PGPASSWORD=$(jq -r .password <<<"$SEC")
unset SEC
RO() { over_time && return 99; PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=20000" timeout --foreground -k "$KILL_AFTER" "$PSQL_TMO" psql -X -q -At -F $'\t' -v ON_ERROR_STOP=1 "$@"; }
EXISTS=$(RO -d postgres -c "select string_agg(datname, ',' order by datname) from pg_database where datname in ('ogevia_sv_test')") || { rc=$?; stop "cannot connect to the database server$(tm $rc)"; }
say "databases present (of the two Ogevia names): ${EXISTS:-none}"
if ! grep -qw "$DB_EXPECT" <<<"${EXISTS//,/ }"; then
  LEDGER_BAD=1; LEDGER_TEXT="RESULT: database $DB_EXPECT DOES NOT EXIST on $RDS_ID. STOP: the plan requires TEST at $EXP_COUNT / $EXP_LATEST."
else
  WHO=$(RO -d "$DB_EXPECT" -c "select current_database() || ' | read_only=' || current_setting('transaction_read_only')") || { rc=$?; stop "cannot connect to $DB_EXPECT$(tm $rc)"; }
  say "connected: $WHO"
  [[ "${WHO%% |*}" == "$DB_EXPECT" ]] || stop "connected to '${WHO%% |*}', not '$DB_EXPECT'"
  [[ "$WHO" == *"read_only=on" ]] || stop "the session is not read-only: refusing to run anything"
  SUMMARY=$(RO -d "$DB_EXPECT" -c "select count(*) || ' migrations applied, latest ' || coalesce(max(version), 'none') from ogevia_meta.schema_migrations") || { rc=$?; stop "the ledger cannot be read in $DB_EXPECT$(tm $rc)"; }
  ROWS=$(RO -d "$DB_EXPECT" -c "begin transaction read only" -c "select version || '  ' || checksum || '  ' || name || '  applied ' || to_char(applied_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') from ogevia_meta.schema_migrations where version > '$EXP_LATEST' order by version" -c "rollback") || { rc=$?; stop "the ledger query failed$(tm $rc)"; }
  ACT=$(RO -d "$DB_EXPECT" -c "select count(*) filter (where enforcement_active_from is not null) || '|' || count(*) from ogevia.organization_readiness_settings") || { rc=$?; stop "the enforcement state cannot be read$(tm $rc)"; }
  say "enforcement activated for ${ACT%%|*} of ${ACT##*|} agencies (read-only select)"
  if [[ -z "$ROWS" && "$SUMMARY" == "$EXP_COUNT migrations applied, latest $EXP_LATEST" && "${ACT%%|*}" == "$EXP_ACT" ]]; then
    LEDGER_TEXT="RESULT for $ARG ($DB_EXPECT): ledger summary: $SUMMARY. NO ROW is above $EXP_LATEST: the TEST ledger is exactly the expected $EXP_COUNT / $EXP_LATEST, and enforcement is activated for ${ACT%%|*} of ${ACT##*|} agencies as expected."
  elif [[ -z "$ROWS" ]]; then
    LEDGER_BAD=1; LEDGER_TEXT="RESULT for $ARG ($DB_EXPECT): ledger summary: $SUMMARY; enforcement activated for ${ACT%%|*}. STOP: the plan requires exactly '$EXP_COUNT migrations applied, latest $EXP_LATEST' and $EXP_ACT activated agencies. Do not continue. Send this output to Claude."
  else
    LEDGER_BAD=1; LEDGER_TEXT="RESULT for $ARG ($DB_EXPECT): ledger summary: $SUMMARY. Migrations ABOVE $EXP_LATEST ARE ALREADY APPLIED:"$'\n'"$ROWS"$'\n'"STOP: do not continue and do not edit migration files in place. Send this output to Claude."
  fi
fi
over_time && say "(time limit exceeded; result kept)"
close_window
say ""; say "================ SUMMARY ================"
say "Environment : $LABEL ($DB_EXPECT)"
say "$LEDGER_TEXT"
[[ -f "$OPEN" ]] && say "SECURITY GROUP: NOT RESTORED, see the instructions above" || say "SECURITY GROUP: restored and verified identical to the original"
[[ "$RC" == 0 && "${LEDGER_BAD:-0}" == 1 ]] && RC=1
exit "$RC"
