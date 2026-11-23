#!/usr/bin/env bash
# TEST database only: migration 0111 (office assignments, counties, caregiver colors) with the migration ledger, in ONE transaction per change.
# Owner rule (2026-11-10): a pending migration is never applied as untracked SQL. Version, filename and SHA-256 go into
# ogevia_meta.schema_migrations in the same transaction as the SQL; rollback removes the row in the same transaction.
#
#   probe      read-only: identity, baseline ledger 109/0110 (0110 recorded with its checksum), 0111 absent, no 0111 objects                     (no approval needed)
#   apply      needs OGEVIA_DEPLOY_APPROVAL and a verified TEST backup (OGEVIA_TEST_BACKUP + .sha256)
#   verify     read-only: ledger 110 rows / 0111 recorded with the pinned checksum, all VERIFY_0111 checks true
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
UP="$REPO/infra/aws/db/pending/migrations/0111_office_assignments_counties_colors.sql"
DOWN="$REPO/infra/aws/db/pending/rollback/0111_office_assignments_counties_colors.down.sql"
VERIFY="$HERE/VERIFY_0111.sql"
STEM=0111_office_assignments_counties_colors
# Pinned bytes. A changed file stops the run.
UP_SHA=d09dbb181b37e7d49c7127ee71962c63c7709bc72ee5187b588d6da6cb4926ed
DOWN_SHA=556f9343795cf25a2dc9376bdc0b3e0f19fb66202547411e370f7c2a5d515af9
VERIFY_SHA=f18fa663d7305a574acf1661592c7246b0881f128eaf80f758bbf40636c23a1f
SHA_0110=76dc0f2a8f8e5a080499f7c4514c718c40403ac6772eedbf841a7c22f3597951
BASE_COUNT=109; BASE_LAST=0110; AFTER_COUNT=110; AFTER_LAST=0111

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
HAS_ROW="$(Q "select count(*) from ogevia_meta.schema_migrations where version = '0111'")"
HAS_0110_BASE="$(Q "select count(*) from ogevia_meta.schema_migrations where version = '0110' and name = '0110_offices.sql' and checksum = '$SHA_0110'")"
echo "database: $CUR   ledger: $LEDGER   0110 recorded with its checksum: $HAS_0110_BASE   0111 ledger rows: $HAS_ROW"

verify_sql() { # expect absent|present; ledger absent|present
  local out rows bad
  out="$(psql -X -At -F '|' -v ON_ERROR_STOP=1 -v expect="$1" -v ledger="$2" -f "$VERIFY" 2>&1)" || { echo "$out" | sed -E 's#postgres://[^ ]*#postgres://<redacted>#g'; return 1; }
  rows="$(echo "$out" | grep -c '|' || true)"; bad="$(echo "$out" | grep -c '|f|' || true)"
  echo "VERIFY_0111 ($1/$2): $rows checks, $bad failing"
  [[ "$rows" -ge 40 && "$bad" -eq 0 ]]
}
require_approval() { [[ -n "${OGEVIA_DEPLOY_APPROVAL:-}" ]] || stop "no explicit owner approval reference (set OGEVIA_DEPLOY_APPROVAL)"; }

case "$MODE" in
  probe)
    [[ "$LEDGER" == "$BASE_COUNT/$BASE_LAST" && "$HAS_0110_BASE" == 1 && "$HAS_ROW" == 0 ]] || stop "not the baseline this release was prepared for (expected $BASE_COUNT/$BASE_LAST with 0110 recorded and no 0111 row)"
    verify_sql absent absent || stop "0111 objects already exist or the check failed"
    echo "PROBE OK: baseline $BASE_COUNT/$BASE_LAST, 0111 absent. Nothing was changed."
    ;;
  apply)
    require_approval
    [[ "$LEDGER" == "$BASE_COUNT/$BASE_LAST" && "$HAS_0110_BASE" == 1 && "$HAS_ROW" == 0 ]] || stop "not the baseline (expected $BASE_COUNT/$BASE_LAST with 0110 recorded and no 0111 row)"
    BK="${OGEVIA_TEST_BACKUP:-}"
    [[ -n "$BK" && -f "$BK" && -f "$BK.sha256" ]] || stop "set OGEVIA_TEST_BACKUP to the TEST logical backup (with its .sha256) taken for this release"
    (cd "$(dirname "$BK")" && sha256sum --check --status "$(basename "$BK").sha256") || stop "backup checksum does not match"
    verify_sql absent absent || stop "pre-check failed"
    set +e
    psql -X -v ON_ERROR_STOP=1 -1 \
      -c "select pg_advisory_xact_lock(4317111)" \
      -c "do \$\$ begin if exists (select 1 from ogevia_meta.schema_migrations where version = '0111') then raise exception 'Migration already recorded; do not reapply'; end if; end \$\$" \
      -c "set local role ogevia_owner" -f "$UP" -c "reset role" \
      -c "insert into ogevia_meta.schema_migrations(version,name,checksum) values ('0111','$STEM.sql','$UP_SHA')" 2>&1 | sed -E 's#postgres://[^ ]*#postgres://<redacted>#g'
    rc=${PIPESTATUS[0]}; set -e
    [[ "$rc" == 0 ]] || stop "apply failed; the transaction rolled back, nothing changed"
    echo "APPLIED 0111 with its ledger row, in one transaction. Now run: verify"
    ;;
  verify)
    [[ "$LEDGER" == "$AFTER_COUNT/$AFTER_LAST" ]] || { echo "!!! ledger is $LEDGER, expected $AFTER_COUNT/$AFTER_LAST"; exit 1; }
    ROW="$(Q "select count(*) from ogevia_meta.schema_migrations where version = '0111' and name = '$STEM.sql' and checksum = '$UP_SHA'")"
    [[ "$ROW" == 1 && "$HAS_0110_BASE" == 1 ]] || { echo "!!! the 0111 (or 0110) ledger row is missing or its checksum differs"; exit 1; }
    verify_sql present present || { echo "!!! POST-STATE DOES NOT MATCH"; exit 1; }
    echo "VERIFIED: ledger $AFTER_COUNT/$AFTER_LAST, 0110 and 0111 recorded with the pinned checksum, all object checks pass."
    ;;
  rollback)
    require_approval
    ROW="$(Q "select count(*) from ogevia_meta.schema_migrations where version = '0111' and name = '$STEM.sql' and checksum = '$UP_SHA'")"
    [[ "$LEDGER" == "$AFTER_COUNT/$AFTER_LAST" && "$ROW" == 1 ]] || stop "0111 is not recorded as applied with the pinned checksum (ledger $LEDGER)"
    set +e
    psql -X -v ON_ERROR_STOP=1 -1 \
      -c "select pg_advisory_xact_lock(4317111)" \
      -c "do \$\$ begin if not exists (select 1 from ogevia_meta.schema_migrations where version = '0111' and checksum = '$UP_SHA' and name = '$STEM.sql') then raise exception 'Missing or changed migration ledger row'; end if; end \$\$" \
      -c "set local role ogevia_owner" -f "$DOWN" -c "reset role" \
      -c "delete from ogevia_meta.schema_migrations where version = '0111'" 2>&1 | sed -E 's#postgres://[^ ]*#postgres://<redacted>#g'
    rc=${PIPESTATUS[0]}; set -e
    [[ "$rc" == 0 ]] || stop "rollback failed; the transaction rolled back, nothing changed"
    echo "ROLLED BACK 0111 and removed its ledger row, in one transaction. Office assignments, counties and caregiver colors are removed with their tables and columns (the primary office stays on the client). Run: probe"
    ;;
esac
