#!/usr/bin/env bash
# F: PRODUCTION SYNTHETIC-DATA CLEANUP of ogevia_prd (owner decision: clean slate, caregivers included). YELLOW/RED when it runs in dryrun or commit mode.
# FOR OWNER REVIEW. NOT run against AWS. Mock-tested: infra/aws/db/test/prd-cleanup-script.db.test.ts (mocked aws, real local PostgreSQL named ogevia_prd; 12 tests, mutation-checked). The SQL it runs is tested separately.
# It reuses common.sh -> lib.sh + window.sh UNCHANGED; it adds no new access mechanism.
#
#   OGEVIA_DEPLOY_APPROVAL=<ref> bash f-cleanup-prd.sh counts              YELLOW, READ ONLY. Opens the temporary database window; prints the pre-cleanup counts, record-level evidence,
#                                                                          sign-in identities and object-store references (section A-F of sql/prd-cleanup-readonly-counts.sql). Writes nothing to the database.
#   OGEVIA_DEPLOY_APPROVAL=<ref> OGEVIA_CLEANUP_EXPECT_CLIENTS=<n> OGEVIA_CLEANUP_EXPECT_AUTHS=<n> OGEVIA_CLEANUP_EXPECT_SHIFTS=<n> bash f-cleanup-prd.sh dryrun
#                                                                          YELLOW. Runs sql/prd-synthetic-cleanup.sql with NO commit: lifts the delete guards, deletes, verifies, restores the guards, then ROLLS BACK.
#   (same variables) OGEVIA_CLEANUP_SNAPSHOT_ID=ogevia-prod-postgres-pre-cleanup-YYYYMMDDHHMM  bash f-cleanup-prd.sh commit
#                                                                          RED. Same script with do_commit=1. Needs a fresh manual, available, encrypted snapshot (at most 2 hours old) and a second typed phrase.
#   bash f-cleanup-prd.sh --restore-only                                   after an interrupted run: remove the temporary rule and verify (idempotent).
# It connects to ogevia_prd only (the SQL also aborts on any other database name). It never names, connects to or queries ogevia_sv_test. It never touches Cognito or S3.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../../2026-10-21-auth-separation/scripts/common.sh"
ARG="${1:-}"; MIGRATING=0
[[ $# -eq 1 && "$ARG" =~ ^(counts|dryrun|commit|--restore-only)$ ]] || { echo "usage: bash f-cleanup-prd.sh counts|dryrun|commit|--restore-only" >&2; exit 2; }
need aws jq timeout psql
SQLDIR="$HERE/../sql"
[[ -f "$SQLDIR/prd-synthetic-cleanup.sql" && -f "$SQLDIR/prd-cleanup-readonly-counts.sql" ]] || stop "the SQL files were not found ($SQLDIR)"
[[ "${OGEVIA_DEPLOY_APPROVAL:-}" =~ $APPROVAL_RE || "$ARG" == --restore-only ]] || stop "set OGEVIA_DEPLOY_APPROVAL to the approval reference"
NUMRE='^[0-9]{1,6}$'
if [[ "$ARG" == dryrun || "$ARG" == commit ]]; then
  for v in OGEVIA_CLEANUP_EXPECT_CLIENTS OGEVIA_CLEANUP_EXPECT_AUTHS OGEVIA_CLEANUP_EXPECT_SHIFTS; do [[ "${!v:-}" =~ $NUMRE ]] || stop "set $v to the count read by 'counts' mode"; done
fi
SNAP="${OGEVIA_CLEANUP_SNAPSHOT_ID:-}"
verify_snapshot() {   # manual, available, encrypted, of ogevia-prod-postgres, created at most 2 hours ago
  local S st ty en db ct age
  [[ "$SNAP" =~ ^ogevia-prod-postgres-pre-cleanup-[0-9]{12}$ ]] || stop "OGEVIA_CLEANUP_SNAPSHOT_ID must look like ogevia-prod-postgres-pre-cleanup-YYYYMMDDHHMM"
  S=$(A rds describe-db-snapshots --db-snapshot-identifier "$SNAP" --output json 2>/dev/null | jq -c '.DBSnapshots[0]') && [[ -n "$S" && "$S" != null ]] || stop "cannot read snapshot $SNAP"
  st=$(jq -r .Status <<<"$S"); ty=$(jq -r .SnapshotType <<<"$S"); en=$(jq -r .Encrypted <<<"$S"); db=$(jq -r .DBInstanceIdentifier <<<"$S"); ct=$(jq -r .SnapshotCreateTime <<<"$S")
  [[ "$st" == available && "$ty" == manual && "$en" == true && "$db" == ogevia-prod-postgres ]] || stop "snapshot $SNAP is $st/$ty/encrypted=$en/instance=$db (need available/manual/true/ogevia-prod-postgres)"
  age=$(( $(date +%s) - $(date -u -d "$ct" +%s 2>/dev/null || echo 0) ))
  (( age >= 0 && age <= 7200 )) || stop "snapshot $SNAP is $((age/60)) minutes old (need at most 120); take a fresh one"
  ok "snapshot $SNAP is available, manual, encrypted, of ogevia-prod-postgres, $((age/60)) minutes old"
}
source "$VENDOR/window.sh"
case "$ARG" in counts) WIN_PHRASE=OPEN-5432-WINDOW-CLEANUP-COUNTS ;; dryrun) WIN_PHRASE=OPEN-5432-WINDOW-CLEANUP-DRYRUN ;; commit) WIN_PHRASE=OPEN-5432-WINDOW-CLEANUP-COMMIT ;; esac
on_exit() { local rc=$?; win_close; [[ $RC != 0 ]] && exit "$RC"; exit "$rc"; }
trap on_exit EXIT
trap 'say "Interrupted: cleaning up."; exit 130' INT TERM HUP
say "== F production synthetic-data cleanup: $ARG (PRODUCTION $DB_EXPECT) UTC $(date -u +%FT%TZ)"
check_account
if [[ "$ARG" == --restore-only ]]; then win_restore_only; exit "$RC"; fi
[[ ! -f "$WIN_OPEN" ]] || stop "an earlier window is marked OPEN ($WIN_OPEN). Run: bash f-cleanup-prd.sh --restore-only"
[[ "$ARG" != commit ]] || verify_snapshot
# window.sh reads the handler function name from here (same as b-admin-prd.sh)
FN=$(A cloudformation list-stack-resources --stack-name "$API_STACK" --output json 2>/dev/null | jq -r '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId | startswith("Handler")))][0].PhysicalResourceId // empty')
[[ -n "$FN" ]] || stop "cannot find the API handler function"; printf '%s\n' "$FN" > "$B/handler-function-name.txt"
case "$ARG" in
  counts) PROP="READ ONLY: count every table, read record-level evidence, sign-in identities and object-store references in $DB_EXPECT (nothing is written)" ;;
  dryrun) PROP="DRY RUN of the cleanup: lift the 32 delete guards, delete 64 tables' rows, verify, restore the guards, then ROLL BACK (nothing is kept; brief table locks)" ;;
  commit) PROP="COMMIT the cleanup: permanently delete all synthetic operational data (64 tables, caregiver memberships) from $DB_EXPECT; audit_events is kept. Undo only by restoring snapshot $SNAP" ;;
esac
win_preflight
win_propose "$PROP"
if [[ "$ARG" == commit ]]; then
  read -r -p "Second confirmation. Type DELETE-PRD-SYNTHETIC-DATA to permanently delete (anything else stops, nothing changed): " ans2 || ans2=""
  [[ "$ans2" == DELETE-PRD-SYNTHETIC-DATA ]] || { say "Declined. Nothing was changed."; exit 0; }
fi
win_open
mkdir -p "$B/cleanup" && chmod 700 "$B/cleanup"; OUT="$B/cleanup/$ARG-$WIN_STAMP.txt"; : > "$OUT"; chmod 600 "$OUT"
say "output file (contains sign-in identifiers; keep it private): $OUT"
case "$ARG" in
  counts)
    RO -d "$DB_EXPECT" -f "$SQLDIR/prd-cleanup-readonly-counts.sql" 2>&1 | tee -a "$OUT" | sed 's/^/   /'
    [[ ${PIPESTATUS[0]} -eq 0 ]] && ok "read-only counts completed" || { nope "the read-only counts failed"; RC=1; } ;;
  dryrun|commit)
    EXTRA=(); [[ "$ARG" == commit ]] && EXTRA=(-v do_commit=1)
    RW -d "$DB_EXPECT" -v exp_clients="$OGEVIA_CLEANUP_EXPECT_CLIENTS" -v exp_auths="$OGEVIA_CLEANUP_EXPECT_AUTHS" -v exp_shifts="$OGEVIA_CLEANUP_EXPECT_SHIFTS" "${EXTRA[@]}" -f "$SQLDIR/prd-synthetic-cleanup.sql" 2>&1 | tee -a "$OUT" | sed 's/^/   /'
    if [[ ${PIPESTATUS[0]} -eq 0 ]]; then ok "$ARG completed (psql exit 0)"; else nope "$ARG FAILED: the transaction was rolled back; read the error above"; RC=1; fi
    AFTER=$(RO -d "$DB_EXPECT" -c "select (select count(*) from ogevia.clients) || ' clients, ' || (select count(*) from ogevia.shifts) || ' shifts, ' || (select count(*) from ogevia.caregiver_records) || ' caregiver records, ' || (select count(*) from ogevia.audit_events) || ' audit events, ' || (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='ogevia' and not t.tgisinternal and t.tgenabled<>'O') || ' guards not enabled'") || { nope "cannot read the after-counts"; RC=1; }
    say "after $ARG: $AFTER" ;;
esac
win_close
say "SECURITY GROUP: $([[ -f "$WIN_OPEN" ]] && echo 'NOT RESTORED, see the instructions above' || echo 'restored and verified identical to the original')"
exit "${RC:-0}"
