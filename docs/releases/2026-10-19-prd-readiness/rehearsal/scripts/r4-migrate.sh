#!/usr/bin/env bash
# R4 APPLY 0047-0085 to ogevia_prd ON THE REHEARSAL COPY ONLY. Mutates the copy. One transaction per file, the ledger row inserted in the same transaction, stop at the first error.
#   OGEVIA_EXPECT_MIGRATIONS_SHA=<64 hex from the README> bash r4-migrate.sh [--resume]
# Same semantics as db/scripts/migrations.ts: "set local role ogevia_owner" unless the file starts with "-- ogevia:run-as=admin", the file's sha-256 as the ledger checksum, the runner's advisory
# lock, then the two grants on ogevia_meta. Applied files are never edited; a failed file is fixed forward by a new migration.
MODE=rw
source "$(dirname "${BASH_SOURCE[0]}")/db-session.sh"
RESUME=0; [[ "${1:-}" == --resume ]] && RESUME=1
[[ -z "${1:-}" || "$RESUME" == 1 ]] || { echo "usage: bash r4-migrate.sh [--resume]" >&2; exit 2; }
[[ "$(state_get BASELINE_DONE)" == yes && -s "$OUT/baseline-fp.tsv" ]] || stop "run r3-baseline.sh first"
[[ "${OGEVIA_EXPECT_MIGRATIONS_SHA:-}" =~ ^[0-9a-f]{64}$ ]] || stop "set OGEVIA_EXPECT_MIGRATIONS_SHA to the 64-character value in the README"
(cd "$PKG_ROOT" && sha256sum -c --quiet MANIFEST.sha256) || stop "the package files do not match MANIFEST.sha256"
SET=$(cd "$PKG_ROOT/migrations" && for f in 00*.sql; do printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"; done | sha256sum | cut -d' ' -f1)
[[ "$SET" == "$OGEVIA_EXPECT_MIGRATIONS_SHA" ]] || stop "the migration set hashes to $SET, not the approved $OGEVIA_EXPECT_MIGRATIONS_SHA"
L=$(ledger_now); COUNT=${L%%|*}; LATEST=${L##*|}
if [[ "$RESUME" == 1 ]]; then
  [[ "$LATEST" =~ ^00[0-9]{2}$ && "$COUNT" == "$((10#$LATEST))" && "$LATEST" > 0046 && "$LATEST" < 0085 ]] || stop "--resume needs a contiguous ledger between 0047 and 0084; found $L"
else
  [[ "$L" == "46|0046" ]] || stop "the ledger is $L, a first run needs 46|0046 (use --resume after a stop)"
fi
FILES=(); for f in "$PKG_ROOT"/migrations/00*.sql; do v=$(basename "$f" | cut -c1-4); [[ "$v" > "$LATEST" ]] && FILES+=("$f"); done
say "PROPOSED (mutates the REHEARSAL COPY $REH only, database $PRD_DB): apply ${#FILES[@]} migrations ${FILES[0]##*/} .. ${FILES[-1]##*/}; production and the shared security group are not touched"
confirm "MIGRATE-$REH"
: > "$OUT/migrate.log"; T0=$(date +%s)
for f in "${FILES[@]}"; do
  name=$(basename "$f"); v=${name:0:4}; sum=$(sha256sum "$f" | cut -d' ' -f1); S=$(date +%s%3N)
  ROLE=(-c "set local role ogevia_owner"); head -1 "$f" | grep -q '^-- ogevia:run-as=admin' && ROLE=()
  if P -d "$PRD_DB" -1 -c "select pg_advisory_xact_lock(4317001)" "${ROLE[@]}" -f "$f" -c "reset role" -c "insert into ogevia_meta.schema_migrations (version, name, checksum) values ('$v', '$name', '$sum')" > "$OUT/migrate-$v.out" 2>&1; then
    E=$(date +%s%3N); printf '%s\t%s\t%s ms\n' "$v" "$name" "$((E - S))" | tee -a "$OUT/migrate.log"
  else
    say "MIGRATION FAILED at $name. That file's transaction was rolled back; it and later files are NOT applied. Last lines (no data): $(tail -3 "$OUT/migrate-$v.out" | tr '\n' ' ' | cut -c1-400)"
    stop "stopped at $name. Do not edit the file. Send this output to Claude, then use --resume only after the cause is fixed forward."
  fi
done
P -d "$PRD_DB" -c "grant usage on schema ogevia_meta to ogevia_readonly" -c "grant select on ogevia_meta.schema_migrations to ogevia_readonly" >/dev/null || stop "the final grants failed"
L=$(ledger_now); say "ledger after: ${L%%|*} migrations applied, latest ${L##*|}; total $(( $(date +%s) - T0 )) s"
[[ "$L" == "85|0085" ]] || stop "the ledger is $L, expected 85|0085"
say "MIGRATED: $PRD_DB on $REH is at 85|0085. Run r5-verify.sh."
