#!/usr/bin/env bash
# =============================================================================
# Ogevia TEST rehearsal (release 0b593e5): APPLY MIGRATIONS 0078-0084 TO THE TEST DATABASE through a temporary, narrow database-access window.
# TEST ONLY (database ogevia_sv_test). YELLOW: run only after the owner's explicit GO. Not run against AWS by anyone yet.
# Adapted from the reviewed candidate-migrate-test.sh of the 2026-10-18 operation. DIFFERENCES: (1) range 0078-0084 on top of a ledger of exactly 77 / 0077 (rollback 0084
# down to 0078); (2) the snapshot is named ogevia-prod-postgres-pre-0084-YYYYMMDDHHMM; (3) there is NO git in CloudShell: the package is proven by BUILD_INFO.json (code
# commit), PACKAGE_MANIFEST.sha256 (every file), no file outside the manifest, and the migration-set hash (scripts/pkg-lib.sh); (4) the script lives in the package under
# docs/releases/2026-10-19-test-rehearsal/scripts. Everything else (the /32 rule, timeouts, cleanup with a rule-set hash, marker, phrase, wrong-database refusals) is unchanged.
#
#   OGEVIA_EXPECT_COMMIT=<40-hex code SHA> OGEVIA_EXPECT_HOST_IP=<admin host private IP> OGEVIA_EXPECT_MIGRATIONS_SHA=<64-hex> \
#   OGEVIA_PREDEPLOY_SNAPSHOT_ID=... OGEVIA_RELEASE_WINDOW_START=... OGEVIA_RELEASE_WINDOW_END=...            bash rehearsal-migrate-test.sh migrate [--resume]
#   (same variables plus OGEVIA_EXPECT_ROLLBACK_SHA=<64-hex>)                                                    bash rehearsal-migrate-test.sh rollback
#   bash rehearsal-migrate-test.sh --restore-only        after an interrupted run: remove the temporary rule and verify (idempotent)
#
# Window: one inbound rule on the RDS security group, tcp 5432, source = the admin host's own private IP as /32 (never a group, never a range). Inside it the script
# (1) proves the connection is to ogevia_sv_test and read-only, (2) proves the ledger is exactly 77 / 0077 (with --resume: contiguous between 0078 and 0083), (3) runs the
# pinned runner against that one database (one transaction per file), (4) re-reads the ledger (84 / 0084) and runs the read-only verification set (infra/aws/db/verification),
# and only then closes the window. ogevia_prd is never named, connected to or queried. The RDS master credential is held in shell memory only and never printed.
#
# SNAPSHOT (required in both modes, checked BEFORE the access window is proposed or opened; every failure refuses and changes nothing):
#   OGEVIA_PREDEPLOY_SNAPSHOT_ID         a manual snapshot named ogevia-prod-postgres-pre-0084-YYYYMMDDHHMM (UTC minute it was taken)
#   OGEVIA_RELEASE_WINDOW_START / _END   the owner-approved release window, UTC, format 2026-10-19T03:00:00Z (END after START, at most 12 hours)
#   It must exist, be `available`, belong to ogevia-prod-postgres, be `manual`, have been CREATED inside the window and not in the future, and carry a name stamp inside
#   the window. `migrate` also requires NOW inside the window; `rollback` only that the window has started. A snapshot is a recovery PREREQUISITE; this script never restores one.
#
# AWS verbs used: sts/cloudformation/lambda/rds/ec2 describe-/list-/get-; ec2 authorize-security-group-ingress and revoke-security-group-ingress (the single temporary
# rule); ssm start-session; secretsmanager get-secret-value. Nothing else.
# EXIT CODES: 0 completed; 1 stopped or failed (cleanup verified if a window had opened); 2 usage; 3 the temporary rule could NOT be verified removed; 130 interrupted.
# =============================================================================
set -uo pipefail
ARG="${1:-}"; MODE2="${2:-}"; RESUME=0
ACCOUNT=300094796789
REGION=us-west-2
RDS_ID=ogevia-prod-postgres
ADMIN_TAG=ogevia-db-admin-temp
EXPECT_RDS_SG=sg-00530a1f4f7648e65      # ogevia-prod-data-layer-RDSSecurityGroup
ADMIN_SG=sg-00e01e2ca80442c1f           # ogevia-db-admin-sg
API_STACK=Ogevia-prod-ServiceVerificationApi
DB_EXPECT=ogevia_sv_test
FIRST_NEW=0078; LAST_NEW=0084; BASELINE=0077
PHRASE=OPEN-5432-WINDOW-MIGRATE-TEST
[[ "$ARG" == rollback ]] && PHRASE=OPEN-5432-WINDOW-ROLLBACK-TEST
DOWN_TMO="${OGEVIA_ROLLBACK_FILE_TIMEOUT:-120}"
MAX_SECONDS="${OGEVIA_WINDOW_MAX_SECONDS:-900}"
STATE_DIR="${OGEVIA_MIGRATE_STATE_DIR:-$HOME/.ogevia-migrate-window}"
LEDGER_STATE_DIR="${OGEVIA_LEDGER_STATE_DIR:-$HOME/.ogevia-ledger-window}"
OPEN="$STATE_DIR/OPEN"
LOCAL_PORT=${OGEVIA_MIGRATE_PORT:-15441}
AWS_TMO="${OGEVIA_AWS_TIMEOUT:-30}"; PSQL_TMO="${OGEVIA_PSQL_TIMEOUT:-45}"; CLEAN_TMO="${OGEVIA_CLEANUP_AWS_TIMEOUT:-20}"
MIGRATE_TMO="${OGEVIA_MIGRATE_TIMEOUT:-600}"; VERIFY_TMO="${OGEVIA_VERIFY_TIMEOUT:-120}"
KILL_AFTER=5
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pkg-lib.sh"
INFRA="$PKG_INFRA"
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION AWS_PAGER=""
case "$ARG" in
  migrate) case "$MODE2" in "") ;; --resume) RESUME=1 ;; *) echo "usage: bash rehearsal-migrate-test.sh migrate [--resume] | rollback | --restore-only" >&2; exit 2 ;; esac ;;
  rollback|--restore-only) [[ -z "$MODE2" ]] || { echo "usage: bash rehearsal-migrate-test.sh migrate [--resume] | rollback | --restore-only" >&2; exit 2; } ;;
  *) echo "usage: bash rehearsal-migrate-test.sh migrate [--resume] | rollback | --restore-only" >&2; exit 2 ;;
esac
mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="${OGEVIA_MIGRATE_DIR:-$HOME/ogevia-migrate-window-${ARG#--}-$STAMP}"; mkdir -p "$OUT"; chmod 700 "$OUT"
RESULT="$OUT/RESULT.txt"; : > "$RESULT"
TUN=""; IID=""; CLOSED=0; OWNS=0; RC=0; MIGRATING=0; START_EPOCH=$(date +%s); HOST_CIDR=""
say() { printf '%s\n' "$*" | tee -a "$RESULT"; }

# ---- bounded commands ---------------------------------------------------------------------------------------------------------
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
sg_canonical() {
  aws ec2 describe-security-groups --group-ids "$1" --query 'SecurityGroups[0].{i:IpPermissions,e:IpPermissionsEgress}' --output json 2>/dev/null \
  | jq -cS --arg dropc "${2:-}" '
      def norm: map(.UserIdGroupPairs |= (map({GroupId, UserId}) | sort_by(.GroupId)) | .IpRanges |= (map({CidrIp}) | sort_by(.CidrIp)) | .Ipv6Ranges |= (map({CidrIpv6}) | sort_by(.CidrIpv6)) | .PrefixListIds |= (map({PrefixListId}) | sort_by(.PrefixListId))) | sort_by(.IpProtocol, (.FromPort // -1), (.ToPort // -1));
      (.i | norm) as $i
      | { i: (if $dropc == "" then $i else ($i | map(if (.IpProtocol=="tcp" and .FromPort==5432 and .ToPort==5432) then (.IpRanges |= map(select(.CidrIp != $dropc))) else . end) | map(select((.UserIdGroupPairs|length) > 0 or (.IpRanges|length) > 0 or (.Ipv6Ranges|length) > 0 or (.PrefixListIds|length) > 0))) end),
          e: (.e | norm) }'
}
sg_hash() { sg_canonical "$@" | sha256sum | cut -d' ' -f1; }
# 0 present, 1 absent (the describe succeeded), 2 unknown (never treated as absent)
cidr_present() {
  local out
  out=$(aws ec2 describe-security-groups --group-ids "$1" --query 'SecurityGroups[0].IpPermissions[?FromPort==`5432` && ToPort==`5432`].IpRanges[].CidrIp' --output text 2>/dev/null) || return 2
  tr '\t' '\n' <<<"$out" | grep -qx "$2"
}
revoke_cidr() { aws ec2 revoke-security-group-ingress --group-id "$1" --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,IpRanges=[{CidrIp=$2}]" >/dev/null 2>&1; }

# Best-effort, bounded read of the ledger through the still-open tunnel (used after a failure or interruption to say where the database is).
ledger_now() {
  [[ -n "${PGPASSWORD:-}" ]] || { echo "unknown (no database session)"; return; }
  PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=10000" timeout --foreground -k 3 15 psql -X -q -At -d "$DB_EXPECT" \
    -c "select count(*) || ' migrations applied, latest ' || coalesce(max(version), 'none') from ogevia_meta.schema_migrations" 2>/dev/null || echo "unknown (could not read the ledger)"
}
close_window() {
  [[ "$CLOSED" == 1 ]] && return 0
  CLOSED=1
  if [[ "$MIGRATING" == 1 ]]; then say ""; say "== LEDGER at the moment of closing (best effort): $(ledger_now)"; fi
  [[ -n "$TUN" ]] && { pkill -P "$TUN" 2>/dev/null; kill "$TUN" 2>/dev/null; }
  [[ -n "$IID" ]] && pkill -f "session-manager-plugin.*$IID" 2>/dev/null
  unset PGPASSWORD PGUSER SEC OGEVIA_DATABASE_URL
  [[ -f "$OPEN" && "$OWNS" == 1 ]] || return 0
  local rds_sg before i ok=0 rp val
  AWS_T="$CLEAN_TMO"
  rds_sg=$(jq -r .rds_sg "$OPEN"); before=$(jq -r .before_sha "$OPEN"); val=$(jq -r .cidr "$OPEN")
  say ""; say "== CLEANUP: removing the temporary rule (tcp 5432 from $val on $rds_sg) and verifying"
  for i in 1 2 3 4; do
    cidr_present "$rds_sg" "$val"; rp=$?
    if [[ "$rp" != 1 ]]; then revoke_cidr "$rds_sg" "$val"; sleep 2; fi
    cidr_present "$rds_sg" "$val"; [[ $? == 1 ]] && { ok=1; break; }
  done
  local after; after=$(sg_hash "$rds_sg")
  if [[ "$ok" == 1 && "$after" == "$before" ]]; then
    say "RESTORED (verified): the temporary rule is gone and the RDS security group's complete rule set is identical to the recorded original (sha256 ${after:0:16}...)."
    rm -f "$OPEN"
  else
    RC=3
    cidr_present "$rds_sg" "$val"; rp=$?
    say "NOT RESTORED (exit 3; access may still be open). Rule still present: $([[ $rp == 0 ]] && echo YES || { [[ $rp == 1 ]] && echo no || echo 'UNKNOWN (the check failed or timed out)'; }). Rule-set hash now ${after:0:16}... vs original ${before:0:16}..."
    say "DO THIS NOW in a SEPARATE session. First identify (read-only); the temporary rule is the ONE row with cidr $val, tcp, 5432, description beginning TEMP-migrate-:"
    say "  aws ec2 describe-security-group-rules --region $REGION --filters Name=group-id,Values=$rds_sg --query 'SecurityGroupRules[?IsEgress==\`false\`].{rule:SecurityGroupRuleId,proto:IpProtocol,from:FromPort,to:ToPort,cidr:CidrIpv4,sourceSg:ReferencedGroupInfo.GroupId,desc:Description}' --output table"
    say "Then remove ONLY that rule by id (never the row whose sourceSg is the application group sg-064ffce3bcbe8eb3b):"
    say "  aws ec2 revoke-security-group-ingress --region $REGION --group-id $rds_sg --security-group-rule-ids sgr-<id of that one row>"
    say "Then re-run: bash rehearsal-migrate-test.sh --restore-only   (verifies against the recorded original)"
    say "  The marker $OPEN stays in place until restoration is verified."
  fi
}
on_exit() { local rc=$?; close_window; [[ $RC != 0 ]] && exit "$RC"; exit "$rc"; }
trap on_exit EXIT
trap 'say "Interrupted: cleaning up."; exit 130' INT TERM HUP
stop() {
  say ""; say "STOPPED: $*"
  if [[ "$OWNS" == 0 ]]; then say "No access window was opened and nothing was changed."
  else say "The window had been opened: the cleanup above restored and verified the security group. The database may be partly migrated: see the ledger line above and the recovery section of the procedure."; fi
  exit 1
}
over_time() { (( $(date +%s) - START_EPOCH > MAX_SECONDS )); }
for t in aws jq psql session-manager-plugin sha256sum timeout node npx find comm; do
  command -v "$t" >/dev/null 2>&1 || stop "missing tool '$t'. Install it yourself; this script installs nothing."
done

say "================================================================"
say "MODE                   : $ARG${MODE2:+ $MODE2}  (TEST only, database $DB_EXPECT)"
say "UTC time              : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "================================================================"
IDENT=$(aws sts get-caller-identity --output json 2>/dev/null) || stop "no valid AWS credentials: sign in again and reopen CloudShell in us-west-2"
[[ "$(jq -r .Account <<<"$IDENT")" == "$ACCOUNT" ]] || stop "wrong AWS account $(jq -r .Account <<<"$IDENT") (expected $ACCOUNT)"
say "account $ACCOUNT, region $REGION: OK"

if [[ "$ARG" == "--restore-only" ]]; then
  if [[ -f "$OPEN" ]]; then CLOSED=0; say "An open-window marker exists ($(jq -r .stamp "$OPEN")). Restoring."; OWNS=1; close_window; else say "No open-window marker: nothing to restore. (Nothing was changed.)"; fi
  exit "$RC"
fi
[[ ! -f "$OPEN" ]] || stop "an earlier migration window is marked OPEN ($OPEN, started $(jq -r .stamp "$OPEN")). Run: bash rehearsal-migrate-test.sh --restore-only"
[[ ! -f "$LEDGER_STATE_DIR/OPEN" ]] || stop "an earlier ledger-check window is marked OPEN ($LEDGER_STATE_DIR/OPEN). Run: bash ledger-check-temp-access.sh --restore-only first"

say ""; say "== 0. The package is exactly the approved release (read-only)"
[[ "${OGEVIA_EXPECT_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || stop "set OGEVIA_EXPECT_COMMIT to the full 40-character approved code commit SHA"
[[ "${OGEVIA_EXPECT_MIGRATIONS_SHA:-}" =~ ^[0-9a-f]{64}$ ]] || stop "set OGEVIA_EXPECT_MIGRATIONS_SHA to the 64-character checksum of the migration set given in the procedure"
[[ "${OGEVIA_EXPECT_HOST_IP:-}" != "" ]] && valid_private_ipv4 "$OGEVIA_EXPECT_HOST_IP" || stop "set OGEVIA_EXPECT_HOST_IP to the admin host's private IPv4 address (the reviewed /32 mode requires it)"
HEAD_SHA=$(pkg_code_commit) || stop "BUILD_INFO.json is missing or has no valid code commit: this script must run inside the extracted operator package"
[[ "$HEAD_SHA" == "$OGEVIA_EXPECT_COMMIT" ]] || stop "the package is built from $HEAD_SHA, not the approved $OGEVIA_EXPECT_COMMIT"
MANI=$(pkg_manifest_ok) || stop "the package does not match its manifest: $MANI"
STRAYS=$(pkg_strays) || stop "cannot list the package files"
[[ -z "$STRAYS" ]] || stop "the package has files that are not in the manifest: $(head -3 <<<"$STRAYS" | tr '\n' ';')"
MIG_SHA=$(pkg_migration_set_sha) && [[ -n "$MIG_SHA" ]] || stop "cannot hash db/migrations"
[[ "$MIG_SHA" == "$OGEVIA_EXPECT_MIGRATIONS_SHA" ]] || stop "db/migrations hashes to $MIG_SHA, not the approved $OGEVIA_EXPECT_MIGRATIONS_SHA"
ls "$INFRA/db/migrations/${LAST_NEW}_"*.sql >/dev/null 2>&1 || stop "migration $LAST_NEW is missing from the checkout"
[[ -d "$INFRA/node_modules" ]] || stop "dependencies are not installed: run 'pnpm install --frozen-lockfile' in the checkout first"
if [[ "$ARG" == rollback ]]; then
  [[ "${OGEVIA_EXPECT_ROLLBACK_SHA:-}" =~ ^[0-9a-f]{64}$ ]] || stop "set OGEVIA_EXPECT_ROLLBACK_SHA to the 64-character checksum of the rollback set given in the procedure"
  ROLL_SHA=$(pkg_rollback_set_sha)
  [[ "$ROLL_SHA" == "$OGEVIA_EXPECT_ROLLBACK_SHA" ]] || stop "db/rollback (0078-0084) hashes to $ROLL_SHA, not the approved $OGEVIA_EXPECT_ROLLBACK_SHA"
  for v in $(seq 78 84); do ls "$INFRA/db/rollback/$(printf '%04d' "$v")_"*.down.sql >/dev/null 2>&1 || stop "the rollback file for $(printf '%04d' "$v") is missing"; done
  say "rollback set sha256 ${ROLL_SHA:0:16}...: OK"
fi
# ---- the named, available pre-deployment snapshot (both modes), validated before access is proposed -------------------------------------------------------------
SNAP_ID="${OGEVIA_PREDEPLOY_SNAPSHOT_ID:-}"
[[ "$SNAP_ID" =~ ^ogevia-prod-postgres-pre-0084-[0-9]{12}$ ]] || stop "set OGEVIA_PREDEPLOY_SNAPSHOT_ID to the named pre-deployment snapshot (pattern ogevia-prod-postgres-pre-0084-YYYYMMDDHHMM, UTC)"
TS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
[[ "${OGEVIA_RELEASE_WINDOW_START:-}" =~ $TS_RE && "${OGEVIA_RELEASE_WINDOW_END:-}" =~ $TS_RE ]] || stop "set OGEVIA_RELEASE_WINDOW_START and OGEVIA_RELEASE_WINDOW_END to the owner-approved window in UTC, format 2026-10-19T03:00:00Z"
W_START=$(date -u -d "$OGEVIA_RELEASE_WINDOW_START" +%s 2>/dev/null) && W_END=$(date -u -d "$OGEVIA_RELEASE_WINDOW_END" +%s 2>/dev/null) || stop "the release window is not a valid date and time"
(( W_END > W_START && W_END - W_START <= 43200 )) || stop "the release window must end after it starts and last at most 12 hours"
NOW_EPOCH=$(date -u +%s)
(( NOW_EPOCH >= W_START )) || stop "the release window has not started (starts $OGEVIA_RELEASE_WINDOW_START)"
if [[ "$ARG" == migrate ]]; then (( NOW_EPOCH <= W_END )) || stop "the release window ended at $OGEVIA_RELEASE_WINDOW_END; migrating outside it is refused"; fi
N_STAMP="${SNAP_ID: -12}"
N_EPOCH=$(date -u -d "${N_STAMP:0:4}-${N_STAMP:4:2}-${N_STAMP:6:2} ${N_STAMP:8:2}:${N_STAMP:10:2}:00" +%s 2>/dev/null) || stop "the time stamp in the snapshot name is not a valid date"
(( N_EPOCH + 60 >= W_START && N_EPOCH <= W_END )) || stop "the time stamp in the snapshot name ($N_STAMP) is outside the release window"
SNAP=$(aws rds describe-db-snapshots --db-snapshot-identifier "$SNAP_ID" --query 'DBSnapshots[0].[Status,DBInstanceIdentifier,SnapshotType,SnapshotCreateTime]' --output text 2>/dev/null) || { rc=$?; stop "cannot read snapshot $SNAP_ID (it does not exist, or access failed$(tm $rc))"; }
IFS=$'\t' read -r SNAP_STATUS SNAP_INSTANCE SNAP_TYPE SNAP_CREATED <<<"$SNAP"
[[ "$SNAP_STATUS" == available ]] || stop "snapshot $SNAP_ID is '${SNAP_STATUS:-unknown}', not available. Wait for it to finish; nothing was changed."
[[ "$SNAP_INSTANCE" == "$RDS_ID" ]] || stop "snapshot $SNAP_ID belongs to '${SNAP_INSTANCE:-unknown}', not $RDS_ID"
[[ "$SNAP_TYPE" == manual ]] || stop "snapshot $SNAP_ID is of type '${SNAP_TYPE:-unknown}', not a manual pre-deployment snapshot"
C_EPOCH=$(date -u -d "${SNAP_CREATED:-}" +%s 2>/dev/null) || stop "snapshot $SNAP_ID has no readable creation time ('${SNAP_CREATED:-}')"
(( C_EPOCH >= W_START && C_EPOCH <= W_END && C_EPOCH <= NOW_EPOCH )) || stop "snapshot $SNAP_ID was created at $SNAP_CREATED, outside the release window $OGEVIA_RELEASE_WINDOW_START to $OGEVIA_RELEASE_WINDOW_END (or in the future); it was not captured for this release"
say "snapshot $SNAP_ID: available, manual, belongs to $RDS_ID, created $SNAP_CREATED inside the release window $OGEVIA_RELEASE_WINDOW_START to $OGEVIA_RELEASE_WINDOW_END. (A recovery PREREQUISITE only: restoring from it is not a prepared procedure.)"
say "package commit $HEAD_SHA, manifest verified ($MANI), no stray file; migration set sha256 ${MIG_SHA:0:16}...: OK"

say ""; say "== 1. Environment (read-only): TEST; expected database $DB_EXPECT"
STATUS=$(aws cloudformation describe-stacks --stack-name "$API_STACK" --query 'Stacks[0].StackStatus' --output text 2>/dev/null) || stop "stack $API_STACK not found"
say "stack $API_STACK: $STATUS"
FN=$(aws cloudformation list-stack-resources --stack-name "$API_STACK" --output json 2>/dev/null | jq -r '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId|startswith("Handler")))][0].PhysicalResourceId // empty')
[[ -n "$FN" ]] || stop "API handler Lambda not found in $API_STACK"
CFG=$(aws lambda get-function-configuration --function-name "$FN" --output json 2>/dev/null) || stop "cannot read Lambda $FN"
L_DB=$(jq -r '.Environment.Variables.DB_NAME // empty' <<<"$CFG"); L_ENV=$(jq -r '.Environment.Variables.OGEVIA_ENV // empty' <<<"$CFG")
say "Lambda $FN: DB_NAME=${L_DB:-unset}  OGEVIA_ENV=${L_ENV:-unset}"
[[ "$L_DB" == "$DB_EXPECT" ]] || stop "the Lambda serves database '${L_DB:-unset}', not '$DB_EXPECT'. Not the TEST environment."
[[ "$L_ENV" != prd ]] || stop "TEST run but OGEVIA_ENV=prd"
say "Environment identified: TEST."

say ""; say "== 2. ORIGINAL CONFIGURATION (recorded before any change)"
RDS=$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0]' --output json 2>/dev/null) || stop "cannot describe RDS $RDS_ID"
[[ "$(jq -r .DBInstanceStatus <<<"$RDS")" == available && "$(jq -r .PubliclyAccessible <<<"$RDS")" == false ]] || stop "RDS is not available and private"
RDS_HOST=$(jq -r .Endpoint.Address <<<"$RDS"); RDS_SGS=$(jq -r '[.VpcSecurityGroups[].VpcSecurityGroupId] | join(" ")' <<<"$RDS")
[[ "$RDS_SGS" == "$EXPECT_RDS_SG" ]] || stop "RDS security groups are '$RDS_SGS', expected exactly '$EXPECT_RDS_SG'. Review before changing anything."
HOST=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$ADMIN_TAG" "Name=instance-state-name,Values=running" --query 'Reservations[0].Instances[0].[InstanceId,SecurityGroups[].GroupId]' --output json 2>/dev/null)
[[ -n "$HOST" && "$HOST" != null && "$HOST" != "[null,null]" ]] || stop "admin host '$ADMIN_TAG' is not running (starting it is a change this script will not make)"
IID=$(jq -r '.[0]' <<<"$HOST"); HOST_SGS=$(jq -r '.[1] | join(" ")' <<<"$HOST")
say "admin host $IID: security groups [$HOST_SGS]  (NOT modified by this script)"
[[ "$HOST_SGS" == "$ADMIN_SG" ]] || stop "the admin host's groups are '$HOST_SGS', expected exactly '$ADMIN_SG'."
ENIS=$(aws ec2 describe-network-interfaces --filters "Name=group-id,Values=$ADMIN_SG" --query 'NetworkInterfaces[].[NetworkInterfaceId,Attachment.InstanceId]' --output json 2>/dev/null) || stop "cannot list network interfaces"
say "group $ADMIN_SG is used by $(jq 'length' <<<"$ENIS") network interface(s) (not granted anything: the rule below names the admin host's own IP only)"
[[ "$(jq --arg i "$IID" '[.[] | select(.[1] == $i)] | length' <<<"$ENIS")" == 1 ]] || stop "the admin host $IID must appear exactly once among the group's interfaces ($ENIS)"
HOST_ENI=$(jq -r --arg i "$IID" '[.[] | select(.[1] == $i)][0][0]' <<<"$ENIS")
HD=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].{state:State.Name,ip:PrivateIpAddress,vpc:VpcId,enis:NetworkInterfaces[].{eni:NetworkInterfaceId,ips:PrivateIpAddresses[].PrivateIpAddress}}' --output json 2>/dev/null) || { rc=$?; stop "cannot read the admin host's network details$(tm $rc)"; }
[[ "$(jq -r .state <<<"$HD")" == running ]] || stop "the admin host is not running"
jq -e '(.enis | length) == 1 and (.enis[0].ips | length) == 1 and .enis[0].ips[0] == .ip' <<<"$HD" >/dev/null 2>&1 || stop "the admin host must have exactly ONE network interface with exactly ONE private IPv4 address; refusing ($(jq -c '.enis' <<<"$HD"))"
HOST_IP=$(jq -r .ip <<<"$HD"); VPC_ID=$(jq -r .vpc <<<"$HD")
valid_private_ipv4 "$HOST_IP" || stop "the admin host's address '$HOST_IP' is not a valid private (RFC 1918) IPv4 address"
[[ "$HOST_IP" == "$OGEVIA_EXPECT_HOST_IP" ]] || stop "the admin host's live IP is $HOST_IP but OGEVIA_EXPECT_HOST_IP is $OGEVIA_EXPECT_HOST_IP. Not proceeding."
[[ "$(jq -r '.enis[0].eni' <<<"$HD")" == "$HOST_ENI" ]] || stop "the host's interface does not match the interface in the admin group"
IPMAP=$(aws ec2 describe-network-interfaces --filters "Name=addresses.private-ip-address,Values=$HOST_IP" "Name=vpc-id,Values=$VPC_ID" --query 'NetworkInterfaces[].[NetworkInterfaceId,Attachment.InstanceId]' --output json 2>/dev/null) || { rc=$?; stop "cannot map the IP to interfaces$(tm $rc)"; }
[[ "$(jq 'length' <<<"$IPMAP")" == 1 && "$(jq -r '.[0][0]' <<<"$IPMAP")" == "$HOST_ENI" && "$(jq -r '.[0][1]' <<<"$IPMAP")" == "$IID" ]] || stop "the IP $HOST_IP does not map to exactly one interface, the admin host's own ($IPMAP)"
HOST_CIDR="$HOST_IP/32"
say "admin host IP (live): $HOST_IP on $HOST_ENI, the only interface and the only address; it maps to no other interface in $VPC_ID"
BEFORE_JSON=$(sg_canonical "$EXPECT_RDS_SG"); [[ -n "$BEFORE_JSON" && "$BEFORE_JSON" != null ]] || stop "cannot read the RDS security group rules"
BEFORE_SHA=$(sha256sum <<<"$BEFORE_JSON" | cut -d' ' -f1)
printf '%s\n' "$BEFORE_JSON" > "$OUT/rds-sg-before.json"; chmod 600 "$OUT/rds-sg-before.json"
say "RDS security group $EXPECT_RDS_SG, ORIGINAL inbound rules:"
jq -r '.i[] | "   " + .IpProtocol + " " + ((.FromPort // "all")|tostring) + "-" + ((.ToPort // "all")|tostring) + "  from " + (([.UserIdGroupPairs[].GroupId] + [.IpRanges[].CidrIp] + [.Ipv6Ranges[].CidrIpv6] + [.PrefixListIds[].PrefixListId]) | join(", "))' <<<"$BEFORE_JSON" | tee -a "$RESULT"
say "ORIGINAL rule-set sha256: $BEFORE_SHA   (full copy: $OUT/rds-sg-before.json)"
cidr_present "$EXPECT_RDS_SG" "$HOST_CIDR"; case $? in
  0) stop "a rule allowing $HOST_CIDR on 5432 ALREADY exists on $EXPECT_RDS_SG. Investigate instead of changing anything." ;;
  2) stop "cannot read the RDS security group rules (failed or timed out). Nothing was changed." ;;
esac

say ""; say "== 3. PROPOSED CHANGES"
say "  1. ADD to $EXPECT_RDS_SG :  inbound tcp 5432 from $HOST_CIDR  (the admin host's own IP only; description 'TEMP-migrate-$STAMP')"
if [[ "$ARG" == rollback ]]; then
  say "  2. Through that window, against $DB_EXPECT ONLY: check the ledger is contiguous from 0078 upward, then revert the migrations from the latest down to $FIRST_NEW with the pinned db/rollback files, one transaction per file (the ledger row is deleted in the same transaction), and re-read the ledger (expected 77 / $BASELINE)."
  say "     NOTE: 0078-0084 are FUNCTIONS ONLY (no table, column or stored row is dropped or changed); each rollback restores the earlier function definitions. The pre-deployment snapshot is $SNAP_ID (restoring it is NOT a prepared procedure)."
else
  say "  2. Through that window, against $DB_EXPECT ONLY: check the ledger is $([[ $RESUME == 1 ]] && echo "contiguous between $FIRST_NEW and 0083 (--resume)" || echo "exactly 77 / $BASELINE"), apply migrations $FIRST_NEW to $LAST_NEW with the pinned runner, re-read the ledger, run the read-only verification set."
fi
say "  3. REMOVE the rule again, then verify the complete rule set equals the original hash above."
say "  Reaches: RDS instance $RDS_ID on 5432 from the admin host only. That instance ALSO holds ogevia_prd: this script never names, connects to or queries it."
read -r -p "Type $PHRASE to open the window and $([[ "$ARG" == rollback ]] && echo "ROLL BACK" || echo migrate) $DB_EXPECT (anything else stops, nothing changed). Keep a SEPARATE recovery session ready: if this session is lost the rule is NOT removed automatically: " ans
[[ "$ans" == "$PHRASE" ]] || { say "Declined. Nothing was changed."; exit 0; }

say ""; say "== 4. Window"
START_EPOCH=$(date +%s)
( set -o noclobber; jq -n --arg rds "$EXPECT_RDS_SG" --arg stamp "$STAMP" --arg sha "$BEFORE_SHA" --arg cidr "$HOST_CIDR" '{rds_sg:$rds, stamp:$stamp, before_sha:$sha, kind:"cidr", cidr:$cidr}' > "$OPEN" ) 2>/dev/null || stop "another window was opened a moment ago ($OPEN exists). Nothing was changed by this run."
OWNS=1; chmod 600 "$OPEN"
aws ec2 authorize-security-group-ingress --group-id "$EXPECT_RDS_SG" --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,IpRanges=[{CidrIp=$HOST_CIDR,Description=TEMP-migrate-$STAMP}]" >/dev/null 2>"$OUT/authorize.err" || { rc=$?; stop "could not add the rule$(tm $rc): $(tail -1 "$OUT/authorize.err")"; }
cidr_present "$EXPECT_RDS_SG" "$HOST_CIDR" || stop "the rule did not appear after adding it (or the check failed or timed out)"
[[ "$(sg_hash "$EXPECT_RDS_SG" "$HOST_CIDR")" == "$BEFORE_SHA" ]] || stop "the group changed in a way other than the single rule: aborting"
say "window open: exactly one rule was added (verified: the group minus that rule equals the original)."

over_time && stop "time limit ($MAX_SECONDS s) reached before the tunnel"
AWS_T="$((MAX_SECONDS + 30))" aws ssm start-session --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$RDS_HOST,portNumber=5432,localPortNumber=$LOCAL_PORT" >/dev/null 2>&1 &
TUN=$!
for _ in $(seq 1 "${OGEVIA_TUNNEL_WAIT:-30}"); do (echo > "/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null && break; sleep 1; done
(echo > "/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null || stop "the Session Manager tunnel did not open in time"
over_time && stop "time limit ($MAX_SECONDS s) reached"
SEC=$(aws secretsmanager get-secret-value --secret-id "$(jq -r .MasterUserSecret.SecretArn <<<"$RDS")" --query SecretString --output text 2>/dev/null) || { rc=$?; stop "cannot read the RDS master secret$(tm $rc)"; }
export PGHOST=127.0.0.1 PGPORT=$LOCAL_PORT PGSSLMODE=require PGCONNECT_TIMEOUT=15
export PGUSER; PGUSER=$(jq -r .username <<<"$SEC")
export PGPASSWORD; PGPASSWORD=$(jq -r .password <<<"$SEC")
DBURL="postgres://$(jq -rn --arg u "$PGUSER" '$u|@uri'):$(jq -rn --arg p "$PGPASSWORD" '$p|@uri')@127.0.0.1:$LOCAL_PORT/$DB_EXPECT?sslmode=no-verify"
unset SEC
RO() { over_time && return 99; PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=20000" timeout --foreground -k "$KILL_AFTER" "$PSQL_TMO" psql -X -q -At -F $'\t' -v ON_ERROR_STOP=1 "$@"; }

say ""; say "== 5. Database and ledger precondition (read-only)"
WHO=$(RO -d "$DB_EXPECT" -c "select current_database() || ' | read_only=' || current_setting('transaction_read_only')") || { rc=$?; stop "cannot connect to $DB_EXPECT$(tm $rc)"; }
say "connected: $WHO"
[[ "${WHO%% |*}" == "$DB_EXPECT" ]] || stop "connected to '${WHO%% |*}', not '$DB_EXPECT'"
[[ "$WHO" == *"read_only=on" ]] || stop "the read-only session is not read-only: refusing to run anything"
LEDGER=$(RO -d "$DB_EXPECT" -c "select count(*) || '|' || coalesce(max(version), 'none') from ogevia_meta.schema_migrations") || { rc=$?; stop "the ledger cannot be read in $DB_EXPECT$(tm $rc)"; }
L_COUNT="${LEDGER%%|*}"; L_LATEST="${LEDGER##*|}"
say "ledger before: $L_COUNT migrations applied, latest $L_LATEST"
if [[ "$ARG" == rollback ]]; then
  [[ "$L_LATEST" =~ ^00[0-9]{2}$ && "$L_COUNT" == "$((10#$L_LATEST))" && "$L_LATEST" > "$BASELINE" && "$L_LATEST" < "0085" ]] || stop "rollback needs a contiguous ledger between 0078 and 0084; found $L_COUNT / $L_LATEST. Nothing was reverted."
elif [[ "$RESUME" == 1 ]]; then
  [[ "$L_LATEST" =~ ^00[0-9]{2}$ && "$L_COUNT" == "$((10#$L_LATEST))" && "$L_LATEST" > "$BASELINE" && "$L_LATEST" < "$LAST_NEW" ]] || stop "--resume needs a contiguous ledger between 0078 and 0083; found $L_COUNT / $L_LATEST"
else
  [[ "$L_COUNT" == 77 && "$L_LATEST" == "$BASELINE" ]] || stop "the TEST ledger is $L_COUNT / $L_LATEST, not exactly 77 / $BASELINE. Nothing was migrated."
fi

# Enforcement activation is a separate owner approval: its state must be exactly the same after this run as before it (read-only).
ACT_Q="select count(*) filter (where enforcement_active_from is not null) || '|' || count(*) from ogevia.organization_readiness_settings"
ACT_BEFORE=$(RO -d "$DB_EXPECT" -c "$ACT_Q") || { rc=$?; stop "cannot read the enforcement state$(tm $rc)"; }
say "enforcement activated for ${ACT_BEFORE%%|*} of ${ACT_BEFORE##*|} agencies before (this run never changes it)"
act_unchanged() { local a; a=$(RO -d "$DB_EXPECT" -c "$ACT_Q") || return 1; [[ "$a" == "$ACT_BEFORE" ]]; }
if [[ "$ARG" == rollback ]]; then
  say ""; say "== 6. Rollback (pinned db/rollback files, newest first, one transaction per file, against $DB_EXPECT only)"
  MIGRATING=1
  for ((v = 10#$L_LATEST; v >= 78; v--)); do
    over_time && stop "time limit ($MAX_SECONDS s) reached before reverting $(printf '%04d' "$v")"
    ver=$(printf '%04d' "$v"); file=$(ls "$INFRA/db/rollback/${ver}_"*.down.sql)
    say "reverting $ver ($(basename "$file"))"
    timeout --foreground -k "$KILL_AFTER" "$DOWN_TMO" psql -X -q -v ON_ERROR_STOP=1 -1 -d "$DB_EXPECT" -c "set local role ogevia_owner" -f "$file" -c "reset role" -c "delete from ogevia_meta.schema_migrations where version = '$ver'" >>"$OUT/rollback.txt" 2>&1
    DRC=$?
    if [[ "$DRC" != 0 ]]; then
      say "ROLLBACK FAILED at $ver (psql exit $DRC$(tm $DRC)). That file's transaction was rolled back; $ver and everything below it are still applied; files already reverted stay reverted. Last lines: $(tail -2 "$OUT/rollback.txt" | tr '\n' ' ')"
      say "Ledger now: $(ledger_now)"
      stop "the rollback did not complete. Follow section 'Recovery' of the procedure."
    fi
  done
  LEDGER=$(RO -d "$DB_EXPECT" -c "select count(*) || '|' || coalesce(max(version), 'none') from ogevia_meta.schema_migrations") || { rc=$?; stop "the ledger cannot be re-read$(tm $rc)"; }
  say "ledger after: ${LEDGER%%|*} migrations applied, latest ${LEDGER##*|}"
  [[ "${LEDGER%%|*}" == 77 && "${LEDGER##*|}" == "$BASELINE" ]] || stop "the ledger is not 77 / $BASELINE after the rollback"
  act_unchanged && say "enforcement state unchanged: ${ACT_BEFORE%%|*} of ${ACT_BEFORE##*|} agencies activated" || stop "the enforcement activation state changed during the rollback (or could not be read)"
  MIGRATING=0
  close_window
  say ""; say "================ SUMMARY ================"
  say "Environment : TEST ($DB_EXPECT)   package commit $HEAD_SHA"
  say "RESULT: migrations 0084 to 0078 reverted; ledger 77 / $BASELINE. The API and web must be rolled back too (procedure, Recovery)."
  [[ -f "$OPEN" ]] && say "SECURITY GROUP: NOT RESTORED, see the instructions above" || say "SECURITY GROUP: restored and verified identical to the original"
  exit "$RC"
fi

say ""; say "== 6. Migrations (the pinned runner, one transaction per file, against $DB_EXPECT only)"
over_time && stop "time limit ($MAX_SECONDS s) reached before migrating"
MIGRATING=1
( cd "$INFRA" && OGEVIA_DATABASE_URL="$DBURL" timeout --foreground -k "$KILL_AFTER" "$MIGRATE_TMO" npx tsx db/scripts/migrate.ts ) 2>&1 | tee -a "$RESULT"
MRC=${PIPESTATUS[0]}
if [[ "$MRC" != 0 ]]; then
  say "MIGRATION FAILED (runner exit $MRC$(tm $MRC)). The runner applies one file per transaction and stops at the first failure: that file was rolled back and earlier files remain applied. DO NOT continue."
  say "Ledger now: $(ledger_now)"
  stop "the migration did not complete. Follow section 'Recovery' of the procedure (stop; do not deploy the API or web)."
fi
LEDGER=$(RO -d "$DB_EXPECT" -c "select count(*) || '|' || coalesce(max(version), 'none') from ogevia_meta.schema_migrations") || { rc=$?; stop "the ledger cannot be re-read$(tm $rc)"; }
say "ledger after: ${LEDGER%%|*} migrations applied, latest ${LEDGER##*|}"
[[ "${LEDGER%%|*}" == 84 && "${LEDGER##*|}" == "$LAST_NEW" ]] || stop "the ledger is not 84 / $LAST_NEW after the runner reported success"

say ""; say "== 7. Verification set (read-only transactions; the runner's own db:verify)"
( cd "$INFRA" && OGEVIA_DATABASE_URL="$DBURL" timeout --foreground -k "$KILL_AFTER" "$VERIFY_TMO" npx tsx db/scripts/verify.ts ) > "$OUT/verify.txt" 2>&1
VRC=$?
P=$(grep -c '^PASS' "$OUT/verify.txt"); F=$(grep -c '^FAIL' "$OUT/verify.txt")
say "verification: $P PASS, $F FAIL (exit $VRC$(tm $VRC)); full output: $OUT/verify.txt"
grep -q "^PASS 01_schema_version.sql latest_migration_is_$LAST_NEW" "$OUT/verify.txt" || stop "the verification set does not report the schema at $LAST_NEW (latest_migration_is_$LAST_NEW). The migrations ARE applied; do not deploy; see the procedure."
[[ "$VRC" == 0 && "$F" == 0 && "$P" -gt 0 ]] || stop "the verification set did not pass. The migrations ARE applied; do not deploy the API or web; see the procedure."
act_unchanged && say "enforcement state unchanged: ${ACT_BEFORE%%|*} of ${ACT_BEFORE##*|} agencies activated" || stop "the enforcement activation state changed during the migration (or could not be read). The migrations ARE applied; do not deploy; see the procedure."
MIGRATING=0
close_window
say ""; say "================ SUMMARY ================"
say "Environment : TEST ($DB_EXPECT)   package commit $HEAD_SHA"
say "RESULT: migrations $FIRST_NEW to $LAST_NEW applied; ledger 84 / $LAST_NEW; verification $P PASS, 0 FAIL."
[[ -f "$OPEN" ]] && say "SECURITY GROUP: NOT RESTORED, see the instructions above" || say "SECURITY GROUP: restored and verified identical to the original"
exit "$RC"
