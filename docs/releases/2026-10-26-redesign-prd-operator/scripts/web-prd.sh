#!/usr/bin/env bash
# PRODUCTION WEB (release 2026-10-26-redesign): build, publish guard, verification and rollback. Modes:
#   OGEVIA_EXPECT_COMMIT=<40 hex> bash web-prd.sh build     LOCAL: builds apps/web with VITE_APP_VERSION=<commit>; reuses the values embedded in the CURRENTLY SERVED production bundle (Cognito pool/client/domain,
#                                                                                         redirect URIs, API base URL) so sign-in cannot break; refuses any other difference. No AWS write.
#   OGEVIA_DEPLOY_APPROVAL=<ref> bash web-prd.sh publish                              YELLOW: uploads the build to the production web bucket (NO --delete) and invalidates CloudFront, then runs verify. Needs the 85|0085 marker,
#                                                                                         the API post-check marker, an intact web-before capture, and the typed phrase PUBLISH-WEB-Ogevia-prd
#   bash web-prd.sh verify                                                            READ-ONLY (curl GETs): the served index.html equals the build byte for byte, the main script carries VITE_APP_VERSION:"<commit>" and VITE_APP_ENV:"production", only the production API host
#   bash web-prd.sh rollback-verify                                                   READ-ONLY: the recovery capture is intact and every captured file is still in the bucket with its captured size
#   OGEVIA_DEPLOY_APPROVAL=<ref> bash web-prd.sh rollback                             YELLOW: restores the captured site (missing/changed captured files first, then the captured index.html), invalidates, verifies the served page equals the capture. No deletes.
# Assets are content-hashed and never deleted, so the previous site's files stay in the bucket; only index.html switches. The production web has no config.json unless the capture has one (never touched).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
PREVIOUS_VERSION=e80b770210c54e423d28ecf48e00f1dda9506cec   # the version string the captured (currently served) production bundle carries
CODE_COMMIT="${OGEVIA_EXPECT_COMMIT:-}"; MODE="${1:-}"
[[ "$CODE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "set OGEVIA_EXPECT_COMMIT to the 40-character code commit of this package" >&2; exit 2; }
[[ "$(jq -r .code_commit "$TB_ROOT/BUILD_INFO.json" 2>/dev/null)" == "$CODE_COMMIT" ]] || { echo "BUILD_INFO.json of this package does not name $CODE_COMMIT" >&2; exit 2; }
[[ "$MODE" =~ ^(build|publish|verify|rollback-verify|rollback)$ && $# -eq 1 ]] || { echo "usage: bash web-prd.sh build|publish|verify|rollback-verify|rollback" >&2; exit 2; }
WEBOUT="${OGEVIA_PRD_WEB_OUT:-/tmp/ogevia-prd-web}"; need jq curl sha256sum timeout
G() { curl -fsS --max-time 60 "$@"; }
pairs() { grep -o 'VITE_[A-Z0-9_]*:"[^"]*"' "$1" | LC_ALL=C sort -u; }
bucket_from_outputs() { jq -r '.[] | select(.OutputKey=="SiteBucketName") | .OutputValue' "$B/outputs-Ogevia-prd-WebHosting.json" 2>/dev/null; }
dist_from_outputs() { jq -r '.[] | select(.OutputKey=="DistributionId") | .OutputValue' "$B/outputs-Ogevia-prd-WebHosting.json" 2>/dev/null; }
capture_intact() { [[ -s "$B/web-before.sha256" && -d "$B/web-before" ]] || return 1; (cd "$B/web-before" && sha256sum -c --quiet ../web-before.sha256) >/dev/null 2>&1; }
bucket_listing() { local L; L=$(A s3api list-objects-v2 --bucket "$1" --output json 2>/dev/null) || return 1; [[ "$(jq -r '.IsTruncated // false' <<<"$L")" == false ]] || return 1; jq -r '.Contents[]? | .Key + "\t" + (.Size|tostring)' <<<"$L"; }
SITE=$(cat "$B/web-url-before.txt" 2>/dev/null); API_URL=$(cat "$B/api-url-before.txt" 2>/dev/null)
[[ "$SITE" =~ ^(https://[A-Za-z0-9.-]+|file://.+)$ && "$API_URL" =~ ^https://[a-z0-9]+\.execute-api\.us-west-2\.amazonaws\.com ]] || stop "no captured production URLs: run p0-baseline-capture.sh first"
PRD_API_ID=$(sed -E 's#^https://([a-z0-9]+)\..*#\1#' <<<"$API_URL")

verify_served() {   # $1 = local reference dir (a build or the capture); $2 = expected version string or NONE
  local ref="$1" want="$2" idx served localh main js V E hosts other
  idx=$(G "$SITE/index.html" -o "$B/served-now-index.html" 2>&1) || { nope "cannot fetch $SITE/index.html"; return 1; }
  served=$(sha256sum "$B/served-now-index.html" | cut -d' ' -f1); localh=$(sha256sum "$ref/index.html" | cut -d' ' -f1)
  say "index.html sha256: served $served  expected $localh"
  [[ "$served" == "$localh" ]] && ok "the served index.html is byte-identical to $ref/index.html" || nope "the served index.html differs from $ref/index.html (CloudFront can lag about a minute after an invalidation: rerun once; otherwise STOP)"
  main=$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' "$B/served-now-index.html" | head -1); [[ -n "$main" ]] && ok "main script $main" || { nope "index.html references no assets/index-*.js"; return 1; }
  G "$SITE/$main" -o "$B/served-now-main.js" || { nope "cannot fetch $SITE/$main"; return 1; }
  [[ "$(sha256sum "$B/served-now-main.js" | cut -d' ' -f1)" == "$(sha256sum "$ref/$main" | cut -d' ' -f1)" ]] && ok "the served main script equals the expected file" || nope "the served main script differs from $ref/$main"
  V=$(grep -o 'VITE_APP_VERSION:"[^"]*"' "$B/served-now-main.js" | head -1); E=$(grep -o 'VITE_APP_ENV:"[^"]*"' "$B/served-now-main.js" | head -1)
  if [[ "$want" == NONE ]]; then [[ -z "$V" ]] && ok "no version string (as captured before the release)" || nope "unexpected version string $V"
  else [[ "$V" == "VITE_APP_VERSION:\"$want\"" ]] && ok "the bundle carries VITE_APP_VERSION:\"$want\"" || nope "the bundle's version string is '${V:-none}', expected the release commit $want"; fi
  [[ "$E" == 'VITE_APP_ENV:"production"' ]] && ok 'built for production (VITE_APP_ENV:"production")' || nope "the bundle's environment is '${E:-none}', not production"
  hosts=$(grep -o '[a-z0-9]*\.execute-api\.[a-z0-9.-]*' "$B/served-now-main.js" | sort -u | tr '\n' ' ')
  grep -q "${PRD_API_ID}\.execute-api" "$B/served-now-main.js" && ok "the bundle calls the production API host ${PRD_API_ID}.execute-api..." || nope "the bundle does not reference the production API host $PRD_API_ID"
  other=$(tr ' ' '\n' <<<"$hosts" | grep -v "^${PRD_API_ID}\." | grep . | tr '\n' ' '); [[ -z "$other" ]] && ok "no other API host in the bundle" || nope "the bundle also names another API host: $other"
  [[ $bad == 0 ]]
}

case "$MODE" in
build)
  PKG="$TB_ROOT"; [[ -d "$PKG/apps/web" ]] || stop "this package holds no apps/web"
  [[ "$(jq -r .code_commit "$PKG/BUILD_INFO.json" 2>/dev/null)" == "$CODE_COMMIT" ]] || stop "the operator package is not built from $CODE_COMMIT"
  OPK=$(operator_pkg_ok "$PKG") || stop "$OPK"
  VITE="$PKG/apps/web/node_modules/.bin/vite"; [[ -x "$VITE" ]] || stop "dependencies are not installed: run 'pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store' in $PKG"
  [[ -s "$B/served-main.js" ]] || stop "no captured production bundle ($B/served-main.js): run p0-baseline-capture.sh"
  pairs "$B/served-main.js" > "$B/live-pairs.txt"; say "values embedded in the CURRENTLY SERVED production bundle (reused so sign-in cannot change): $(wc -l < "$B/live-pairs.txt") ($(cut -d: -f1 "$B/live-pairs.txt" | tr '\n' ' '))"
  grep -qx 'VITE_APP_ENV:"production"' "$B/live-pairs.txt" || stop "the served bundle is not marked VITE_APP_ENV:\"production\""
  grep -qx "VITE_APP_VERSION:\"$PREVIOUS_VERSION\"" "$B/live-pairs.txt" || stop "the served bundle's version string is not the previous release $PREVIOUS_VERSION ($(grep '^VITE_APP_VERSION:' "$B/live-pairs.txt" || echo none)); review before replacing it"
  grep -v '^VITE_APP_VERSION:' "$B/live-pairs.txt" > "$B/live-pairs.novers.txt" && mv "$B/live-pairs.novers.txt" "$B/live-pairs.txt"
  grep -qx "VITE_SV_API_BASE_URL:\"${API_URL%/}\"" "$B/live-pairs.txt" || grep -q "VITE_SV_API_BASE_URL:\"https://${PRD_API_ID}\." "$B/live-pairs.txt" || stop "the served bundle's API base URL is not the production API"
  while IFS= read -r p; do export "${p%%:*}=$(sed -E 's/^[^:]*:"(.*)"$/\1/' <<<"$p")"; done < "$B/live-pairs.txt"
  export VITE_APP_VERSION="$CODE_COMMIT"
  rm -rf "$WEBOUT"; (cd "$PKG/apps/web" && PATH="$PKG/apps/web/node_modules/.bin:$PATH" "$VITE" build --outDir "$WEBOUT" --emptyOutDir) >"$B/d3-build.out" 2>&1 || { tail -5 "$B/d3-build.out"; stop "the web build failed ($B/d3-build.out)"; }
  [[ -f "$WEBOUT/index.html" ]] || stop "the build produced no index.html"
  NEWMAIN=$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' "$WEBOUT/index.html" | head -1); [[ -f "$WEBOUT/$NEWMAIN" ]] || stop "the build's index.html references no main script"
  { cat "$B/live-pairs.txt"; echo "VITE_APP_VERSION:\"$CODE_COMMIT\""; } | LC_ALL=C sort -u > "$B/expect-pairs.txt"; pairs "$WEBOUT/$NEWMAIN" > "$B/new-pairs.txt"
  if diff -q "$B/expect-pairs.txt" "$B/new-pairs.txt" >/dev/null; then ok "the new bundle embeds exactly the production values plus VITE_APP_VERSION:\"$CODE_COMMIT\""; else nope "the new bundle's embedded values differ from production's plus the version:"; diff "$B/expect-pairs.txt" "$B/new-pairs.txt" | sed 's/^/   /' | tee -a "$LOG"; fi
  [[ ! -e "$WEBOUT/config.json" ]] && ok "the build contains no config.json" || nope "the build contains a config.json; the capture's config is never replaced by this package"
  (cd "$WEBOUT" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) > "$B/web-build.sha256"; printf '%s\n' "$CODE_COMMIT" > "$B/web-build.commit"
  [[ $bad == 0 ]] || stop "the build is not acceptable (see FAIL lines)"
  say "WEB BUILD READY: $WEBOUT ($(wc -l < "$B/web-build.sha256") files; manifest $B/web-build.sha256). Nothing was published." ;;
verify)
  [[ -s "$B/web-build.sha256" && "$(cat "$B/web-build.commit" 2>/dev/null)" =~ ^[0-9a-f]{40}$ ]] || stop "no build manifest: run the build first"
  (cd "$WEBOUT" && sha256sum -c --quiet "$B/web-build.sha256") >/dev/null 2>&1 || stop "the local build does not match its manifest"
  verify_served "$WEBOUT" "$(cat "$B/web-build.commit")" && say "WEB VERIFIED: $SITE serves the release build." || stop "a web check failed. See recovery: bash web-prd.sh rollback-verify, then rollback." ;;
rollback-verify)
  capture_intact && ok "the recovery capture is intact ($(wc -l < "$B/web-before.sha256") files hashed)" || nope "the recovery capture ($B/web-before) is missing or does not match web-before.sha256"
  BUCKET=$(bucket_from_outputs); [[ -n "$BUCKET" ]] || stop "no production bucket in the captured outputs"
  LIST=$(bucket_listing "$BUCKET") || stop "cannot list s3://$BUCKET completely"
  MISS=0; while IFS=$'\t' read -r key size; do
    [[ "$key" == config.json ]] && continue
    got=$(awk -F'\t' -v k="$key" '$1==k{print $2}' <<<"$LIST")
    if [[ -z "$got" ]]; then say "   missing from the bucket: $key"; MISS=$((MISS + 1)); elif [[ "$got" != "$size" ]]; then say "   size differs: $key (bucket $got, capture $size)"; MISS=$((MISS + 1)); fi
  done < <(cd "$B/web-before" && find . -type f -printf '%P\t%s\n')
  [[ $MISS == 0 ]] && ok "every captured file is in the bucket with its captured size (rollback needs only the index.html switch)" || info "$MISS captured file(s) are missing or differ: 'rollback' restores them first"
  [[ $bad == 0 ]] && say "ROLLBACK SOURCE OK" || stop "the recovery source is not usable" ;;
publish|rollback)
  [[ "${OGEVIA_DEPLOY_APPROVAL:-}" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || stop "set OGEVIA_DEPLOY_APPROVAL to the owner's approval reference"
  check_account; BUCKET=$(bucket_from_outputs); DIST=$(dist_from_outputs)
  [[ "$BUCKET" =~ ^ogevia-prd-[a-z0-9.-]+$ && "$DIST" =~ ^E[A-Z0-9]+$ ]] || stop "the captured outputs do not name a production bucket (ogevia-prd-*) and a distribution"
  capture_intact || stop "the recovery capture ($B/web-before) is missing or damaged: refusing to change the site without it"
  if [[ "$MODE" == publish ]]; then
    [[ "$(cut -d' ' -f1 "$B/release-record.state" 2>/dev/null)" != DEPLOYED-RECORD-* ]] || stop "$B/release-record.state says the release has already taken effect: the web is not published twice automatically. Re-run record-deployed-prd.sh (read-only); a deliberate second publish needs the Owner's new written instruction"
    G "$SITE/index.html" -o "$B/served-pre-publish.html" 2>/dev/null && [[ "$(sha256sum "$B/served-pre-publish.html" | cut -d' ' -f1)" == "$(sha256sum "$B/web-before/index.html" | cut -d' ' -f1)" ]] || stop "the served index.html is not the one captured in web-before: the site changed since the capture (or cannot be read). Run p0-baseline-capture.sh again before publishing, so the recovery copy is the site you are replacing."
    [[ "$(cat "$B/db-0086.ok" 2>/dev/null)" == "85|0085|0086" ]] || stop "no $B/db-0086.ok: migration 0086 is not applied"
    [[ -s "$B/api-at-release.ok" ]] || stop "no $B/api-at-release.ok: run 'deploy-guard-prd.sh post Ogevia-prd-ServiceVerificationApi' successfully first (the web calls the new API)"
    [[ -s "$B/web-build.sha256" && "$(cat "$B/web-build.commit" 2>/dev/null)" =~ ^[0-9a-f]{40}$ ]] || stop "no build manifest: run the build first"
    (cd "$WEBOUT" && sha256sum -c --quiet "$B/web-build.sha256") >/dev/null 2>&1 || stop "the local build does not match its manifest"
    [[ ! -e "$WEBOUT/config.json" ]] || stop "the build contains a config.json"
    PH=PUBLISH-WEB-Ogevia-prd; SRC="$WEBOUT"
    say "PROPOSED (YELLOW, changes the PRODUCTION site; commit $(cat "$B/web-build.commit")): aws s3 sync $WEBOUT/assets s3://$BUCKET/assets (immutable, no --delete); aws s3 cp $WEBOUT/index.html s3://$BUCKET/index.html (no-cache); aws s3 sync the remaining build files (no --delete); aws cloudfront create-invalidation --distribution-id $DIST --paths /index.html /"
  else
    PH=RESTORE-WEB-Ogevia-prd; SRC="$B/web-before"
    LIST=$(bucket_listing "$BUCKET") || stop "cannot list s3://$BUCKET completely"
    say "PROPOSED (YELLOW, changes the PRODUCTION site): restore any captured file that is missing or differs in size (assets first), then put the captured index.html back (no-cache), invalidate CloudFront. No object is deleted; config.json is never touched."
  fi
  read -r -p "Type $PH to continue (anything else stops, nothing changed): " ans || ans=""
  [[ "$ans" == "$PH" ]] || { say "Declined. Nothing was changed."; exit 0; }
  if [[ "$MODE" == publish ]]; then
    A s3 sync "$WEBOUT/assets" "s3://$BUCKET/assets" --cache-control "public,max-age=31536000,immutable" --only-show-errors >/dev/null || stop "uploading the assets failed; the old index.html is still served"
    A s3 sync "$WEBOUT" "s3://$BUCKET" --exclude "assets/*" --exclude "index.html" --only-show-errors >/dev/null || stop "uploading the other files failed; the old index.html is still served"
    A s3 cp "$WEBOUT/index.html" "s3://$BUCKET/index.html" --cache-control "no-cache" --only-show-errors >/dev/null || stop "uploading index.html failed (check the bucket; rollback-verify, then rollback if the site is broken)"
  else
    while IFS=$'\t' read -r key size; do
      [[ "$key" == index.html || "$key" == config.json ]] && continue
      got=$(awk -F'\t' -v k="$key" '$1==k{print $2}' <<<"$LIST")
      if [[ "$got" != "$size" ]]; then A s3 cp "$B/web-before/$key" "s3://$BUCKET/$key" --cache-control "public,max-age=31536000,immutable" --only-show-errors >/dev/null && say "restored $key" || stop "cannot restore $key"; fi
    done < <(cd "$B/web-before" && find . -type f -printf '%P\t%s\n')
    A s3 cp "$B/web-before/index.html" "s3://$BUCKET/index.html" --cache-control "no-cache" --only-show-errors >/dev/null || stop "cannot restore index.html"
  fi
  A cloudfront create-invalidation --distribution-id "$DIST" --paths "/index.html" "/" >/dev/null 2>&1 || info "the CloudFront invalidation failed; the cached page can stay up to its TTL (index.html is no-cache); create it in the console or rerun"
  say "uploaded; waiting ${OGEVIA_CDN_WAIT:-20} s for the invalidation"; sleep "${OGEVIA_CDN_WAIT:-20}"
  if [[ "$MODE" == publish ]]; then
    verify_served "$WEBOUT" "$(cat "$B/web-build.commit")" || { bad=0; sleep "${OGEVIA_CDN_WAIT:-20}"; verify_served "$WEBOUT" "$(cat "$B/web-build.commit")"; } && say "PUBLISHED AND VERIFIED: $SITE serves $(cat "$B/web-build.commit")" || stop "the published site did not verify. Run: bash web-prd.sh rollback"
  else
    verify_served "$B/web-before" "$PREVIOUS_VERSION" || { bad=0; sleep "${OGEVIA_CDN_WAIT:-20}"; verify_served "$B/web-before" "$PREVIOUS_VERSION"; } && say "ROLLED BACK AND VERIFIED: $SITE serves the captured site" || stop "the restored site did not verify against the capture"
  fi ;;
esac
[[ $bad == 0 ]] || exit 1
