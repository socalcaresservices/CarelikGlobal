#!/usr/bin/env bash
# R5 VERIFY the migrated copy. READ-ONLY. Checks, in order: ledger 85|0085 and every file checksum (C2), the repository verification set (C5), schema parity with the copy of TEST (C3),
# and that existing data is untouched (C4). Writes $OUT/verify.txt. Exit 0 only if everything passes. Prints counts, names and digests; never row contents.
MODE=ro
source "$(dirname "${BASH_SOURCE[0]}")/db-session.sh"
FAIL=0; bad() { say "FAIL $*"; FAIL=1; }; ok() { say "PASS $*"; }
[[ -s "$OUT/baseline-fp.tsv" ]] || stop "no baseline: run r3-baseline.sh before the migration"
L=$(ledger_now); [[ "$L" == "85|0085" ]] && ok "ledger $L" || bad "ledger is $L, expected 85|0085"
P -d "$PRD_DB" -c "select version, checksum from ogevia_meta.schema_migrations order by version" > "$OUT/after-ledger.tsv" || stop "cannot read the ledger"
cat "$PKG_ROOT/data/LEDGER_0001_0046.tsv" "$PKG_ROOT/data/LEDGER_0047_0085.tsv" > "$OUT/expected-ledger.tsv"
diff -q "$OUT/after-ledger.tsv" "$OUT/expected-ledger.tsv" >/dev/null && ok "all 85 ledger checksums equal the repository's files (C2)" || bad "ledger checksums differ from the repository's files: $(diff <(cut -f1,2 "$OUT/after-ledger.tsv") <(cut -f1,2 "$OUT/expected-ledger.tsv") | grep -E '^[<>]' | awk '{print $2}' | sort -u | tr '\n' ' ')"
VF=0
for f in "$PKG_ROOT"/verification/*.sql; do
  OUTV=$(P -d "$PRD_DB" -c "begin transaction read only" -f "$f" -c "rollback" 2>&1) || { bad "verification $(basename "$f") could not run: $(printf '%s' "$OUTV" | tail -1 | cut -c1-200)"; VF=1; continue; }
  N=$(printf '%s\n' "$OUTV" | grep -c . || true); F=$(printf '%s\n' "$OUTV" | awk -F'\t' '$2=="f"' | wc -l)
  if [[ "$F" == 0 ]]; then ok "verification $(basename "$f"): $N check rows, none failed"; else bad "verification $(basename "$f"): $F failed: $(printf '%s\n' "$OUTV" | awk -F'\t' '$2=="f"{print $1}' | tr '\n' ' ')"; VF=1; fi
done
P -d "$PRD_DB" -f "$PKG_ROOT/sql/fingerprint.sql" > "$OUT/after-fp.tsv" || stop "the fingerprint query failed"
if [[ -s "$OUT/baseline-fp-test.tsv" ]]; then
  P -d "$TEST_DB" -f "$PKG_ROOT/sql/fingerprint.sql" > "$OUT/after-fp-test.tsv" || stop "the fingerprint query on $TEST_DB failed"
  if R=$(python3 "$PKG_ROOT/scripts/fp-compare.py" schema "$OUT/after-fp.tsv" "$OUT/after-fp-test.tsv"); then ok "schema parity with the copy of TEST: $R (C3)"; else bad "schema parity (C3):"$'\n'"$R"; fi
else say "NOTE: C3 not checked (no $TEST_DB fingerprint at baseline)"; fi
if R=$(python3 "$PKG_ROOT/scripts/fp-compare.py" data "$OUT/baseline-fp.tsv" "$OUT/after-fp.tsv"); then ok "existing data unchanged: $R (C4)"; else bad "existing data (C4):"$'\n'"$R"; fi
{ echo "verify $(date -u +%FT%TZ) result: $([[ $FAIL == 0 ]] && echo PASS || echo FAIL)"; } >> "$OUT/verify.txt"
[[ "$FAIL" == 0 ]] && say "VERIFIED: the copy passes C2-C5. Timings are in $OUT/migrate.log." || stop "one or more checks failed (see FAIL lines). Send this output to Claude."
