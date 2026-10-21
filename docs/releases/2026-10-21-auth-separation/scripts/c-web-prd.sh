#!/usr/bin/env bash
# C: the PRODUCTION WEB build and publish with the NEW production pool. The sign-in settings are the ONLY values that change: every other value embedded in the currently
# served bundle (API address, environment, version) is reused so nothing else can break. Modes:
#   bash c-web-prd.sh build       LOCAL, no AWS write: reads the stack outputs, builds apps/web with the production pool/client/domain and refuses a bundle that still carries the
#                                 shared pool, the legacy client, the old production client or the shared domain.
#   OGEVIA_DEPLOY_APPROVAL=<ref> bash c-web-prd.sh publish    YELLOW: only after the production API already trusts the new pool. Captures the CURRENT index.html and the bucket listing
#                                 (rollback source), uploads the build (NO --delete: old hashed files stay), invalidates CloudFront, verifies. Typed phrase PUBLISH-WEB-Ogevia-prd-AUTH.
#   bash c-web-prd.sh verify      READ-ONLY (HTTP GETs): the served index.html equals the build; the served bundle carries the new pool and client and none of the old ones.
#   OGEVIA_DEPLOY_APPROVAL=<ref> bash c-web-prd.sh rollback   YELLOW: restores the captured index.html (the previous bundle's files are still in the bucket), invalidates, verifies.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/common.sh"
MODE="${1:-}"; [[ $# -eq 1 && "$MODE" =~ ^(build|publish|verify|rollback)$ ]] || { echo "usage: bash c-web-prd.sh build|publish|verify|rollback" >&2; exit 2; }
need aws jq curl sha256sum timeout grep
CURL="${OGEVIA_CURL:-curl}"; G() { "$CURL" -fsS --max-time 60 "$@"; }
WEBOUT="${OGEVIA_PRD_WEB_OUT:-$HOME/ogevia-prd-web-auth}"; BEFORE_DIR="$AB/web-before"
WEB_SRC="${OGEVIA_WEB_SRC:-$HERE/../../../../apps/web}"; VITE="${OGEVIA_VITE_BIN:-$WEB_SRC/node_modules/.bin/vite}"
check_account
SITE=$(stack_out "$WEB_STACK" WebOrigin); BUCKET=$(stack_out "$WEB_STACK" SiteBucketName); DIST=$(stack_out "$WEB_STACK" DistributionId); OLD_CLIENT=$(stack_out "$WEB_STACK" TestAppClientId)
API_URL=$(stack_out "$API_STACK" ApiUrl)
POOL=$(stack_out "$AUTH_STACK" UserPoolId); CLIENT=$(stack_out "$AUTH_STACK" AppClientId); DOMAIN=$(stack_out "$AUTH_STACK" ManagedLoginDomain)
[[ "$SITE" =~ ^(https://[A-Za-z0-9.-]+|file://.+)$ && -n "$BUCKET" && -n "$DIST" && "$API_URL" =~ ^https://[a-z0-9]+\.execute-api\.us-west-2\.amazonaws\.com$ ]] || stop "cannot read the production web and API stack outputs"
[[ "$POOL" =~ ^us-west-2_[A-Za-z0-9]+$ && "$POOL" != "$SHARED_POOL" && "$CLIENT" =~ ^[a-z0-9]{26}$ && "$DOMAIN" =~ ^https://[a-z0-9-]+\.auth\.us-west-2\.amazoncognito\.com$ ]] || stop "the production pool outputs are missing: deploy a-deploy-prd.sh first"
SHARED_DOMAIN_RE='us-west-2849ayz5j7'; LEGACY_CLIENT="${OGEVIA_LEGACY_CLIENT_ID:-1i27abbina08fvg1i9u8vprgo9}"
pairs() { grep -o 'VITE_[A-Z0-9_]*:"[^"]*"' "$1" | LC_ALL=C sort -u; }
served_main() {   # $1 = output file for the served main script; echoes its name
  G "$SITE/index.html" -o "$AB/served-index.html" || return 1
  local m; m=$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' "$AB/served-index.html" | head -1); [[ -n "$m" ]] || return 1
  G "$SITE/$m" -o "$1" || return 1; echo "$m"
}
carries_only_new() {   # $1 = bundle file; prints PASS/FAIL lines
  grep -q "$CLIENT" "$1" && ok "the bundle carries the production client" || nope "the bundle does not carry the production client"
  grep -q "$POOL" "$1" && ok "the bundle carries the production pool" || nope "the bundle does not carry the production pool"
  grep -q "${DOMAIN#https://}" "$1" && ok "the bundle carries the production sign-in domain" || nope "the bundle does not carry the production sign-in domain"
  for old in "$SHARED_POOL" "$LEGACY_CLIENT" "$OLD_CLIENT" "$SHARED_DOMAIN_RE"; do
    [[ -z "$old" ]] && continue
    grep -q "$old" "$1" && nope "the bundle still carries an old sign-in value ($(printf '%s' "$old" | cut -c1-6)...)" || ok "no old sign-in value ${old:0:6}... in the bundle"
  done
}

case "$MODE" in
build)
  [[ -x "$VITE" ]] || stop "vite is not installed: run 'pnpm install --frozen-lockfile' in the package ($VITE)"
  MAIN=$(served_main "$AB/served-main.js") || stop "cannot fetch the currently served production bundle from $SITE"
  pairs "$AB/served-main.js" > "$AB/live-pairs.txt"; say "values embedded in the served bundle: $(wc -l < "$AB/live-pairs.txt") (names: $(cut -d: -f1 "$AB/live-pairs.txt" | tr '\n' ' '))"
  grep -qx 'VITE_APP_ENV:"production"' "$AB/live-pairs.txt" || stop "the served bundle is not marked VITE_APP_ENV:\"production\""
  grep -qx "VITE_SV_API_BASE_URL:\"$API_URL\"" "$AB/live-pairs.txt" || stop "the served bundle's API address is not the production API $API_URL"
  grep -qx 'VITE_AUTH_PROVIDER:"cognito"' "$AB/live-pairs.txt" || stop "the served bundle is not the AWS (Cognito) build"
  while IFS= read -r p; do export "${p%%:*}=$(sed -E 's/^[^:]*:"(.*)"$/\1/' <<<"$p")"; done < "$AB/live-pairs.txt"
  # the ONLY values that change:
  export VITE_COGNITO_USER_POOL_ID="$POOL" VITE_COGNITO_CLIENT_ID="$CLIENT" VITE_COGNITO_DOMAIN="$DOMAIN" VITE_COGNITO_REGION=us-west-2 \
         VITE_COGNITO_REDIRECT_URI="$SITE/auth/callback" VITE_COGNITO_LOGOUT_URI="$SITE/" VITE_COGNITO_REFRESH_PERSISTENCE=session
  changed=$(for k in VITE_COGNITO_USER_POOL_ID VITE_COGNITO_CLIENT_ID VITE_COGNITO_DOMAIN; do grep -q "^$k:\"${!k}\"$" "$AB/live-pairs.txt" || echo "$k"; done | tr '\n' ' ')
  say "sign-in values replaced: ${changed:-none (already the production pool)}"
  rm -rf "$WEBOUT"; (cd "$WEB_SRC" && "$VITE" build --outDir "$WEBOUT" --emptyOutDir) >"$AB/web-build.out" 2>&1 || { tail -5 "$AB/web-build.out"; stop "the web build failed"; }
  [[ -f "$WEBOUT/index.html" ]] || stop "the build produced no index.html"
  NEWMAIN=$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' "$WEBOUT/index.html" | head -1); [[ -f "$WEBOUT/$NEWMAIN" ]] || stop "the build's index.html references no main script"
  carries_only_new "$WEBOUT/$NEWMAIN"; grep -q "VITE_APP_ENV:\"production\"" "$WEBOUT/$NEWMAIN" && ok 'built for production' || nope 'not built for production'
  grep -q "${API_URL#https://}" "$WEBOUT/$NEWMAIN" && ok "the bundle calls the production API" || nope "the bundle does not reference the production API"
  [[ $bad == 0 ]] || stop "BUILD CHECKS FAILED. Nothing was published."
  (cd "$WEBOUT" && find . -type f | sort | xargs sha256sum) > "$AB/web-build.sha256"; date +%s > "$AB/web-build.ok"
  say "BUILD OK: $WEBOUT (index.html sha256 $(sha256sum "$WEBOUT/index.html" | cut -c1-16)...). Nothing was published." ;;
publish)
  [[ "${OGEVIA_DEPLOY_APPROVAL:-}" =~ $APPROVAL_RE ]] || stop "set OGEVIA_DEPLOY_APPROVAL to the approval reference"
  [[ -s "$AB/web-build.ok" && -f "$WEBOUT/index.html" ]] || stop "run 'bash c-web-prd.sh build' first"
  (cd "$WEBOUT" && sha256sum -c --quiet "$AB/web-build.sha256") >/dev/null 2>&1 || stop "the build changed since it was checked: rebuild"
  API_ID=$(sed -E 's#^https://([a-z0-9]+)\..*#\1#' <<<"$API_URL")
  AUD=$(A apigatewayv2 get-authorizers --api-id "$API_ID" --output json 2>/dev/null | jq -c '[.Items[].JwtConfiguration.Audience] | add')
  [[ "$AUD" == "[\"$CLIENT\"]" ]] || stop "the production API does not yet trust only the production client (audience $AUD). Publishing the new site now would break sign-in."
  ok "the production API already trusts exactly the production client"
  say "== PROPOSED (YELLOW): upload the new production site to s3://$BUCKET (no --delete) and invalidate CloudFront $DIST. The CURRENT index.html and bucket listing are saved first for rollback."
  read -r -p "Type PUBLISH-WEB-Ogevia-prd-AUTH to publish (anything else stops): " ANS || true
  [[ "${ANS:-}" == PUBLISH-WEB-Ogevia-prd-AUTH ]] || { say "Declined. Nothing was changed."; exit 0; }
  rm -rf "$BEFORE_DIR"; mkdir -p "$BEFORE_DIR"
  A s3 cp "s3://$BUCKET/index.html" "$BEFORE_DIR/index.html" >/dev/null 2>&1 && [[ -s "$BEFORE_DIR/index.html" ]] || stop "cannot capture the current index.html (rollback source). Nothing was changed."
  A s3api list-objects-v2 --bucket "$BUCKET" --output json 2>/dev/null | jq -r '.Contents[]? | .Key + "\t" + (.Size|tostring)' | sort > "$AB/web-before-keys.txt"; [[ -s "$AB/web-before-keys.txt" ]] || stop "cannot list the bucket"
  sha256sum "$BEFORE_DIR/index.html" > "$AB/web-before.sha256"; ok "captured the current index.html ($(wc -l < "$AB/web-before-keys.txt") objects listed)"
  A s3 sync "$WEBOUT/assets" "s3://$BUCKET/assets" --cache-control "public,max-age=31536000,immutable" >/dev/null || stop "asset upload failed (the live index.html was not changed)"
  A s3 sync "$WEBOUT" "s3://$BUCKET" --exclude "assets/*" --exclude "index.html" >/dev/null || stop "upload failed (the live index.html was not changed)"
  A s3 cp "$WEBOUT/index.html" "s3://$BUCKET/index.html" --cache-control "no-cache" >/dev/null || stop "index.html upload failed"
  A cloudfront create-invalidation --distribution-id "$DIST" --paths "/index.html" "/" >/dev/null || stop "invalidation failed (the new index.html is uploaded; CloudFront may serve the old one briefly)"
  sleep "${OGEVIA_CDN_WAIT:-30}"; exec bash "$0" verify ;;
verify)
  MAIN=$(served_main "$AB/served-main.js") || stop "cannot fetch the served site $SITE"
  if [[ -f "$WEBOUT/index.html" ]]; then
    [[ "$(sha256sum "$AB/served-index.html" | cut -d' ' -f1)" == "$(sha256sum "$WEBOUT/index.html" | cut -d' ' -f1)" ]] && ok "the served index.html is byte-identical to the build" || nope "the served index.html differs from the build (CloudFront can lag about a minute after an invalidation)"
  fi
  carries_only_new "$AB/served-main.js"
  [[ $bad == 0 ]] && say "VERIFY PASSED: the production site signs in with the production pool only." || { say "VERIFY FAILED."; exit 1; } ;;
rollback)
  [[ "${OGEVIA_DEPLOY_APPROVAL:-}" =~ $APPROVAL_RE ]] || stop "set OGEVIA_DEPLOY_APPROVAL to the approval reference"
  [[ -s "$BEFORE_DIR/index.html" && -s "$AB/web-before.sha256" ]] && (cd "$BEFORE_DIR" && sha256sum -c --quiet "$AB/web-before.sha256") >/dev/null 2>&1 || stop "the captured index.html is missing or changed: no rollback source"
  say "== PROPOSED (YELLOW): restore the captured index.html to s3://$BUCKET and invalidate CloudFront $DIST (no other file is touched or deleted)."
  read -r -p "Type ROLLBACK-WEB-Ogevia-prd-AUTH to restore (anything else stops): " ANS || true
  [[ "${ANS:-}" == ROLLBACK-WEB-Ogevia-prd-AUTH ]] || { say "Declined. Nothing was changed."; exit 0; }
  while IFS=$'\t' read -r key size; do A s3api head-object --bucket "$BUCKET" --key "$key" >/dev/null 2>&1 || nope "captured object missing now: $key"; done < <(head -50 "$AB/web-before-keys.txt")
  [[ $bad == 0 ]] || stop "captured objects are missing from the bucket; do not roll back blindly"
  A s3 cp "$BEFORE_DIR/index.html" "s3://$BUCKET/index.html" --cache-control "no-cache" >/dev/null || stop "restore failed"
  A cloudfront create-invalidation --distribution-id "$DIST" --paths "/index.html" "/" >/dev/null || stop "invalidation failed"
  sleep "${OGEVIA_CDN_WAIT:-30}"
  G "$SITE/index.html" -o "$AB/served-index.html" || stop "cannot fetch the site"
  [[ "$(sha256sum "$AB/served-index.html" | cut -d' ' -f1)" == "$(cut -d' ' -f1 "$AB/web-before.sha256")" ]] && say "ROLLED BACK: the served index.html equals the captured one." || { say "NOT YET EQUAL: CloudFront may lag; re-run 'bash c-web-prd.sh verify' shortly."; exit 1; } ;;
esac
