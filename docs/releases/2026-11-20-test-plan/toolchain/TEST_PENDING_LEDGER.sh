#!/usr/bin/env bash
# TEST database only: Release Train 2 migrations 0113-0116, ONE migration per run, each in ONE transaction with its ledger row.
# Same rules as TEST_0112_LEDGER.sh (owner rule 2026-11-10: never untracked SQL; version, filename and SHA-256 recorded in
# ogevia_meta.schema_migrations in the same transaction; rollback removes the row in the same transaction).
#
#   TEST_PENDING_LEDGER.sh probe    <0113|0114|0115|0116>   read-only: identity, ledger, prerequisites, target absent
#   TEST_PENDING_LEDGER.sh apply    <migration>             needs OGEVIA_DEPLOY_APPROVAL + OGEVIA_TEST_BACKUP (+ .sha256)
#   TEST_PENDING_LEDGER.sh verify   <migration>             read-only: ledger row with the file's checksum, VERIFY_PENDING.sql all true
#   TEST_PENDING_LEDGER.sh rollback <migration>             needs OGEVIA_DEPLOY_APPROVAL; runs the down script + removes the row atomically
#
# Order: 0113, 0114, 0115, 0116 (0113 needs 0110, 0111 and 0091; 0115 needs 0105; 0116 needs 0106 - checked from the ledger below).
# Roll back in reverse order. Connection = the operator's own libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE=ogevia_sv_test).
# This script never reads a secret store and never prints a password. A database not named ogevia_sv_test, or containing "prd", is refused.
# Unlike the 0112 script it does not assume an exact ledger row count (the TEST ledger is read and reported, not guessed); it requires the
# prerequisite versions to be recorded and the target to be absent. Run `probe` first and read the ledger line it prints.
set -euo pipefail
set +x +H
umask 077
stop() { echo "STOP: $*" >&2; exit 2; }
MODE="${1:-}"; MIG="${2:-}"
case "$MODE" in probe|apply|verify|rollback) ;; *) stop "usage: probe|apply|verify|rollback <0113|0114|0115|0116>";; esac
case "$MIG" in
  0113) STEM=0113_notifications;               NEED="0091 0110 0111";;
  0114) STEM=0114_office_branding;             NEED="0113";;
  0115) STEM=0115_import_history_rollback;     NEED="0105 0114";;
  0116) STEM=0116_staff_merge_hardening;       NEED="0106 0115";;
  *) stop "migration must be one of 0113 0114 0115 0116";;
esac
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO:-$(cd "$HERE/../../../.." && pwd)}"
UP="$REPO/infra/aws/db/pending/migrations/$STEM.sql"
DOWN="$REPO/infra/aws/db/pending/rollback/$STEM.down.sql"
VERIFY="$HERE/VERIFY_PENDING.sql"
for f in "$UP" "$DOWN" "$VERIFY"; do [[ -f "$f" ]] || stop "missing file: $f (set REPO to a checkout of the release branch)"; done
UP_SHA="$(sha256sum -- "$UP" | cut -d' ' -f1)"
LOCK=$((4317200 + 10#${MIG:2}))

DB="${PGDATABASE:-}"
[[ "$DB" == ogevia_sv_test ]] || stop "PGDATABASE must be ogevia_sv_test (got '${DB:-unset}')"
[[ "$DB" != *prd* ]] || stop "a production database name is never allowed"
Q() { psql -X -At -v ON_ERROR_STOP=1 -c "$1" 2>&1 | sed -E 's#postgres://[^ ]*#postgres://<redacted>#g'; return "${PIPESTATUS[0]}"; }
CUR="$(Q 'select current_database()')" || stop "cannot connect (check PGHOST, PGPORT, PGUSER, PGPASSWORD in your shell)"
[[ "$CUR" == "$DB" ]] || stop "connected to '$CUR', expected '$DB'"
LEDGER="$(Q 'select count(*)||'"'"'/'"'"'||max(version) from ogevia_meta.schema_migrations')"
HAS_ROW="$(Q "select count(*) from ogevia_meta.schema_migrations where version = '$MIG'")"
MISSING=""
for v in $NEED; do n="$(Q "select count(*) from ogevia_meta.schema_migrations where version = '$v'")"; [[ "$n" == 1 ]] || MISSING="$MISSING $v"; done
echo "database: $CUR   ledger (rows/last): $LEDGER   $MIG rows: $HAS_ROW   prerequisites missing:${MISSING:- none}"

verify_sql() { # expect absent|present
  local out rows bad
  out="$(psql -X -At -F '|' -v ON_ERROR_STOP=1 -v mig="$MIG" -v expect="$1" -f "$VERIFY" 2>&1)" || { echo "$out" | sed -E 's#postgres://[^ ]*#postgres://<redacted>#g'; return 1; }
  rows="$(echo "$out" | grep -c '|' || true)"; bad="$(echo "$out" | grep -c '|f|' || true)"
  echo "VERIFY_PENDING $MIG ($1): $rows checks, $bad failing"
  [[ "$rows" -ge 3 && "$bad" -eq 0 ]]
}
require_approval() { [[ -n "${OGEVIA_DEPLOY_APPROVAL:-}" ]] || stop "no explicit owner approval reference (set OGEVIA_DEPLOY_APPROVAL)"; }

case "$MODE" in
  probe)
    [[ -z "$MISSING" ]] || stop "prerequisite migrations not recorded in the TEST ledger:$MISSING"
    [[ "$HAS_ROW" == 0 ]] || stop "$MIG is already recorded"
    verify_sql absent || stop "$MIG objects already exist or the check failed"
    echo "PROBE OK: prerequisites present, $MIG absent. Nothing was changed."
    ;;
  apply)
    require_approval
    [[ -z "$MISSING" && "$HAS_ROW" == 0 ]] || stop "prerequisites missing or $MIG already recorded; run probe"
    BK="${OGEVIA_TEST_BACKUP:-}"
    [[ -n "$BK" && -s "$BK" && -f "$BK.sha256" ]] || stop "set OGEVIA_TEST_BACKUP to a NON-EMPTY TEST logical backup (with its .sha256) taken for this release"
    [[ "$(stat -c %s "$BK")" -ge 100000 ]] || stop "the backup is smaller than 100 kB; a real TEST dump is larger. Check that pg_dump finished"
    if command -v pg_restore >/dev/null; then pg_restore --list "$BK" >/dev/null 2>&1 || stop "the backup is not a readable pg_dump custom-format archive"; fi
    (cd "$(dirname "$BK")" && sha256sum --check --status "$(basename "$BK").sha256") || stop "backup checksum does not match"
    verify_sql absent || stop "pre-check failed"
    set +e
    psql -X -v ON_ERROR_STOP=1 -1 \
      -c "select pg_advisory_xact_lock($LOCK)" \
      -c "do \$\$ begin if exists (select 1 from ogevia_meta.schema_migrations where version = '$MIG') then raise exception 'Migration already recorded; do not reapply'; end if; end \$\$" \
      -c "set local role ogevia_owner" -f "$UP" -c "reset role" \
      -c "insert into ogevia_meta.schema_migrations(version,name,checksum) values ('$MIG','$STEM.sql','$UP_SHA')" 2>&1 | sed -E 's#postgres://[^ ]*#postgres://<redacted>#g'
    rc=${PIPESTATUS[0]}; set -e
    [[ "$rc" == 0 ]] || stop "apply failed; the transaction rolled back, nothing changed"
    echo "APPLIED $MIG with its ledger row, in one transaction. Now run: verify $MIG"
    ;;
  verify)
    ROW="$(Q "select count(*) from ogevia_meta.schema_migrations where version = '$MIG' and name = '$STEM.sql' and checksum = '$UP_SHA'")"
    [[ "$ROW" == 1 ]] || { echo "!!! the $MIG ledger row is missing or its checksum differs from the file in this checkout"; exit 1; }
    verify_sql present || { echo "!!! POST-STATE DOES NOT MATCH"; exit 1; }
    echo "VERIFIED $MIG: recorded with the checksum of this checkout's file, object checks pass."
    ;;
  rollback)
    require_approval
    ROW="$(Q "select count(*) from ogevia_meta.schema_migrations where version = '$MIG' and name = '$STEM.sql' and checksum = '$UP_SHA'")"
    [[ "$ROW" == 1 ]] || stop "$MIG is not recorded as applied with this checkout's checksum"
    set +e
    psql -X -v ON_ERROR_STOP=1 -1 \
      -c "select pg_advisory_xact_lock($LOCK)" \
      -c "set local role ogevia_owner" -f "$DOWN" -c "reset role" \
      -c "delete from ogevia_meta.schema_migrations where version = '$MIG'" 2>&1 | sed -E 's#postgres://[^ ]*#postgres://<redacted>#g'
    rc=${PIPESTATUS[0]}; set -e
    [[ "$rc" == 0 ]] || stop "rollback failed; the transaction rolled back, nothing changed"
    echo "ROLLED BACK $MIG and removed its ledger row, in one transaction. Roll back later migrations first (reverse order)."
    ;;
esac
