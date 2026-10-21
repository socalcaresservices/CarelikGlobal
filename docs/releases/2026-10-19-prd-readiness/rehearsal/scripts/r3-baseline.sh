#!/usr/bin/env bash
# R3 BASELINE of the rehearsal copy BEFORE any migration. READ-ONLY (every statement runs with default_transaction_read_only=on). Output: counts, versions, hashes; never row contents.
#   bash r3-baseline.sh
# Requires the copy's ogevia_prd to be at exactly 46 migrations, latest 0046, and its ledger checksums to equal the repository's migration files 0001-0046 (otherwise the real runner would refuse with "Drift").
MODE=ro
source "$(dirname "${BASH_SOURCE[0]}")/db-session.sh"
say "== R3 baseline $(date -u +%FT%TZ) on $REH =="
L=$(ledger_now) || stop "the ledger cannot be read in $PRD_DB (no ledger table?)"
say "ledger: ${L%%|*} migrations applied, latest ${L##*|}"
[[ "$L" == "46|0046" ]] || stop "the copy's ledger is $L, the rehearsal expects 46|0046. Do not migrate. Send this output to Claude."
P -d "$PRD_DB" -c "select version, checksum from ogevia_meta.schema_migrations order by version" > "$OUT/baseline-ledger.tsv" || stop "cannot read the ledger rows"
if ! diff -q "$OUT/baseline-ledger.tsv" "$PKG_ROOT/data/LEDGER_0001_0046.tsv" >/dev/null; then
  say "DRIFT: ledger rows that differ from the repository's files (versions only):"
  diff <(cut -f1,2 "$OUT/baseline-ledger.tsv") <(cut -f1,2 "$PKG_ROOT/data/LEDGER_0001_0046.tsv") | grep -E '^[<>]' | awk '{print $2}' | sort -u | tr '\n' ' ' | tee -a "$LOG"; echo
  stop "the copy's ledger checksums do not match the repository: the real runner would refuse. Do not migrate."
fi
say "ledger checksums 0001-0046 equal the repository's files"
say "database size: $(P -d "$PRD_DB" -c "select pg_size_pretty(pg_database_size(current_database()))")"
P -d "$PRD_DB" -f "$PKG_ROOT/sql/fingerprint.sql" > "$OUT/baseline-fp.tsv" || stop "the fingerprint query failed"
say "fingerprint of $PRD_DB: $(wc -l < "$OUT/baseline-fp.tsv") keys; non-empty tables: $(grep '^data:' "$OUT/baseline-fp.tsv" | grep -vc $'\t0:') of $(grep -c '^data:' "$OUT/baseline-fp.tsv"); total rows: $(grep '^data:' "$OUT/baseline-fp.tsv" | awk -F'\t' '{split($2,a,":"); s+=a[1]} END{print s+0}')"
if grep -qw "$TEST_DB" <<<"${DBS//,/ }"; then
  P -d "$TEST_DB" -f "$PKG_ROOT/sql/fingerprint.sql" > "$OUT/baseline-fp-test.tsv" || stop "the fingerprint query on $TEST_DB failed"
  say "fingerprint of $TEST_DB (the copy of TEST, used for schema parity): $(wc -l < "$OUT/baseline-fp-test.tsv") keys; ledger $(P -d "$TEST_DB" -c "select count(*) || '|' || coalesce(max(version), 'none') from ogevia_meta.schema_migrations")"
else say "NOTE: $TEST_DB is not on the copy; schema parity (C3) cannot be checked"; fi
state_set BASELINE_DONE yes
say "BASELINE RECORDED in $OUT (baseline-ledger.tsv, baseline-fp.tsv). Nothing was changed."
