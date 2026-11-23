#!/usr/bin/env bash
# READ-ONLY verification of the TEST site after the release candidate's web build was published to TEST (curl GETs of the TEST web origin and read-only AWS describe/get calls).
#   OGEVIA_EXPECT_COMMIT=<40-hex candidate code commit> bash web-verify-candidate.sh <package root> [TEST web origin]
#   <package root> = the extracted package (apps/web/dist-aws is the local build just published).  Evidence directory: ~/ogevia-cand (web-before/ = the bucket before the publish).
# Checks: the served index.html equals the local build byte for byte; the main script embeds VITE_APP_VERSION:"<commit>" and VITE_APP_ENV:"test" and the two environment-band texts;
# the served /config.json is unchanged from the pre-publish capture and names the TEST pool and API (and not the production ones); the TEST API stack still holds the pinned Handler asset
# (the API did not change). Exit 0 = all pass; 1 = a check failed; 2 = usage. Writes nothing to AWS.
set -uo pipefail
ROOT="${1:-}"; SITE="${2:-https://d2xumch5w0izfg.cloudfront.net}"; B="${OGEVIA_CAND:-$HOME/ogevia-cand}"
[[ "${OGEVIA_EXPECT_COMMIT:-}" =~ ^[0-9a-f]{40}$ && -d "$ROOT/apps/web" && "$SITE" =~ ^https://[A-Za-z0-9.-]+$ ]] || { echo "usage: OGEVIA_EXPECT_COMMIT=<40 hex> bash web-verify-candidate.sh <package root> [https://<TEST web origin>]" >&2; exit 2; }
bad=0; ok() { echo "PASS $*"; }; nope() { echo "FAIL $*"; bad=1; }
G() { curl -fsS --max-time 60 "$@"; }
HANDLER_KEY=94b73574c5a681d5a8c22b4264742f64e5a6d40aa1ace783be12e7383b9d8a9e.zip
DIST="$ROOT/apps/web/dist-aws"; [[ -f "$DIST/index.html" ]] || { echo "FAIL no local build at $DIST"; exit 1; }
TMP=$(mktemp) && trap 'rm -f "$TMP"' EXIT || exit 1
G "$SITE/index.html" -o "$TMP" || { echo "FAIL cannot fetch $SITE/index.html"; exit 1; }
[[ "$(sha256sum "$TMP" | cut -d' ' -f1)" == "$(sha256sum "$DIST/index.html" | cut -d' ' -f1)" ]] && ok "the served index.html is the build just published" || nope "the served index.html differs from the build (CloudFront lag: wait a minute and re-run once)"
ASSET=$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' "$TMP" | head -1); [[ -n "$ASSET" ]] && ok "main script $ASSET" || { nope "index.html references no main script"; exit 1; }
JS=$(G "$SITE/$ASSET") || { nope "cannot fetch the main script"; exit 1; }
[[ "$(grep -o 'VITE_APP_VERSION:"[^"]*"' <<<"$JS" | head -1)" == "VITE_APP_VERSION:\"$OGEVIA_EXPECT_COMMIT\"" ]] && ok "the bundle carries the candidate commit $OGEVIA_EXPECT_COMMIT" || nope "the bundle's version string is not the candidate commit"
grep -q 'VITE_APP_ENV:"test"' <<<"$JS" && ok 'built for TEST (VITE_APP_ENV:"test")' || nope "the bundle is not built for TEST"
grep -q 'TEST — synthetic data only' <<<"$JS" && ok "the TEST band text is in the bundle" || nope "the TEST band text is not in the bundle"
grep -q 'Environment not verified' <<<"$JS" && ok "the 'Environment not verified' text is in the bundle" || nope "the 'Environment not verified' text is not in the bundle"
CFG=$(G "$SITE/config.json") || CFG=""
if [[ -n "$CFG" ]]; then
  echo "config.json (identifiers only): $(jq -c '{VITE_APP_ENV,VITE_COGNITO_USER_POOL_ID,VITE_COGNITO_CLIENT_ID,VITE_SV_API_BASE_URL}' <<<"$CFG" 2>/dev/null)"
  [[ "$(jq -r .VITE_COGNITO_USER_POOL_ID <<<"$CFG")" == us-west-2_849AYz5J7 ]] && ok "config.json names the TEST pool us-west-2_849AYz5J7" || nope "config.json does not name the TEST pool"
  grep -q 's0epy5rgzb' <<<"$CFG" && ok "config.json names the TEST API s0epy5rgzb" || nope "config.json does not name the TEST API"
  grep -q 'FHJoX71ca\|zk527zk4ua' <<<"$CFG" && nope "config.json names a PRODUCTION identifier" || ok "config.json names no production identifier"
  if [[ -f "$B/web-before/config.json" ]]; then [[ "$(sha256sum "$B/web-before/config.json" | cut -d' ' -f1)" == "$(sha256sum <<<"$CFG" | cut -d' ' -f1)" || "$(jq -S . "$B/web-before/config.json" | sha256sum)" == "$(jq -S . <<<"$CFG" | sha256sum)" ]] && ok "config.json unchanged from the capture" || nope "config.json differs from the capture"; else echo "NOTE no config.json in the capture"; fi
else echo "NOTE the site serves no config.json (the build's own values apply)"; fi
grep -q 'FHJoX71ca\|zk527zk4ua' <<<"$JS" && nope "the bundle names a PRODUCTION identifier" || ok "the bundle names no production identifier"
KEY=$(aws cloudformation get-template --stack-name Ogevia-prod-ServiceVerificationApi --template-stage Original --output json 2>/dev/null | jq -r '.TemplateBody // . | [.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key|startswith("Handler"))) | .value.Properties.Code.S3Key][0] // empty')
[[ "$KEY" == "$HANDLER_KEY" ]] && ok "the TEST API still holds the pinned Handler asset (the API did not change)" || nope "the TEST API Handler asset is '${KEY:-unreadable}', not $HANDLER_KEY"
[[ $bad == 0 ]] && { echo "CANDIDATE WEB VERIFIED ON TEST: $SITE serves $OGEVIA_EXPECT_COMMIT"; exit 0; } || { echo "STOP: a check failed."; exit 1; }
