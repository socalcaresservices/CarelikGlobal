#!/usr/bin/env bash
# R6 (OPTIONAL) ROLLBACK 0085 -> 0047 on the REHEARSAL COPY ONLY. Mutates the copy. Newest first, one transaction per file, ledger row removed in the same transaction (the down scripts do not touch the ledger).
#   OGEVIA_EXPECT_ROLLBACK_SHA=<64 hex from the README> bash r6-rollback.sh
# BACKUP REQUIRED scripts drop tables WITH their rows and keep no copy; on the copy that is intended. Afterwards the schema must equal the baseline except the 11 objects the 0047 down script keeps by design.
MODE=rw
source "$(dirname "${BASH_SOURCE[0]}")/db-session.sh"
[[ "$(state_get BASELINE_DONE)" == yes && -s "$OUT/baseline-fp.tsv" ]] || stop "run r3-baseline.sh first"
[[ "${OGEVIA_EXPECT_ROLLBACK_SHA:-}" =~ ^[0-9a-f]{64}$ ]] || stop "set OGEVIA_EXPECT_ROLLBACK_SHA to the 64-character value in the README"
(cd "$PKG_ROOT" && sha256sum -c --quiet MANIFEST.sha256) || stop "the package files do not match MANIFEST.sha256"
SET=$(cd "$PKG_ROOT/rollback" && for f in 00*.down.sql; do printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"; done | sha256sum | cut -d' ' -f1)
[[ "$SET" == "$OGEVIA_EXPECT_ROLLBACK_SHA" ]] || stop "the rollback set hashes to $SET, not the approved $OGEVIA_EXPECT_ROLLBACK_SHA"
L=$(ledger_now); COUNT=${L%%|*}; LATEST=${L##*|}
[[ "$LATEST" =~ ^00[0-9]{2}$ && "$COUNT" == "$((10#$LATEST))" && "$LATEST" > 0046 && "$LATEST" < 0086 ]] || stop "needs a contiguous ledger between 0047 and 0085; found $L"
say "PROPOSED (mutates the REHEARSAL COPY $REH only): roll back $((10#$LATEST - 46)) migrations from $LATEST down to 0047, deleting the data of the dropped tables"
confirm "ROLLBACK-$REH"
: > "$OUT/rollback.log"; T0=$(date +%s)
for ((n = 10#$LATEST; n >= 47; n--)); do
  v=$(printf '%04d' "$n"); f=$(ls "$PKG_ROOT"/rollback/${v}_*.down.sql 2>/dev/null | head -1); [[ -n "$f" ]] || stop "no rollback script for $v"
  S=$(date +%s%3N)
  if P -d "$PRD_DB" -1 -c "select pg_advisory_xact_lock(4317001)" -c "set local statement_timeout = 120000" -c "set local role ogevia_owner" -f "$f" -c "reset role" -c "delete from ogevia_meta.schema_migrations where version = '$v'" > "$OUT/rollback-$v.out" 2>&1; then
    [[ "$(P -d "$PRD_DB" -c "select count(*) from ogevia_meta.schema_migrations where version = '$v'")" == 0 ]] || stop "the ledger row for $v is still present"
    E=$(date +%s%3N); printf '%s\t%s\t%s ms\n' "$v" "$(basename "$f")" "$((E - S))" | tee -a "$OUT/rollback.log"
  else
    say "ROLLBACK FAILED at $v. That file's transaction was rolled back; $v and everything below it are still applied. Last lines (no data): $(tail -3 "$OUT/rollback-$v.out" | tr '\n' ' ' | cut -c1-400)"
    stop "stopped at $v. Send this output to Claude."
  fi
done
L=$(ledger_now); say "ledger after: ${L%%|*} migrations applied, latest ${L##*|}; total $(( $(date +%s) - T0 )) s"
[[ "$L" == "46|0046" ]] || stop "the ledger is $L, expected 46|0046"
P -d "$PRD_DB" -f "$PKG_ROOT/sql/fingerprint.sql" > "$OUT/rollback-fp.tsv" || stop "the fingerprint query failed"
FAIL=0
if R=$(python3 "$PKG_ROOT/scripts/fp-compare.py" schema "$OUT/baseline-fp.tsv" "$OUT/rollback-fp.tsv" --allow "$PKG_ROOT/data/kept_after_rollback.txt"); then say "PASS schema equals the baseline except the objects 0047 keeps by design: $R"; else say "FAIL schema after rollback:"$'\n'"$R"; FAIL=1; fi
if R=$(python3 "$PKG_ROOT/scripts/fp-compare.py" data "$OUT/baseline-fp.tsv" "$OUT/rollback-fp.tsv"); then say "PASS existing data counts and content: $R"; else say "FAIL data after rollback:"$'\n'"$R"; FAIL=1; fi
[[ "$FAIL" == 0 ]] && say "ROLLED BACK: $PRD_DB on $REH is at 46|0046 and matches the baseline (C7)." || stop "the rollback result differs from the baseline. Send this output to Claude."
