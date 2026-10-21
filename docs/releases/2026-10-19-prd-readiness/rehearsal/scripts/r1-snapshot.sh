#!/usr/bin/env bash
# R1 FRESH SNAPSHOT of the shared instance, named ogevia-prod-postgres-pre-rehearsal-YYYYMMDDHHMM. YELLOW in create mode (one create-db-snapshot call; the snapshot costs storage).
#   OGEVIA_RELEASE_WINDOW_START=2026-10-21T01:00:00Z OGEVIA_RELEASE_WINDOW_END=2026-10-21T05:00:00Z bash r1-snapshot.sh create|verify
# Verified: available, manual, belongs to ogevia-prod-postgres, StorageEncrypted, created inside the window and not in the future. This snapshot is the REHEARSAL source; it is not the
# production rollback anchor (a new one must be taken at the real window).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
MODE="${1:-}"; [[ "$MODE" == create || "$MODE" == verify ]] || { echo "usage: bash r1-snapshot.sh create|verify" >&2; exit 2; }
need aws jq timeout date
TS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
[[ "${OGEVIA_RELEASE_WINDOW_START:-}" =~ $TS_RE && "${OGEVIA_RELEASE_WINDOW_END:-}" =~ $TS_RE ]] || stop "set OGEVIA_RELEASE_WINDOW_START and OGEVIA_RELEASE_WINDOW_END (UTC, 2026-10-21T01:00:00Z)"
WS=$(date -u -d "$OGEVIA_RELEASE_WINDOW_START" +%s 2>/dev/null) && WE=$(date -u -d "$OGEVIA_RELEASE_WINDOW_END" +%s 2>/dev/null) || stop "the window is not a valid date"
(( WE > WS && WE - WS <= 43200 )) || stop "the window must end after it starts and last at most 12 hours"
check_account
[[ -s "$OUT/r0.json" ]] || stop "run r0-preflight.sh first ($OUT/r0.json is missing)"
if [[ "$MODE" == create ]]; then
  NOW=$(date -u +%s); (( NOW >= WS && NOW <= WE )) || stop "now is outside the release window; a snapshot taken outside it is refused"
  SNAP="ogevia-prod-postgres-pre-rehearsal-$(date -u +%Y%m%d%H%M)"
  say "PROPOSED (the only change): rds create-db-snapshot --db-instance-identifier $PROD_RDS --db-snapshot-identifier $SNAP (a copy of the shared instance, which holds ogevia_prd and ogevia_sv_test)"
  confirm "SNAPSHOT-NOW"
  state_set SNAP_ID "$SNAP"
  A rds create-db-snapshot --db-instance-identifier "$PROD_RDS" --db-snapshot-identifier "$SNAP" --output json >/dev/null || stop "create-db-snapshot failed (it may or may not exist: run 'verify' before retrying)"
  say "waiting for $SNAP"
  timeout --foreground -k 5 2400 aws rds wait db-snapshot-available --db-snapshot-identifier "$SNAP" || stop "the snapshot did not become available (run 'verify' once credentials work; do not create a second)"
else
  SNAP="${OGEVIA_REHEARSAL_SNAPSHOT_ID:-$(state_get SNAP_ID)}"
fi
[[ "$SNAP" =~ ^ogevia-prod-postgres-pre-rehearsal-[0-9]{12}$ ]] || stop "the snapshot id '$SNAP' does not match ogevia-prod-postgres-pre-rehearsal-YYYYMMDDHHMM"
S=$(A rds describe-db-snapshots --db-snapshot-identifier "$SNAP" --output json 2>/dev/null | jq -c '.DBSnapshots[0]') && [[ -n "$S" && "$S" != null ]] || stop "cannot read snapshot $SNAP"
ST=$(jq -r .Status <<<"$S"); INST=$(jq -r .DBInstanceIdentifier <<<"$S"); TYPE=$(jq -r .SnapshotType <<<"$S"); ENC=$(jq -r .Encrypted <<<"$S"); CR=$(jq -r .SnapshotCreateTime <<<"$S")
say "snapshot $SNAP: status=$ST instance=$INST type=$TYPE created=$CR encrypted=$ENC"
[[ "$ST" == available ]] || stop "status is '$ST', not available"
[[ "$INST" == "$PROD_RDS" ]] || stop "snapshot belongs to '$INST', not $PROD_RDS"
[[ "$TYPE" == manual ]] || stop "snapshot type is '$TYPE', not manual"
[[ "$ENC" == true ]] || stop "snapshot is not encrypted"
C=$(date -u -d "$CR" +%s 2>/dev/null) || stop "no readable creation time"
(( C >= WS && C <= WE && C <= $(date -u +%s) )) || stop "snapshot was created at $CR, outside the window (or in the future)"
state_set SNAP_ID "$SNAP"
say "SNAPSHOT VERIFIED: $SNAP"
