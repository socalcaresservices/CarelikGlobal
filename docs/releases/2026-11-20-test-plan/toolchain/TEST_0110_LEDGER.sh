#!/usr/bin/env bash
# TEST database only: migration 0110 (offices) with the migration ledger, in ONE transaction per change.
# Owner rule (2026-11-10): a pending migration is never applied as untracked SQL. Version, filename and SHA-256 go into
# ogevia_meta.schema_migrations in the same transaction as the SQL; rollback removes the row in the same transaction.
#
#   probe      read-only: identity, baseline ledger 108/0109 (0109 recorded with its checksum), 0110 absent, no 0110 objects                     (no approval needed)
#   apply      needs OGEVIA_DEPLOY_APPROVAL and a verified TEST backup (OGEVIA_TEST_BACKUP + .sha256)
#   verify     read-only: ledger 109 rows / 0110 recorded with the pinned checksum, all VERIFY_0110 checks true
#   rollback   needs OGEVIA_DEPLOY_APPROVAL; runs the pinned down script and removes the ledger row atomically
#
# The connection is the operator's own: standard libpq variables (PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE) from their shell,
# for example through the same tunnel the other TEST operator scripts use. This script never reads a secret store and never prints a password.
# REPO = a checkout at the pinned commit (default: the repository containing this file).
# It refuses anything that is not the isolated TEST database: PGDATABASE and current_database() must be ogevia_sv_test, the ledger must be
# exactly the accepted TEST ledger, and a name containing "prd" is always refused. OGEVIA_LOCAL_REHEARSAL=1 allows a local disposable database
# named ogevia_test_<12 hex> on 127.0.0.1 or localhost only (used by the automated test); it never widens a real target.
set -euo pipefail
set +x +H
umask 077
stop() { echo "STOP: $*" >&2; exit 2; }
MODE="${1:-}"
case "$MODE" in probe|apply|verify|rollback) ;; *) stop "usage: probe | apply | verify | rollback";; esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO:-$(cd "$HERE/../../../.." && pwd)}"
UP="$REPO/infra/aws/db/pending/migrations/0110_offices.sql"
DOWN="$REPO/infra/aws/db/pending/rollback/0110_offices.down.sql"
VERIFY="$HERE/VERIFY_0110.sql"
STEM=0110_offices
# Pinned bytes. A changed file stops the run.
UP_SHA=76dc0f2a8f8e5a080499f7c4514c718c40403ac6772eedbf841a7c22f3597951
DOWN_SHA=db1c19d88a715752189bcb9dcbed2a96c304a409c0663bf61f6b11c291a3c15a
VERIFY_SHA=54dbcc0c7998b311427412c128e869a8927023dc9dba96b111aabb17dc9fe859
SHA_0109=2c0ebb9e91e5a88d52f4cd323a82c7b691fb85197c74f80ca98ee774642cd25b
BASE_COUNT=108; BASE_LAST=0109; AFTER_COUNT=109; AFTER_LAST=0110

sha_of() { sha256sum -- "$1" | cut -d' ' -f1; }
for pair in "$UP:$UP_SHA" "$DOWN:$DOWN_SHA" "$VERIFY:$VERIFY_SHA"; do
  f="${pair%%:*}"; want="${pair##*:}"
  [[ -f "$f" ]] || stop "missing file: $f (set REPO to a checkout at the pinned commit)"
  [[ "$(sha_of "$f")" == "$want" ]] || stop "file differs from the pinned bytes: $(basename "$f")"
done

DB="${PGDATABASE:-}"
if [[ "${OGEVIA_LOCAL_REHEARSAL:-}" == 1 ]]; then
  [[ "$DB" =~ ^ogevia_test_[0-9a-f]{12}$ ]] || stop "rehearsal needs a local disposable database named ogevia_test_<12 hex> (the test suite's naming)"
  case "${PGHOST:-localhost}" in localhost|127.0.0.1|"") ;; *) stop "rehearsal is local only";; esac
else
  [[ "$DB" == ogevia_sv_test ]] || stop "PGDATABASE must be ogevia_sv_test (got '${DB:-unset}')"
fi
[[ "$DB" != *prd* ]] || stop "a production database name is never allowed"

Q() { psql -X -At -v ON_ERROR_STOP=1 -c "$1" 2>&1 | sed -E 's#postgres://[^ ]*#postgres://<redacted>#g'; return "${PIPESTATUS[0]}"; }
CUR="$(Q 'select current_database()')" || stop "cannot connect (check PGHOST, PGPORT, PGUSER, PGPASSWORD in your shell)"
[[ "$CUR" == "$DB" ]] || stop "connected to '$CUR', expected '$DB'"
LEDGER="$(Q 'select count(*)||'"'"'/'"'"'||max(version) from ogevia_meta.schema_migrations')"
HAS_ROW="$(Q "select count(*) from ogevia_meta.schema_migrations where version = '0110'")"
HAS_0109="$(Q "select count(*) from ogevia_meta.schema_migrations where version = '0109' and name = '0109_request_cleanup.sql' and checksum = '$SHA_0109'")"
echo "database: $CUR   ledger: $LEDGER   0109 recorded with its checksum: $HAS_0109   0110 ledger rows: $HAS_ROW"

verify_sql() { # expect absent|present; ledger absent|present
  local out rows bad
  out="$(psql -X -At -F '|' -v ON_ERROR_STOP=1 -v expect="$1" -v ledger="$2" -f "$VERIFY" 2>&1)" || { echo "$out" | sed -E 's#postgres://[^ ]*#postgres://<redacted>#g'; return 1; }
  rows="$(echo "$out" | grep -c '|' || true)"; bad="$(echo "$out" | grep -c '|f|' || true)"
  echo "VERIFY_0110 ($1/$2): $rows checks, $bad failing"
  [[ "$rows" -ge 37 && "$bad" -eq 0 ]]
}
require_approval() { [[ -n "${OGEVIA_DEPLOY_APPROVAL:-}" ]] || stop "no explicit owner approval reference (set OGEVIA_DEPLOY_APPROVAL)"; }

case "$MODE" in
  probe)
    [[ "$LEDGER" == "$BASE_COUNT/$BASE_LAST" && "$HAS_0109" == 1 && "$HAS_ROW" == 0 ]] || stop "not the baseline this release was prepared for (expected $BASE_COUNT/$BASE_LAST with 0109 recorded and no 0110 row)"
    verify_sql absent absent || stop "0110 objects already exist or the check failed"
    echo "PROBE OK: baseline $BASE_COUNT/$BASE_LAST, 0110 absent. Nothing was changed."
    ;;
  apply)
    require_approval
    [[ "$LEDGER" == "$BASE_COUNT/$BASE_LAST" && "$HAS_0109" == 1 && "$HAS_ROW" == 0 ]] || stop "not the baseline (expected $BASE_COUNT/$BASE_LAST with 0109 recorded and no 0110 row)"
    BK="${OGEVIA_TEST_BACKUP:-}"
    [[ -n "$BK" && -f "$BK" && -f "$BK.sha256" ]] || stop "set OGEVIA_TEST_BACKUP to the TEST logical backup (with its .sha256) taken for this release"
    (cd "$(dirname "$BK")" && sha256sum --check --status "$(basename "$BK").sha256") || stop "backup checksum does not match"
    verify_sql absent absent || stop "pre-check failed"
    set +e
    psql -X -v ON_ERROR_STOP=1 -1 \
      -c "select pg_advisory_xact_lock(4317110)" \
      -c "do \$\$ begin if exists (select 1 from ogevia_meta.schema_migrations where version = '0110') then raise exception 'Migration already recorded; do not reapply'; end if; end \$\$" \
      -c "set local role ogevia_owner" -f "$UP" -c "reset role" \
      -c "insert into ogevia_meta.schema_migrations(version,name,checksum) values ('0110','$STEM.sql','$UP_SHA')" 2>&1 | sed -E 's#postgres://[^ ]*#postgres://<redacted>#g'
    rc=${PIPESTATUS[0]}; set -e
    [[ "$rc" == 0 ]] || stop "apply failed; the transaction rolled back, nothing changed"
    echo "APPLIED 0110 with its ledger row, in one transaction. Now run: verify"
    ;;
  verify)
    [[ "$LEDGER" == "$AFTER_COUNT/$AFTER_LAST" ]] || { echo "!!! ledger is $LEDGER, expected $AFTER_COUNT/$AFTER_LAST"; exit 1; }
    ROW="$(Q "select count(*) from ogevia_meta.schema_migrations where version = '0110' and name = '$STEM.sql' and checksum = '$UP_SHA'")"
    [[ "$ROW" == 1 && "$HAS_0109" == 1 ]] || { echo "!!! the 0110 (or 0109) ledger row is missing or its checksum differs"; exit 1; }
    verify_sql present present || { echo "!!! POST-STATE DOES NOT MATCH"; exit 1; }
    echo "VERIFIED: ledger $AFTER_COUNT/$AFTER_LAST, 0109 and 0110 recorded with the pinned checksum, all object checks pass."
    ;;
  rollback)
    require_approval
    ROW="$(Q "select count(*) from ogevia_meta.schema_migrations where version = '0110' and name = '$STEM.sql' and checksum = '$UP_SHA'")"
    [[ "$LEDGER" == "$AFTER_COUNT/$AFTER_LAST" && "$ROW" == 1 ]] || stop "0110 is not recorded as applied with the pinned checksum (ledger $LEDGER)"
    set +e
    psql -X -v ON_ERROR_STOP=1 -1 \
      -c "select pg_advisory_xact_lock(4317110)" \
      -c "do \$\$ begin if not exists (select 1 from ogevia_meta.schema_migrations where version = '0110' and checksum = '$UP_SHA' and name = '$STEM.sql') then raise exception 'Missing or changed migration ledger row'; end if; end \$\$" \
      -c "set local role ogevia_owner" -f "$DOWN" -c "reset role" \
      -c "delete from ogevia_meta.schema_migrations where version = '0110'" 2>&1 | sed -E 's#postgres://[^ ]*#postgres://<redacted>#g'
    rc=${PIPESTATUS[0]}; set -e
    [[ "$rc" == 0 ]] || stop "rollback failed; the transaction rolled back, nothing changed"
    echo "ROLLED BACK 0110 and removed its ledger row, in one transaction. Office names and client office assignments are removed with the table. Run: probe"
    ;;
esac
