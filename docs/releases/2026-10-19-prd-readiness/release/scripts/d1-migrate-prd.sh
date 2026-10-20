#!/usr/bin/env bash
# =============================================================================
# D1: PRODUCTION DATABASE MIGRATION 0047-0085 on ogevia_prd (46/0046 -> 85/0085), or its rollback, through a temporary, narrow access window. YELLOW/RED: changes PRODUCTION.
# Run only after the owner's explicit GO. NOT run against AWS by anyone yet; tested with a mocked aws and a real local PostgreSQL.
#
#   OGEVIA_DEPLOY_APPROVAL=<ref> OGEVIA_EXPECT_COMMIT=<40 hex> OGEVIA_EXPECT_HOST_IP=<admin host private IP> OGEVIA_EXPECT_MIGRATIONS_SHA=<64 hex> \
#   OGEVIA_PREDEPLOY_SNAPSHOT_ID=ogevia-prod-postgres-pre-prdrelease-YYYYMMDDHHMM OGEVIA_RELEASE_WINDOW_START=... OGEVIA_RELEASE_WINDOW_END=...   bash d1-migrate-prd.sh migrate [--resume]
#   (same, plus OGEVIA_EXPECT_ROLLBACK_SHA=<64 hex>)                                                                                              bash d1-migrate-prd.sh rollback
#   bash d1-migrate-prd.sh --restore-only          after an interrupted run: remove the temporary rule and verify (idempotent)
#
# Before ANY change (all read-only): the package equals its MANIFEST and BUILD_INFO commit; the migration set equals the pinned hash (the set rehearsed on the restored copy); the
# release gate (p2-gate.sh) passes (production is exactly the p0 baseline); the pre-release snapshot is available, manual, encrypted, of ogevia-prod-postgres, created inside the window and
# at most 6 hours old; the environment is production (Lambda serves ogevia_prd with OGEVIA_ENV=prd). Inside the window: the ledger is exactly 46/0046 and its 46 checksums equal the repository's
# files (otherwise the real runner would refuse with "Drift"); a data fingerprint is recorded; the 39 files are applied with the runner's semantics (one transaction per file, advisory lock 4317001,
# `set local role ogevia_owner` unless the file starts `-- ogevia:run-as=admin`, the file's sha-256 as the ledger checksum); ledger 85/0085 with all 85 checksums; the 8 read-only verification files;
# existing data unchanged. Only then does it write $B/db-at-0085.ok (85|0085), which the API deploy guard requires. The window is closed on every exit path and the security group verified.
# ROLLBACK drops tables WITH their rows (13 of the 39 down scripts are BACKUP REQUIRED): it needs the snapshot AND a second typed phrase, and removes the marker.
# EXIT CODES: 0 completed; 1 stopped or failed (cleanup verified if a window had opened); 2 usage; 3 the temporary rule could NOT be verified removed; 130 interrupted.
# =============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib.sh"
PINNED_MIGRATIONS_SHA=ad0e2910180ddd8047347a988a903db1e2a42122cb1e73f641bf7ee7a108da49
PINNED_ROLLBACK_SHA=703c4cd9f0880b42dd38347cc2388ebb106f074647f76a3f838bab01a5f11799
ARG="${1:-}"; MODE2="${2:-}"; RESUME=0; BASELINE=0046; LAST_NEW=0085; MIGRATING=0
usage() { echo "usage: bash d1-migrate-prd.sh migrate [--resume] | rollback | --restore-only" >&2; exit 2; }
case "$ARG" in
  migrate) case "$MODE2" in "") ;; --resume) RESUME=1 ;; *) usage ;; esac ;;
  rollback|--restore-only) [[ -z "$MODE2" ]] || usage ;;
  *) usage ;;
esac
need aws jq psql sha256sum timeout python3 find comm
source "$HERE/window.sh"
WIN_PHRASE=OPEN-5432-WINDOW-MIGRATE-PRD; [[ "$ARG" == rollback ]] && WIN_PHRASE=OPEN-5432-WINDOW-ROLLBACK-PRD
D1="$B/d1"; mkdir -p "$D1"; chmod 700 "$D1"
on_exit() { local rc=$?; win_close; [[ $RC != 0 ]] && exit "$RC"; exit "$rc"; }
trap on_exit EXIT
trap 'say "Interrupted: cleaning up."; exit 130' INT TERM HUP
say "================================================================"
say "MODE: $ARG${MODE2:+ $MODE2}  (PRODUCTION, database $DB_EXPECT)   UTC $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "================================================================"
check_account
if [[ "$ARG" == --restore-only ]]; then win_restore_only; exit "$RC"; fi
[[ ! -f "$WIN_OPEN" ]] || stop "an earlier window is marked OPEN ($WIN_OPEN, started $(jq -r .stamp "$WIN_OPEN")). Run: bash d1-migrate-prd.sh --restore-only"

say ""; say "== 0. The package is exactly the approved release (read-only)"
[[ "${OGEVIA_DEPLOY_APPROVAL:-}" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || stop "set OGEVIA_DEPLOY_APPROVAL to the owner's approval reference (6-64 characters of A-Za-z0-9._-)"
[[ "${OGEVIA_EXPECT_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || stop "set OGEVIA_EXPECT_COMMIT to the full 40-character source commit of this package (BUILD_INFO.json)"
PKG_COMMIT=$(jq -er .source_commit "$PKG_ROOT/BUILD_INFO.json" 2>/dev/null) || stop "BUILD_INFO.json is missing or unreadable"
[[ "$PKG_COMMIT" == "$OGEVIA_EXPECT_COMMIT" ]] || stop "the package is built from $PKG_COMMIT, not the approved $OGEVIA_EXPECT_COMMIT"
[[ "$(jq -r .source_tree "$PKG_ROOT/BUILD_INFO.json")" == clean ]] || stop "the package was built from a DIRTY source tree"
(cd "$PKG_ROOT" && sha256sum -c --quiet MANIFEST.sha256) || stop "the package files do not match MANIFEST.sha256"
STRAYS=$(cd "$PKG_ROOT" && find . -type f -print | sed 's|^\./||' | LC_ALL=C sort | comm -23 - <(sed 's/^[0-9a-f]\{64\}  //' MANIFEST.sha256 | { cat; echo MANIFEST.sha256; } | LC_ALL=C sort))
[[ -z "$STRAYS" ]] || stop "the package has files that are not in the manifest: $(head -3 <<<"$STRAYS" | tr '\n' ';')"
setsha() { (cd "$1" && for f in $2; do printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"; done | sha256sum | cut -d' ' -f1); }
[[ "${OGEVIA_EXPECT_MIGRATIONS_SHA:-}" =~ ^[0-9a-f]{64}$ ]] || stop "set OGEVIA_EXPECT_MIGRATIONS_SHA to the 64-character migration-set hash in the README"
MIG_SHA=$(setsha "$PKG_ROOT/migrations" "00*.sql")
[[ "$MIG_SHA" == "$OGEVIA_EXPECT_MIGRATIONS_SHA" && "$MIG_SHA" == "$PINNED_MIGRATIONS_SHA" ]] || stop "the migration set hashes to $MIG_SHA; the approved (and rehearsed) set is $PINNED_MIGRATIONS_SHA and you gave ${OGEVIA_EXPECT_MIGRATIONS_SHA}"
[[ "$(ls "$PKG_ROOT"/migrations/00*.sql | wc -l)" == 39 ]] || stop "the migration set must hold exactly 39 files (0047-0085)"
if [[ "$ARG" == rollback ]]; then
  [[ "${OGEVIA_EXPECT_ROLLBACK_SHA:-}" =~ ^[0-9a-f]{64}$ ]] || stop "set OGEVIA_EXPECT_ROLLBACK_SHA to the 64-character rollback-set hash in the README"
  ROLL_SHA=$(setsha "$PKG_ROOT/rollback" "00*.down.sql")
  [[ "$ROLL_SHA" == "$OGEVIA_EXPECT_ROLLBACK_SHA" && "$ROLL_SHA" == "$PINNED_ROLLBACK_SHA" ]] || stop "the rollback set hashes to $ROLL_SHA; the approved set is $PINNED_ROLLBACK_SHA"
fi
say "package commit $PKG_COMMIT, manifest verified, no stray file; migration set sha256 ${MIG_SHA:0:16}...: OK (approval reference $OGEVIA_DEPLOY_APPROVAL)"

# the named pre-release snapshot, validated BEFORE any access is proposed
SNAP_ID="${OGEVIA_PREDEPLOY_SNAPSHOT_ID:-}"
[[ "$SNAP_ID" =~ ^ogevia-prod-postgres-pre-prdrelease-[0-9]{12}$ ]] || stop "set OGEVIA_PREDEPLOY_SNAPSHOT_ID to the named pre-release snapshot (ogevia-prod-postgres-pre-prdrelease-YYYYMMDDHHMM, UTC)"
TS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
[[ "${OGEVIA_RELEASE_WINDOW_START:-}" =~ $TS_RE && "${OGEVIA_RELEASE_WINDOW_END:-}" =~ $TS_RE ]] || stop "set OGEVIA_RELEASE_WINDOW_START and OGEVIA_RELEASE_WINDOW_END to the owner-approved window in UTC, format 2026-10-21T03:00:00Z"
W_START=$(date -u -d "$OGEVIA_RELEASE_WINDOW_START" +%s 2>/dev/null) && W_END=$(date -u -d "$OGEVIA_RELEASE_WINDOW_END" +%s 2>/dev/null) || stop "the release window is not a valid date and time"
(( W_END > W_START && W_END - W_START <= 43200 )) || stop "the release window must end after it starts and last at most 12 hours"
NOW=$(date -u +%s)
(( NOW >= W_START )) || stop "the release window has not started (starts $OGEVIA_RELEASE_WINDOW_START)"
[[ "$ARG" == rollback ]] || (( NOW <= W_END )) || stop "the release window ended at $OGEVIA_RELEASE_WINDOW_END; migrating outside it is refused"
SNAP=$(A rds describe-db-snapshots --db-snapshot-identifier "$SNAP_ID" --output json 2>/dev/null | jq -c '.DBSnapshots[0]') && [[ -n "$SNAP" && "$SNAP" != null ]] || stop "cannot read snapshot $SNAP_ID (it does not exist, or access failed)"
[[ "$(jq -r .Status <<<"$SNAP")" == available && "$(jq -r .DBInstanceIdentifier <<<"$SNAP")" == "$RDS_ID" && "$(jq -r .SnapshotType <<<"$SNAP")" == manual && "$(jq -r .Encrypted <<<"$SNAP")" == true ]] || stop "snapshot $SNAP_ID is not available, manual, encrypted and of $RDS_ID"
C_EPOCH=$(date -u -d "$(jq -r .SnapshotCreateTime <<<"$SNAP")" +%s 2>/dev/null) || stop "snapshot $SNAP_ID has no readable creation time"
(( C_EPOCH >= W_START && C_EPOCH <= W_END && C_EPOCH <= NOW )) || stop "snapshot $SNAP_ID was created outside the release window (or in the future); it was not captured for this release"
(( NOW - C_EPOCH <= ${OGEVIA_SNAPSHOT_MAX_AGE:-21600} )) || stop "snapshot $SNAP_ID is older than $(( ${OGEVIA_SNAPSHOT_MAX_AGE:-21600} / 3600 )) hours; take a fresh one"
say "snapshot $SNAP_ID: available, manual, encrypted, of $RDS_ID, created inside the release window. (A recovery PREREQUISITE only: restoring it is a RED step this package does not perform.)"

if [[ "$ARG" == migrate ]]; then
  say ""; say "== release gate (read-only): production must still be the recorded baseline, and the whole difference the release's"
  bash "$HERE/p2-gate.sh" >"$D1/gate.out" 2>&1; GRC=$?; tail -3 "$D1/gate.out" | sed 's/^/   /' | tee -a "$LOG"
  [[ $GRC == 0 ]] || stop "the release gate failed ($D1/gate.out). Nothing was changed."
fi
win_preflight
if [[ "$ARG" == rollback ]]; then
  win_propose "check the ledger is contiguous from 0047 upward, revert the migrations from the latest down to 0047 with the pinned db/rollback files (newest first, one transaction per file, the ledger row deleted in the same transaction), compare with the baseline, remove the marker. 13 of those down scripts DROP TABLES WITH THEIR ROWS and keep no copy; the snapshot $SNAP_ID is the only backup (restoring it is NOT a prepared procedure)"
  read -r -p "Second confirmation. This can DELETE DATA. Type ROLLBACK-DROPS-DATA-$DB_EXPECT to continue (anything else stops, nothing changed): " ans2 || ans2=""
  [[ "$ans2" == "ROLLBACK-DROPS-DATA-$DB_EXPECT" ]] || { say "Declined. Nothing was changed."; exit 0; }
else
  win_propose "check the ledger is $([[ $RESUME == 1 ]] && echo 'contiguous between 0047 and 0084 (--resume)' || echo 'exactly 46 / 0046 with checksums equal to the repository'), record a data fingerprint, apply the 39 migrations 0047-0085 with the runner's semantics, re-read the ledger (85 / 0085), run the 8 read-only verification files, compare the data fingerprint, write the marker"
fi
win_open
LCOUNT_Q="select count(*) || '|' || coalesce(max(version), 'none') from ogevia_meta.schema_migrations"
L=$(RO -d "$DB_EXPECT" -c "$LCOUNT_Q") || { rc=$?; stop "the ledger cannot be read in $DB_EXPECT$(tm $rc)"; }
COUNT="${L%%|*}"; LATEST="${L##*|}"; say "ledger before: $COUNT migrations applied, latest $LATEST"

if [[ "$ARG" == rollback ]]; then
  [[ "$LATEST" =~ ^00[0-9]{2}$ && "$COUNT" == "$((10#$LATEST))" && "$LATEST" > "$BASELINE" && "$LATEST" < 0086 ]] || stop "rollback needs a contiguous ledger between 0047 and 0085; found $L. Nothing was reverted."
  say ""; say "== Rollback (pinned files, newest first, one transaction per file, against $DB_EXPECT only)"
  MIGRATING=1
  for ((n = 10#$LATEST; n >= 47; n--)); do
    over_time && stop "time limit ($MAX_SECONDS s) reached before reverting $(printf '%04d' "$n")"
    v=$(printf '%04d' "$n"); f=$(ls "$PKG_ROOT"/rollback/${v}_*.down.sql 2>/dev/null | head -1); [[ -n "$f" ]] || stop "no rollback script for $v"
    say "reverting $v ($(basename "$f"))"
    if ! RW -d "$DB_EXPECT" -1 -c "select pg_advisory_xact_lock(4317001)" -c "set local statement_timeout = 120000" -c "set local role ogevia_owner" -f "$f" -c "reset role" -c "delete from ogevia_meta.schema_migrations where version = '$v'" >"$D1/rollback-$v.out" 2>&1; then
      say "ROLLBACK FAILED at $v. That file's transaction was rolled back; $v and everything below it are still applied. Last lines (no data): $(tail -3 "$D1/rollback-$v.out" | tr '\n' ' ' | cut -c1-400)"
      stop "the rollback did not complete. Ledger now: $(ledger_now)"
    fi
  done
  L=$(RO -d "$DB_EXPECT" -c "$LCOUNT_Q") || stop "the ledger cannot be re-read"; say "ledger after: ${L%%|*} migrations applied, latest ${L##*|}"
  [[ "$L" == "46|0046" ]] || stop "the ledger is $L after the rollback, expected 46|0046"
  rm -f "$B/db-at-0085.ok"; say "removed the marker $B/db-at-0085.ok (the API deploy guard will refuse until the database is migrated again)"
  if [[ -s "$D1/baseline-fp.tsv" ]]; then
    RO -d "$DB_EXPECT" -f "$PKG_ROOT/sql/fingerprint.sql" > "$D1/rollback-fp.tsv" || stop "the fingerprint query failed"
    if R=$(python3 -I -B "$PKG_ROOT/scripts/fp-compare.py" schema "$D1/baseline-fp.tsv" "$D1/rollback-fp.tsv" --allow "$PKG_ROOT/data/kept_after_rollback.txt"); then say "PASS schema equals the baseline except the objects 0047 keeps by design: $R"; else say "FAIL schema after rollback:"$'\n'"$R"; stop "the schema differs from the recorded baseline"; fi
    if R=$(python3 -I -B "$PKG_ROOT/scripts/fp-compare.py" data "$D1/baseline-fp.tsv" "$D1/rollback-fp.tsv"); then say "PASS existing data counts and content equal the baseline: $R"; else say "NOTE data differs from the baseline (rows written after the migration are expected to be gone or changed):"$'\n'"$R"; fi
  else say "NOTE: no recorded baseline fingerprint ($D1/baseline-fp.tsv): schema and data were not compared"; fi
  MIGRATING=0; win_close
  say ""; say "================ SUMMARY ================"; say "RESULT: migrations rolled back to 46 / 0046 on $DB_EXPECT. The API and web must be rolled back too (RUNBOOK, recovery)."
  [[ -f "$WIN_OPEN" ]] && say "SECURITY GROUP: NOT RESTORED, see the instructions above" || say "SECURITY GROUP: restored and verified identical to the original"
  exit "$RC"
fi

if [[ "$RESUME" == 1 ]]; then
  [[ "$LATEST" =~ ^00[0-9]{2}$ && "$COUNT" == "$((10#$LATEST))" && "$LATEST" > "$BASELINE" && "$LATEST" < "$LAST_NEW" ]] || stop "--resume needs a contiguous ledger between 0047 and 0084; found $L"
else
  [[ "$L" == "46|0046" ]] || stop "the production ledger is $L, not exactly 46|0046. Nothing was migrated."
fi
RO -d "$DB_EXPECT" -c "select version, checksum from ogevia_meta.schema_migrations order by version" > "$D1/ledger-before.tsv" || stop "cannot read the ledger rows"
head -n "$COUNT" "$PKG_ROOT/data/LEDGER_0001_0046.tsv" > "$D1/ledger-expected-before.tsv"
if [[ "$RESUME" == 1 ]]; then cat "$PKG_ROOT/data/LEDGER_0001_0046.tsv" "$PKG_ROOT/data/LEDGER_0047_0085.tsv" | head -n "$COUNT" > "$D1/ledger-expected-before.tsv"; fi
if ! diff -q "$D1/ledger-before.tsv" "$D1/ledger-expected-before.tsv" >/dev/null; then
  say "DRIFT: ledger rows that differ from the repository's files (versions only): $(diff <(cut -f1,2 "$D1/ledger-before.tsv") <(cut -f1,2 "$D1/ledger-expected-before.tsv") | grep -E '^[<>]' | awk '{print $2}' | sort -u | tr '\n' ' ')"
  stop "the production ledger checksums do not match the repository: the real runner would refuse. Nothing was migrated."
fi
say "ledger checksums equal the repository's files ($COUNT rows)"
if [[ "$RESUME" == 1 && -s "$D1/baseline-fp.tsv" ]]; then say "resuming: the baseline fingerprint recorded before the first run is kept ($D1/baseline-fp.tsv)"
else RO -d "$DB_EXPECT" -f "$PKG_ROOT/sql/fingerprint.sql" > "$D1/baseline-fp.tsv" || stop "the baseline fingerprint query failed"; say "baseline fingerprint recorded: $(wc -l < "$D1/baseline-fp.tsv") keys ($D1/baseline-fp.tsv)"; fi

say ""; say "== Migrations (the runner's semantics, one transaction per file, against $DB_EXPECT only)"
MIGRATING=1; : > "$D1/migrate.log"; T0=$(date +%s)
for f in "$PKG_ROOT"/migrations/00*.sql; do
  name=$(basename "$f"); v=${name:0:4}; [[ "$v" > "$LATEST" ]] || continue
  over_time && stop "time limit ($MAX_SECONDS s) reached before applying $name"
  sum=$(sha256sum "$f" | cut -d' ' -f1); S=$(date +%s%3N); ROLE=(-c "set local role ogevia_owner"); head -1 "$f" | grep -q '^-- ogevia:run-as=admin' && ROLE=()
  if RW -d "$DB_EXPECT" -1 -c "select pg_advisory_xact_lock(4317001)" "${ROLE[@]}" -f "$f" -c "reset role" -c "insert into ogevia_meta.schema_migrations (version, name, checksum) values ('$v', '$name', '$sum')" >"$D1/migrate-$v.out" 2>&1; then
    printf '%s\t%s\t%s ms\n' "$v" "$name" "$(( $(date +%s%3N) - S ))" | tee -a "$D1/migrate.log"
  else
    say "MIGRATION FAILED at $name. That file's transaction was rolled back; it and later files are NOT applied; earlier files remain applied. Last lines (no data): $(tail -3 "$D1/migrate-$v.out" | tr '\n' ' ' | cut -c1-400)"
    say "Ledger now: $(ledger_now)"
    stop "the migration did not complete. DO NOT deploy the API or web. Do not edit an applied file; fix forward. Resume with --resume only after the cause is fixed."
  fi
done
RW -d "$DB_EXPECT" -c "grant usage on schema ogevia_meta to ogevia_readonly" -c "grant select on ogevia_meta.schema_migrations to ogevia_readonly" >/dev/null 2>&1 || stop "the final grants on ogevia_meta failed"
say "applied in $(( $(date +%s) - T0 )) s (timings: $D1/migrate.log)"
L=$(RO -d "$DB_EXPECT" -c "$LCOUNT_Q") || stop "the ledger cannot be re-read"; say "ledger after: ${L%%|*} migrations applied, latest ${L##*|}"
[[ "$L" == "85|$LAST_NEW" ]] || stop "the ledger is $L after the runner loop, expected 85|$LAST_NEW"
RO -d "$DB_EXPECT" -c "select version, checksum from ogevia_meta.schema_migrations order by version" > "$D1/ledger-after.tsv" || stop "cannot read the ledger rows"
cat "$PKG_ROOT/data/LEDGER_0001_0046.tsv" "$PKG_ROOT/data/LEDGER_0047_0085.tsv" > "$D1/ledger-expected-after.tsv"
diff -q "$D1/ledger-after.tsv" "$D1/ledger-expected-after.tsv" >/dev/null && say "PASS all 85 ledger checksums equal the repository's files" || stop "the ledger checksums after the migration differ from the repository's files. The migrations ARE applied; do not deploy."

say ""; say "== Verification set (read-only transactions)"
VF=0; VP=0
for f in "$PKG_ROOT"/verification/*.sql; do
  OUTV=$(RO -d "$DB_EXPECT" -c "begin transaction read only" -f "$f" -c "rollback" 2>&1) || { say "FAIL verification $(basename "$f") could not run: $(printf '%s' "$OUTV" | tail -1 | cut -c1-200)"; VF=$((VF + 1)); continue; }
  F=$(printf '%s\n' "$OUTV" | awk -F'\t' '$2=="f"' | wc -l); N=$(printf '%s\n' "$OUTV" | grep -c . || true)
  if [[ "$F" == 0 ]]; then say "PASS verification $(basename "$f"): $N check rows, none failed"; VP=$((VP + 1)); else say "FAIL verification $(basename "$f"): $F failed: $(printf '%s\n' "$OUTV" | awk -F'\t' '$2=="f"{print $1}' | tr '\n' ' ')"; VF=$((VF + 1)); fi
done
[[ "$VF" == 0 && "$VP" == 8 ]] || stop "the verification set did not pass ($VP of 8 files; $VF failed). The migrations ARE applied; do not deploy the API or web; see the RUNBOOK."
RO -d "$DB_EXPECT" -f "$PKG_ROOT/sql/fingerprint.sql" > "$D1/after-fp.tsv" || stop "the fingerprint query failed"
if R=$(python3 -I -B "$PKG_ROOT/scripts/fp-compare.py" data "$D1/baseline-fp.tsv" "$D1/after-fp.tsv"); then say "PASS existing data unchanged: $R"; else say "FAIL existing data:"$'\n'"$R"; stop "existing production data differs from the baseline taken before the migration. The migrations ARE applied; do not deploy."; fi
MIGRATING=0
printf '85|%s\n' "$LAST_NEW" > "$B/db-at-0085.ok"; printf '%s\n' "$SNAP_ID" > "$B/db-at-0085.snapshot"
win_close
say ""; say "================ SUMMARY ================"
say "Environment : PRODUCTION ($DB_EXPECT)   package commit $PKG_COMMIT   approval $OGEVIA_DEPLOY_APPROVAL"
say "RESULT: migrations 0047 to $LAST_NEW applied; ledger 85 / $LAST_NEW; verification $VP of 8 files PASS; existing data unchanged; marker $B/db-at-0085.ok written."
say "NEXT (do not wait): deploy the API now (the old API fails against the new schema): bash deploy-guard-prd.sh deploy Ogevia-prd-ServiceVerificationApi, then d3-web-prd.sh."
[[ -f "$WIN_OPEN" ]] && say "SECURITY GROUP: NOT RESTORED, see the instructions above" || say "SECURITY GROUP: restored and verified identical to the original"
exit "$RC"
