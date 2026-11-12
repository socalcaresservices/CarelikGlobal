#!/usr/bin/env bash
# MOCKED-AWS TEST of STELLA_PRD_DEPLOY.sh (no AWS, no CDK, no network): a stub `aws` and a stub `npx` answer from fixtures built from a synthesized PRODUCTION assembly and RECORD every call.
# Proves: the drift check against the recorded baseline (no drift passes; a changed template, Lambda code, route list or web file stops), the database marker requirement, the expected-only gate,
# and that `cdk deploy` is only reached after the typed confirmation.   bash mock_aws_test_deploy.sh /path/to/prd-cdk.out     (needs script(1), jq, python3, a clean checkout)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO="$(cd "$HERE/../../.." && pwd)"; ASM="${1:?path to the synthesized production assembly (cdk synth -c env=prd -c mode=deploy)}"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT; mkdir -p "$W/bin" "$W/home" "$W/mock/live" "$W/mock/site" "$W/mock/webfiles/assets" "$W/base/live"; export HOME="$W/home"; mkdir -p "$HOME"
APIT="Ogevia-prd-ServiceVerificationApi"
# ---- fixtures: the BASELINE = production before the release (assembly minus the 22 release routes, the previous Handler asset) ----
python3 - "$ASM" "$W" "$HERE" <<'PY'
import copy, json, os, sys
asm, w, here = sys.argv[1:4]
import re; exec(re.search(r"NEW_ROUTES = \{.*?\n\}\n", open(os.path.join(here, "diff_gate_prd0088.py")).read(), re.S).group(0), globals())
for f in os.listdir(asm):
    if f.endswith(".template.json") and f.startswith("Ogevia-prd-"):
        t = json.load(open(os.path.join(asm, f))); name = f[:-len(".template.json")]
        if name == "Ogevia-prd-ServiceVerificationApi":
            res = t["Resources"]
            for k in [k for k, v in res.items() if v["Type"] == "AWS::ApiGatewayV2::Route" and v["Properties"]["RouteKey"] in NEW_ROUTES]: del res[k]
            hk = next(k for k, v in res.items() if v["Type"] == "AWS::Lambda::Function" and k.startswith("Handler")); res[hk]["Properties"]["Code"]["S3Key"] = "debd1d43" + "0" * 56 + ".zip"
            ak = next(k for k, v in res.items() if v["Type"] == "AWS::ApiGatewayV2::Api"); cors = res[ak]["Properties"]["CorsConfiguration"]; cors["AllowOrigins"] = cors["AllowOrigins"][:2]   # production's live template: [app, CloudFront] only (dry run 2026-11-01)
            routes = sorted(v["Properties"]["RouteKey"] for v in res.values() if v["Type"] == "AWS::ApiGatewayV2::Route")
            json.dump(routes, open(os.path.join(w, "base", "routes-before.json"), "w")); json.dump(routes, open(os.path.join(w, "mock", "routes.json"), "w"))
        json.dump({"TemplateBody": t} if False else t, open(os.path.join(w, "base", "live", name + ".json"), "w")); json.dump(t, open(os.path.join(w, "mock", "live", name + ".json"), "w"))
json.dump({"Resources": {}}, open(os.path.join(w, "base", "live", "Ogevia-prod-NetworkEgress.json"), "w")); json.dump({"Resources": {}}, open(os.path.join(w, "mock", "live", "Ogevia-prod-NetworkEgress.json"), "w"))
cfg = {"FunctionName": "mock-handler", "CodeSha256": "E4Vv7ushYGqW7oVtyAW2T1QYjHwdFR+T+FaAQyJ9kW4=", "Environment": {"Variables": {"DB_NAME": "ogevia_prd", "OGEVIA_ENV": "prd"}}}
json.dump(cfg, open(os.path.join(w, "base", "lambda-config-before.json"), "w")); json.dump(cfg, open(os.path.join(w, "mock", "lambda-config.json"), "w"))
PY
printf 'index\n' > "$W/mock/site/index.html"; printf 'a\n' > "$W/mock/webfiles/index.html"; printf 'b\n' > "$W/mock/webfiles/assets/x.js"; cp "$W/mock/site/index.html" "$W/mock/webfiles/index.html"
( cd "$W/mock/webfiles" && find . -type f -print0 | sort -z | xargs -0 sha256sum > "$W/base/web-before.sha256" )
cat > "$W/bin/aws" <<'S'
#!/usr/bin/env bash
echo "aws $*" >> "$MOCK_LOG"; a="$*"; M="$MOCKDIR/mock"
case "$a" in
  *"sts get-caller-identity"*) echo 300094796789 ;;
  *"cloudformation describe-stacks"*"StackStatus"*) echo "${MOCK_STACK_STATUS:-UPDATE_COMPLETE}" ;;
  *"cloudformation get-template --stack-name "*) s=$(sed -E 's/.*--stack-name ([^ ]+).*/\1/' <<<"$a"); f="$M/live/$s.json"; [[ "${MOCK_DRIFT:-}" == "$s" ]] && { jq '.Description = "changed-by-someone"' "$f"; exit 0; }; cat "$f" ;;
  *"OutputKey=='ApiUrl'"*) echo https://zk527zk4ua.execute-api.us-west-2.amazonaws.com ;;
  *"OutputKey=='WebOrigin'"*) echo "file://$M/site" ;;
  *"OutputKey=='SiteBucketName'"*) echo mock-bucket ;;
  *"OutputKey=='DistributionId'"*) echo EMOCK ;;
  *"list-stack-resources"*) echo mock-handler ;;
  *"lambda get-function-configuration"*) if [[ -n "${MOCK_SHA:-}" ]]; then jq --arg s "$MOCK_SHA" '.CodeSha256=$s' "$M/lambda-config.json"; else cat "$M/lambda-config.json"; fi ;;
  *"s3api head-object"*) echo 260561 ;;
  *"apigatewayv2 get-routes"*) if [[ "${MOCK_ROUTE:-0}" == 1 ]]; then jq '. + ["GET /v1/surprise"]' "$M/routes.json"; else cat "$M/routes.json"; fi ;;
  *"s3 sync s3://mock-bucket"*) d=$(awk '{print $4}' <<<"$a"); mkdir -p "$d"; cp -r "$M/webfiles/." "$d/"; if [[ "${MOCK_WEB:-0}" == 1 ]]; then echo changed > "$d/assets/x.js"; fi ;;
  *) echo "MOCK: unhandled aws call: $a" >&2; exit 1 ;;
esac
S
cat > "$W/bin/npx" <<'S'
#!/usr/bin/env bash
echo "npx $*" >> "$MOCK_LOG"; echo "(mock cdk: $*)"; exit 0
S
chmod +x "$W/bin/aws" "$W/bin/npx"
mkdir -p "$W/repo/infra/aws/node_modules/.bin"; : > "$W/repo/infra/aws/node_modules/.bin/cdk"; chmod +x "$W/repo/infra/aws/node_modules/.bin/cdk"
# a clean checkout stand-in at the same commit: the script only reads git rev-parse and status of REPO
git clone -q --no-checkout "$REPO" "$W/repo2" 2>/dev/null; ( cd "$W/repo2" && git checkout -q "$(git -C "$REPO" rev-parse HEAD)" ) ; mkdir -p "$W/repo2/infra/aws/node_modules/.bin"; : > "$W/repo2/infra/aws/node_modules/.bin/cdk"; chmod +x "$W/repo2/infra/aws/node_modules/.bin/cdk"
cp "$HERE/STELLA_PRD_DEPLOY.sh" "$HERE/diff_gate_prd0088.py" "$HERE/fill_pins_prd.py" "$W/"
S0=$(date -u -d '-1 hour' '+%Y-%m-%d %H:%M:%S'); E0=$(date -u -d '+3 hours' '+%Y-%m-%d %H:%M:%S')
python3 "$W/fill_pins_prd.py" --repo "$W/repo2" --assembly "$ASM" --go-ref GO-MOCK-TEST-0000 --window-start "$S0" --window-end "$E0" --files STELLA_PRD_DEPLOY.sh >/dev/null || { echo "fill failed"; exit 2; }
fail=0; OUTTXT=""
runm() { # label stdin-text mode [ENV=...]...
  local ans="$1" mode="$2"; shift 2; : > "$W/calls.log"
  OUTTXT=$(cd "$W" && printf '%s\n' "$ans" | env PATH="$W/bin:$PATH" MOCKDIR="$W" MOCK_LOG="$W/calls.log" REPO="$W/repo2" ASSEMBLY="$ASM" OGEVIA_PRD_BASELINE="$W/base" OGEVIA_PRD_BEFORE_0088="$W/before" OGEVIA_DEPLOY_APPROVAL=GO-MOCK-TEST-0000 "$@" script -qec "bash STELLA_PRD_DEPLOY.sh $mode" /dev/null 2>&1 | sed 's/\x1b\[[0-9;?]*[a-zA-Z]//g; s/\r//g')
}
expect() { if grep -q -E "$2" <<<"$OUTTXT"; then echo "PASS $1"; else echo "FAIL $1: pattern '$2' not found"; echo "$OUTTXT" | tail -5 | cut -c1-170; fail=1; fi; }
refuse_no() { if grep -q -E "$2" "$W/calls.log"; then echo "FAIL $1: a call matching '$2' WAS made"; fail=1; else echo "PASS $1"; fi; }
runm x capture;                    expect "capture with no drift passes and says so" "CAPTURED to .* and no drift from the baseline"; expect "the 83-file style web comparison is reported" "equal the baseline"
runm x capture MOCK_DRIFT=$APIT;   expect "a changed live API template stops the capture (drift)" "$APIT CHANGED since the recorded baseline"
rm -rf "$W/before"; runm x capture MOCK_SHA=abc;      expect "changed Lambda code stops the capture (drift)" "API Lambda code CHANGED since the baseline"
rm -rf "$W/before"; runm x capture MOCK_ROUTE=1;      expect "a changed route list stops the capture (drift)" "route list CHANGED since the baseline"
rm -rf "$W/before"; runm x capture MOCK_WEB=1;        expect "a changed web file stops the capture (drift)" "web files CHANGED since the baseline"
rm -rf "$W/before"; runm x capture >/dev/null 2>&1
rm -rf "$W/before"; runm x capture MOCK_STACK_STATUS=UPDATE_ROLLBACK_COMPLETE; expect "capture: ONLY the API stack may be in UPDATE_ROLLBACK_COMPLETE (another stack is refused)" "Ogevia-prd-Auth is UPDATE_ROLLBACK_COMPLETE, not settled"; if grep -q "$APIT is UPDATE_ROLLBACK_COMPLETE, not settled" <<<"$OUTTXT"; then echo "FAIL the API stack in UPDATE_ROLLBACK_COMPLETE was refused"; fail=1; else echo "PASS the API stack in UPDATE_ROLLBACK_COMPLETE is accepted (its template is still compared)"; fi
rm -rf "$W/before"; runm x capture >/dev/null 2>&1
runm x check;                       expect "check: the production gate accepts exactly the release's difference" "added: 22 route\(s\) \(the 22 expected\)"; expect "check: EXPECTED-ONLY: YES" "EXPECTED-ONLY: YES"
runm x deploy-api;                  expect "deploy-api without the database marker is refused" "database marker .* is missing"; refuse_no "no cdk deploy without the marker" "npx .*deploy"
mkdir -p "$HOME/.prd0088"; printf '88|0088|snap-x|%s|%s\n' "$(date -u +%FT%TZ)" "0000000000000000000000000000000000000000" > "$HOME/.prd0088/db-at-0088.ok"
runm x deploy-api;                  expect "a marker for another commit is refused" "not for this release"; refuse_no "no cdk deploy with a foreign marker" "npx .*deploy"
printf '88|0088|snap-x|%s|%s\n' "$(date -u -d '-20 hours' +%FT%TZ)" "$(git -C "$W/repo2" rev-parse HEAD)" > "$HOME/.prd0088/db-at-0088.ok"
runm x deploy-api;                  expect "a marker older than 12 hours is refused" "older than 12 hours"; refuse_no "no cdk deploy with a stale marker" "npx .*deploy"
printf '88|0088|snap-x|%s|%s\n' "$(date -u +%FT%TZ)" "$(git -C "$W/repo2" rev-parse HEAD)" > "$HOME/.prd0088/db-at-0088.ok"
runm "wrong phrase" deploy-api;     expect "with a valid marker and a passing gate, a wrong confirmation changes nothing" "confirmation not given"; expect "the proposal names the production stack" "ABOUT TO RUN \(YELLOW, PRODUCTION\)"; refuse_no "no cdk deploy without the typed phrase" "npx .*deploy"
rm -f "$HOME/.prd0088/db-at-0088.ok"; runm x web;  expect "web without the marker is refused" "database marker .* is missing"
[[ $fail == 0 ]] && echo "DEPLOY MOCK TEST PASSED" || { echo "DEPLOY MOCK TEST FAILED"; exit 1; }
