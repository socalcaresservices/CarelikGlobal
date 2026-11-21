#!/usr/bin/env bash
# PRODUCTION web-only publish of the web follow-ups (staff ID removed from the caregiver header; Reports and the shared Chart follow the chosen palette).
# Owner authorization: "all now" (2026-11-21), after the owner reported the issues on production. Web files only: NO database, API, IAM, security-group or account change.
# Same method as stage 6 of the 2026-11-11 and 2026-11-21 production releases: the existing deploy-production.sh `web` mode (dedicated production sign-in pool asserted before upload,
# uploads without delete, CloudFront invalidation), preceded by a capture of the live web files and a rollback script.
#   OGEVIA_DEPLOY_APPROVAL=owner-production-web-go bash production-web-release.sh
set -euo pipefail
set +x +H
umask 077
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER='' AWS_CLI_AUTO_PROMPT=off
A() { aws --cli-connect-timeout 5 --cli-read-timeout 60 "$@"; }
stop() { echo "STOP: $*"; exit 1; }
stage() { STEP="$1"; printf '\033[32m%s\033[0m\n' "$STEP"; }
[[ "${OGEVIA_DEPLOY_APPROVAL:-}" == owner-production-web-go ]] || stop 'production owner authorization is required'
[[ "$(uname -s)" == Linux ]] || stop 'run in AWS CloudShell'
[[ "$(A sts get-caller-identity --query Account --output text)" == 300094796789 ]] || stop 'wrong account'
exec 9>/tmp/ogevia-production-release.lock
flock -n 9 || stop 'another production release is running'
WORK=$(mktemp -d /tmp/ogevia-production-web.XXXXXX)
exec > >(tee "$WORK/release.log") 2>&1
SOURCE=26f58384875d55b650b28554bdd5233ba3d3d3cc
ASSETS=cdk-hnb659fds-assets-300094796789-us-west-2
PREFIX="s3://$ASSETS/ogevia-production-release/$(basename "$WORK")"
STEP=preparation; WEB_STARTED=0
trap 'rc=$?; echo "Release state: website-started=$WEB_STARTED"; echo "Private recovery: $PREFIX/web-before.tgz"; [[ "$rc" == 0 ]] || echo "STOPPED at $STEP. Keep this session open. Log: $WORK/release.log"; exit "$rc"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
confirm() { local got; echo; echo "$2"; if [[ "${OGEVIA_NO_CONFIRM:-}" == 1 ]]; then return 0; fi
  printf 'Type exactly  %s  to continue: ' "$1" > /dev/tty; read -r got < /dev/tty; [[ "$got" == "$1" ]] || stop "confirmation not given"; }
confirm GO-PRODUCTION-WEB "PRODUCTION WEB PUBLISH (owner GO): build the website from commit $SOURCE for production and upload it to the production site bucket, then invalidate CloudFront. Web files only: no database, API or security change. The current web files are saved first for rollback."
stage '[1/4] Restore tools and the application checkout'
export COREPACK_HOME="$WORK/corepack" XDG_CACHE_HOME="$WORK/cache" npm_config_cache="$WORK/npm-cache" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
for bin in /tmp/ogevia-*/node-v22.*-linux-*/bin; do [[ ! -x "$bin/node" ]] || { export PATH="$bin:$PATH"; break; }; done
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" != 22 ]]; then
  case "$(uname -m)" in x86_64) arch=x64;; aarch64) arch=arm64;; *) stop 'unsupported CPU';; esac
  archive="node-v22.23.5-linux-$arch.tar.xz"
  curl -fsS --retry 3 --connect-timeout 10 --max-time 180 "https://nodejs.org/dist/v22.23.5/$archive" -o "$WORK/$archive"
  curl -fsS --connect-timeout 10 --max-time 60 https://nodejs.org/dist/v22.23.5/SHASUMS256.txt -o "$WORK/node-sums"
  awk -v f="$archive" '$2==f' "$WORK/node-sums" > "$WORK/node-check"
  test -s "$WORK/node-check"
  (cd "$WORK" && sha256sum --check node-check)
  tar -xJf "$WORK/$archive" -C "$WORK"
  export PATH="$WORK/${archive%.tar.xz}/bin:$PATH"
fi
mkdir -p "$WORK/bin"
corepack enable --install-directory "$WORK/bin"
export PATH="$WORK/bin:$PATH"
REPO=''
while IFS= read -r g; do
  r="${g%/.git}"
  if [[ "$(git -C "$r" rev-parse HEAD 2>/dev/null)" == "$SOURCE" && -z "$(git -C "$r" status --porcelain --untracked-files=no)" && -x "$r/apps/web/node_modules/.bin/vite" ]]; then REPO="$r"; break; fi
done < <(find /tmp -maxdepth 5 -type d -name .git -print 2>/dev/null)
if [[ -z "$REPO" ]]; then
  REPO="$WORK/repo"; git init -q "$REPO"
  git -C "$REPO" remote add origin https://github.com/socalcaresservices/CarelikGlobal.git
  git -C "$REPO" config remote.origin.promisor true
  git -C "$REPO" config remote.origin.partialclonefilter blob:none
  git -C "$REPO" fetch --filter=blob:none --depth=1 origin "$SOURCE"
  git -C "$REPO" checkout --detach -q FETCH_HEAD
  [[ "$(git -C "$REPO" rev-parse HEAD)" == "$SOURCE" ]] || stop 'the fetched checkout is not the release commit'
fi
[[ -x "$REPO/apps/web/node_modules/.bin/vite" ]] || corepack pnpm@9.15.4 --dir "$REPO" install --frozen-lockfile --store-dir "$WORK/store" --prefer-offline
stage '[2/4] Capture the live production web files (rollback) and check the targets'
for s in Ogevia-prd-WebHosting Ogevia-prd-Auth Ogevia-prd-ServiceVerificationApi; do
  A cloudformation describe-stacks --stack-name "$s" --query 'Stacks[0].{Status:StackStatus,Outputs:Outputs}' --output json > "$WORK/$s.stack.json"
  jq -e '.Status=="UPDATE_COMPLETE" or .Status=="CREATE_COMPLETE" or .Status=="UPDATE_ROLLBACK_COMPLETE"' "$WORK/$s.stack.json" >/dev/null || stop "stack not settled: $s"
done
out_w() { jq -er --arg key "$2" '.Outputs[] | select(.OutputKey==$key) | .OutputValue' "$WORK/$1.stack.json"; }
BUCKET=$(out_w Ogevia-prd-WebHosting SiteBucketName); DIST=$(out_w Ogevia-prd-WebHosting DistributionId)
WEB=$(out_w Ogevia-prd-WebHosting WebOrigin); API=$(out_w Ogevia-prd-ServiceVerificationApi ApiUrl)
TEST_BUCKET=$(A cloudformation describe-stacks --stack-name Ogevia-prod-WebHosting --query 'Stacks[0].Outputs[?OutputKey==`SiteBucketName`].OutputValue' --output text)
[[ "$BUCKET" != "$TEST_BUCKET" && "$BUCKET" == ogevia-prd-* && "$WEB" == https://*.cloudfront.net && "$API" == https://*.execute-api.us-west-2.amazonaws.com* ]] || stop 'web/API targets differ'
[[ "$(A cloudformation describe-stacks --stack-name Ogevia-prd-Auth --query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text)" == us-west-2_FHJoX71ca ]] || stop 'dedicated production Auth pool differs'
A s3 sync "s3://$BUCKET" "$WORK/web-before" --only-show-errors
test -s "$WORK/web-before/index.html"
A s3api get-public-access-block --bucket "$ASSETS" --query PublicAccessBlockConfiguration --output json | jq -e '.BlockPublicAcls and .IgnorePublicAcls and .BlockPublicPolicy and .RestrictPublicBuckets' >/dev/null || stop 'backup bucket must be private'
A s3api get-bucket-encryption --bucket "$ASSETS" --query 'ServerSideEncryptionConfiguration.Rules' --output json | jq -e 'length>0 and all(.[]; .ApplyServerSideEncryptionByDefault.SSEAlgorithm=="AES256" or .ApplyServerSideEncryptionByDefault.SSEAlgorithm=="aws:kms")' >/dev/null || stop 'backup bucket must be encrypted'
printf '%s\n%s\n' "$BUCKET" "$DIST" > "$WORK/rollback-targets.txt"
cat > "$WORK/rollback-web.sh" <<'ROLLBACK_WEB'
#!/usr/bin/env bash
# Restores the captured production web files only (nothing is deleted).
set -euo pipefail
set +x
export AWS_REGION=us-west-2 AWS_PAGER=''
cd "$(dirname "$0")"
[[ "$(aws sts get-caller-identity --query Account --output text)" == 300094796789 ]]
mapfile -t targets < rollback-targets.txt
aws s3 sync web-before "s3://${targets[0]}" --exclude index.html --only-show-errors
aws s3 cp web-before/index.html "s3://${targets[0]}/index.html" --cache-control no-cache --only-show-errors
aws cloudfront create-invalidation --distribution-id "${targets[1]}" --paths / /index.html >/dev/null
echo 'Web rollback completed.'
ROLLBACK_WEB
(cd "$WORK" && tar -czf web-before.tgz -- web-before rollback-targets.txt rollback-web.sh)
A s3 cp "$WORK/web-before.tgz" "$PREFIX/web-before.tgz" --only-show-errors
A s3api head-object --bucket "$ASSETS" --key "ogevia-production-release/$(basename "$WORK")/web-before.tgz" --query ContentLength --output text | grep -Eq '^[1-9][0-9]*$'
echo "PRIVATE WEB BACKUP SAVED: $PREFIX/web-before.tgz   (rollback: bash $WORK/rollback-web.sh)"
stage '[3/4] Publish the production web'
WEB_STARTED=1
VITE_APP_VERSION="$SOURCE" OGEVIA_DEPLOY_APPROVAL=owner-production-web-go bash "$REPO/infra/aws/scripts/deploy-production.sh" web
stage '[4/4] Verify what production serves'
[[ "$(curl -sS --connect-timeout 10 --max-time 30 -o /dev/null -w '%{http_code}' "${API%/}/v1/me")" == 401 ]] || stop 'API anonymous check failed'
for n in $(seq 1 30); do
  curl -fsS --connect-timeout 10 --max-time 30 -D "$WORK/web.headers" "$WEB/?release=$SOURCE" -o "$WORK/web.live.html"
  if cmp -s "$WORK/web.live.html" "$REPO/apps/web/dist-aws-prd/index.html"; then break; fi
  sleep 5
done
cmp -s "$WORK/web.live.html" "$REPO/apps/web/dist-aws-prd/index.html" || stop 'the new website has not reached CloudFront yet; do not republish: wait a minute and run only the check'
grep -qi '^content-security-policy:' "$WORK/web.headers" || stop 'web CSP missing'
echo "PRODUCTION WEB PUBLISHED: $WEB serves commit $SOURCE"
echo "Check in the app: the caregiver page shows the name only; Reports and Home charts follow the palette chosen in Settings > Appearance (a browser keeps its own choice)."
echo "Rollback if needed: bash $WORK/rollback-web.sh"
exit 0
