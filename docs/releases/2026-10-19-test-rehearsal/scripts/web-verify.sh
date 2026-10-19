#!/usr/bin/env bash
# =============================================================================
# TEST rehearsal, STEP 12 (after the web publish): READ-ONLY verification of what the TEST site now serves. Only curl GETs of the TEST web origin.
#   OGEVIA_EXPECT_COMMIT=<40-hex code SHA> bash web-verify.sh [SITE_URL]       (SITE_URL default: the captured $OGEVIA_BEFORE/web-url-before.txt)
# Checks: the served index.html is byte-identical to the one just built (apps/web/dist-aws/index.html); the main script it references embeds
# VITE_APP_VERSION:"<the 40-character code SHA>" and VITE_APP_ENV:"test" (the web has no on-screen version text: the build embeds the version in the bundle);
# config.json (if the capture has one) is unchanged. A CloudFront cache can lag for about a minute after the invalidation: retry once before stopping.
# Exit 0 = all pass; 1 = a check failed; 2 = usage.
# =============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ROOT="$(cd "$HERE/../../../.." && pwd)"
B="${OGEVIA_BEFORE:-$HOME/ogevia-before}"
[[ "${OGEVIA_EXPECT_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: set OGEVIA_EXPECT_COMMIT to the 40-character code SHA" >&2; exit 2; }
SITE="${1:-$(cat "$B/web-url-before.txt" 2>/dev/null)}"
[[ "$SITE" =~ ^https://[A-Za-z0-9.-]+$ ]] || { echo "usage: bash web-verify.sh https://<the TEST web origin>" >&2; exit 2; }
bad=0; ok() { echo "PASS $*"; }; nope() { echo "FAIL $*"; bad=1; }
G() { curl -fsS --max-time 60 "$@"; }
DIST="$ROOT/apps/web/dist-aws"
[[ -f "$DIST/index.html" ]] || { echo "FAIL no local build at $DIST (run the web step first)"; exit 1; }
LOCAL=$(sha256sum "$DIST/index.html" | cut -d' ' -f1)
IDX=$(G "$SITE/index.html") || { echo "FAIL cannot fetch $SITE/index.html"; exit 1; }
SERVED=$(printf '%s' "$IDX" | sha256sum | cut -d' ' -f1)
echo "index.html sha256: served $SERVED  local build $LOCAL"
[[ "$SERVED" == "$LOCAL" ]] && ok "the served index.html is the one just built" || nope "the served index.html differs from the build (cache lag? wait a minute and rerun once; otherwise STOP)"
ASSET=$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' <<<"$IDX" | head -1)
[[ -n "$ASSET" ]] && ok "main script $ASSET" || { nope "index.html references no assets/index-*.js"; echo "STOP"; exit 1; }
JS=$(G "$SITE/$ASSET") || { nope "cannot fetch $SITE/$ASSET"; echo "STOP"; exit 1; }
VER=$(grep -o 'VITE_APP_VERSION:"[^"]*"' <<<"$JS" | head -1)
echo "version string in the served bundle: ${VER:-none}"
[[ "$VER" == "VITE_APP_VERSION:\"$OGEVIA_EXPECT_COMMIT\"" ]] && ok "the bundle carries the code SHA $OGEVIA_EXPECT_COMMIT" || nope "the bundle's version string is not the code SHA"
grep -q 'VITE_APP_ENV:"test"' <<<"$JS" && ok "built for TEST (VITE_APP_ENV:\"test\")" || nope "the bundle is not built for TEST"
if [[ -f "$B/web-before/config.json" ]]; then
  CFG=$(G "$SITE/config.json" | sha256sum | cut -d' ' -f1); OLD=$(sha256sum "$B/web-before/config.json" | cut -d' ' -f1)
  [[ "$CFG" == "$OLD" ]] && ok "config.json unchanged" || nope "config.json differs from the capture"
else echo "NOTE the capture has no config.json; nothing to compare"; fi
[[ $bad == 0 ]] && { echo "WEB VERIFIED: $SITE serves code $OGEVIA_EXPECT_COMMIT"; exit 0; } || { echo "STOP: a web check failed. See Recovery 'web'."; exit 1; }
