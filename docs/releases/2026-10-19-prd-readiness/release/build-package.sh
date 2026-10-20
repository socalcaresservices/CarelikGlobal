#!/usr/bin/env bash
# Builds the PRODUCTION RELEASE package, stages A (discovery) and B (gate and guard): scripts, the six release templates synthesized from the repository HEAD (`cdk synth`, local, no AWS call), a README and a
# manifest, as a directory and a reproducible tar.gz. Local only; contacts nothing.
#   bash build-package.sh <output-dir> [--use-synth <env=prd cdk.out> <env=prod cdk.out>]
set -euo pipefail
OUTDIR="${1:-}"; [[ -n "$OUTDIR" ]] || { echo "usage: bash build-package.sh <output-dir> [--use-synth <prd-cdk-out> <prod-cdk-out>]" >&2; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO="$(cd "$HERE/../../../.." && pwd)"; INFRA="$REPO/infra/aws"
NAME=ogevia-prd-release; ROOT="$OUTDIR/$NAME"; mkdir -p "$OUTDIR"; rm -rf "$ROOT"; mkdir -p "$ROOT"/{scripts,release-templates}
if [[ "${2:-}" == --use-synth ]]; then PRD_OUT="${3:?}"; PROD_OUT="${4:?}"
else
  WORK="$(mktemp -d)"; PRD_OUT="$WORK/prd"; PROD_OUT="$WORK/prod"
  (cd "$INFRA" && npx --no-install cdk synth --quiet --no-notices -c env=prd -c mode=plan -o "$PRD_OUT" >/dev/null 2>&1 && npx --no-install cdk synth --quiet --no-notices -c env=prod -c mode=plan -o "$PROD_OUT" >/dev/null 2>&1) || { echo "cdk synth failed" >&2; exit 1; }
fi
for S in Ogevia-prd-DatabaseSecret Ogevia-prd-EvidenceStorage Ogevia-prd-WebHosting Ogevia-prd-ServiceVerificationApi Ogevia-prd-Observability; do cp "$PRD_OUT/$S.template.json" "$ROOT/release-templates/$S.json"; done
cp "$PROD_OUT/Ogevia-prod-NetworkEgress.template.json" "$ROOT/release-templates/Ogevia-prod-NetworkEgress.json"
cp "$HERE"/scripts/* "$ROOT/scripts/"
{ for d in "$PRD_OUT"/asset.*; do [[ -d "$d" ]] && echo "asset ${d##*/asset.}"; done; } | sort > "$ROOT/ASSETS.txt"
HK=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key|startswith("Handler"))) | .value.Properties.Code.S3Key][0]' "$ROOT/release-templates/Ogevia-prd-ServiceVerificationApi.json")
IK=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key|startswith("IdentityHandler"))) | .value.Properties.Code.S3Key][0]' "$ROOT/release-templates/Ogevia-prd-ServiceVerificationApi.json")
COMMIT=$(git -C "$REPO" rev-parse HEAD); CDATE=$(git -C "$REPO" show -s --format=%cI HEAD); DIRTY=$([[ -z "$(git -C "$REPO" status --porcelain -- infra/aws docs/releases/2026-10-19-prd-readiness/release)" ]] && echo clean || echo DIRTY)
sed -e "s/@COMMIT@/$COMMIT/g" -e "s/@HANDLER_KEY@/$HK/g" -e "s/@IDENTITY_KEY@/$IK/g" "$HERE/README.md.tmpl" > "$ROOT/README.md"
jq -n --arg c "$COMMIT" --arg d "$CDATE" --arg t "$DIRTY" --arg h "$HK" --arg i "$IK" '{package:"ogevia-prd-release",stage:"A+B (discovery and gate; no deployment mechanics, no migration, no web publish)",source_commit:$c,commit_date:$d,source_tree:$t,release_handler_asset:$h,release_identity_asset:$i,note:"contacts AWS only when the operator runs a script; every AWS call is a read"}' > "$ROOT/BUILD_INFO.json"
(cd "$ROOT" && find . -type f ! -name MANIFEST.sha256 | sort | sed 's|^\./||' | xargs sha256sum > MANIFEST.sha256)
chmod 755 "$ROOT"/scripts/*.sh "$ROOT"/scripts/*.py; find "$ROOT" -type d -exec chmod 755 {} +; find "$ROOT" -type f ! -name '*.sh' ! -name '*.py' -exec chmod 644 {} +
TAR="$OUTDIR/$NAME.tar.gz"; tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="$CDATE" -C "$OUTDIR" -cf - "$NAME" | gzip -n -9 > "$TAR"
echo "built $TAR"; sha256sum "$TAR"; echo "handler asset: $HK"; echo "identity asset: $IK"; echo "source commit: $COMMIT ($DIRTY)"
