#!/usr/bin/env bash
# Builds the PRODUCTION DISCOVERY package for the staff-management / redesign release (TEST-accepted code 7870a04 plus the owner-approved production flag): READ-ONLY capture and diff
# scripts, the seven release templates synthesized from this checkout (`cdk synth`, local, no AWS call), a README and a manifest, as a directory and a reproducible tar.gz.
# It REUSES the existing discovery scripts of docs/releases/2026-10-19-prd-readiness (p0, p1, tpl_diff, lib) and the production ledger read. It deliberately ships NONE of that
# folder's stage B-E scripts: they are pinned to the older e80b770 release (Handler asset eab95a80, 228 routes) and must not travel with this package.
#   bash build-discovery-package.sh <output-dir> [--use-synth <env=prd plan cdk.out> <env=prod plan cdk.out>]
set -euo pipefail
OUTDIR="${1:-}"; [[ -n "$OUTDIR" ]] || { echo "usage: bash build-discovery-package.sh <output-dir> [--use-synth <prd-cdk-out> <prod-cdk-out>]" >&2; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"; INFRA="$REPO/infra/aws"; OLD="$REPO/docs/releases/2026-10-19-prd-readiness"
NAME=ogevia-prd-discovery; ROOT="$OUTDIR/$NAME"; mkdir -p "$OUTDIR"; rm -rf "$ROOT"; mkdir -p "$ROOT"/{scripts,release-templates}
if [[ "${2:-}" == --use-synth ]]; then PRD_OUT="${3:?}"; PROD_OUT="${4:?}"
else
  WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT; PRD_OUT="$WORK/prd"; PROD_OUT="$WORK/prod"
  (cd "$INFRA" && npx --no-install cdk synth --quiet --no-notices -c env=prd -c mode=plan -o "$PRD_OUT" >/dev/null 2>&1 && npx --no-install cdk synth --quiet --no-notices -c env=prod -c mode=plan -o "$PROD_OUT" >/dev/null 2>&1) \
    || { echo "cdk synth failed (run pnpm install first)" >&2; exit 1; }
fi
for S in Ogevia-prd-DatabaseSecret Ogevia-prd-EvidenceStorage Ogevia-prd-WebHosting Ogevia-prd-ServiceVerificationApi Ogevia-prd-Observability Ogevia-prd-Auth; do cp "$PRD_OUT/$S.template.json" "$ROOT/release-templates/$S.json"; done
cp "$PROD_OUT/Ogevia-prod-NetworkEgress.template.json" "$ROOT/release-templates/Ogevia-prod-NetworkEgress.json"
for f in lib.sh p0-baseline-capture.sh p1-diff-report.sh tpl_diff.py; do cp "$OLD/release/scripts/$f" "$ROOT/scripts/$f"; done
cp "$OLD/scripts/ledger-prd-read.sh" "$ROOT/scripts/ledger-prd-read.sh"
HK=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key|startswith("Handler"))) | .value.Properties.Code.S3Key][0]' "$ROOT/release-templates/Ogevia-prd-ServiceVerificationApi.json")
IK=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key|startswith("IdentityHandler"))) | .value.Properties.Code.S3Key][0]' "$ROOT/release-templates/Ogevia-prd-ServiceVerificationApi.json")
NR=$(jq '[.Resources[] | select(.Type=="AWS::ApiGatewayV2::Route")] | length' "$ROOT/release-templates/Ogevia-prd-ServiceVerificationApi.json")
COMMIT=$(git -C "$REPO" rev-parse HEAD); CDATE=$(git -C "$REPO" show -s --format=%cI HEAD)
DIRTY=$([[ -z "$(git -C "$REPO" status --porcelain -- infra/aws docs/releases/2026-10-19-prd-readiness docs/releases/2026-10-26-redesign-production)" ]] && echo clean || echo DIRTY)
sed -e "s/@COMMIT@/$COMMIT/g" -e "s/@HANDLER_KEY@/$HK/g" -e "s/@IDENTITY_KEY@/$IK/g" -e "s/@ROUTES@/$NR/g" "$HERE/DISCOVERY_README.md.tmpl" > "$ROOT/README.md"
jq -n --arg c "$COMMIT" --arg d "$CDATE" --arg t "$DIRTY" --arg h "$HK" --arg i "$IK" --argjson r "$NR" \
  '{package:"ogevia-prd-discovery", purpose:"READ-ONLY production discovery for the staff-management/redesign release", source_commit:$c, source_commit_date:$d, source_tree:$t, handler_asset:$h, identity_asset:$i, api_routes_in_release:$r, aws_changes:"none: every script uses describe/get/list/head calls, an S3 download, curl GETs; ledger-prd-read.sh adds ONE temporary /32 rule only after a typed phrase", built_by:"build-discovery-package.sh"}' > "$ROOT/BUILD_INFO.json"
(cd "$ROOT" && find . -type f ! -name MANIFEST.sha256 | sort | sed 's|^\./||' | xargs sha256sum > MANIFEST.sha256)
chmod 755 "$ROOT"/scripts/*.sh "$ROOT"/scripts/*.py; find "$ROOT" -type d -exec chmod 755 {} +; find "$ROOT" -type f ! -name '*.sh' ! -name '*.py' -exec chmod 644 {} +
TAR="$OUTDIR/$NAME.tar.gz"; tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="$CDATE" -C "$OUTDIR" -cf - "$NAME" | gzip -n -9 > "$TAR"
echo "built $TAR"; sha256sum "$TAR"; echo "handler asset: $HK"; echo "identity asset: $IK"; echo "routes in the release API: $NR"; echo "source commit: $COMMIT ($DIRTY)"
