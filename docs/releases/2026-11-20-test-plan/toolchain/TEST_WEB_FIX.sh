#!/usr/bin/env bash
# TEST ONLY, WEB ONLY: publishes the web build of the release commit to the TEST site (bucket and CloudFront of Ogevia-prod-WebHosting). No API, database or switch change.
#   1 guards (commit, clean tree, account, approval reference, the TEST web targets are not production's)  2 read-only capture of the live TEST web files (the rollback reference)
#   3 typed confirmation  4 build for TEST stamped with the commit and upload (no delete), CloudFront invalidation  5 verify what the site serves
#   REPO=<checkout at the release commit> OGEVIA_RELEASE_COMMIT=<full sha> WORK=<work dir> OGEVIA_DEPLOY_APPROVAL=<owner TEST authorization reference> bash TEST_WEB_FIX.sh [deploy|rollback-web]
#   OGEVIA_NO_CONFIRM=1 skips the typed confirmation (automated test only).
set -euo pipefail
set +x +H
umask 077
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER="" CDK_DISABLE_CLI_TELEMETRY=true PYTHONDONTWRITEBYTECODE=1
stop() { echo "STOP: $*" >&2; exit 2; }
MODE="${1:-deploy}"; case "$MODE" in deploy|rollback-web) ;; *) stop "usage: deploy | rollback-web";; esac
: "${REPO:?set REPO to the checkout at the release commit}"; : "${OGEVIA_RELEASE_COMMIT:?set OGEVIA_RELEASE_COMMIT}"; : "${WORK:?set WORK}"; : "${OGEVIA_DEPLOY_APPROVAL:?set OGEVIA_DEPLOY_APPROVAL}"
[[ "$OGEVIA_DEPLOY_APPROVAL" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || stop "OGEVIA_DEPLOY_APPROVAL must be 6 to 64 characters of A-Za-z0-9._-"
COMMIT="$OGEVIA_RELEASE_COMMIT"
[[ "$(git -C "$REPO" rev-parse HEAD)" == "$COMMIT" ]] || stop "the checkout is not at the release commit"
[[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop "tracked files in the checkout are modified"
A() { timeout --foreground -k 5 "${OGEVIA_AWS_TIMEOUT:-300}" aws --cli-connect-timeout 5 --cli-read-timeout 120 "$@"; }
[[ "$(A sts get-caller-identity --query Account --output text)" == 300094796789 ]] || stop "wrong AWS account (expected 300094796789 in us-west-2)"
export XDG_CACHE_HOME="$WORK/cache" XDG_DATA_HOME="$WORK/data" XDG_STATE_HOME="$WORK/state" COREPACK_HOME="$WORK/corepack"
for d in "$WORK"/node-v22.*-linux-*/bin; do [[ -d "$d" ]] && export PATH="$d:$PATH"; done
[[ -d "$WORK/bin" ]] && export PATH="$WORK/bin:$PATH"
confirm() { local got; echo; echo "$2"; if [[ "${OGEVIA_NO_CONFIRM:-}" == 1 ]]; then return 0; fi
  printf 'Type exactly  %s  to continue: ' "$1" > /dev/tty; read -r got < /dev/tty; [[ "$got" == "$1" ]] || stop "confirmation not given"; }
out() { A cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
SITE_BUCKET="$(out Ogevia-prod-WebHosting SiteBucketName)"; DIST_ID="$(out Ogevia-prod-WebHosting DistributionId)"
[[ -n "$SITE_BUCKET" && "$SITE_BUCKET" != None && -n "$DIST_ID" && "$DIST_ID" != None ]] || stop "missing TEST web targets"
[[ "$SITE_BUCKET" != "$(out Ogevia-prd-WebHosting SiteBucketName)" && "$DIST_ID" != "$(out Ogevia-prd-WebHosting DistributionId)" ]] || stop "the TEST web targets are shared with production"
if [[ "$MODE" == rollback-web ]]; then
  B="${WEB_DIR:-$( { ls -d "$WORK"/webfix-2* 2>/dev/null | sort | tail -1; } || true)}"; [[ -n "$B" && -d "$B/web-before" ]] || stop "no captured web files in $WORK"
  [[ "$(cat "$B/release-commit.txt")" == "$COMMIT" ]] || stop "the capture was made for a different commit"
  confirm "ROLLBACK-TEST-WEB" "Restores the captured pre-fix web files to the TEST bucket (nothing is deleted; config.json is not touched)."
  (cd "$B/web-before" && for a in $(grep -o 'assets/[A-Za-z0-9._-]*' index.html | sort -u); do [[ -f "$a" ]] || { echo "STOP: $a is referenced by the captured index.html but is missing" >&2; exit 2; }; done)
  A s3 sync "$B/web-before/assets" "s3://$SITE_BUCKET/assets" --cache-control "public,max-age=31536000,immutable" --only-show-errors
  A s3 sync "$B/web-before" "s3://$SITE_BUCKET" --exclude "assets/*" --exclude index.html --exclude config.json --only-show-errors
  A s3 cp "$B/web-before/index.html" "s3://$SITE_BUCKET/index.html" --cache-control no-cache --only-show-errors
  A cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/index.html" "/" >/dev/null
  echo "ROLLBACK-WEB done: the captured index.html is back (allow a minute for CloudFront)"; exit 0
fi
B="$WORK/webfix-$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -p "$B"; chmod 700 "$B"; echo "$COMMIT" > "$B/release-commit.txt"
A s3 sync "s3://$SITE_BUCKET" "$B/web-before" --only-show-errors
echo "web files captured: $(find "$B/web-before" -type f | wc -l) (rollback reference: $B)"
confirm "PUBLISH-TEST-WEB" "ABOUT TO CHANGE TEST ONLY (owner authorization $OGEVIA_DEPLOY_APPROVAL): publish the web build of $COMMIT to the TEST site. No API, database or switch change. Production is not touched."
(cd "$REPO" && VITE_APP_VERSION="$COMMIT" bash infra/aws/scripts/deploy-test-slice.sh web) || stop "the web publish failed; run rollback-web, then send the output."
echo "waiting 60 s for CloudFront..."; sleep "${OGEVIA_CF_WAIT:-60}"
SITE="$(out Ogevia-prod-WebHosting WebOrigin)"; DIST="$REPO/apps/web/dist-aws"; [[ -f "$DIST/index.html" ]] || stop "no local web build"
bad=0; ok() { echo "PASS $*"; }; nope() { echo "FAIL $*"; bad=1; }
IDXF="$(mktemp)"; curl -fsS --max-time 60 -o "$IDXF" "$SITE/index.html" || stop "cannot fetch $SITE/index.html"
[[ "$(sha256sum "$IDXF" | cut -d' ' -f1)" == "$(sha256sum "$DIST/index.html" | cut -d' ' -f1)" ]] && ok "the served index.html is the one just built" || nope "the served index.html differs (CloudFront lag: wait a minute and recheck)"
ASSET="$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' "$IDXF" | head -1)"; rm -f "$IDXF"; [[ -n "$ASSET" ]] || stop "index.html references no main script"
JS="$(curl -fsS --max-time 60 "$SITE/$ASSET")" || stop "cannot fetch the main script"
[[ "$(grep -o 'VITE_APP_VERSION:"[^"]*"' <<<"$JS" | head -1)" == "VITE_APP_VERSION:\"$COMMIT\"" ]] && ok "the bundle carries commit $COMMIT" || nope "the bundle version is not $COMMIT"
grep -q 'VITE_APP_ENV:"test"' <<<"$JS" && ok 'built for TEST' || nope "the bundle is not built for TEST"
if [[ -f "$B/web-before/config.json" ]]; then
  [[ "$(curl -fsS --max-time 60 "$SITE/config.json" | sha256sum | cut -d' ' -f1)" == "$(sha256sum "$B/web-before/config.json" | cut -d' ' -f1)" ]] && ok "config.json unchanged" || nope "config.json differs from the capture"
fi
[[ "$bad" == 0 ]] || stop "a web check failed (see rollback-web)"
echo; echo "TEST WEB PUBLISHED: $SITE serves $COMMIT. API, database and switches untouched; production untouched. Rollback reference: $B"
