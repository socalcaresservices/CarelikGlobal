#!/usr/bin/env bash
# =============================================================================
# TEST release 2026-10-26-redesign, STEP 7: create the named pre-deployment snapshot of ogevia-prod-postgres [YELLOW: one create-db-snapshot call; the snapshot costs storage] and VERIFY it.
#   bash snapshot-verify.sh create    # takes the snapshot inside the release window, waits for it, verifies it
#   bash snapshot-verify.sh verify    # verifies an existing snapshot only (read-only); reads the id from OGEVIA_PREDEPLOY_SNAPSHOT_ID or $OGEVIA_BEFORE/snapshot-id.txt
# Verified: the id matches ogevia-prod-postgres-pre-0087-YYYYMMDDHHMM; the snapshot exists, status available, belongs to ogevia-prod-postgres, type manual, StorageEncrypted true,
# created inside OGEVIA_RELEASE_WINDOW_START..END and not in the future. Anything else exits 1 and the operator STOPS. The snapshot is a recovery PREREQUISITE, not a restore procedure.
# AWS verbs: rds create-db-snapshot (create mode only), rds wait db-snapshot-available, rds describe-db-snapshots.
# =============================================================================
set -uo pipefail
MODE="${1:-}"; [[ "$MODE" == create || "$MODE" == verify ]] || { echo "usage: bash snapshot-verify.sh create|verify" >&2; exit 2; }
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""
RDS_ID=ogevia-prod-postgres; B="${OGEVIA_BEFORE:-$HOME/ogevia-before}"
A() { timeout --foreground -k 5 "${OGEVIA_AWS_TIMEOUT:-60}" aws "$@"; }
stop() { echo "STOP: $*"; exit 1; }
TS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
[[ "${OGEVIA_RELEASE_WINDOW_START:-}" =~ $TS_RE && "${OGEVIA_RELEASE_WINDOW_END:-}" =~ $TS_RE ]] || stop "set OGEVIA_RELEASE_WINDOW_START and OGEVIA_RELEASE_WINDOW_END (UTC, 2026-10-27T03:00:00Z)"
W_START=$(date -u -d "$OGEVIA_RELEASE_WINDOW_START" +%s 2>/dev/null) && W_END=$(date -u -d "$OGEVIA_RELEASE_WINDOW_END" +%s 2>/dev/null) || stop "the release window is not a valid date"
(( W_END > W_START && W_END - W_START <= 43200 )) || stop "the release window must end after it starts and last at most 12 hours"
NOW=$(date -u +%s)
if [[ "$MODE" == create ]]; then
  (( NOW >= W_START && NOW <= W_END )) || stop "now ($(date -u +%FT%TZ)) is outside the release window; a snapshot taken outside it is refused"
  SNAP="ogevia-prod-postgres-pre-0087-$(date -u +%Y%m%d%H%M)"
  mkdir -p "$B" && echo "$SNAP" > "$B/snapshot-id.txt" || stop "cannot write $B/snapshot-id.txt"
  echo "creating $SNAP"
  A rds create-db-snapshot --db-instance-identifier "$RDS_ID" --db-snapshot-identifier "$SNAP" --query 'DBSnapshot.Status' --output text || stop "create-db-snapshot failed"
  timeout --foreground -k 5 2400 aws rds wait db-snapshot-available --db-snapshot-identifier "$SNAP" || stop "the snapshot did not become available"
else
  SNAP="${OGEVIA_PREDEPLOY_SNAPSHOT_ID:-$(cat "$B/snapshot-id.txt" 2>/dev/null)}"
fi
[[ "$SNAP" =~ ^ogevia-prod-postgres-pre-0087-[0-9]{12}$ ]] || stop "the snapshot id '$SNAP' does not match ogevia-prod-postgres-pre-0087-YYYYMMDDHHMM"
ROW=$(A rds describe-db-snapshots --db-snapshot-identifier "$SNAP" --query 'DBSnapshots[0].[Status,DBInstanceIdentifier,SnapshotType,SnapshotCreateTime,Encrypted]' --output text 2>/dev/null) || stop "cannot read snapshot $SNAP (it does not exist, or access failed)"
IFS=$'\t' read -r ST INST TYPE CREATED ENC <<<"$ROW"
echo "snapshot $SNAP: status=$ST instance=$INST type=$TYPE created=$CREATED encrypted=$ENC"
[[ "$ST" == available ]] || stop "snapshot status is '${ST:-unknown}', not available"
[[ "$INST" == "$RDS_ID" ]] || stop "snapshot belongs to '${INST:-unknown}', not $RDS_ID"
[[ "$TYPE" == manual ]] || stop "snapshot type is '${TYPE:-unknown}', not manual"
[[ "$ENC" == True || "$ENC" == true ]] || stop "snapshot is not encrypted (Encrypted=${ENC:-unknown})"
C=$(date -u -d "${CREATED:-}" +%s 2>/dev/null) || stop "no readable creation time ('${CREATED:-}')"
(( C >= W_START && C <= W_END && C <= $(date -u +%s) )) || stop "snapshot was created at $CREATED, outside the release window (or in the future)"
echo "SNAPSHOT VERIFIED: $SNAP (available, manual, ogevia-prod-postgres, encrypted, created inside the window). Record this id; export OGEVIA_PREDEPLOY_SNAPSHOT_ID=$SNAP"
