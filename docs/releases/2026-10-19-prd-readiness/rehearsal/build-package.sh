#!/usr/bin/env bash
# Builds the production-upgrade rehearsal package (a directory and a reproducible tar.gz) from the repository. Local only; contacts nothing.
#   bash build-package.sh <output-dir>
# Contents: scripts/, sql/, data/, migrations/0047-0085, rollback/0047-0085, verification/, README.md, BUILD_INFO.json, MANIFEST.sha256.
set -euo pipefail
OUTDIR="${1:-}"; [[ -n "$OUTDIR" ]] || { echo "usage: bash build-package.sh <output-dir>" >&2; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO="$(cd "$HERE/../../../.." && pwd)"; DB="$REPO/infra/aws/db"
NAME=ogevia-prd-rehearsal; ROOT="$OUTDIR/$NAME"
rm -rf "$ROOT"; mkdir -p "$ROOT"/{scripts,sql,data,migrations,rollback,verification}
cp "$HERE"/scripts/*.sh "$HERE"/scripts/*.py "$ROOT/scripts/"; cp "$HERE"/sql/*.sql "$ROOT/sql/"; cp "$HERE/data/kept_after_rollback.txt" "$ROOT/data/"
n=0; for v in $(seq 47 85); do
  p=$(printf '%04d' "$v"); m=$(ls "$DB"/migrations/${p}_*.sql | grep -v '\.down\.sql'); d=$(ls "$DB"/rollback/${p}_*.down.sql)
  [[ "$(echo "$m" | wc -l)" == 1 && "$(echo "$d" | wc -l)" == 1 ]] || { echo "migration or rollback file for $p missing or ambiguous" >&2; exit 1; }
  cp "$m" "$ROOT/migrations/"; cp "$d" "$ROOT/rollback/"; n=$((n + 1))
done
[[ "$n" == 39 ]] || { echo "expected 39 files, found $n" >&2; exit 1; }
cp "$DB"/verification/*.sql "$ROOT/verification/"
ledger() { for f in $(ls "$DB"/migrations/*.sql | grep -v '\.down\.sql' | sort); do b=$(basename "$f"); v=${b:0:4}; (( 10#$v >= $1 && 10#$v <= $2 )) && printf '%s\t%s\n' "$v" "$(sha256sum "$f" | cut -d' ' -f1)"; done; return 0; }
ledger 1 46 > "$ROOT/data/LEDGER_0001_0046.tsv"; ledger 47 85 > "$ROOT/data/LEDGER_0047_0085.tsv"
[[ "$(wc -l < "$ROOT/data/LEDGER_0001_0046.tsv")" == 46 && "$(wc -l < "$ROOT/data/LEDGER_0047_0085.tsv")" == 39 ]] || { echo "ledger lists have the wrong length" >&2; exit 1; }
setsha() { (cd "$1" && for f in $2; do printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"; done | sha256sum | cut -d' ' -f1); }
MSHA=$(setsha "$ROOT/migrations" "00*.sql"); RSHA=$(setsha "$ROOT/rollback" "00*.down.sql")
COMMIT=$(git -C "$REPO" rev-parse HEAD); CDATE=$(git -C "$REPO" show -s --format=%cI HEAD); DIRTY=$([[ -z "$(git -C "$REPO" status --porcelain -- infra/aws/db docs/releases/2026-10-19-prd-readiness/rehearsal)" ]] && echo clean || echo DIRTY)
sed -e "s/@MIGRATIONS_SHA@/$MSHA/g" -e "s/@ROLLBACK_SHA@/$RSHA/g" -e "s/@COMMIT@/$COMMIT/g" "$HERE/README.md.tmpl" > "$ROOT/README.md"
jq -n --arg c "$COMMIT" --arg d "$CDATE" --arg t "$DIRTY" --arg m "$MSHA" --arg r "$RSHA" '{package:"ogevia-prd-rehearsal",source_commit:$c,commit_date:$d,source_tree:$t,migrations_0047_0085_set_sha256:$m,rollback_0047_0085_set_sha256:$r,note:"rehearsal of the 46 to 85 upgrade on a RESTORED COPY; contacts AWS only when the operator runs a script"}' > "$ROOT/BUILD_INFO.json"
(cd "$ROOT" && find . -type f ! -name MANIFEST.sha256 | sort | sed 's|^\./||' | xargs sha256sum > MANIFEST.sha256)
chmod 755 "$ROOT"/scripts/*.sh "$ROOT"/scripts/*.py; find "$ROOT" -type d -exec chmod 755 {} +; find "$ROOT" -type f ! -name '*.sh' ! -name '*.py' -exec chmod 644 {} +
TAR="$OUTDIR/$NAME.tar.gz"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="$CDATE" -C "$OUTDIR" -cf - "$NAME" | gzip -n -9 > "$TAR"
echo "built $TAR"; sha256sum "$TAR"; echo "migrations set sha256: $MSHA"; echo "rollback set sha256:   $RSHA"; echo "source commit: $COMMIT ($DIRTY)"
