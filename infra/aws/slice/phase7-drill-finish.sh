#!/usr/bin/env bash
# =============================================================================
# Finish an interrupted Phase 7 restore drill. Creates NOTHING.
#   1. checks the drill instance is exactly the expected throwaway copy
#      (name pattern, tag purpose=restore-drill, available, private, encrypted
#      with the source key) and that it is not the production instance;
#   2. reads the restore point and timings from RDS events;
#   3. through the admin host (app security group attached only for the check,
#      always restored), compares the restored database with the source.
#      The BASELINE is the source's own migration ledger (never a hardcoded
#      version): versions must be contiguous from 0001 and known to the pilot
#      build, and version+checksum must be identical on both sides; row counts
#      for rows created at or before the restore point must match. Read-only.
#      Also records read-only diagnostics about which pilot migrations the
#      source is missing and why (databases, ledgers, objects, Lambda target,
#      pilot logs). It never applies a migration;
#   4. STOPS if any check fails: the drill instance is then kept for diagnosis
#      (about 2 cents an hour) and the exact delete command is printed;
#   5. otherwise deletes ONLY the drill instance (no final snapshot, no retained
#      backups) and verifies: instance gone, no retained automated backups,
#      admin host groups restored, production instance untouched.
# Log: ~/ogevia-phase7/drill-finish-<UTC>.log  Record: ~/ogevia-phase7/restore-drill-<UTC>.txt
# =============================================================================
set -uo pipefail
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""
DRILL_ID="${1:-ogevia-restore-drill-202610032255}"
ACCOUNT=300094796789
SRC_ID=ogevia-prod-postgres
APP_SG=sg-064ffce3bcbe8eb3b
ADMIN_TAG=ogevia-db-admin-temp
P_DRILL=15433; P_SRC=15434
OUT="$HOME/ogevia-phase7"; mkdir -p "$OUT"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOG="$OUT/drill-finish-$STAMP.log"; REPORT="$OUT/restore-drill-$STAMP.txt"
exec 3>&1
exec > >(tee -a "$LOG") 2>&1
trap '' PIPE
STEP=start; IID=""; BASE_SGS=""; T1=""; T2=""
say() { { printf '%s\n' "$*" >&3; } 2>/dev/null; printf '%s\n' "$*" >> "$LOG"; }
step() { STEP="$1"; echo; echo "== $1"; }
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
  [[ -z "${DONE:-}" && -z "${STOPPED:-}" ]] && say "EXITED UNEXPECTEDLY in \"$STEP\" (exit $rc). Paste the same block again; it resumes safely. Log: $LOG"
}
trap on_exit EXIT
stop() {
  STOPPED=1
  say "STOP in \"$STEP\": $*"
  say "The drill instance $DRILL_ID was NOT deleted (kept for diagnosis, about 2 cents an hour)."
  say "Delete it later with: aws rds delete-db-instance --region us-west-2 --db-instance-identifier $DRILL_ID --skip-final-snapshot --delete-automated-backups"
  say "Log: $LOG"
  exit 1
}

step "1 Identity and the drill instance"
ARN=$(aws sts get-caller-identity --query Arn --output text 2>/dev/null) || stop "AWS credentials are not valid: sign in again and reopen CloudShell (us-west-2)"
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT" && "$ARN" == *AdministratorAccess* ]] || stop "needs account $ACCOUNT with AdministratorAccess (current: $ARN)"
[[ "$DRILL_ID" =~ ^ogevia-restore-drill-[0-9]{12}$ && "$DRILL_ID" != "$SRC_ID" ]] || stop "refusing: $DRILL_ID is not a restore-drill identifier"
D=$(aws rds describe-db-instances --db-instance-identifier "$DRILL_ID" --query 'DBInstances[0]' --output json 2>&1) || {
  if grep -q DBInstanceNotFound <<<"$D"; then STOPPED=1; say "$DRILL_ID no longer exists: nothing to finish or delete."; exit 0; fi
  stop "cannot read $DRILL_ID: $D"; }
S=$(aws rds describe-db-instances --db-instance-identifier "$SRC_ID" --query 'DBInstances[0]' --output json) || stop "cannot read $SRC_ID"
TAG=$(aws rds list-tags-for-resource --resource-name "$(jq -r .DBInstanceArn <<<"$D")" --query "TagList[?Key=='purpose'].Value | [0]" --output text)
STATUS=$(jq -r .DBInstanceStatus <<<"$D")
[[ "$TAG" == restore-drill ]] || stop "refusing: $DRILL_ID is not tagged purpose=restore-drill (tag: $TAG)"
[[ "$(jq -r .DbiResourceId <<<"$D")" != "$(jq -r .DbiResourceId <<<"$S")" ]] || stop "refusing: $DRILL_ID resolves to the production instance"
[[ "$STATUS" == available ]] || stop "$DRILL_ID is $STATUS, not available; wait and paste again"
ENC=$([[ "$(jq -r .StorageEncrypted <<<"$D")" == true && "$(jq -r .KmsKeyId <<<"$D")" == "$(jq -r .KmsKeyId <<<"$S")" ]] && echo yes || echo NO)
PUB=$(jq -r .PubliclyAccessible <<<"$D")
[[ "$ENC" == yes && "$PUB" == false ]] || stop "$DRILL_ID encrypted-with-source-key=$ENC, public=$PUB"
SRC_DP_BEFORE=$(jq -r .DeletionProtection <<<"$S")
echo "$DRILL_ID: available, tag restore-drill, encrypted with the source key, not public. Source $SRC_ID: $(jq -r .DBInstanceStatus <<<"$S"), deletion protection $SRC_DP_BEFORE"

step "2 Restore point and timings (RDS events)"
EV=$(aws rds describe-events --source-type db-instance --source-identifier "$DRILL_ID" --duration 1440 \
  --query 'Events[].[Date,Message]' --output json) || stop "cannot read RDS events for $DRILL_ID"
RESTORED_EV=$(jq -r '[.[] | select(.[1] | test("Restored from"))][0] // empty | @tsv' <<<"$EV")
# The restore point is read from the event MESSAGE only, never from the event date.
RESTORE_POINT=$(cut -f2- <<<"$RESTORED_EV" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}' | tail -1)
DONE_AT=$(cut -f1 <<<"$RESTORED_EV")
echo "Restore point (from the event message): ${RESTORE_POINT:-unknown}"
[[ -n "$RESTORE_POINT" ]] || stop "the restore point could not be read from the RDS events; send this to Claude"
# Start = the drill instance's creation time (the restore request); end = the
# "Restored from" event. The first EVENT is often that same event, so it can
# not be the start (that produced a false 0 s). If the two do not bracket a
# positive interval, the duration is reported as unknown, never as 0.
CREATED=$(jq -r '.InstanceCreateTime // empty' <<<"$D")
DUR="unknown"
if [[ -n "$CREATED" && -n "$DONE_AT" ]]; then
  s=$(( $(date -d "$DONE_AT" +%s) - $(date -d "$CREATED" +%s) ))
  if (( s > 0 )); then DUR="$((s / 60)) min $((s % 60)) s"; else DUR="unknown (creation $CREATED is not before restore event $DONE_AT)"; fi
fi
echo "Instance created (restore requested): ${CREATED:-unknown} | restore completed event: ${DONE_AT:-unknown}"
echo "Time to restore: $DUR"

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
[[ "$IID" == i-* ]] || { IID=""; stop "admin host $ADMIN_TAG is not running: start it in the EC2 console, then paste again"; }
NOW_SGS=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)
BASE_SGS=$(tr -s ' \t' '\n' <<<"$NOW_SGS" | grep -v "^$APP_SG$" | sort | xargs)
[[ -n "$BASE_SGS" ]] || stop "the admin host's own security group could not be determined (current: $NOW_SGS)"
REF="$HOME/ogevia-pilot-run/rollback/admin-host-sgs.txt"
if [[ -s "$REF" ]]; then
  WANT=$(tr -s ' \t' '\n' < "$REF" | grep -v "^$APP_SG$" | sort | xargs)
  [[ "$WANT" == "$BASE_SGS" ]] || stop "admin host groups ($BASE_SGS) differ from the recorded original ($WANT); send this to Claude"
fi
echo "Admin host $IID original groups: $BASE_SGS$(grep -qw "$APP_SG" <<<"$NOW_SGS" && echo " (app group currently attached: it will be removed at the end)")"
# shellcheck disable=SC2086
grep -qw "$APP_SG" <<<"$NOW_SGS" || aws ec2 modify-instance-attribute --instance-id "$IID" --groups $BASE_SGS "$APP_SG" \
  || stop "could not attach $APP_SG to the admin host"

step "4 Read-only data verification (restored copy vs source)"
tunnel() {
  aws ssm start-session --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters "host=$1,portNumber=5432,localPortNumber=$2" >/dev/null &
  echo $!
}
T1=$(tunnel "$(jq -r .Endpoint.Address <<<"$D")" $P_DRILL)
T2=$(tunnel "$(jq -r .Endpoint.Address <<<"$S")" $P_SRC)
for p in $P_DRILL $P_SRC; do
  for _ in $(seq 1 30); do (echo > "/dev/tcp/127.0.0.1/$p") 2>/dev/null && break; sleep 2; done
  (echo > "/dev/tcp/127.0.0.1/$p") 2>/dev/null || stop "SSM tunnel on port $p did not open"
done
SECRET_ARN=$(jq -r '.MasterUserSecret.SecretArn // empty' <<<"$S")
[[ -n "$SECRET_ARN" ]] || stop "the source has no RDS-managed master secret"
SEC=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query SecretString --output text) || stop "cannot read the master secret"
export PGHOST=127.0.0.1 PGSSLMODE=require PGCONNECT_TIMEOUT=15 PGDATABASE=ogevia_sv_test
export PGUSER; PGUSER=$(jq -r .username <<<"$SEC")
export PGPASSWORD; PGPASSWORD=$(jq -r .password <<<"$SEC")
unset SEC
TP="${RESTORE_POINT/ /T}+00"
QUERY="set default_transaction_read_only = on;
select 'ledger=' || (select string_agg(version || ':' || left(checksum, 12), ',' order by version) from ogevia_meta.schema_migrations)
 || ' organizations=' || (select count(*) from ogevia.organizations where created_at <= '$TP')
 || ' clients=' || (select count(*) from ogevia.clients where created_at <= '$TP')
 || ' visits=' || (select count(*) from ogevia.service_visits where created_at <= '$TP')
 || ' corrections=' || (select count(*) from ogevia.visit_corrections where created_at <= '$TP')
 || ' audit_events=' || (select count(*) from ogevia.audit_events where occurred_at <= '$TP');"
R_DRILL=$(PGPORT=$P_DRILL psql -X -At -v ON_ERROR_STOP=1 -c "$QUERY" 2>&1 | tail -1) || true
R_SRC=$(PGPORT=$P_SRC psql -X -At -v ON_ERROR_STOP=1 -c "$QUERY" 2>&1 | tail -1) || true
unset PGPASSWORD
echo "restored: $R_DRILL"
echo "source:   $R_SRC"
[[ "$R_DRILL" == ledger=* ]] || stop "the restored copy could not be queried: $R_DRILL"
[[ "$R_SRC" == ledger=* ]] || stop "the source could not be queried: $R_SRC"
SRC_LEDGER=$(sed -E 's/^ledger=([^ ]*).*/\1/' <<<"$R_SRC")
VERSIONS=$(tr ',' '\n' <<<"$SRC_LEDGER" | cut -d: -f1 | paste -sd,)
N=$(tr ',' '\n' <<<"$VERSIONS" | grep -c .)
BASELINE=$(tr ',' '\n' <<<"$VERSIONS" | tail -1)
[[ "$VERSIONS" == "$(seq -f '%04g' 1 "$N" | paste -sd,)" ]] || stop "source ledger is not contiguous from 0001: $VERSIONS"
(( N >= 1 && N <= 18 )) || stop "source ledger has $N migrations; the pilot build knows 0001-0018"
[[ "$R_DRILL" == "$R_SRC" ]] || stop "restored copy differs from the source (ledger with checksums, or row counts up to the restore point)"
COUNTS=${R_DRILL#ledger=$SRC_LEDGER }
CHECK="PASS: migration ledger 0001-$BASELINE (versions and checksums) identical to the source; row counts up to $RESTORE_POINT UTC identical ($COUNTS)"
echo "$CHECK"

step "4b Read-only diagnostics: pilot migrations on the source"
DIAG="$OUT/migration-diagnostics-$STAMP.txt"
export PGPASSWORD; PGPASSWORD=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query SecretString --output text | jq -r .password)
{
  echo "Source $SRC_ID, read $(date -u +%FT%TZ). Pilot build 87a9be2 contains migrations 0001-0018."
  echo "Missing from ogevia_sv_test (pilot build minus source ledger): $(comm -23 <(seq -f '%04g' 1 18) <(tr ',' '\n' <<<"$VERSIONS") | paste -sd, -)"
  echo "-- ledgers of every database on the instance:"
  if ! DBLIST=$(PGPORT=$P_SRC PGDATABASE=postgres psql -X -At -c "select datname from pg_database where not datistemplate order by 1" 2>&1); then
    echo "   could not list databases: $(tail -1 <<<"$DBLIST")"; DBLIST=""
  fi
  for db in $DBLIST; do
    L=$(PGPORT=$P_SRC PGDATABASE="$db" psql -X -At -c "select case when to_regclass('ogevia_meta.schema_migrations') is null then 'no ledger' else (select 'count ' || count(*) || ', latest ' || max(version) || ', last applied ' || to_char(max(applied_at), 'YYYY-MM-DD HH24:MI:SS') || ' UTC by ' || string_agg(distinct applied_by, '/') from ogevia_meta.schema_migrations) end" 2>&1 | tail -1)
    echo "   $db: $L"
  done
  echo "-- ogevia_sv_test ledger with apply times:"
  PGPORT=$P_SRC psql -X -At -F ' | ' -c "select version, name, to_char(applied_at, 'YYYY-MM-DD HH24:MI:SS'), applied_by from ogevia_meta.schema_migrations where version >= '0010' order by version" 2>&1 | sed 's/^/   /'
  echo "-- objects that 0013/0014/0015 create (present = applied outside the ledger):"
  PGPORT=$P_SRC psql -X -At -c "select '   0013 ogevia.match_scheduled_shift_for_visit: ' || (to_regproc('ogevia.match_scheduled_shift_for_visit') is not null)
    union all select '   0014 ogevia.caregiver_has_current_shift: ' || exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'ogevia' and p.proname = 'caregiver_has_current_shift')
    union all select '   0015 ogevia_api.close_missed_service_visit: ' || exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'ogevia_api' and p.proname = 'close_missed_service_visit')
    union all select '   0015 column service_visits.time_out_entered_by: ' || exists(select 1 from information_schema.columns where table_schema = 'ogevia' and table_name = 'service_visits' and column_name = 'time_out_entered_by')" 2>&1
  FN=$(aws cloudformation describe-stack-resources --stack-name Ogevia-prod-ServiceVerificationApi --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId | [0]" --output text 2>&1)
  FENV=$(aws lambda get-function-configuration --function-name "$FN" --query 'Environment.Variables' --output json 2>&1)
  echo "-- API Lambda target: DB_NAME=$(jq -r .DB_NAME <<<"$FENV" 2>/dev/null), DB_HOST=$(jq -r .DB_HOST <<<"$FENV" 2>/dev/null | cut -d. -f1)"
  APPSEC=$(jq -r .DB_SECRET_ARN <<<"$FENV" 2>/dev/null)
  echo "   app secret dbname key (password not read out): $(aws secretsmanager get-secret-value --secret-id "$APPSEC" --query SecretString --output text 2>/dev/null | jq -r '.dbname // "not set"' 2>/dev/null)"
  echo "-- pilot run (~/ogevia-pilot-run): state markers: $(ls "$HOME/ogevia-pilot-run/state" 2>/dev/null | tr '\n' ' ')"
  for f in "$HOME"/ogevia-pilot-run/deploy-*.log; do
    [[ -e "$f" ]] || continue
    hits=$(sed -E 's/\x1b\[[0-9;]*m//g' "$f" | grep -E '^=== 1[0-2]/12|Migration ledger before|^applying 00|^applied [0-9]+, already|01_schema_version|STOPPED|Existing visit timestamps unchanged|Pilot seed' | head -n 14)
    [[ -n "$hits" ]] && { echo "   $(basename "$f"):"; sed 's/^/      /' <<<"$hits"; }
  done
} > "$DIAG" 2>&1
unset PGPASSWORD
sed -E 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/<email>/g' "$DIAG"
close_tunnels; restore_sgs; BASE_SGS_DONE=$BASE_SGS

step "5 Delete ONLY $DRILL_ID"
TAG=$(aws rds list-tags-for-resource --resource-name "$(jq -r .DBInstanceArn <<<"$D")" --query "TagList[?Key=='purpose'].Value | [0]" --output text)
[[ "$TAG" == restore-drill && "$DRILL_ID" =~ ^ogevia-restore-drill-[0-9]{12}$ ]] || stop "refusing to delete: tag or name changed"
aws rds delete-db-instance --db-instance-identifier "$DRILL_ID" --skip-final-snapshot --delete-automated-backups >/dev/null \
  || stop "delete request failed (error above)"
echo "Waiting for deletion (usually 5-10 minutes)..."
aws rds wait db-instance-deleted --db-instance-identifier "$DRILL_ID" || aws rds wait db-instance-deleted --db-instance-identifier "$DRILL_ID" || true

step "6 Verify cleanup"
OK=1
G=$(aws rds describe-db-instances --db-instance-identifier "$DRILL_ID" 2>&1) && { echo "FAIL: $DRILL_ID still exists"; OK=0; } \
  || { grep -q DBInstanceNotFound <<<"$G" && echo "PASS: $DRILL_ID deleted" || { echo "FAIL: could not confirm deletion: $G"; OK=0; }; }
AB=$(aws rds describe-db-instance-automated-backups --db-instance-identifier "$DRILL_ID" --query 'length(DBInstanceAutomatedBackups)' --output text 2>&1)
[[ "$AB" == 0 || "$AB" == *DBInstanceAutomatedBackupNotFound* ]] && echo "PASS: no retained automated backups for $DRILL_ID" || { echo "FAIL: retained backups: $AB"; OK=0; }
NOW_SGS=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text | tr -s ' \t' '\n' | sort | xargs)
[[ "$NOW_SGS" == "$BASE_SGS_DONE" ]] && echo "PASS: admin host groups are the original ($NOW_SGS)" || { echo "FAIL: admin host groups are $NOW_SGS (expected $BASE_SGS_DONE)"; OK=0; }
S2=$(aws rds describe-db-instances --db-instance-identifier "$SRC_ID" --query 'DBInstances[0]' --output json | jq -r '"\(.DBInstanceStatus) \(.DeletionProtection) \(.DbiResourceId)"')
[[ "$S2" == "available $SRC_DP_BEFORE $(jq -r .DbiResourceId <<<"$S")" ]] && echo "PASS: $SRC_ID untouched (available, deletion protection $SRC_DP_BEFORE)" \
  || { echo "FAIL: $SRC_ID now: $S2"; OK=0; }
LEFT=$(aws rds describe-db-instances --query "DBInstances[?starts_with(DBInstanceIdentifier,'ogevia-restore-drill-')].DBInstanceIdentifier" --output text)
[[ -z "$LEFT" ]] && echo "PASS: no other restore-drill instances exist" || { echo "FAIL: other restore-drill instances still exist: $LEFT (not touched)"; OK=0; }

{
  echo "Ogevia restore drill, finished $STAMP"
  echo "drill instance: $DRILL_ID (restored from $SRC_ID; deleted after the check)"
  echo "restore point: $RESTORE_POINT UTC; restore requested (instance created) ${CREATED:-unknown}; restore completed event $DONE_AT; time to restore $DUR"
  echo "encrypted with the source KMS key: $ENC; publicly accessible: $PUB"
  echo "data check: $CHECK"
  echo "cleanup: $([[ $OK == 1 ]] && echo PASS || echo 'INCOMPLETE (see log)')"
  echo "baseline: the source database is at migration $BASELINE; diagnostics: $DIAG"
} > "$REPORT"
DONE=1
echo
echo "================ Restore drill result ================"
cat "$REPORT"
echo "Log: $LOG"
[[ $OK == 1 ]] || exit 1
