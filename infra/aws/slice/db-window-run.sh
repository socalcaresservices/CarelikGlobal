#!/usr/bin/env bash
# =============================================================================
# Ogevia: run ONE reviewed database script through the repository's approved DB window (the same method as owner-access-check.sh and the pilot/production
# deploy scripts): temporarily attach the application security group to the admin host, open an SSM port-forward to the private RDS endpoint, hold the
# RDS-managed master credential in shell memory only, and ALWAYS restore the admin host's original security groups afterwards (verified).
#
#   bash db-window-run.sh <prd|test> preview                              read-only count preview (no change)
#   bash db-window-run.sh <prd|test> dashboard                            read-only: the Home dashboard figures as the application computes them
#   bash db-window-run.sh prd snapshot-create                             typed SNAPSHOT-NOW; creates and verifies an RDS snapshot (no database window)
#   bash db-window-run.sh prd snapshot-verify <snapshot-id>               read-only check of an existing snapshot (no database window)
#   bash db-window-run.sh prd clear-dry-run <expected-clients>            the cleanup logic, ALWAYS rolled back: shows what would be removed and kept
#   bash db-window-run.sh prd clear-apply <expected-clients> <snapshot-id>   verifies the snapshot, repeats the dry run, then asks for CLEAR-<agency>-<N>
#   bash db-window-run.sh test verify-new-agencies                        TEST only: two new agencies are empty and isolated (rolled back)
#
# Never prints credentials. Every database script is read-only or ends in ROLLBACK unless clear-apply is confirmed by typing the exact phrase.
# OGEVIA_DBRUN_LOCAL_URL exists only to rehearse this script against a local PostgreSQL; never set it in AWS.
# =============================================================================
set -uo pipefail
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""
ACCOUNT=300094796789; RDS_ID=ogevia-prod-postgres; APP_SG=sg-064ffce3bcbe8eb3b; ADMIN_TAG=ogevia-db-admin-temp
PORT=${OGEVIA_DBRUN_LOCAL_PORT:-15436}
LOCAL_URL=${OGEVIA_DBRUN_LOCAL_URL:-}
OUT="${OGEVIA_DBRUN_OUT:-$HOME/ogevia-cleanup}"; mkdir -p "$OUT"; chmod 700 "$OUT"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ENVN="${1:-}"; ACTION="${2:-}"
usage() {
  cat >&2 <<'USAGE'
usage: bash db-window-run.sh <prd|test> <action> [arguments]
  preview                                  read-only count preview (no change)
  dashboard                                read-only: the Home dashboard figures as the application computes them (no change)
  snapshot-create                          typed SNAPSHOT-NOW; creates and verifies an RDS snapshot (prd)
  snapshot-verify <snapshot-id>            read-only check of an existing snapshot (prd)
  clear-dry-run <expected-clients>         the cleanup logic, ALWAYS rolled back (prd)
  clear-apply <expected-clients> <snapshot-id>   verifies the snapshot, dry-runs, then asks for CLEAR-<agency>-<N> (prd)
  verify-new-agencies                      TEST only: two new agencies are empty and isolated (rolled back)
USAGE
  exit 2
}
case "$ENVN" in
  prd)  DB=ogevia_prd;     SLUG=${OGEVIA_ORG_SLUG:-socal-care-services} ;;
  test) DB=ogevia_sv_test; SLUG=${OGEVIA_ORG_SLUG:-scs-pilot-synthetic} ;;
  *) usage ;;
esac
shift 2 2>/dev/null || true

LOG="$OUT/run-$ENVN-$ACTION-$STAMP.txt"; : > "$LOG"; chmod 600 "$LOG"
say() { printf '%s\n' "$*" | tee -a "$LOG"; }
IID=""; BASE_SGS=""; TUN=""; DONE=""
stop() { DONE=1; say "STOP: $*"; say "Log: $LOG"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || stop "$1 is not installed in this shell (nothing was changed)"; }

sqlfile() {  # sqlfile <name>: next to this script, in OGEVIA_SQL_DIR, or at the repository location
  local n="$1" d
  for d in "${OGEVIA_SQL_DIR:-}" "$HERE" "$HERE/../db/preview" "$HERE/../db/maintenance"; do
    [[ -n "$d" && -f "$d/$n" ]] && { printf '%s\n' "$d/$n"; return 0; }
  done
  stop "SQL file $n not found next to this script"
}

cleanup() {
  local rc=$?
  [[ -n "$TUN" ]] && kill "$TUN" 2>/dev/null
  [[ -n "$IID" ]] && pkill -f "session-manager-plugin.*$IID" 2>/dev/null
  unset PGPASSWORD
  if [[ -n "$IID" && -n "$BASE_SGS" ]]; then
    local now
    now=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text 2>/dev/null | tr -s ' \t' '\n' | sort | xargs)
    if [[ "$now" != "$BASE_SGS" ]]; then
      # shellcheck disable=SC2086
      aws ec2 modify-instance-attribute --instance-id "$IID" --groups $BASE_SGS && say "Admin host security groups restored: $BASE_SGS" \
        || say "WARNING: restore the admin host's security groups to: $BASE_SGS (EC2 console, instance $IID)"
    fi
    now=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text 2>/dev/null | tr -s ' \t' '\n' | sort | xargs)
    [[ "$now" == "$BASE_SGS" ]] && say "Verified: admin host security groups are the original ($now)." || say "WARNING: admin host groups are '$now', expected '$BASE_SGS'"
  fi
  [[ $rc != 0 && -z "$DONE" ]] && say "EXITED UNEXPECTEDLY (exit $rc). Log: $LOG"
}
trap cleanup EXIT

# --- snapshots (AWS only; no database window) --------------------------------------------------------------------------------------------------------------
verify_snapshot() {
  local id="$1" S now c
  [[ "$id" =~ ^ogevia-prod-postgres-pre-testdata-[0-9]{12}$ ]] || stop "snapshot id '$id' must look like ogevia-prod-postgres-pre-testdata-YYYYMMDDHHMM"
  [[ -n "$LOCAL_URL" ]] && { say "LOCAL REHEARSAL: snapshot not verified."; return 0; }
  S=$(aws rds describe-db-snapshots --db-snapshot-identifier "$id" --query 'DBSnapshots[0]' --output json 2>/dev/null) && [[ -n "$S" && "$S" != null ]] || stop "cannot read snapshot $id"
  [[ "$(jq -r .Status <<<"$S")" == available ]] || stop "snapshot $id is '$(jq -r .Status <<<"$S")', not available yet"
  [[ "$(jq -r .DBInstanceIdentifier <<<"$S")" == "$RDS_ID" && "$(jq -r .SnapshotType <<<"$S")" == manual && "$(jq -r .Encrypted <<<"$S")" == true ]] \
    || stop "snapshot $id is not a manual, encrypted snapshot of $RDS_ID"
  c=$(date -u -d "$(jq -r .SnapshotCreateTime <<<"$S")" +%s 2>/dev/null) || stop "snapshot has no readable creation time"; now=$(date -u +%s)
  (( c <= now && now - c <= ${OGEVIA_SNAPSHOT_MAX_AGE:-21600} )) || stop "snapshot $id is $(( (now - c) / 60 )) minutes old; the limit is $(( ${OGEVIA_SNAPSHOT_MAX_AGE:-21600} / 60 )). Create a fresh one."
  say "SNAPSHOT VERIFIED: $id is available, manual, encrypted, of $RDS_ID, $(( (now - c) / 60 )) minutes old."
}

if [[ "$ACTION" == snapshot-create || "$ACTION" == snapshot-verify ]]; then
  need aws; need jq
  [[ "$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" == "$ACCOUNT" ]] || stop "not signed in to account $ACCOUNT"
  if [[ "$ACTION" == snapshot-verify ]]; then verify_snapshot "${1:-}"; DONE=1; exit 0; fi
  ID="ogevia-prod-postgres-pre-testdata-$(date -u +%Y%m%d%H%M)"
  say "This creates a billable manual snapshot of $RDS_ID (it holds BOTH ogevia_prd and ogevia_sv_test): $ID"
  read -r -p "Type SNAPSHOT-NOW to create it (anything else changes nothing): " ans || ans=""
  [[ "$ans" == SNAPSHOT-NOW ]] || { say "Declined. Nothing was changed."; DONE=1; exit 0; }
  aws rds create-db-snapshot --db-instance-identifier "$RDS_ID" --db-snapshot-identifier "$ID" --tags Key=purpose,Value=pre-testdata-cleanup >/dev/null || stop "create-db-snapshot failed"
  say "Snapshot $ID requested; waiting until it is available (several minutes)..."
  aws rds wait db-snapshot-available --db-snapshot-identifier "$ID" || stop "the snapshot did not become available; re-run: bash db-window-run.sh prd snapshot-verify $ID"
  verify_snapshot "$ID"; say "Use this snapshot id: $ID"; DONE=1; exit 0
fi

# --- database actions --------------------------------------------------------------------------------------------------------------------------------------
case "$ACTION" in
  preview|dashboard|clear-dry-run|clear-apply|verify-new-agencies) ;;
  *) usage ;;
esac
[[ "$ACTION" == verify-new-agencies && "$ENVN" != test ]] && stop "verify-new-agencies runs against TEST only"
EXPECTED="${1:-}"; SNAP="${2:-}"
if [[ "$ACTION" == clear-dry-run || "$ACTION" == clear-apply ]]; then
  [[ "$EXPECTED" =~ ^[0-9]+$ ]] || stop "give the expected client count from the preview, for example: clear-dry-run 4"
  [[ "$ENVN" == prd || "${OGEVIA_ALLOW_TEST_PURGE:-}" == yes ]] || stop "the cleanup targets production; for TEST set OGEVIA_ALLOW_TEST_PURGE=yes deliberately"
fi
[[ "$ACTION" == clear-apply ]] && { [[ -n "$SNAP" ]] || stop "clear-apply needs the snapshot id: clear-apply <N> <snapshot-id>"; }
need psql; need jq
if [[ -z "$LOCAL_URL" ]]; then
  need aws; need session-manager-plugin
  [[ "$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" == "$ACCOUNT" ]] || stop "not signed in to account $ACCOUNT"
fi
[[ "$ACTION" == clear-apply ]] && verify_snapshot "$SNAP"

db() { if [[ -n "$LOCAL_URL" ]]; then psql "$LOCAL_URL" -X -A -F'|' -v ON_ERROR_STOP=1 "$@"; else psql -X -A -F'|' -v ON_ERROR_STOP=1 -d "$DB" "$@"; fi; }

if [[ -z "$LOCAL_URL" ]]; then
  RDS=$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0]' --output json) || stop "cannot read $RDS_ID"
  [[ "$(jq -r .DBInstanceStatus <<<"$RDS")" == available ]] || stop "$RDS_ID is not available"
  RDS_HOST=$(jq -r .Endpoint.Address <<<"$RDS"); SECRET_ARN=$(jq -r '.MasterUserSecret.SecretArn // empty' <<<"$RDS")
  [[ -n "$SECRET_ARN" ]] || stop "the RDS-managed master secret was not found"
  IID=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$ADMIN_TAG" "Name=instance-state-name,Values=running" --query 'Reservations[0].Instances[0].InstanceId' --output text)
  [[ "$IID" == i-* ]] || stop "the admin host $ADMIN_TAG is not running (start it in the EC2 console, then re-run)"
  BASE_SGS=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text | tr -s ' \t' '\n' | sort | xargs)
  say "Admin host $IID original security groups: $BASE_SGS"
  grep -qw "$APP_SG" <<<"$BASE_SGS" && stop "the admin host already carries $APP_SG (a previous window was left open). Restore its groups first, then re-run."
  # shellcheck disable=SC2086
  aws ec2 modify-instance-attribute --instance-id "$IID" --groups $BASE_SGS "$APP_SG" || stop "could not attach the application security group"
  say "DB window OPEN (temporary). It is closed and verified when this script exits."
  aws ssm start-session --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters "host=$RDS_HOST,portNumber=5432,localPortNumber=$PORT" >/dev/null &
  TUN=$!
  for _ in $(seq 1 30); do (echo > "/dev/tcp/127.0.0.1/$PORT") 2>/dev/null && break; sleep 2; done
  MASTER=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query SecretString --output text) || stop "cannot read the master secret"
  export PGHOST=127.0.0.1 PGPORT=$PORT PGSSLMODE=require
  PGUSER=$(jq -r .username <<<"$MASTER"); export PGUSER
  PGPASSWORD=$(jq -r .password <<<"$MASTER"); export PGPASSWORD
  unset MASTER
fi

CUR=$(db -t -c "select current_database()" 2>>"$LOG") || stop "cannot connect to the database through the tunnel"
if [[ -z "$LOCAL_URL" ]]; then [[ "$CUR" == "$DB" ]] || stop "connected to '$CUR', expected '$DB'"; fi
say "Connected to database: $CUR   agency: $SLUG   action: $ACTION"

case "$ACTION" in
  preview)
    R="$OUT/preview-$ENVN-$STAMP.txt"
    db -v "org_slug=$SLUG" -f "$(sqlfile test_data_cleanup_preview.sql)" | tee "$R" | tee -a "$LOG"
    [[ ${PIPESTATUS[0]} == 0 ]] || stop "the preview failed"
    say "Preview saved: $R  (counts only; send it to the engineer, not to chat or tickets)" ;;
  dashboard)
    R="$OUT/dashboard-$ENVN-$STAMP.txt"
    db -v "org_slug=$SLUG" -f "$(sqlfile dashboard_totals.sql)" 2>&1 | tee "$R" | tee -a "$LOG"
    [[ ${PIPESTATUS[0]} == 0 ]] || stop "the dashboard read failed or did not run: see above (nothing changed)"
    say "Dashboard figures saved: $R  (counts and minutes only)" ;;
  clear-dry-run)
    R="$OUT/clear-dry-run-$ENVN-$STAMP.txt"
    db -v "org_slug=$SLUG" -v "expected_clients=$EXPECTED" -v mode=dry-run -f "$(sqlfile test_data_clear_linked.sql)" | tee "$R" | tee -a "$LOG"
    [[ ${PIPESTATUS[0]} == 0 ]] || stop "the dry run was refused or failed (nothing changed)"
    say "Dry run saved: $R" ;;
  clear-apply)
    say "== Step 1 of 2: dry run (rolled back) =="
    db -v "org_slug=$SLUG" -v "expected_clients=$EXPECTED" -v mode=dry-run -f "$(sqlfile test_data_clear_linked.sql)" | tee -a "$LOG"
    [[ ${PIPESTATUS[0]} == 0 ]] || stop "the dry run was refused or failed (nothing changed)"
    say "Snapshot $SNAP is verified. The client rows and their authorizations STAY. Only the linked test records above are deleted. This cannot be undone except from the snapshot."
    read -r -p "Type CLEAR-$SLUG-$EXPECTED to apply (anything else changes nothing): " ans || ans=""
    [[ "$ans" == "CLEAR-$SLUG-$EXPECTED" ]] || { say "Declined. Nothing was changed."; DONE=1; exit 0; }
    R="$OUT/clear-apply-$ENVN-$STAMP.txt"
    db -v "org_slug=$SLUG" -v "expected_clients=$EXPECTED" -v mode=apply -v "snapshot_id=$SNAP" -v "confirm=$ans" -f "$(sqlfile test_data_clear_linked.sql)" | tee "$R" | tee -a "$LOG"
    [[ ${PIPESTATUS[0]} == 0 ]] || stop "the apply failed; the transaction was rolled back and nothing changed"
    say "Applied. Saved: $R. Now run: bash db-window-run.sh $ENVN preview   and   bash db-window-run.sh $ENVN dashboard   and compare with the earlier outputs." ;;
  verify-new-agencies)
    R="$OUT/verify-new-agencies-$STAMP.txt"
    db -f "$(sqlfile test_new_agency_isolation_check.sql)" 2>&1 | tee "$R" | tee -a "$LOG"
    [[ ${PIPESTATUS[0]} == 0 ]] || stop "a check FAILED or did not run: see above. Nothing remains in the database (rolled back)."
    say "Saved: $R" ;;
esac
DONE=1
