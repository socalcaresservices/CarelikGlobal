#!/usr/bin/env bash
# Builds the PRODUCTION RELEASE package, stages A (discovery) and B (gate and guard): scripts, the six release templates synthesized from the repository HEAD (`cdk synth`, local, no AWS call), a README and a
# manifest, as a directory and a reproducible tar.gz. Local only; contacts nothing.
#   bash build-package.sh <output-dir> [--use-synth <env=prd cdk.out> <env=prod cdk.out>]
set -euo pipefail
OUTDIR="${1:-}"; [[ -n "$OUTDIR" ]] || { echo "usage: bash build-package.sh <output-dir> [--use-synth <prd-cdk-out> <prod-cdk-out>]" >&2; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO="$(cd "$HERE/../../../.." && pwd)"; INFRA="$REPO/infra/aws"
NAME=ogevia-prd-release; ROOT="$OUTDIR/$NAME"; mkdir -p "$OUTDIR"; rm -rf "$ROOT"; mkdir -p "$ROOT"/{scripts,release-templates,sql,data,migrations,rollback,verification}
if [[ "${2:-}" == --use-synth ]]; then PRD_OUT="${3:?}"; PROD_OUT="${4:?}"
else
  WORK="$(mktemp -d)"; PRD_OUT="$WORK/prd"; PROD_OUT="$WORK/prod"
  # OGEVIA_RELEASE_SOURCE_COMMIT: synthesize the templates from THAT commit's tree (git archive; the working tree's node_modules are linked in)
  # instead of the working tree. Used once later work (the authentication-separation release) changed the production stacks, so this package
  # keeps describing the release it was approved for.
  if [[ -n "${OGEVIA_RELEASE_SOURCE_COMMIT:-}" ]]; then
    SRC="$WORK/src"; mkdir -p "$SRC"; git -C "$REPO" archive "$OGEVIA_RELEASE_SOURCE_COMMIT" | tar -x -C "$SRC" || { echo "cannot archive $OGEVIA_RELEASE_SOURCE_COMMIT" >&2; exit 1; }
    while IFS= read -r nm; do rel="${nm#"$REPO"/}"; mkdir -p "$SRC/$(dirname "$rel")"; ln -s "$nm" "$SRC/$rel"; done < <(find "$REPO" -maxdepth 4 -name node_modules -prune -not -path "*/node_modules/*")
    INFRA="$SRC/infra/aws"
  fi
  (cd "$INFRA" && npx --no-install cdk synth --quiet --no-notices -c env=prd -c mode=plan -o "$PRD_OUT" >/dev/null 2>&1 && npx --no-install cdk synth --quiet --no-notices -c env=prod -c mode=plan -o "$PROD_OUT" >/dev/null 2>&1) || { echo "cdk synth failed" >&2; exit 1; }
fi
for S in Ogevia-prd-DatabaseSecret Ogevia-prd-EvidenceStorage Ogevia-prd-WebHosting Ogevia-prd-ServiceVerificationApi Ogevia-prd-Observability; do cp "$PRD_OUT/$S.template.json" "$ROOT/release-templates/$S.json"; done
cp "$PROD_OUT/Ogevia-prod-NetworkEgress.template.json" "$ROOT/release-templates/Ogevia-prod-NetworkEgress.json"
cp "$HERE"/scripts/* "$ROOT/scripts/"
# database payload for stage D1: the SAME 39 migrations and 39 rollback scripts, verification set, fingerprint SQL and comparer that were rehearsed on the restored copy
REH="$HERE/../rehearsal"; DB="$REPO/infra/aws/db"
cp "$REH/scripts/fp-compare.py" "$ROOT/scripts/"; cp "$REH/sql/fingerprint.sql" "$ROOT/sql/"; cp "$REH/data/kept_after_rollback.txt" "$ROOT/data/"; cp "$DB"/verification/*.sql "$ROOT/verification/"
n=0; for v in $(seq 47 85); do
  p=$(printf '%04d' "$v"); m=$(ls "$DB"/migrations/${p}_*.sql | grep -v '\.down\.sql'); d=$(ls "$DB"/rollback/${p}_*.down.sql)
  [[ "$(echo "$m" | wc -l)" == 1 && "$(echo "$d" | wc -l)" == 1 ]] || { echo "migration or rollback file for $p missing or ambiguous" >&2; exit 1; }
  cp "$m" "$ROOT/migrations/"; cp "$d" "$ROOT/rollback/"; n=$((n + 1))
done
[[ "$n" == 39 ]] || { echo "expected 39 files, found $n" >&2; exit 1; }
ledger() { for f in $(ls "$DB"/migrations/*.sql | grep -v '\.down\.sql' | sort); do b=$(basename "$f"); v=${b:0:4}; (( 10#$v >= $1 && 10#$v <= $2 )) && printf '%s\t%s\n' "$v" "$(sha256sum "$f" | cut -d' ' -f1)"; done; return 0; }
ledger 1 46 > "$ROOT/data/LEDGER_0001_0046.tsv"; ledger 47 85 > "$ROOT/data/LEDGER_0047_0085.tsv"
[[ "$(wc -l < "$ROOT/data/LEDGER_0001_0046.tsv")" == 46 && "$(wc -l < "$ROOT/data/LEDGER_0047_0085.tsv")" == 39 ]] || { echo "ledger lists have the wrong length" >&2; exit 1; }
setsha() { (cd "$1" && for f in $2; do printf '%s  %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"; done | sha256sum | cut -d' ' -f1); }
MSHA=$(setsha "$ROOT/migrations" "00*.sql"); RSHA=$(setsha "$ROOT/rollback" "00*.down.sql")
{ for d in "$PRD_OUT"/asset.*; do [[ -d "$d" ]] && echo "asset ${d##*/asset.}"; done; } | sort > "$ROOT/ASSETS.txt"
HK=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key|startswith("Handler"))) | .value.Properties.Code.S3Key][0]' "$ROOT/release-templates/Ogevia-prd-ServiceVerificationApi.json")
IK=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key|startswith("IdentityHandler"))) | .value.Properties.Code.S3Key][0]' "$ROOT/release-templates/Ogevia-prd-ServiceVerificationApi.json")
COMMIT=$(git -C "$REPO" rev-parse HEAD); CDATE=$(git -C "$REPO" show -s --format=%cI HEAD); DIRTY=$([[ -z "$(git -C "$REPO" status --porcelain -- infra/aws docs/releases/2026-10-19-prd-readiness/release)" ]] && echo clean || echo DIRTY)
sed -e "s/@MIGRATIONS_SHA@/$MSHA/g" -e "s/@ROLLBACK_SHA@/$RSHA/g" -e "s/@COMMIT@/$COMMIT/g" -e "s/@HANDLER_KEY@/$HK/g" -e "s/@IDENTITY_KEY@/$IK/g" "$HERE/README.md.tmpl" > "$ROOT/README.md"
jq -n --arg m "$MSHA" --arg r "$RSHA" --arg c "$COMMIT" --arg d "$CDATE" --arg t "$DIRTY" --arg h "$HK" --arg i "$IK" '{package:"ogevia-prd-release",stage:"A+B+C1+D+E (discovery, gate, snapshot, migration executor, deploy-mode assembly, API guard, web publish guard, verification record); nothing in it has been run against AWS",migrations_0047_0085_set_sha256:$m,rollback_0047_0085_set_sha256:$r,source_commit:$c,commit_date:$d,source_tree:$t,release_handler_asset:$h,release_identity_asset:$i,note:"contacts AWS only when the operator runs a script; every AWS call is a read"}' > "$ROOT/BUILD_INFO.json"
(cd "$ROOT" && find . -type f ! -name MANIFEST.sha256 | sort | sed 's|^\./||' | xargs sha256sum > MANIFEST.sha256)
chmod 755 "$ROOT"/scripts/*.sh "$ROOT"/scripts/*.py; find "$ROOT" -type d -exec chmod 755 {} +; find "$ROOT" -type f ! -name '*.sh' ! -name '*.py' -exec chmod 644 {} +
TAR="$OUTDIR/$NAME.tar.gz"; tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="$CDATE" -C "$OUTDIR" -cf - "$NAME" | gzip -n -9 > "$TAR"
echo "built $TAR"; sha256sum "$TAR"; echo "handler asset: $HK"; echo "identity asset: $IK"; echo "source commit: $COMMIT ($DIRTY)"
