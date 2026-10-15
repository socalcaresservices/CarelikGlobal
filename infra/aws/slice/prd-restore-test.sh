#!/usr/bin/env bash
# =============================================================================
# Ogevia PRODUCTION restore test for ogevia_prd  (Phase 7 gate A3 / check E3).
# STATUS: PREPARED FOR REVIEW. NOT RUN. YELLOW action (CLAUDE.md s.13): it
# creates, then deletes, one temporary RDS instance. Run it only after the owner
# approves, from AWS CloudShell (us-west-2, AdministratorAccess).
#
#   OGEVIA_RESTORE_TEST_APPROVAL=<approval reference> bash prd-restore-test.sh
#   bash prd-restore-test.sh resume        # after an interruption; never creates a 2nd copy
#
# What it does (read-only against production; the production instance is never modified):
#   1. checks identity, the approval reference, and the source instance
#      (available, private, encrypted, deletion protection on, backups >= 7 days);
#   2. through the admin host (app security group attached only while needed,
#      always restored): confirms ogevia_prd exists on the source, its migration
#      ledger is contiguous from 0001 and has at least 38 migrations, and the last
#      migration is old enough to be inside the restore window;
#   3. restores the latest restorable time of ogevia-prod-postgres to a NEW
#      instance ogevia-restore-drill-<UTC minute>: db.t4g.micro, single-AZ, private,
#      same subnet group, same security groups, same KMS key, tagged
#      purpose=restore-drill;
#   4. waits for it (survives expired CloudShell credentials: it pauses and
#      `resume` continues; the time to restore is recorded);
#   5. read-only comparison of the restored ogevia_prd with the source: migration
#      ledger (versions + checksums), table/function counts, row counts up to the
#      restore point, the production access model, and a login as ogevia_prd_app;
#   6. if EVERY check passed, deletes ONLY the temporary instance (no final
#      snapshot, no retained backups) and verifies the cleanup; if any check
#      failed, KEEPS the instance for diagnosis and prints the delete command;
#   7. writes a record to ~/ogevia-phase7/prd-restore-test-<UTC>.txt.
# It never prints a password or a row of client data (counts only).
# =============================================================================
set -uo pipefail
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""

MODE="${1:-run}"
[[ "$MODE" == run || "$MODE" == resume ]] || { echo "usage: bash prd-restore-test.sh [run|resume]"; exit 2; }

ACCOUNT=300094796789
SRC_ID=ogevia-prod-postgres
DB_NAME=ogevia_prd
APP_LOGIN=ogevia_prd_app
APP_SECRET_NAME=ogevia/prd/database/app
APP_SG=sg-064ffce3bcbe8eb3b
ADMIN_TAG=ogevia-db-admin-temp
ADMIN_BASE_SGS=sg-00e01e2ca80442c1f          # verified by the owner on 2026-10-08
MIN_MIGRATIONS=${OGEVIA_EXPECT_MIN_MIGRATIONS:-38}
MIN_LEDGER_AGE_S=900                          # last migration must predate the restore point
P_DRILL=15433; P_SRC=15434
WAIT_MAX_S=$((90 * 60)); POLL_S=${OGEVIA_POLL_SECONDS:-30}
OUT="$HOME/ogevia-phase7"; mkdir -p "$OUT"
STATE="$OUT/prd-restore-state.env"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOG="$OUT/prd-restore-test-$STAMP.log"; REPORT="$OUT/prd-restore-test-$STAMP.txt"
exec 3>&1
exec > >(tee -a "$LOG") 2>&1
trap '' PIPE

STEP=start; IID=""; BASE_SGS=""; T1=""; T2=""; DRILL_ID=""; T0=""; T0_ISO=""
RESULTS=(); FAILS=0; DRILL_DELETED=""; STOPPED=""; DONE=""

say() { { printf '%s\n' "$*" >&3; } 2>/dev/null; printf '%s\n' "$*" >> "$LOG"; }
step() { STEP="$1"; echo; echo "== $1"; }
chk() { RESULTS+=("$1|$2|$3"); echo "$1  $2: $3"; [[ "$1" == FAIL ]] && FAILS=$((FAILS + 1)); return 0; }

close_tunnels() {
  [[ -n "${T1:-}" ]] && kill "$T1" 2>/dev/null; [[ -n "${T2:-}" ]] && kill "$T2" 2>/dev/null; T1=""; T2=""
  [[ -n "$IID" ]] && pkill -f "session-manager-plugin.*$IID" 2>/dev/null
  unset PGPASSWORD
}
restore_sgs() {
  [[ -n "$IID" && -n "$BASE_SGS" ]] || return 0
  local now
  now=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text 2>/dev/null | tr -s ' \t' '\n' | sort | xargs)
  [[ "$now" == "$BASE_SGS" ]] && return 0
  # shellcheck disable=SC2086
  if aws ec2 modify-instance-attribute --instance-id "$IID" --groups $BASE_SGS; then
    say "Admin host security groups restored: $BASE_SGS"
  else
    say "WARNING: could not restore the admin host's security groups; set them to: $BASE_SGS (EC2 console)"
  fi
}
on_exit() {
  local rc=$?
  close_tunnels; restore_sgs
  [[ -z "$DONE" && -z "$STOPPED" ]] && say "EXITED UNEXPECTEDLY in \"$STEP\" (exit $rc). If a temporary copy exists, run: bash prd-restore-test.sh resume. Log: $LOG"
}
trap on_exit EXIT

keep_note() {
  [[ -n "$DRILL_ID" && -z "$DRILL_DELETED" ]] || return 0
  say "The temporary copy $DRILL_ID was NOT deleted (about 2 cents an hour while it exists)."
  say "To retry the checks and cleanup: bash prd-restore-test.sh resume"
  say "To delete it by hand (only after you have seen the failure): aws rds delete-db-instance --region us-west-2 --db-instance-identifier $DRILL_ID --skip-final-snapshot --delete-automated-backups"
}
stop() { STOPPED=1; say "STOP in \"$STEP\": $*"; keep_note; say "Log: $LOG"; exit 1; }
pause() { STOPPED=1; say "PAUSED in \"$STEP\": $*"; keep_note; say "Log: $LOG"; exit 3; }

save_state() {
  { printf 'DRILL_ID=%s\nT0=%s\nT0_ISO=%s\nBASE_SGS=%s\n' "$DRILL_ID" "$T0" "$T0_ISO" "$BASE_SGS"; } > "$STATE"
}
state_get() { sed -n "s/^$1=//p" "$STATE" | head -1; }

creds_ok() { [[ "$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" == "$ACCOUNT" ]]; }

# ---------------------------------------------------------------- step 1 ----
step "1 Identity, approval and plan"
ARN=$(aws sts get-caller-identity --query Arn --output text 2>/dev/null) || stop "AWS credentials are not valid: sign in again and reopen CloudShell (us-west-2)"
creds_ok && [[ "$ARN" == *AdministratorAccess* ]] || stop "needs account $ACCOUNT with AdministratorAccess (current: $ARN)"
if [[ "$MODE" == run ]]; then
  [[ "${OGEVIA_RESTORE_TEST_APPROVAL:-}" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || stop "set OGEVIA_RESTORE_TEST_APPROVAL to the owner's approval reference (6-64 letters, digits, . _ -)"
  [[ ! -s "$STATE" ]] || stop "an earlier run left $STATE (a temporary copy may exist). Run: bash prd-restore-test.sh resume"
  EXISTING=$(aws rds describe-db-instances --query "DBInstances[?starts_with(DBInstanceIdentifier,'ogevia-restore-drill-')].DBInstanceIdentifier" --output text) || stop "cannot list RDS instances"
  [[ -z "$EXISTING" ]] || stop "restore-drill instance(s) already exist: $EXISTING (not touched). Delete them or use resume"
  cat <<PLAN

This test does exactly this (approval reference: $OGEVIA_RESTORE_TEST_APPROVAL):
  1. Read-only checks of $SRC_ID, then of $DB_NAME on it (through the admin host).
  2. CREATE one temporary instance ogevia-restore-drill-<UTC minute> from $SRC_ID's
     latest restorable time: db.t4g.micro, single-AZ, private, same subnet group,
     security groups and KMS key. About 15-40 minutes.
  3. TEMPORARILY ADD security group $APP_SG to the admin host $ADMIN_TAG
     (twice, only while a check runs); its original group $ADMIN_BASE_SGS is restored each time.
  4. Read-only comparison of the restored $DB_NAME with $SRC_ID; a login as $APP_LOGIN.
  5. If everything passed, DELETE only the temporary instance. If anything failed,
     KEEP it and tell you how to delete it.
Cost: about 10 cents for roughly an hour (INFERRED). $SRC_ID itself is never modified.
PLAN
  [[ -t 0 ]] || stop "run this from an interactive terminal (CloudShell)"
  read -r -p "Type RESTORE to run the production restore test (anything else stops): " ans
  [[ "$ans" == RESTORE ]] || { STOPPED=1; say "Not confirmed. Nothing was changed."; exit 0; }
else
  [[ -s "$STATE" ]] || stop "no $STATE: nothing to resume"
  DRILL_ID=$(state_get DRILL_ID); T0=$(state_get T0); T0_ISO=$(state_get T0_ISO); BASE_SGS=$(state_get BASE_SGS)
  [[ "$DRILL_ID" =~ ^ogevia-restore-drill-[0-9]{12}$ && "$DRILL_ID" != "$SRC_ID" && "$T0" =~ ^[0-9]+$ && -n "$BASE_SGS" ]] || stop "the saved state is not valid: $STATE"
  echo "Resuming with $DRILL_ID (restore requested $T0_ISO)"
fi

# ---------------------------------------------------------------- step 2 ----
step "2 Source instance (read-only)"
S=$(aws rds describe-db-instances --db-instance-identifier "$SRC_ID" --query 'DBInstances[0]' --output json) || stop "cannot read $SRC_ID"
read -r SRC_STATUS SRC_RET SRC_ENC SRC_PUB SRC_DP <<<"$(jq -r '[.DBInstanceStatus, .BackupRetentionPeriod, .StorageEncrypted, .PubliclyAccessible, .DeletionProtection] | @tsv' <<<"$S")"
SRC_KMS=$(jq -r .KmsKeyId <<<"$S"); SRC_RES=$(jq -r .DbiResourceId <<<"$S"); SRC_LRT=$(jq -r '.LatestRestorableTime // empty' <<<"$S")
SECRET_ARN=$(jq -r '.MasterUserSecret.SecretArn // empty' <<<"$S")
[[ "$SRC_STATUS" == available && "$SRC_ENC" == true && "$SRC_PUB" == false && "$SRC_DP" == true && "$SRC_RET" -ge 7 && -n "$SRC_LRT" && -n "$SECRET_ARN" ]] \
  || stop "source is not in the required state (status=$SRC_STATUS encrypted=$SRC_ENC public=$SRC_PUB deletion-protection=$SRC_DP backups=${SRC_RET}d latest-restorable=${SRC_LRT:-none} master-secret=${SECRET_ARN:+yes})"
chk PASS "source instance" "$SRC_ID available, encrypted, private, deletion protection on, backups ${SRC_RET} days, latest restorable $SRC_LRT"

step "3 Tools and the admin host"
for t in jq psql session-manager-plugin; do
  command -v "$t" >/dev/null && continue
  case "$t" in
    psql) sudo dnf install -y -q postgresql15 >/dev/null || stop "could not install psql" ;;
    session-manager-plugin) sudo dnf install -y -q https://s3.amazonaws.com/session-manager-downloads/plugin/latest/linux_64bit/session-manager-plugin.rpm >/dev/null || stop "could not install session-manager-plugin" ;;
    jq) stop "jq is missing" ;;
  esac
done
IID=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$ADMIN_TAG" Name=instance-state-name,Values=running \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
[[ "$IID" == i-* ]] || { IID=""; stop "admin host $ADMIN_TAG is not running: start it in the EC2 console, then run again"; }
NOW_SGS=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)
CUR_BASE=$(tr -s ' \t' '\n' <<<"$NOW_SGS" | grep -v "^$APP_SG$" | sort | xargs)
[[ "$CUR_BASE" == "$ADMIN_BASE_SGS" ]] || stop "admin host groups ($CUR_BASE) are not the verified original ($ADMIN_BASE_SGS); nothing was changed"
[[ -z "$BASE_SGS" || "$BASE_SGS" == "$CUR_BASE" ]] || stop "admin host groups differ from the saved original; nothing was changed"
BASE_SGS="$CUR_BASE"
echo "Admin host $IID original groups: $BASE_SGS"

attach_sg() {
  local now; now=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)
  # shellcheck disable=SC2086
  grep -qw "$APP_SG" <<<"$now" || aws ec2 modify-instance-attribute --instance-id "$IID" --groups $BASE_SGS "$APP_SG" \
    || stop "could not attach $APP_SG to the admin host"
}
tunnel() { # tunnel <host> <local port>
  aws ssm start-session --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters "host=$1,portNumber=5432,localPortNumber=$2" >/dev/null &
  echo $!
}
wait_port() { # wait_port <port>
  local _
  for _ in $(seq 1 30); do (echo > "/dev/tcp/127.0.0.1/$1") 2>/dev/null && return 0; sleep 2; done
  return 1
}
master_login() {
  local sec
  sec=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query SecretString --output text) || stop "cannot read the master secret"
  export PGHOST=127.0.0.1 PGSSLMODE=require PGCONNECT_TIMEOUT=15 PGOPTIONS='-c default_transaction_read_only=on'
  export PGUSER; PGUSER=$(jq -r .username <<<"$sec")
  export PGPASSWORD; PGPASSWORD=$(jq -r .password <<<"$sec")
}
q() { PGPORT="$1" PGDATABASE="$2" psql -X -At -q -v ON_ERROR_STOP=1 -c "$3" 2>&1 | tail -n 1; } # q <port> <db> <sql>

LEDGER_OK_SQL="select coalesce(string_agg(version, ',' order by version), '') from ogevia_meta.schema_migrations"
ledger_contiguous() { # ledger_contiguous <comma list>; prints the count when OK
  local n; n=$(tr ',' '\n' <<<"$1" | grep -c .)
  [[ "$n" -ge "$MIN_MIGRATIONS" && "$1" == "$(seq -f '%04g' 1 "$n" | paste -sd,)" ]] && echo "$n"
}

step "4 Production database on the source (read-only, through the admin host)"
if [[ "$MODE" == run ]]; then
  attach_sg
  T2=$(tunnel "$(jq -r .Endpoint.Address <<<"$S")" $P_SRC)
  wait_port $P_SRC || stop "SSM tunnel to the source did not open"
  master_login
  HAS=$(q $P_SRC postgres "select count(*) from pg_database where datname = '$DB_NAME'")
  [[ "$HAS" == 1 ]] || stop "database $DB_NAME does not exist on $SRC_ID (got: $HAS). Run the production database step first"
  VERS=$(q $P_SRC "$DB_NAME" "$LEDGER_OK_SQL")
  N=$(ledger_contiguous "$VERS") || stop "the $DB_NAME ledger is not contiguous from 0001 with at least $MIN_MIGRATIONS migrations (got: $VERS)"
  AGE=$(q $P_SRC "$DB_NAME" "select floor(extract(epoch from now() - max(applied_at))) from ogevia_meta.schema_migrations")
  [[ "$AGE" =~ ^[0-9]+$ && "$AGE" -ge "$MIN_LEDGER_AGE_S" ]] || stop "the last migration is only ${AGE}s old (need $MIN_LEDGER_AGE_S s): the restore point could predate $DB_NAME. Wait and run again"
  chk PASS "source $DB_NAME" "exists, ledger 0001-$(tail -c 5 <<<"$VERS") ($N migrations), last migration ${AGE}s old"
  close_tunnels; restore_sgs

  step "5 Create the temporary copy"
  DRILL_ID="ogevia-restore-drill-$(date -u +%Y%m%d%H%M)"
  SUBNET_GROUP=$(jq -r .DBSubnetGroup.DBSubnetGroupName <<<"$S")
  SRC_SGS=$(jq -r '[.VpcSecurityGroups[].VpcSecurityGroupId] | join(" ")' <<<"$S")
  T0=$(date +%s); T0_ISO=$(date -u +%FT%TZ)
  save_state
  # shellcheck disable=SC2086
  aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier "$SRC_ID" \
    --target-db-instance-identifier "$DRILL_ID" --use-latest-restorable-time \
    --db-instance-class db.t4g.micro --db-subnet-group-name "$SUBNET_GROUP" --vpc-security-group-ids $SRC_SGS \
    --no-publicly-accessible --no-multi-az --no-deletion-protection \
    --tags Key=purpose,Value=restore-drill Key=test,Value=prd-restore Key=created-by,Value=prd-restore-test >/dev/null \
    || { rm -f "$STATE"; DRILL_ID=""; stop "the restore request failed (error above); nothing was created"; }
  echo "Requested $DRILL_ID at $T0_ISO"
fi

# ---------------------------------------------------------------- wait -------
step "6 Wait for $DRILL_ID (usually 15-40 minutes)"
BAD=0
while true; do
  ST=$(aws rds describe-db-instances --db-instance-identifier "$DRILL_ID" --query 'DBInstances[0].DBInstanceStatus' --output text 2>&1); RC=$?
  if [[ $RC -ne 0 ]]; then
    grep -q DBInstanceNotFound <<<"$ST" && { rm -f "$STATE"; DRILL_ID=""; stop "$DRILL_ID does not exist"; }
    BAD=$((BAD + 1))
    [[ $BAD -ge 3 ]] && pause "AWS stopped answering (usually expired CloudShell credentials). Reopen CloudShell, sign in, then run: bash prd-restore-test.sh resume"
  else
    BAD=0
    [[ "$ST" == available ]] && break
    case "$ST" in failed|incompatible-restore|incompatible-parameters|storage-full) stop "$DRILL_ID is in state '$ST'" ;; esac
  fi
  (( $(date +%s) - T0 > WAIT_MAX_S )) && stop "$DRILL_ID is still '$ST' after $((WAIT_MAX_S / 60)) minutes"
  sleep "$POLL_S"
done
T_AVAIL=$(date +%s)
D=$(aws rds describe-db-instances --db-instance-identifier "$DRILL_ID" --query 'DBInstances[0]' --output json) || stop "cannot read $DRILL_ID"
TAG=$(aws rds list-tags-for-resource --resource-name "$(jq -r .DBInstanceArn <<<"$D")" --query "TagList[?Key=='purpose'].Value | [0]" --output text)
[[ "$TAG" == restore-drill && "$(jq -r .DbiResourceId <<<"$D")" != "$SRC_RES" ]] || stop "refusing to continue: $DRILL_ID is not a tagged copy distinct from the source"
ENC_OK=$([[ "$(jq -r .StorageEncrypted <<<"$D")" == true && "$(jq -r .KmsKeyId <<<"$D")" == "$SRC_KMS" ]] && echo yes || echo no)
PUB=$(jq -r .PubliclyAccessible <<<"$D")
OBS_S=$((T_AVAIL - T0))
EV=$(aws rds describe-events --source-type db-instance --source-identifier "$DRILL_ID" --duration 1440 --query 'Events[].[Date,Message]' --output json 2>/dev/null || echo '[]')
RESTORED_EV=$(jq -r '[.[] | select(.[1] | test("Restored from"))][0] // empty | @tsv' <<<"$EV")
RESTORE_POINT=$(cut -f2- <<<"$RESTORED_EV" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}' | tail -1)
DONE_AT=$(cut -f1 <<<"$RESTORED_EV")
CREATED=$(jq -r '.InstanceCreateTime // empty' <<<"$D")
EV_S=""
if [[ -n "$CREATED" && -n "$DONE_AT" ]]; then
  EV_S=$(( $(date -d "$DONE_AT" +%s) - $(date -d "$CREATED" +%s) )); (( EV_S > 0 )) || EV_S=""
fi
if [[ -n "$EV_S" ]]; then TIME_TXT="$((EV_S / 60)) min $((EV_S % 60)) s (RDS events; observed by this script: $((OBS_S / 60)) min $((OBS_S % 60)) s)"
else TIME_TXT="at most $((OBS_S / 60)) min $((OBS_S % 60)) s (observed by this script, polling every ${POLL_S}s$([[ "$MODE" == resume ]] && echo '; includes the pause before resume'))"; fi
echo "Restore point (from the RDS event): ${RESTORE_POINT:-unreadable}"
[[ "$ENC_OK" == yes && "$PUB" == false ]] && chk PASS "temporary copy" "$DRILL_ID available, private, encrypted with the source KMS key" \
  || chk FAIL "temporary copy" "$DRILL_ID encrypted-with-source-key=$ENC_OK public=$PUB"
chk PASS "time to restore" "$TIME_TXT"
[[ -n "$RESTORE_POINT" ]] && chk PASS "restore point" "$RESTORE_POINT UTC" || chk FAIL "restore point" "could not be read from the RDS events"

# ---------------------------------------------------------------- compare ----
step "7 Compare the restored $DB_NAME with the source (read-only)"
if [[ -n "$RESTORE_POINT" ]]; then
  attach_sg
  T1=$(tunnel "$(jq -r .Endpoint.Address <<<"$D")" $P_DRILL)
  T2=$(tunnel "$(jq -r .Endpoint.Address <<<"$S")" $P_SRC)
  wait_port $P_DRILL && wait_port $P_SRC || stop "an SSM tunnel did not open"
  master_login
  TP="${RESTORE_POINT/ /T}+00"
  LEDGER_SQL="select coalesce(string_agg(version || ':' || left(checksum, 12), ',' order by version), '') from ogevia_meta.schema_migrations where applied_at <= '$TP'"
  COUNTS_SQL="select 'tables=' || (select count(*) from information_schema.tables where table_schema in ('ogevia','ogevia_meta','ogevia_api'))
    || ' routines=' || (select count(*) from information_schema.routines where routine_schema in ('ogevia','ogevia_meta','ogevia_api'))
    || ' organizations=' || (select count(*) from ogevia.organizations where created_at <= '$TP')
    || ' clients=' || (select count(*) from ogevia.clients where created_at <= '$TP')
    || ' visits=' || (select count(*) from ogevia.service_visits where created_at <= '$TP')
    || ' corrections=' || (select count(*) from ogevia.visit_corrections where created_at <= '$TP')
    || ' audit_events=' || (select count(*) from ogevia.audit_events where occurred_at <= '$TP')"
  ACCESS_SQL="select case
    when has_database_privilege('public', '$DB_NAME', 'CONNECT') then 'PUBLIC can connect'
    when not exists (select 1 from pg_roles where rolname = '$APP_LOGIN') then '$APP_LOGIN missing'
    when not has_database_privilege('$APP_LOGIN', '$DB_NAME', 'CONNECT') then '$APP_LOGIN cannot connect'
    when exists (select 1 from pg_roles where rolname = '$APP_LOGIN' and (rolsuper or rolcreaterole or rolcreatedb or rolbypassrls or rolinherit)) then '$APP_LOGIN over-privileged'
    when to_regclass('ogevia_meta.schema_migrations') is null then 'ledger missing'
    else 'ok' end"
  RD=$(q $P_DRILL postgres "select count(*) from pg_database where datname = '$DB_NAME'")
  if [[ "$RD" != 1 ]]; then
    chk FAIL "restored database" "$DB_NAME is NOT present on the restored copy (got: $RD)"
  else
    chk PASS "restored database" "$DB_NAME is present on the restored copy"
    L_D=$(q $P_DRILL "$DB_NAME" "$LEDGER_SQL"); L_S=$(q $P_SRC "$DB_NAME" "$LEDGER_SQL")
    NV=$(ledger_contiguous "$(tr ',' '\n' <<<"$L_S" | cut -d: -f1 | paste -sd,)") || NV=""
    if [[ -n "$NV" && "$L_D" == "$L_S" ]]; then chk PASS "migration ledger" "$NV migrations (versions and checksums) identical to the source, contiguous from 0001"
    else chk FAIL "migration ledger" "restored and source differ, or the source ledger is not contiguous with >= $MIN_MIGRATIONS (restored ${#L_D} chars, source ${#L_S} chars)"; fi
    C_D=$(q $P_DRILL "$DB_NAME" "$COUNTS_SQL"); C_S=$(q $P_SRC "$DB_NAME" "$COUNTS_SQL")
    if [[ "$C_D" == tables=* && "$C_D" == "$C_S" ]]; then chk PASS "counts to the restore point" "identical: $C_D"
    else chk FAIL "counts to the restore point" "restored: $C_D | source: $C_S"; fi
    A_D=$(q $P_DRILL "$DB_NAME" "$ACCESS_SQL"); A_S=$(q $P_SRC "$DB_NAME" "$ACCESS_SQL")
    [[ "$A_D" == ok && "$A_S" == ok ]] && chk PASS "production access model" "restored and source both ok (PUBLIC cannot connect; $APP_LOGIN unprivileged)" \
      || chk FAIL "production access model" "restored: $A_D | source: $A_S"
  fi
  unset PGPASSWORD PGOPTIONS
  APP_JSON=$(aws secretsmanager get-secret-value --secret-id "$APP_SECRET_NAME" --query SecretString --output text 2>/dev/null)
  if [[ -n "$APP_JSON" && "$(jq -r .username <<<"$APP_JSON")" == "$APP_LOGIN" && "$(jq -r .dbname <<<"$APP_JSON")" == "$DB_NAME" ]]; then
    WHO=$(PGPASSWORD="$(jq -r .password <<<"$APP_JSON")" PGHOST=127.0.0.1 PGPORT=$P_DRILL PGSSLMODE=require PGCONNECT_TIMEOUT=15 \
      psql -X -At -w -U "$APP_LOGIN" -d "$DB_NAME" -c 'select current_database()' 2>&1 | tail -n 1)
    [[ "$WHO" == "$DB_NAME" ]] && chk PASS "application login" "$APP_LOGIN connects to the restored $DB_NAME with the production secret" \
      || chk FAIL "application login" "$APP_LOGIN could not connect to the restored copy ($(head -c 120 <<<"$WHO"))"
  else
    chk FAIL "application login" "the production secret $APP_SECRET_NAME is unreadable or does not name $APP_LOGIN / $DB_NAME"
  fi
  unset APP_JSON WHO
  close_tunnels; restore_sgs
else
  chk FAIL "comparison" "skipped: no restore point"
fi

# ---------------------------------------------------------------- cleanup ----
CLEAN="not done"
if (( FAILS == 0 )); then
  step "8 Delete ONLY $DRILL_ID"
  [[ "$DRILL_ID" =~ ^ogevia-restore-drill-[0-9]{12}$ && "$DRILL_ID" != "$SRC_ID" ]] || stop "refusing to delete unexpected identifier $DRILL_ID"
  TAG=$(aws rds list-tags-for-resource --resource-name "$(jq -r .DBInstanceArn <<<"$D")" --query "TagList[?Key=='purpose'].Value | [0]" --output text)
  [[ "$TAG" == restore-drill ]] || stop "refusing to delete $DRILL_ID: it is not tagged purpose=restore-drill"
  aws rds delete-db-instance --db-instance-identifier "$DRILL_ID" --skip-final-snapshot --delete-automated-backups >/dev/null || stop "delete request failed (error above)"
  echo "Waiting for deletion (usually 5-10 minutes)..."
  for _ in $(seq 1 $((3600 / POLL_S))); do
    G=$(aws rds describe-db-instances --db-instance-identifier "$DRILL_ID" 2>&1) || { grep -q DBInstanceNotFound <<<"$G" && break; }
    sleep "$POLL_S"
  done
  DRILL_DELETED=1
  step "9 Verify the cleanup"
  G=$(aws rds describe-db-instances --db-instance-identifier "$DRILL_ID" 2>&1) && CL1="FAIL: $DRILL_ID still exists" || { grep -q DBInstanceNotFound <<<"$G" && CL1=ok || CL1="FAIL: could not confirm deletion"; }
  AB=$(aws rds describe-db-instance-automated-backups --db-instance-identifier "$DRILL_ID" --query 'length(DBInstanceAutomatedBackups)' --output text 2>&1)
  [[ "$AB" == 0 || "$AB" == *NotFound* ]] && CL2=ok || CL2="FAIL: retained automated backups ($AB)"
  NOW=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text | tr -s ' \t' '\n' | sort | xargs)
  [[ "$NOW" == "$BASE_SGS" ]] && CL3=ok || CL3="FAIL: admin host groups are $NOW"
  S2=$(aws rds describe-db-instances --db-instance-identifier "$SRC_ID" --query 'DBInstances[0]' --output json | jq -r '"\(.DBInstanceStatus) \(.DeletionProtection) \(.DbiResourceId)"')
  [[ "$S2" == "available true $SRC_RES" ]] && CL4=ok || CL4="FAIL: $SRC_ID is now: $S2"
  LEFT=$(aws rds describe-db-instances --query "DBInstances[?starts_with(DBInstanceIdentifier,'ogevia-restore-drill-')].DBInstanceIdentifier" --output text)
  [[ -z "$LEFT" ]] && CL5=ok || CL5="FAIL: restore-drill instance(s) exist: $LEFT"
  for c in "$CL1" "$CL2" "$CL3" "$CL4" "$CL5"; do
    [[ "$c" == ok ]] && continue
    chk FAIL "cleanup" "$c"
  done
  (( FAILS == 0 )) && { CLEAN="complete"; chk PASS "cleanup" "temporary copy gone, no retained backups, admin host groups original, $SRC_ID untouched"; rm -f "$STATE"; } || CLEAN="INCOMPLETE"
else
  say "At least one check failed. The temporary copy is KEPT for diagnosis."
fi

# ---------------------------------------------------------------- record -----
{
  echo "Ogevia ogevia_prd restore test, $STAMP"
  echo "source: $SRC_ID (database $DB_NAME); temporary copy: $DRILL_ID; mode: $MODE"
  echo "approval reference: ${OGEVIA_RESTORE_TEST_APPROVAL:-"(resumed run)"}"
  for r in "${RESULTS[@]}"; do IFS='|' read -r a b c <<<"$r"; echo "$a  $b: $c"; done
  echo "cleanup: $CLEAN"
  if (( FAILS == 0 )); then echo "RESULT: PASS - gate A3 satisfied for restore point ${RESTORE_POINT:-unknown} UTC"
  else echo "RESULT: FAIL ($FAILS failed check(s)) - gate A3 NOT satisfied"; fi
} > "$REPORT"
DONE=1
echo; echo "================ ogevia_prd restore test result ================"
cat "$REPORT"
echo "Log: $LOG"
(( FAILS == 0 )) || { keep_note; exit 1; }
