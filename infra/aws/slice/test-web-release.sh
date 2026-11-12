#!/usr/bin/env bash
# =============================================================================
# OGEVIA: TEST-ONLY WEB RELEASE (infra/aws/slice/test-web-release.sh)
# Prepared 2026-10-16. NOT AUTHORIZED TO RUN until the owner's written Phase C statement exists
# (docs/releases/2026-10-16-test-web-release/PHASE_C_AUTHORIZATION_STATEMENT.md).
#
# Publishes the web app to the TEST environment ONLY (stacks Ogevia-prod-*, API s0epy5rgzb). "prod" in those names means TEST;
# PROD is Ogevia-prd-*. It never touches PROD, the database, the API, Cognito, DNS or config.json. The build is labelled
# "test" so the "TEST - synthetic data only" banner shows even though TEST's live config.json has no VITE_APP_ENV key, and a
# build that is not labelled test (or is labelled production) is refused.
#
# RELEASE COMMIT: the 40-character commit named in the owner's approval, given as OGEVIA_RELEASE_COMMIT (no default: the script refuses without it). The checkout must contain it and its application files
# (apps/, packages/, lockfile, workspace files) must be identical to it; other files (scripts, docs, tests) may differ, so this
# script can run from the reviewed pull request branch or from main after it is merged.
#
# Run in AWS CloudShell (us-west-2, administrator role), from the repository root:
#     git clone https://github.com/socalcaresservices/CarelikGlobal.git   # skip if already cloned
#     cd CarelikGlobal && git fetch origin && git checkout <the reviewed branch or commit named in the authorization>
#     bash infra/aws/slice/test-web-release.sh preflight   # READ-ONLY: guards, live TEST config check
#     bash infra/aws/slice/test-web-release.sh build       # LOCAL ONLY: installs dependencies, builds, checks the label
#     bash infra/aws/slice/test-web-release.sh capture     # READS the TEST site into local files: the rollback copy
#     OGEVIA_DEPLOY_APPROVAL=<reference> OGEVIA_WINDOW_END=<UTC time> bash infra/aws/slice/test-web-release.sh publish   # WRITES (TEST only)
#     bash infra/aws/slice/test-web-release.sh verify      # READ-ONLY public requests: proves what is live
#     OGEVIA_DEPLOY_APPROVAL=<reference> bash infra/aws/slice/test-web-release.sh rollback                                  # WRITES (TEST only)
#
# OGEVIA_WINDOW_END is the end of the approved window as a UTC time, for example 2026-10-16T22:30:00Z. publish refuses to start
# after it (and refuses a time more than 4 hours ahead). A running publish finishes.
# EXIT CODES  0 ok | 2 refused by a guard (nothing written) | 3 a command failed or a check did not pass
# Writes go ONLY to: the TEST site bucket (assets, index.html, root files; never config.json; never --delete) and one TEST
# CloudFront invalidation. Local files go under $HOME/ogevia-test-web-release-<first 7 characters of the release commit> (mode 700).
# =============================================================================
set -uo pipefail
umask 077

ACCOUNT=300094796789
REGION=us-west-2
EXPECTED_COMMIT="${OGEVIA_RELEASE_COMMIT:-}"   # validated below, after the step name is checked
TEST_PREFIX=Ogevia-prod            # NOTE: "prod" is the name of the TEST stacks. PROD is Ogevia-prd.
PROD_PREFIX=Ogevia-prd
TEST_API=s0epy5rgzb
TEST_WEB_HOST=d2xumch5w0izfg.cloudfront.net
APP_PATHS="apps packages pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json"
EXPECTED_ENTRY_JS=""     # no fingerprint is pinned for a new commit; the build records its own entry script name
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION AWS_PAGER=""
RUN="${OGEVIA_TEST_WEB_RUN_DIR:-$HOME/ogevia-test-web-release-${EXPECTED_COMMIT:0:7}}"
CMD="${1:-}"

refuse() { printf 'REFUSED (nothing was written): %s\n' "$*" >&2; exit 2; }
fail()   { printf 'FAILED: %s\n' "$*" >&2; [[ -d "$RUN" ]] && printf '%s FAILED: %s\n' "$(date -u +%FT%TZ)" "$*" >> "$RUN/release.log"; exit 3; }
note()   { printf '%s\n' "$*"; [[ -d "$RUN" ]] && printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$RUN/release.log"; return 0; }
sanitize() { tr '\n\r' '  ' | sed -E 's/[0-9]{12}/<acct>/g; s#arn:aws[a-z-]*:[^ ]*#<arn>#g' | head -c 240; }

case "$CMD" in preflight|build|capture|publish|verify|rollback) ;; *) awk 'NR>1{print} /^# =+$/{c++; if (c==2) exit}' "$0"; exit 2;; esac
[[ "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]] || refuse "set OGEVIA_RELEASE_COMMIT to the 40-character commit named in the owner's approval (lowercase hex)"
for t in aws jq curl git sha256sum; do command -v "$t" >/dev/null 2>&1 || refuse "missing tool: $t"; done
mkdir -p "$RUN" && chmod 700 "$RUN" || refuse "cannot create $RUN"
TMP=$(mktemp -d) || refuse "cannot create a temporary folder"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------- guards ----
guard_repo() {
  REPO=$(git rev-parse --show-toplevel 2>/dev/null) || refuse "run this from inside the CarelikGlobal clone"
  git -C "$REPO" cat-file -e "${EXPECTED_COMMIT}^{commit}" 2>/dev/null \
    || refuse "this clone does not contain the approved release commit commit ${EXPECTED_COMMIT:0:7}. Run: git fetch origin"
  git -C "$REPO" merge-base --is-ancestor "$EXPECTED_COMMIT" HEAD 2>/dev/null \
    || refuse "HEAD does not contain the approved release commit ${EXPECTED_COMMIT:0:7}. Check out the reviewed branch or commit named in the authorization"
  git -C "$REPO" diff --quiet "$EXPECTED_COMMIT" HEAD -- $APP_PATHS \
    || refuse "application files differ from the approved release commit ${EXPECTED_COMMIT:0:7} ($APP_PATHS); this release publishes the baseline application only"
  [[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || refuse "the clone has local changes to tracked files; use a clean checkout"
  [[ -f "$REPO/apps/web/package.json" && -f "$REPO/pnpm-lock.yaml" ]] || refuse "required files are missing from this checkout"
  HEAD_SHA=$(git -C "$REPO" rev-parse HEAD)
}
aws_try() { local l=$1 rc; shift; "$@" >"$TMP/$l.out" 2>"$TMP/$l.err"; rc=$?; (( rc == 0 )) || fail "$l: command failed with exit code $rc: $(sanitize < "$TMP/$l.err")"; }
cfout() {   # cfout <stack> <OutputKey> <regex> <var>: read one CloudFormation output and validate it before it is used
  local v
  aws_try "out-$1-$2" aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" --output text
  v=$(tr -d '\r\n' < "$TMP/out-$1-$2.out"); v=${v%/}
  if [[ -z "$v" || "$v" == None || "$v" == null ]] || ! [[ "$v" =~ $3 ]]; then fail "required output $2 of stack $1 is missing or malformed"; fi
  printf -v "$4" '%s' "$v"
}
guard_aws() {
  aws_try identity aws sts get-caller-identity --query Account --output text
  [[ "$(tr -d '\r\n' < "$TMP/identity.out")" == "$ACCOUNT" ]] || refuse "the signed-in AWS account is not the Ogevia account"
  local re_web='^https://[a-z0-9]+\.cloudfront\.net$' re_api='^https://[a-z0-9]+\.execute-api\.us-west-2\.amazonaws\.com$' re_b='^[a-z0-9][a-z0-9.-]{2,62}$' re_d='^[A-Z0-9]{10,20}$'
  cfout "$TEST_PREFIX-WebHosting" WebOrigin "$re_web" WEB;  cfout "$TEST_PREFIX-WebHosting" SiteBucketName "$re_b" BUCKET
  cfout "$TEST_PREFIX-WebHosting" DistributionId "$re_d" DIST; cfout "$TEST_PREFIX-ServiceVerificationApi" ApiUrl "$re_api" API
  [[ "${WEB#https://}" == "$TEST_WEB_HOST" ]] || refuse "TEST web address is ${WEB#https://}, expected $TEST_WEB_HOST"
  local lab=${API#https://}; lab=${lab%%.*}
  [[ "$lab" == "$TEST_API" ]] || refuse "TEST API id is $lab, expected $TEST_API"
  # environment separation: every TEST resource must differ from the PROD resource of the same kind (and PROD must be readable)
  local pw pb pd
  cfout "$PROD_PREFIX-WebHosting" WebOrigin "$re_web" pw; cfout "$PROD_PREFIX-WebHosting" SiteBucketName "$re_b" pb; cfout "$PROD_PREFIX-WebHosting" DistributionId "$re_d" pd
  [[ "$WEB" != "$pw" && "$BUCKET" != "$pb" && "$DIST" != "$pd" ]] || refuse "a TEST resource equals the PROD resource: the environments are not separated. Stop and report."
  [[ "$BUCKET" != *prd* ]] || refuse "the TEST bucket name contains 'prd'; refusing"
  # the live config.json: TEST's own API, and a label that is absent or test (never production)
  local code; code=$(curl -sS -m 20 -o "$TMP/live-config.json" -w '%{http_code}' "$WEB/config.json" 2>"$TMP/cfg.err") || fail "cannot read $WEB/config.json: $(sanitize < "$TMP/cfg.err")"
  [[ "$code" == 200 ]] && jq -e 'type=="object"' "$TMP/live-config.json" >/dev/null 2>&1 || refuse "the live config.json is missing or not a JSON object (HTTP $code)"
  local capi; capi=$(jq -r '.VITE_SV_API_BASE_URL // ""' "$TMP/live-config.json" | sed -E 's#https://([a-z0-9]+)\..*#\1#')
  [[ "$capi" == "$TEST_API" ]] || refuse "the live config.json points at API '$capi', expected $TEST_API"
  LIVE_ENV=$(jq -r '.VITE_APP_ENV // "(absent)"' "$TMP/live-config.json")
  [[ "$LIVE_ENV" == "(absent)" || "$LIVE_ENV" == test || "$LIVE_ENV" == development ]] || refuse "the live config.json says VITE_APP_ENV=$LIVE_ENV; TEST must not claim to be production"
  LIVE_CFG_SHA=$(sha256sum "$TMP/live-config.json" | cut -d' ' -f1)
}
assert_label() {   # the banner TEXT is in every build; the baked-in VITE_APP_ENV value is what differs
  local d=$1
  grep -rqE 'VITE_APP_ENV:[[:space:]]*"test"' "$d/assets" 2>/dev/null || fail "the build is not labelled test (VITE_APP_ENV:\"test\" not found)"
  if grep -rqE 'VITE_APP_ENV:[[:space:]]*"production"' "$d/assets" 2>/dev/null; then fail "the build is labelled production; refusing"; fi
  [[ ! -e "$d/config.json" ]] || fail "the build contains a config.json; it must never be uploaded"
}
window_open() {   # the approved window must still be open (UTC end time in OGEVIA_WINDOW_END)
  local end now
  [[ -n "${OGEVIA_WINDOW_END:-}" ]] || refuse "set OGEVIA_WINDOW_END to the end of the approved window as a UTC time, for example 2026-10-16T22:30:00Z"
  end=$(date -u -d "$OGEVIA_WINDOW_END" +%s 2>/dev/null) || refuse "OGEVIA_WINDOW_END is not a valid time: $OGEVIA_WINDOW_END"
  now=$(date -u +%s)
  (( end > now )) || refuse "the approved window ended at $OGEVIA_WINDOW_END; ask the owner for a new window"
  (( end - now <= 14400 )) || refuse "OGEVIA_WINDOW_END is more than 4 hours ahead; a window is at most 4 hours"
}
approval() {   # approval <typed phrase>
  [[ "${OGEVIA_DEPLOY_APPROVAL:-}" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || refuse "set OGEVIA_DEPLOY_APPROVAL to the owner's approval reference"
  local ans=""; read -r -p "Type $1 to continue (anything else stops): " ans || true   # EOF without a newline still leaves what was typed
  [[ "$ans" == "$1" ]] || refuse "not confirmed"
}

# ---------------------------------------------------------------- commands ----
case "$CMD" in
preflight)
  guard_repo; guard_aws
  note "PREFLIGHT OK (read-only). baseline ${EXPECTED_COMMIT:0:7}, checkout ${HEAD_SHA:0:7}; TEST web $WEB; TEST API id $TEST_API; separated from PROD."
  note "live TEST config.json VITE_APP_ENV: $LIVE_ENV (absent is expected; the build will carry the test label)"
  note "live config.json sha256: $LIVE_CFG_SHA (must be unchanged after publish)"
  ;;
build)
  guard_repo
  export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}"
  note "installing dependencies from the frozen lockfile ..."
  (cd "$REPO" && npx -y pnpm@9.15.4 install --frozen-lockfile >"$RUN/install.log" 2>&1) || fail "dependency install failed (see $RUN/install.log)"
  rm -rf "$RUN/web-build"
  (cd "$REPO/apps/web" && VITE_APP_ENV=test VITE_AUTH_PROVIDER=cognito VITE_APP_VERSION="$EXPECTED_COMMIT" npx vite build --outDir "$RUN/web-build" --emptyOutDir >"$RUN/build.log" 2>&1) || fail "web build failed (see $RUN/build.log)"
  rm -f "$RUN/web-build/config.json"
  assert_label "$RUN/web-build"
  # The commit is baked into the bundle so anyone can read what is live: curl the site, open the index-*.js it names, search for VITE_APP_VERSION.
  grep -rqF "VITE_APP_VERSION:\"$EXPECTED_COMMIT\"" "$RUN/web-build/assets" --include="*.js" || fail "the build does not carry VITE_APP_VERSION:\"${EXPECTED_COMMIT:0:7}...\"; refusing to publish an unlabelled build"
  (cd "$RUN/web-build" && find . -type f | sort | xargs sha256sum) > "$RUN/web-build.manifest.sha256"
  entry=$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' "$RUN/web-build/index.html" | head -1 | sed 's#assets/##')
  printf 'commit=%s\nhead=%s\nnode=%s\nlabel=test\nversion_in_bundle=yes\nentry_js=%s\nindex_sha256=%s\n' "$EXPECTED_COMMIT" "$HEAD_SHA" "$(node --version 2>/dev/null)" "$entry" "$(sha256sum "$RUN/web-build/index.html" | cut -d' ' -f1)" > "$RUN/BUILD_OK"
  note "BUILD OK. label test confirmed. entry script $entry (measured fingerprint: $EXPECTED_ENTRY_JS)"
  [[ -z "$EXPECTED_ENTRY_JS" || "$entry" == "$EXPECTED_ENTRY_JS" ]] || note "NOTE: the entry script name differs from the measured fingerprint (a different Node version can do this); not a stop, report it."
  ;;
capture)
  guard_repo; guard_aws
  rm -rf "$RUN/rollback"; mkdir -p "$RUN/rollback/web"
  aws_try sync-down aws s3 sync "s3://$BUCKET" "$RUN/rollback/web" --only-show-errors
  aws_try head aws s3api head-object --bucket "$BUCKET" --key index.html --query '{LastModified:LastModified,VersionId:VersionId}' --output json
  cp "$TMP/head.out" "$RUN/rollback/index-head.json"
  aws_try vers aws s3api get-bucket-versioning --bucket "$BUCKET" --query Status --output text
  cp "$TMP/live-config.json" "$RUN/rollback/config.json"
  [[ -f "$RUN/rollback/web/index.html" ]] || fail "the captured copy has no index.html"
  sha256sum "$RUN/rollback/web/index.html" | cut -d' ' -f1 > "$RUN/rollback/index.sha256"
  printf 'bucket=%s\nconfig_sha256=%s\nversioning=%s\n' "$BUCKET" "$LIVE_CFG_SHA" "$(tr -d '\r\n' < "$TMP/vers.out")" > "$RUN/CAPTURE_OK"
  note "CAPTURE OK. $(find "$RUN/rollback/web" -type f | wc -l) files saved to $RUN/rollback (bucket versioning: $(tr -d '\r\n' < "$TMP/vers.out"))"
  ;;
publish)
  guard_repo; guard_aws
  [[ -f "$RUN/BUILD_OK" ]] && grep -q "^commit=$EXPECTED_COMMIT$" "$RUN/BUILD_OK" && grep -q "^head=$HEAD_SHA$" "$RUN/BUILD_OK" || refuse "run 'build' first from this same checkout (no build record for this commit)"
  [[ -f "$RUN/CAPTURE_OK" ]] && grep -q "^bucket=$BUCKET$" "$RUN/CAPTURE_OK" || refuse "run 'capture' first (no rollback copy for this bucket)"
  [[ "$(sha256sum "$RUN/web-build/index.html" | cut -d' ' -f1)" == "$(sed -n 's/^index_sha256=//p' "$RUN/BUILD_OK")" ]] || refuse "the build folder changed since 'build'; rebuild"
  assert_label "$RUN/web-build"
  window_open
  note "ABOUT TO WRITE to TEST only: bucket for $WEB ; approval reference ${OGEVIA_DEPLOY_APPROVAL:-(unset)} ; window ends $OGEVIA_WINDOW_END"
  approval "PUBLISH TEST"
  W="$RUN/web-build"
  aws_try up-assets aws s3 sync "$W/assets" "s3://$BUCKET/assets" --only-show-errors --cache-control "public,max-age=31536000,immutable"
  aws_try up-root aws s3 sync "$W" "s3://$BUCKET" --only-show-errors --exclude "assets/*" --exclude "index.html" --exclude "config.json"
  aws_try up-index aws s3 cp "$W/index.html" "s3://$BUCKET/index.html" --only-show-errors --content-type "text/html; charset=utf-8" --cache-control "no-cache"
  aws_try inval aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" --query Invalidation.Id --output text
  INV=$(tr -d '\r\n' < "$TMP/inval.out")
  note "waiting for the CloudFront invalidation $INV ..."
  aws_try wait aws cloudfront wait invalidation-completed --distribution-id "$DIST" --id "$INV"
  printf 'published=%s\napproval=%s\n' "$(date -u +%FT%TZ)" "$OGEVIA_DEPLOY_APPROVAL" > "$RUN/PUBLISHED"
  note "PUBLISH DONE (TEST). Now run: verify, then open $WEB in a browser and complete the acceptance list (SMK-07 banner first)."
  ;;
verify)
  guard_repo; guard_aws
  [[ -f "$RUN/BUILD_OK" ]] || refuse "no build record"
  bad=0
  chk() { if [[ "$2" == ok ]]; then note "  OK    $1"; else note "  FAIL  $1"; bad=$((bad+1)); fi; }
  c=$(curl -sS -m 30 -o "$TMP/served-index.html" -w '%{http_code}' "$WEB/" 2>/dev/null) || c=000
  [[ "$c" == 200 ]] && chk "TEST front page returns 200" ok || chk "TEST front page returned $c" no
  [[ "$(sha256sum "$TMP/served-index.html" 2>/dev/null | cut -d' ' -f1)" == "$(sed -n 's/^index_sha256=//p' "$RUN/BUILD_OK")" ]] && chk "live index.html is byte-identical to the build for ${EXPECTED_COMMIT:0:7}" ok || chk "live index.html differs from the build (stale cache or not published)" no
  n=0; lbl=0
  for f in $(grep -oE 'assets/[A-Za-z0-9._-]+\.js' "$TMP/served-index.html" | sort -u); do
    curl -sS -m 40 -o "$TMP/js-$n.js" "$WEB/$f" 2>/dev/null && n=$((n+1)) && grep -qE 'VITE_APP_ENV:[[:space:]]*"test"' "$TMP/js-$((n-1)).js" && lbl=$((lbl+1)); done
  (( n > 0 && lbl > 0 )) && chk "served scripts carry VITE_APP_ENV test ($lbl of $n entry scripts)" ok || chk "served scripts do not carry the test label" no
  if grep -rqE 'VITE_APP_ENV:[[:space:]]*"production"' "$TMP"/js-*.js 2>/dev/null; then chk "no served script carries the production label" no; else chk "no served script carries the production label" ok; fi
  [[ "$LIVE_CFG_SHA" == "$(sed -n 's/^config_sha256=//p' "$RUN/CAPTURE_OK" 2>/dev/null)" ]] && chk "config.json is unchanged since capture" ok || chk "config.json differs from the captured copy (it must never be changed by this release)" no
  m=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "$API/v1/me" 2>/dev/null) || m=000
  [[ "$m" == 401 || "$m" == 403 ]] && chk "TEST API rejects an unauthenticated request ($m)" ok || chk "TEST API returned $m to an unauthenticated request" no
  note "verify: $bad failed check(s). A browser check is still required: sign in and confirm the banner 'TEST — synthetic data only' on every page (SMK-07)."
  (( bad == 0 )) || exit 3
  ;;
rollback)
  guard_repo; guard_aws
  [[ -f "$RUN/CAPTURE_OK" ]] && grep -q "^bucket=$BUCKET$" "$RUN/CAPTURE_OK" && [[ -f "$RUN/rollback/web/index.html" ]] || refuse "no rollback copy for this bucket"
  note "ABOUT TO RESTORE the previously captured TEST web files (TEST only). approval reference ${OGEVIA_DEPLOY_APPROVAL:-(unset)}"
  approval "ROLLBACK TEST"
  RB="$RUN/rollback/web"
  for f in $(cd "$RB" && find . -maxdepth 1 -type f ! -name index.html ! -name config.json | sed 's#^\./##'); do
    aws_try "rb-$f" aws s3 cp "$RB/$f" "s3://$BUCKET/$f" --only-show-errors; done
  aws_try rb-index aws s3 cp "$RB/index.html" "s3://$BUCKET/index.html" --only-show-errors --content-type "text/html; charset=utf-8" --cache-control "no-cache"
  aws_try inval aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" --query Invalidation.Id --output text
  INV=$(tr -d '\r\n' < "$TMP/inval.out"); aws_try wait aws cloudfront wait invalidation-completed --distribution-id "$DIST" --id "$INV"
  c=$(curl -sS -m 30 -o "$TMP/rb-index.html" -w '%{http_code}' "$WEB/" 2>/dev/null) || c=000
  [[ "$c" == 200 && "$(sha256sum "$TMP/rb-index.html" | cut -d' ' -f1)" == "$(cat "$RUN/rollback/index.sha256")" ]] || fail "rollback uploaded, but the live index.html does not match the captured one yet (HTTP $c); wait and run verify-style checks"
  note "ROLLBACK DONE (TEST). The live index.html is the captured one. Assets from the new build remain in the bucket (harmless; never deleted)."
  ;;
esac
exit 0
