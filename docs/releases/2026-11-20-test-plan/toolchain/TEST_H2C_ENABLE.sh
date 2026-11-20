#!/usr/bin/env bash
# PHASE H2c: turn the request-cleanup switch ON for TEST (adds exactly three API routes). TEST ONLY (stack Ogevia-prod-ServiceVerificationApi, database ogevia_sv_test).
# Needs the H2b result: migration 0109 applied, API deployed with the switch OFF. It changes nothing else.
#   1 guards (commit, clean tree, account, approval reference, H2a capture, H2b evidence) and drift (live template equals what H2b left)
#   2 database check: ledger 108/0109 and the 20 object checks (read-only)
#   3 apply the pinned one-line patch TEST-requestCleanup-on.patch to infra/aws/lib/config.ts, synthesize (deploy mode), restore the file at once,
#     and run the expected-only gate --expect on (exactly three routes added, 259 -> 262, nothing else but an optional Handler asset change)
#   4 cdk deploy of the ONE API stack, then: --expect post, 262 routes, the three routes answer 401 without a token, /v1/me 401, Handler still on ogevia_sv_test
#   REPO=<checkout at the release commit> OGEVIA_RELEASE_COMMIT=<full sha> WORK=<work dir> OGEVIA_DEPLOY_APPROVAL=<the owner TEST authorization reference> bash TEST_H2C_ENABLE.sh [enable|rollback-switch]
#   rollback-switch redeploys the switch-OFF assembly H2b saved (removes the three routes; the database objects stay, they are inert).
set -euo pipefail
set +x +H
umask 077
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER="" CDK_DISABLE_CLI_TELEMETRY=true PYTHONDONTWRITEBYTECODE=1
stop() { echo "STOP: $*" >&2; exit 2; }
MODE="${1:-enable}"
case "$MODE" in enable|rollback-switch) ;; *) stop "usage: enable | rollback-switch";; esac
: "${REPO:?set REPO to the checkout at the release commit}"
: "${OGEVIA_RELEASE_COMMIT:?set OGEVIA_RELEASE_COMMIT to the full release commit}"
: "${WORK:?set WORK to the work directory}"
: "${OGEVIA_DEPLOY_APPROVAL:?set OGEVIA_DEPLOY_APPROVAL to the owner TEST authorization reference}"
[[ "$OGEVIA_DEPLOY_APPROVAL" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || stop "OGEVIA_DEPLOY_APPROVAL must be 6 to 64 characters of A-Za-z0-9._-"
export OGEVIA_DEPLOY_APPROVAL
COMMIT="$OGEVIA_RELEASE_COMMIT"
[[ "$(git -C "$REPO" rev-parse HEAD)" == "$COMMIT" ]] || stop "the checkout is not at the release commit"
[[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop "tracked files in the checkout are modified"
A() { timeout --foreground -k 5 "${OGEVIA_AWS_TIMEOUT:-300}" aws --cli-connect-timeout 5 --cli-read-timeout 120 "$@"; }
[[ "$(A sts get-caller-identity --query Account --output text)" == 300094796789 ]] || stop "wrong AWS account (expected 300094796789 in us-west-2)"
export XDG_CACHE_HOME="$WORK/cache" XDG_DATA_HOME="$WORK/data" XDG_STATE_HOME="$WORK/state" COREPACK_HOME="$WORK/corepack"
for d in "$WORK"/node-v22.*-linux-*/bin; do [[ -d "$d" ]] && export PATH="$d:$PATH"; done
[[ -d "$WORK/bin" ]] && export PATH="$WORK/bin:$PATH"
TC="$REPO/docs/releases/2026-11-20-test-plan/toolchain"
PATCH="$REPO/docs/releases/2026-11-20-test-plan/TEST-requestCleanup-on.patch"
PATCH_SHA=f39895c812c09325edf1182d67332c0b17ba24791dcfb850ae3db03d15c359c0
STACK=Ogevia-prod-ServiceVerificationApi
confirm() { local got; echo; echo "$2"; if [[ "${OGEVIA_NO_CONFIRM:-}" == 1 ]]; then return 0; fi
  printf 'Type exactly  %s  to continue: ' "$1" > /dev/tty; read -r got < /dev/tty; [[ "$got" == "$1" ]] || stop "confirmation not given"; }

H2A="${H2A:-$( { ls -d "$WORK"/h2a-2* 2>/dev/null | sort | tail -1; } || true)}"
[[ -n "$H2A" && -d "$H2A" ]] || stop "no H2a capture found in $WORK"
[[ "$(cat "$H2A/release-commit.txt" 2>/dev/null)" == "$COMMIT" ]] || stop "the capture was made for a different commit"
for f in after-live.json lambda-after.json deploy-off/$STACK.template.json candidate-master-arn.txt qr-parameter-spec.json handler-tags.json test-lambda.json; do [[ -s "$H2A/$f" ]] || stop "the H2b evidence is missing ($f): run H2b first"; done
FN="$(A cloudformation list-stack-resources --stack-name "$STACK" --output json | jq -er '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId|startswith("Handler")))] | if length==1 then .[0].PhysicalResourceId else error("expected exactly one API Handler") end')"
API_URL="$(A cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)"
[[ "$API_URL" == https://* ]] || stop "no API URL"
R1=/v1/care-notifications/read; R2=/v1/documents/00000000-0000-4000-8000-000000000000/cancel; R3=/v1/document-types/00000000-0000-4000-8000-000000000000/retire
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST -H 'content-type: application/json' -d '{}' "$API_URL$1"; }

# the live template must be exactly what H2b left (ON-state excepted for the rollback mode)
A cloudformation get-template --stack-name "$STACK" --template-stage Original --query TemplateBody --output json > "$H2A/h2c-live-before.json"

if [[ "$MODE" == rollback-switch ]]; then
  confirm "ROLLBACK-TEST-SWITCH" "Redeploys the switch-OFF assembly saved by H2b to TEST (removes the three request-cleanup routes). The database objects stay; they are inert."
  python3 -c 'import json,sys; t=json.load(open(sys.argv[1])); t=t.get("TemplateBody",t); n=sum(1 for r in t["Resources"].values() if r.get("Type")=="AWS::ApiGatewayV2::Route"); print("live routes before the rollback:", n); sys.exit(0 if n in (259, 262) else 1)' "$H2A/h2c-live-before.json" || stop "the live stack has an unexpected route count; send me this output"
  (cd "$REPO" && pnpm --dir infra/aws exec cdk deploy --app "$H2A/deploy-off" --exclusively "$STACK" --require-approval broadening --no-notices) || stop "cdk deploy failed"
  A cloudformation get-template --stack-name "$STACK" --template-stage Original --query TemplateBody --output json > "$H2A/h2c-rollback-live.json"
  python3 "$TC/diff_gate_0109.py" --live "$H2A/h2c-rollback-live.json" --new "$H2A/deploy-off/$STACK.template.json" --expect post || stop "the rolled-back stack differs from the saved OFF assembly"
  for r in "$R1" "$R2" "$R3"; do c="$(code "$r")"; echo "POST $r: $c"; [[ "$c" == 404 ]] || stop "expected 404 after the rollback"; done
  echo "ROLLBACK-SWITCH OK: the three routes are gone (404); the stack equals the switch-OFF assembly"; exit 0
fi

python3 "$TC/diff_gate_0109.py" --live "$H2A/h2c-live-before.json" --new "$H2A/after-live.json" --expect post >/dev/null || stop "the live TEST API changed since H2b finished; send me this output"
echo "no drift since H2b"
for r in "$R1" "$R2" "$R3"; do c="$(code "$r")"; echo "POST $r (before): $c"; [[ "$c" == 404 ]] || stop "expected 404 before the switch is turned on (is it already on?)"; done

echo; echo "=== database (read-only) ==="
bash "$TC/TEST_DB_SESSION.sh" bash "$TC/TEST_0109_LEDGER.sh" verify || stop "the 0109 post-state does not match; the switch stays off"

confirm "ENABLE-TEST-REQUEST-CLEANUP" "ABOUT TO CHANGE TEST ONLY (owner authorization $OGEVIA_DEPLOY_APPROVAL): add the three request-cleanup routes to $STACK. Production is not touched."

echo; echo "=== assembly with the switch ON (the pinned patch is applied for the synthesis only) ==="
[[ "$(sha256sum "$PATCH" | cut -d' ' -f1)" == "$PATCH_SHA" ]] || stop "the patch differs from the pinned bytes"
git -C "$REPO" apply --check "$PATCH" || stop "the patch does not apply to this checkout"
OUTDIR="$H2A/deploy-on"; rm -rf "$OUTDIR"
MASTER_ARN="$(cat "$H2A/candidate-master-arn.txt")"; QR_SPEC="$(cat "$H2A/qr-parameter-spec.json")"; TAGS="$(cat "$H2A/handler-tags.json")"
restore() { git -C "$REPO" apply -R "$PATCH" 2>/dev/null || true; }
trap restore EXIT
git -C "$REPO" apply "$PATCH"
rc=0; (cd "$REPO" && pnpm --dir infra/aws exec cdk synth '*' --quiet --lookups=false -c env=prod -c mode=deploy -c liveTestBaseline=0102 \
  -c "liveQrParameterSpec=$QR_SPEC" -c "liveTestHandlerTags=$TAGS" -c testDatabase=isolated -c "testMasterSecretArn=$MASTER_ARN" --output "$OUTDIR") || rc=$?
git -C "$REPO" apply -R "$PATCH"; trap - EXIT
[[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop "the checkout was not restored to the release commit"
[[ "$rc" == 0 ]] || stop "synthesis failed. Nothing was changed."
CAND="$OUTDIR/$STACK.template.json"; [[ -f "$CAND" ]] || stop "the assembly was not produced"
python3 "$TC/diff_gate_0109.py" --live "$H2A/h2c-live-before.json" --new "$CAND" --expect on || stop "the expected-only gate failed. Nothing was changed."

echo; echo "=== API deploy (switch ON) ==="
(cd "$REPO" && pnpm --dir infra/aws exec cdk deploy --app "$OUTDIR" --exclusively "$STACK" --require-approval broadening --no-notices) || stop "cdk deploy failed. Send the output; the rollback is: bash TEST_H2C_ENABLE.sh rollback-switch"
st="$(A cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text)"; echo "$STACK: $st"; [[ "$st" == UPDATE_COMPLETE ]] || stop "stack status is $st"
A lambda wait function-updated --function-name "$FN"
A lambda get-function-configuration --function-name "$FN" --query '{CodeSha256:CodeSha256,Database:{host:Environment.Variables.DB_HOST,name:Environment.Variables.DB_NAME,secretArn:Environment.Variables.DB_SECRET_ARN}}' --output json > "$H2A/h2c-lambda-after.json"
[[ "$(jq -S .Database "$H2A/h2c-lambda-after.json")" == "$(jq -S .Database "$H2A/test-lambda.json")" ]] && echo "PASS Handler still targets ogevia_sv_test, same host and secret" || stop "the Handler database settings changed"
A cloudformation get-template --stack-name "$STACK" --template-stage Original --query TemplateBody --output json > "$H2A/h2c-live-after.json"
python3 "$TC/diff_gate_0109.py" --live "$H2A/h2c-live-after.json" --new "$CAND" --expect post || stop "the deployed stack differs from the assembly"
python3 -c 'import json,sys; t=json.load(open(sys.argv[1])); t=t.get("TemplateBody",t); n=sum(1 for r in t["Resources"].values() if r.get("Type")=="AWS::ApiGatewayV2::Route"); print("live routes:", n); sys.exit(0 if n==262 else 1)' "$H2A/h2c-live-after.json" || stop "expected 262 routes"
c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$API_URL/v1/me")"; echo "GET /v1/me without a token: $c"; [[ "$c" == 401 ]] || stop "expected 401"
for r in "$R1" "$R2" "$R3"; do c="$(code "$r")"; echo "POST $r without a token (switch ON): $c"; [[ "$c" == 401 ]] || stop "expected 401: the route must exist and require a sign-in"; done
bash "$TC/TEST_DB_SESSION.sh" bash "$TC/TEST_0109_LEDGER.sh" verify || stop "the database check after the switch failed"
echo
echo "H2c COMPLETE (TEST): request cleanup is ON (262 routes). The three routes exist and require a sign-in. Migration 0109 verified. Production was not touched."
echo "Next: validate the three behaviors and the go-live items in a browser on the TEST site, one at a time."
