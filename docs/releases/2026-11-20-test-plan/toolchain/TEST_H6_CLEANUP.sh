#!/usr/bin/env bash
# PHASE H6: TEST ONLY. Turns the request-cleanup switch ON for TEST (adds exactly three API routes: Retire document type, Cancel document request, Mark read). Stack Ogevia-prod-*, database ogevia_sv_test.
# Starting point = the CURRENT TEST state after the Offices release: 265 routes (offices ON, request cleanup OFF), ledger 109/0110 (0109 already applied). No database change, no web change.
#   1 guards, tools; 2 read-only capture of the live TEST API; the three routes must be absent (404) and the office routes present
#   3 TWO assemblies are gated BEFORE anything changes: "off" (the live state: only the Handler asset may differ) and "on" (exactly the three routes added)
#   4 typed confirmation, cdk deploy of the ONE API stack, post checks (268 routes, the three routes require a sign-in, nothing else changed, 0109 and 0110 still verified)
#   REPO=<checkout at the release commit> OGEVIA_RELEASE_COMMIT=<full sha> WORK=<work dir> OGEVIA_DEPLOY_APPROVAL=<owner TEST authorization reference> bash TEST_H6_CLEANUP.sh [enable|rollback-switch]
#   rollback-switch redeploys the saved switch-OFF assembly (removes the three routes; the database objects stay, they are inert). OGEVIA_NO_CONFIRM=1 is for the automated test only.
set -euo pipefail
set +x +H
umask 077
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER="" CDK_DISABLE_CLI_TELEMETRY=true PYTHONDONTWRITEBYTECODE=1
stop() { echo "STOP: $*" >&2; exit 2; }
MODE="${1:-enable}"
case "$MODE" in enable|rollback-switch) ;; *) stop "usage: enable | rollback-switch";; esac
: "${REPO:?set REPO to the checkout at the release commit}"
: "${OGEVIA_RELEASE_COMMIT:?set OGEVIA_RELEASE_COMMIT to the full release commit}"
: "${WORK:?set WORK to a private work directory with free space}"
: "${OGEVIA_DEPLOY_APPROVAL:?set OGEVIA_DEPLOY_APPROVAL to the owner TEST authorization reference}"
[[ "$OGEVIA_DEPLOY_APPROVAL" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || stop "OGEVIA_DEPLOY_APPROVAL must be 6 to 64 characters of A-Za-z0-9._-"
export OGEVIA_DEPLOY_APPROVAL
COMMIT="$OGEVIA_RELEASE_COMMIT"
[[ "$(git -C "$REPO" rev-parse HEAD)" == "$COMMIT" ]] || stop "the checkout is not at the release commit"
[[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop "tracked files in the checkout are modified"
A() { timeout --foreground -k 5 "${OGEVIA_AWS_TIMEOUT:-300}" aws --cli-connect-timeout 5 --cli-read-timeout 120 "$@"; }
[[ "$(A sts get-caller-identity --query Account --output text)" == 300094796789 ]] || stop "wrong AWS account (expected 300094796789 in us-west-2)"
export XDG_CACHE_HOME="$WORK/cache" XDG_DATA_HOME="$WORK/data" XDG_STATE_HOME="$WORK/state" COREPACK_HOME="$WORK/corepack"
mkdir -p "$WORK/bin" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"
for d in "$WORK"/node-v22.*-linux-*/bin; do [[ -d "$d" ]] && export PATH="$d:$PATH"; done
[[ -d "$WORK/bin" ]] && export PATH="$WORK/bin:$PATH"
TC="$REPO/docs/releases/2026-11-20-test-plan/toolchain"
STACK=Ogevia-prod-ServiceVerificationApi
confirm() { local got; echo; echo "$2"; if [[ "${OGEVIA_NO_CONFIRM:-}" == 1 ]]; then return 0; fi
  printf 'Type exactly  %s  to continue: ' "$1" > /dev/tty; read -r got < /dev/tty; [[ "$got" == "$1" ]] || stop "confirmation not given"; }
out() { A cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
handler_fn() { A cloudformation list-stack-resources --stack-name "$STACK" --output json | jq -er '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId|startswith("Handler")))] | if length==1 then .[0].PhysicalResourceId else error("expected exactly one API Handler") end'; }
route_count() { python3 -c 'import json,sys; t=json.load(open(sys.argv[1])); t=t.get("TemplateBody",t); print(sum(1 for r in t["Resources"].values() if r.get("Type")=="AWS::ApiGatewayV2::Route"))' "$1"; }
ID0=00000000-0000-4000-8000-000000000000
R1=/v1/care-notifications/read; R2=/v1/documents/$ID0/cancel; R3=/v1/document-types/$ID0/retire
code_get() { curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$API_URL$1"; }
code_post() { curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST -H 'content-type: application/json' -d '{}' "$API_URL$1"; }
CONFIG="$REPO/infra/aws/lib/config.ts"
F_OLD='features: { staffManagement: true, signInOverride: true, bulkImport: true, staffDuplicates: false },'
# edit_config <offices true|false> <requestCleanup true|false>: the isolated-TEST features line only (exactly one match), synthesis only; the file is restored right after.
edit_config() { python3 - "$CONFIG" "$1" "$2" "$F_OLD" <<'PY'
import sys
p, off, rc, old = sys.argv[1:]
s = open(p).read()
assert s.count(old) == 1, "the TEST features line was not found exactly once"
add = (", requestCleanup: true" if rc == "true" else "") + (", offices: true" if off == "true" else "")
open(p, "w").write(s.replace(old, old[:-3] + add + " },"))
PY
}
restore_config() { git -C "$REPO" checkout -- infra/aws/lib/config.ts 2>/dev/null || true; }
# synth <outdir> <offices> <rc>
synth() {
  local o="$1" off="$2" rc="$3" r=0
  rm -rf "$o"; trap restore_config EXIT
  edit_config "$off" "$rc"
  (cd "$REPO" && pnpm --dir infra/aws exec cdk synth '*' --quiet --lookups=false -c env=prod -c mode=deploy -c liveTestBaseline=0102 \
    -c "liveQrParameterSpec=$QR_SPEC" -c "liveTestHandlerTags=$TAGS" -c testDatabase=isolated -c "testMasterSecretArn=$MASTER_ARN" --output "$o") || r=$?
  restore_config; trap - EXIT
  [[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop "the checkout was not restored to the release commit"
  [[ "$r" == 0 && -f "$o/$STACK.template.json" ]] || stop "synthesis failed. Nothing was changed."
}


ensure_tools() {   # Node 22, pnpm 9.15.4 and the installed dependencies, all under $WORK
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

CAP="${H6_DIR:-$( { ls -d "$WORK"/h6-2* 2>/dev/null | sort | tail -1; } || true)}"
if [[ "$MODE" == rollback-switch ]]; then
  [[ -n "$CAP" && -d "$CAP" && "$(cat "$CAP/release-commit.txt" 2>/dev/null)" == "$COMMIT" ]] || stop "no H6 capture for this commit in $WORK"
  (cd "$CAP" && sha256sum --check --quiet SHA256SUMS) || stop "the H6 capture was modified or is incomplete"
  confirm "ROLLBACK-TEST-SWITCH" "Redeploys the saved switch-OFF assembly to TEST: removes the three request-cleanup routes (the office routes stay). The database objects stay; they are inert."
  (cd "$REPO" && pnpm --dir infra/aws exec cdk deploy --app "$CAP/deploy-off" --exclusively "$STACK" --require-approval broadening --no-notices) || stop "cdk deploy failed"
  A cloudformation get-template --stack-name "$STACK" --template-stage Original --query TemplateBody --output json > "$CAP/rollback-live.json"
  python3 "$TC/diff_gate_0110.py" --live "$CAP/rollback-live.json" --new "$CAP/deploy-off/$STACK.template.json" --expect post || stop "the rolled-back stack differs from the saved switch-OFF assembly"
  API_URL="$(out "$STACK" ApiUrl)"
  for r in "$R1" "$R2" "$R3"; do c="$(code_post "$r")"; echo "POST $r: $c"; [[ "$c" == 404 ]] || stop "expected 404 after the rollback"; done
  echo "ROLLBACK-SWITCH OK: the three routes are gone (404); the stack equals the saved switch-OFF assembly"; exit 0
fi
ensure_tools
for f in TEST_0110_LEDGER.sh VERIFY_0110.sql diff_gate_0110.py TEST_DB_SESSION.sh; do [[ -f "$TC/$f" ]] || stop "the toolchain is missing $f"; done
B="${H6_DIR:-$WORK/h6-$(date -u +%Y%m%dT%H%M%SZ)}"
[[ "$B" == /* && ! -L "$B" ]] || stop "the capture directory must be an absolute path"
mkdir -p "$B"; [[ -z "$(find "$B" -mindepth 1 -maxdepth 1 -print -quit)" ]] || stop "use a new empty capture directory"
chmod 700 "$B"; echo "CAPTURE: $B"; echo "$COMMIT" > "$B/release-commit.txt"

echo "=== 1. read-only capture of the live TEST state ==="
MASTER_ARN="$(A rds describe-db-instances --db-instance-identifier ogevia-postgres --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)"
[[ "$MASTER_ARN" == arn:aws:secretsmanager:us-west-2:300094796789:secret:rds!db-* ]] || stop "the managed master-secret ARN was not found"
A cloudformation get-template --stack-name "$STACK" --template-stage Original --query TemplateBody --output json > "$B/live-api.template.json"
FN="$(handler_fn)"
A lambda get-function-configuration --function-name "$FN" --query '{FunctionName:FunctionName,CodeSha256:CodeSha256,Database:{host:Environment.Variables.DB_HOST,name:Environment.Variables.DB_NAME,secretArn:Environment.Variables.DB_SECRET_ARN}}' --output json > "$B/test-lambda.json"
jq -e '.Database.name=="ogevia_sv_test" and .Database.host=="ogevia-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com"' "$B/test-lambda.json" >/dev/null || stop "the live TEST Handler does not target the isolated TEST database"
python3 - "$B" <<'PY'
import json, pathlib, sys
b = pathlib.Path(sys.argv[1]); t = json.loads((b / 'live-api.template.json').read_text())
qr = t['Parameters']['ClientQrEncryptionKey']
assert qr.get('Type') == 'String' and qr.get('NoEcho') is True and qr.get('Default', '') == '', 'STOP: the QR parameter metadata is not safe to preserve'
(b / 'qr-parameter-spec.json').write_text(json.dumps(qr)); (b / 'handler-tags.json').write_text(json.dumps(t['Resources']['Handler886CB40B']['Properties'].get('Tags', [])))
PY
QR_SPEC="$(cat "$B/qr-parameter-spec.json")"; TAGS="$(cat "$B/handler-tags.json")"
ROUTES_BEFORE="$(route_count "$B/live-api.template.json")"
[[ "$ROUTES_BEFORE" == 265 ]] || stop "the live TEST API has $ROUTES_BEFORE routes; this release expects 265 (offices ON, request cleanup OFF). If it is 268 the switch is already on. Nothing was changed."
API_URL="$(out "$STACK" ApiUrl)"; [[ "$API_URL" == https://* ]] || stop "no API URL"
for r in "$R1" "$R2" "$R3"; do c="$(code_post "$r")"; echo "POST $r (before): $c"; [[ "$c" == 404 ]] || stop "expected 404: the request-cleanup routes must not exist yet"; done
c="$(code_get /v1/offices)"; echo "GET /v1/offices (before): $c"; [[ "$c" == 401 ]] || stop "expected 401: the office routes must exist (the Offices release)"
echo "--- database (read-only): ledger 109/0110, 0109 and 0110 recorded with their checksums, all object checks"
bash "$TC/TEST_DB_SESSION.sh" bash "$TC/TEST_0110_LEDGER.sh" verify || stop "the TEST database is not at 109/0110. Nothing was changed."

echo; echo "=== 2. two assemblies, checked before anything is changed ==="
synth "$B/deploy-off" true false
python3 "$TC/diff_gate_0110.py" --live "$B/live-api.template.json" --new "$B/deploy-off/$STACK.template.json" --expect off | tee "$B/gate-off.txt" || stop "the switch-OFF assembly differs from the live TEST API in more than the Handler code. Nothing was changed."
synth "$B/deploy-on" true true
python3 "$TC/diff_gate_0110.py" --live "$B/live-api.template.json" --new "$B/deploy-on/$STACK.template.json" --expect on --set cleanup | tee "$B/gate-on.txt" || stop "the switch-ON assembly is not exactly the three request-cleanup routes plus the Handler code. Nothing was changed."
CAND="$B/deploy-on/$STACK.template.json"
[[ "$(route_count "$CAND")" == 268 ]] || stop "the assembly has the wrong route count"
find "$B" -type f -not -name SHA256SUMS -exec sha256sum {} + > "$B/SHA256SUMS"

confirm "ENABLE-TEST-REQUEST-CLEANUP" "ABOUT TO CHANGE TEST ONLY (owner authorization $OGEVIA_DEPLOY_APPROVAL): add the three request-cleanup routes (Retire document type, Cancel document request, Mark read) to $STACK. No database or web change. Production is not touched."

echo; echo "=== 3. API deploy (request cleanup ON) ==="
(cd "$REPO" && pnpm --dir infra/aws exec cdk deploy --app "$B/deploy-on" --exclusively "$STACK" --require-approval broadening --no-notices) || stop "cdk deploy failed. Send the output; the rollback is: bash TEST_H6_CLEANUP.sh rollback-switch"
st="$(A cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text)"; echo "$STACK: $st"; [[ "$st" == UPDATE_COMPLETE ]] || stop "stack status is $st"
A lambda wait function-updated --function-name "$FN"
A lambda get-function-configuration --function-name "$FN" --query '{CodeSha256:CodeSha256,Database:{host:Environment.Variables.DB_HOST,name:Environment.Variables.DB_NAME,secretArn:Environment.Variables.DB_SECRET_ARN}}' --output json > "$B/lambda-after.json"
[[ "$(jq -S .Database "$B/lambda-after.json")" == "$(jq -S .Database "$B/test-lambda.json")" ]] && echo "PASS Handler still targets ogevia_sv_test, same host and secret" || stop "the Handler database settings changed"
A cloudformation get-template --stack-name "$STACK" --template-stage Original --query TemplateBody --output json > "$B/after-live.json"
python3 "$TC/diff_gate_0110.py" --live "$B/after-live.json" --new "$CAND" --expect post || stop "the deployed stack differs from the assembly"
[[ "$(route_count "$B/after-live.json")" == 268 ]] && echo "PASS 268 routes live" || stop "unexpected live route count"
c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$API_URL/v1/me")"; echo "GET /v1/me without a token: $c"; [[ "$c" == 401 ]] || stop "expected 401"
for r in "$R1" "$R2" "$R3"; do c="$(code_post "$r")"; echo "POST $r without a token (switch ON): $c"; [[ "$c" == 401 ]] || stop "expected 401: the route must exist and require a sign-in"; done
c="$(code_get /v1/offices)"; echo "GET /v1/offices without a token: $c"; [[ "$c" == 401 ]] || stop "the office routes changed"
bash "$TC/TEST_DB_SESSION.sh" bash "$TC/TEST_0110_LEDGER.sh" verify || stop "the database check after the deploy failed"
echo
echo "H6 COMPLETE (TEST): request cleanup is ON (268 routes). Retire document type, Cancel document request and Mark read now exist and require a sign-in. Offices unchanged. Production was not touched."
echo "Rollback reference kept in $B. Next: retire a synthetic duplicate document type in the TEST site."
