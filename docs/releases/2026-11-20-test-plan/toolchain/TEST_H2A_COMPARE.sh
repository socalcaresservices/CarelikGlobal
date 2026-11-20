#!/usr/bin/env bash
# PHASE H2a: READ-ONLY comparison for the TEST release. Captures the live TEST API template, the live Handler code (rollback ZIP) and the live web files,
# builds the candidate API template for this commit with the switch OFF (same CDK context as the live deployment), and runs diff_gate_0109.py --expect off.
# Deploys nothing. Writes nothing to TEST or production. Reads no secret value (the QR key stays in its NoEcho parameter), no table data, no client record.
#
#   REPO=<checkout at the release commit> OGEVIA_RELEASE_COMMIT=<full sha> WORK=<private work dir with space> bash TEST_H2A_COMPARE.sh
# On success it prints "COMPARISON PASSED: NOTHING DEPLOYED" and leaves the private capture in $WORK/h2a-<time> (keep it: it is the rollback reference).
set -euo pipefail
set +x +H
umask 077
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER="" CDK_DISABLE_CLI_TELEMETRY=true PYTHONDONTWRITEBYTECODE=1
stop() { echo "STOP: $*" >&2; exit 2; }
: "${REPO:?set REPO to the checkout at the release commit}"
: "${OGEVIA_RELEASE_COMMIT:?set OGEVIA_RELEASE_COMMIT to the full release commit}"
: "${WORK:?set WORK to a private directory with free space}"
[[ "$(git -C "$REPO" rev-parse HEAD)" == "$OGEVIA_RELEASE_COMMIT" ]] || stop "the checkout is not at the release commit"
[[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop "tracked files in the checkout are modified"
A() { timeout --foreground -k 5 "${OGEVIA_AWS_TIMEOUT:-120}" aws --cli-connect-timeout 5 --cli-read-timeout 60 "$@"; }
[[ "$(A sts get-caller-identity --query Account --output text)" == 300094796789 ]] || stop "wrong AWS account (expected 300094796789 in us-west-2)"
# Keep every cache and package store in $WORK (CloudShell's home directory is small).
export XDG_CACHE_HOME="$WORK/cache" XDG_DATA_HOME="$WORK/data" XDG_STATE_HOME="$WORK/state" COREPACK_HOME="$WORK/corepack"
mkdir -p "$WORK/bin" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"
TC="$REPO/docs/releases/2026-11-20-test-plan/toolchain"
[[ -f "$TC/diff_gate_0109.py" ]] || stop "the gate is missing from the checkout"

B="${OGEVIA_H2A_DIR:-$WORK/h2a-$(date -u +%Y%m%dT%H%M%SZ)}"
[[ "$B" == /* && ! -L "$B" ]] || stop "the capture directory must be an absolute path"
mkdir -p "$B"; [[ -z "$(find "$B" -mindepth 1 -maxdepth 1 -print -quit)" ]] || stop "use a new empty capture directory"
chmod 700 "$B"; echo "CAPTURE: $B"
echo "$OGEVIA_RELEASE_COMMIT" > "$B/release-commit.txt"

ensure_tools() {   # Node 22 and pnpm 9.15.4 (the repository's packageManager) and the installed dependencies, all under $WORK
  if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" != 22 ]]; then
    case "$(uname -m)" in x86_64) arch=x64;; aarch64) arch=arm64;; *) stop "unsupported CPU";; esac
    archive="node-v22.23.5-linux-$arch.tar.xz"
    curl -fsS --connect-timeout 10 --max-time 180 "https://nodejs.org/dist/v22.23.5/$archive" -o "$WORK/$archive"
    curl -fsS --connect-timeout 10 --max-time 60 https://nodejs.org/dist/v22.23.5/SHASUMS256.txt -o "$WORK/node-sums"
    awk -v f="$archive" '$2==f' "$WORK/node-sums" > "$WORK/node-check"; [[ -s "$WORK/node-check" ]] || stop "no checksum for $archive"
    (cd "$WORK" && sha256sum --check node-check) || stop "the Node download does not match its published checksum"
    tar -xJf "$WORK/$archive" -C "$WORK"; export PATH="$WORK/${archive%.tar.xz}/bin:$PATH"
  fi
  corepack enable --install-directory "$WORK/bin"; export PATH="$WORK/bin:$PATH"
  [[ "$(cd "$REPO" && pnpm --version)" == 9.15.4 ]] || stop "pnpm 9.15.4 is required"
  if [[ ! -x "$REPO/infra/aws/node_modules/.bin/cdk" ]]; then
    echo "--- installing dependencies under $WORK (a few minutes)"
    (cd "$REPO" && pnpm install --frozen-lockfile --store-dir "$WORK/store" --prefer-offline) || stop "pnpm install failed"
  fi
  [[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop "the install modified tracked files"
}
ensure_tools

STACK=Ogevia-prod-ServiceVerificationApi
out() { A cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
SITE_BUCKET="$(out Ogevia-prod-WebHosting SiteBucketName)"; DIST_ID="$(out Ogevia-prod-WebHosting DistributionId)"
[[ -n "$SITE_BUCKET" && "$SITE_BUCKET" != None && -n "$DIST_ID" && "$DIST_ID" != None ]] || stop "missing TEST web targets"
[[ "$SITE_BUCKET" != "$(out Ogevia-prd-WebHosting SiteBucketName)" && "$DIST_ID" != "$(out Ogevia-prd-WebHosting DistributionId)" ]] || stop "the TEST web targets are shared with production"
printf '%s\n%s\n' "$SITE_BUCKET" "$DIST_ID" > "$B/web-targets.txt"
MASTER_ARN="$(A rds describe-db-instances --db-instance-identifier ogevia-postgres --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)"
[[ "$MASTER_ARN" == arn:aws:secretsmanager:us-west-2:300094796789:secret:rds!db-* ]] || stop "the managed master-secret ARN was not found"   # an ARN only; the value is never read here
printf '%s\n' "$MASTER_ARN" > "$B/candidate-master-arn.txt"

echo "--- capturing the live TEST API (read-only)"
A cloudformation get-template --stack-name "$STACK" --template-stage Original --query TemplateBody --output json > "$B/live-api.template.json"
A cloudformation describe-stacks --stack-name "$STACK" --output json | jq '[.Stacks[0] | {StackName,StackStatus,ParameterNames:[.Parameters[].ParameterKey]}]' > "$B/live-api.stack.json"
FN="$(A cloudformation list-stack-resources --stack-name "$STACK" --output json | jq -er '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId|startswith("Handler")))] | if length==1 then .[0].PhysicalResourceId else error("expected exactly one API Handler") end')"
A lambda get-function-configuration --function-name "$FN" --query '{FunctionName:FunctionName,CodeSha256:CodeSha256,LastModified:LastModified,RevisionId:RevisionId,Runtime:Runtime,Database:{host:Environment.Variables.DB_HOST,name:Environment.Variables.DB_NAME,secretArn:Environment.Variables.DB_SECRET_ARN}}' --output json > "$B/test-lambda.json"
jq -e '.Database.name=="ogevia_sv_test" and .Database.host=="ogevia-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com"' "$B/test-lambda.json" >/dev/null || stop "the live TEST Handler does not target the isolated TEST database"
LOCATION="$(A lambda get-function --function-name "$FN" --query 'Code.Location' --output text)"
curl -fsS --connect-timeout 5 --max-time 120 "$LOCATION" -o "$B/test-lambda.zip"; unset LOCATION
python3 - "$B" <<'PY'
import base64, hashlib, json, pathlib, sys, zipfile
b = pathlib.Path(sys.argv[1])
expected = json.loads((b / 'test-lambda.json').read_text())['CodeSha256']
assert base64.b64encode(hashlib.sha256((b / 'test-lambda.zip').read_bytes()).digest()).decode() == expected, 'STOP: the rollback ZIP does not match the live Handler'
with zipfile.ZipFile(b / 'test-lambda.zip') as z:
    info = z.getinfo('index.js'); assert info.file_size <= 10_000_000, 'STOP: unexpected live Handler bundle size'
    (b / 'test-lambda-index.sha256').write_text(hashlib.sha256(z.read(info)).hexdigest() + '\n')
t = json.loads((b / 'live-api.template.json').read_text())
qr = t['Parameters']['ClientQrEncryptionKey']
assert qr.get('Type') == 'String' and qr.get('NoEcho') is True and qr.get('Default', '') == '', 'STOP: the QR parameter metadata is not safe to preserve'
assert set(qr) <= set('Type NoEcho Default Description AllowedPattern AllowedValues MinLength MaxLength ConstraintDescription'.split()), 'STOP: unexpected QR parameter fields'
(b / 'qr-parameter-spec.json').write_text(json.dumps(qr))
(b / 'handler-tags.json').write_text(json.dumps(t['Resources']['Handler886CB40B']['Properties'].get('Tags', [])))
print('Verified the rollback ZIP against the live Handler; the QR key stays in its existing NoEcho parameter.')
PY
A s3 sync "s3://$SITE_BUCKET" "$B/web-before" --only-show-errors
echo "web files captured: $(find "$B/web-before" -type f | wc -l)"

echo "--- candidate API template for this commit (switch OFF)"
cd "$REPO"
QR_SPEC="$(cat "$B/qr-parameter-spec.json")"; TAGS="$(cat "$B/handler-tags.json")"
pnpm --dir infra/aws exec cdk synth '*' --quiet --lookups=false -c env=prod -c mode=plan -c liveTestBaseline=0102 \
  -c "liveQrParameterSpec=$QR_SPEC" -c "liveTestHandlerTags=$TAGS" -c testDatabase=isolated -c "testMasterSecretArn=$MASTER_ARN" --output "$B/candidate-off"
CAND="$B/candidate-off/$STACK.template.json"
[[ -f "$CAND" ]] || stop "the synthesized candidate template was not produced"
python3 -c 'import json,sys; t=json.load(open(sys.argv[1])); t=t.get("TemplateBody",t); n=sum(1 for r in t["Resources"].values() if r.get("Type")=="AWS::ApiGatewayV2::Route"); print("candidate routes:", n); print("candidate Handler code asset:", t["Resources"]["Handler886CB40B"]["Properties"]["Code"].get("S3Key")); sys.exit(0 if n==259 else 1)' "$CAND" || stop "the candidate does not have 259 routes"

echo "--- the expected-only gate (switch OFF)"
set +e
python3 "$TC/diff_gate_0109.py" --live "$B/live-api.template.json" --new "$CAND" --expect off | tee "$B/gate-off.txt"
GATE=${PIPESTATUS[0]}
set -e
find "$B" -type f -not -name SHA256SUMS -exec sha256sum {} + > "$B/SHA256SUMS"
if [[ "$GATE" -ne 0 ]]; then echo "STOP: the gate found differences other than the Handler code asset (listed above). Nothing was deployed."; echo "CAPTURE KEPT: $B"; exit 1; fi
echo "COMPARISON PASSED: NOTHING DEPLOYED"
echo "Keep this private capture (rollback reference): $B"
