#!/usr/bin/env bash
# C1: the fresh PRE-RELEASE SNAPSHOT of the production instance. YELLOW (creates a billable manual snapshot of ogevia-prod-postgres, which holds ogevia_prd AND ogevia_sv_test). Not run by anyone yet.
#   OGEVIA_DEPLOY_APPROVAL=<ref> OGEVIA_RELEASE_WINDOW_START=... OGEVIA_RELEASE_WINDOW_END=... bash c1-snapshot-prd.sh create     creates ogevia-prod-postgres-pre-prdrelease-<UTC YYYYMMDDHHMM>, waits for `available`, verifies
#   OGEVIA_PREDEPLOY_SNAPSHOT_ID=... bash c1-snapshot-prd.sh verify                                                              READ-ONLY: the same checks on an existing snapshot (as the migration and deploy guards apply them)
# Checks: manual, available, encrypted, of ogevia-prod-postgres, created inside the owner's window (at most 12 hours), at most 6 hours old. Writes $B/predeploy-snapshot-id.txt (the id to export as OGEVIA_PREDEPLOY_SNAPSHOT_ID).
# create needs the typed phrase SNAPSHOT-NOW. It never deletes, copies, shares or restores a snapshot. Retention is the owner's decision (a snapshot costs storage until deleted).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
MODE="${1:-}"; RDS_ID=ogevia-prod-postgres
[[ "$MODE" == create || "$MODE" == verify ]] || { echo "usage: bash c1-snapshot-prd.sh create|verify" >&2; exit 2; }
need aws jq timeout; check_account
verify_snapshot() {
  local id="$1" S c now ws we
  [[ "$id" =~ ^ogevia-prod-postgres-pre-prdrelease-[0-9]{12}$ ]] || stop "the snapshot id '$id' does not match ogevia-prod-postgres-pre-prdrelease-YYYYMMDDHHMM"
  S=$(A rds describe-db-snapshots --db-snapshot-identifier "$id" --output json 2>/dev/null | jq -c '.DBSnapshots[0]') && [[ -n "$S" && "$S" != null ]] || stop "cannot read snapshot $id"
  [[ "$(jq -r .Status <<<"$S")" == available ]] || stop "snapshot $id is '$(jq -r .Status <<<"$S")', not available (percent: $(jq -r '.PercentProgress // "?"' <<<"$S"))"
  [[ "$(jq -r .DBInstanceIdentifier <<<"$S")" == "$RDS_ID" && "$(jq -r .SnapshotType <<<"$S")" == manual && "$(jq -r .Encrypted <<<"$S")" == true ]] || stop "snapshot $id is not a manual, encrypted snapshot of $RDS_ID"
  c=$(date -u -d "$(jq -r .SnapshotCreateTime <<<"$S")" +%s 2>/dev/null) || stop "no readable creation time"; now=$(date -u +%s)
  (( c <= now && now - c <= ${OGEVIA_SNAPSHOT_MAX_AGE:-21600} )) || stop "snapshot $id was created $(( (now - c) / 60 )) minutes ago; the limit is $(( ${OGEVIA_SNAPSHOT_MAX_AGE:-21600} / 60 )) minutes. Take a fresh one."
  if [[ -n "${OGEVIA_RELEASE_WINDOW_START:-}" ]]; then
    ws=$(date -u -d "$OGEVIA_RELEASE_WINDOW_START" +%s 2>/dev/null) && we=$(date -u -d "$OGEVIA_RELEASE_WINDOW_END" +%s 2>/dev/null) || stop "the release window is not a valid date and time"
    (( c >= ws && c <= we )) || stop "snapshot $id was created outside the release window"
  fi
  printf '%s\n' "$id" > "$B/predeploy-snapshot-id.txt"
  say "SNAPSHOT VERIFIED: $id is available, manual, encrypted, of $RDS_ID, $(( (now - c) / 60 )) minutes old. Export OGEVIA_PREDEPLOY_SNAPSHOT_ID=$id"
}
if [[ "$MODE" == verify ]]; then verify_snapshot "${OGEVIA_PREDEPLOY_SNAPSHOT_ID:-}"; exit 0; fi
[[ "${OGEVIA_DEPLOY_APPROVAL:-}" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || stop "set OGEVIA_DEPLOY_APPROVAL to the owner's approval reference"
TS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
[[ "${OGEVIA_RELEASE_WINDOW_START:-}" =~ $TS_RE && "${OGEVIA_RELEASE_WINDOW_END:-}" =~ $TS_RE ]] || stop "set OGEVIA_RELEASE_WINDOW_START and _END (UTC, 2026-10-21T03:00:00Z)"
ws=$(date -u -d "$OGEVIA_RELEASE_WINDOW_START" +%s) && we=$(date -u -d "$OGEVIA_RELEASE_WINDOW_END" +%s) || stop "invalid window"; now=$(date -u +%s)
(( we > ws && we - ws <= 43200 && now >= ws && now <= we )) || stop "now is not inside a valid release window (at most 12 hours)"
R=$(A rds describe-db-instances --db-instance-identifier "$RDS_ID" --output json 2>/dev/null | jq -c '.DBInstances[0]') && [[ "$(jq -r .DBInstanceStatus <<<"$R")" == available && "$(jq -r .StorageEncrypted <<<"$R")" == true ]] || stop "$RDS_ID is not available and encrypted"
ID="ogevia-prod-postgres-pre-prdrelease-$(date -u +%Y%m%d%H%M)"
if A rds describe-db-snapshots --db-snapshot-identifier "$ID" >/dev/null 2>&1; then stop "snapshot $ID already exists (wait a minute, or use verify)"; fi
say "PROPOSED (YELLOW, creates a billable manual snapshot): aws rds create-db-snapshot --db-instance-identifier $RDS_ID --db-snapshot-identifier $ID --tags purpose=pre-prdrelease approval=$OGEVIA_DEPLOY_APPROVAL"
read -r -p "Type SNAPSHOT-NOW to create it (anything else stops, nothing changed): " ans || ans=""
[[ "$ans" == SNAPSHOT-NOW ]] || { say "Declined. Nothing was changed."; exit 0; }
A rds create-db-snapshot --db-instance-identifier "$RDS_ID" --db-snapshot-identifier "$ID" --tags Key=purpose,Value=pre-prdrelease Key=approval,Value="$OGEVIA_DEPLOY_APPROVAL" >/dev/null 2>"$B/c1.err" || stop "create-db-snapshot failed: $(tail -1 "$B/c1.err")"
say "snapshot $ID requested; waiting for it to become available (up to ${OGEVIA_SNAPSHOT_WAIT:-1800} s; the script can be re-run as: OGEVIA_PREDEPLOY_SNAPSHOT_ID=$ID bash c1-snapshot-prd.sh verify)"
T0=$(date +%s)
until [[ "$(A rds describe-db-snapshots --db-snapshot-identifier "$ID" --output json 2>/dev/null | jq -r '.DBSnapshots[0].Status // empty')" == available ]]; do
  (( $(date +%s) - T0 > ${OGEVIA_SNAPSHOT_WAIT:-1800} )) && stop "snapshot $ID is not available after ${OGEVIA_SNAPSHOT_WAIT:-1800} s; verify later with: OGEVIA_PREDEPLOY_SNAPSHOT_ID=$ID bash c1-snapshot-prd.sh verify"
  sleep "${OGEVIA_SNAPSHOT_POLL:-15}"
done
verify_snapshot "$ID"
