#!/usr/bin/env bash
# READ-ONLY diagnosis of live check 6 (release 0027-0036). Changes nothing in AWS.
# Compares the API Lambda configuration captured BEFORE the deployment with the
# live one, field by field (environment values shown only as a hash), and checks
# the live code against the deployment package the live template references.
# Output: ~/ogevia-release-0036-run/check6-diagnosis-<time>.txt
set -uo pipefail
RUN="${OGEVIA_RELEASE_RUN_DIR:-$HOME/ogevia-release-0036-run}"; RB="$RUN/rollback"
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""
OUT="$RUN/check6-diagnosis-$(date -u +%Y%m%dT%H%M%SZ).txt"
[ -f "$RB/handler-config.json" ] && [ -f "$RB/MANIFEST.json" ] || { echo "STOP: $RB has no pre-deployment capture"; exit 1; }
FN=$(jq -r .lambda "$RB/MANIFEST.json")
LIVE="$RUN/handler-config-live-diagnosis.json"
aws lambda get-function-configuration --function-name "$FN" --output json > "$LIVE" || { echo "STOP: cannot read $FN"; exit 1; }
chmod 600 "$LIVE"
{
echo "Function: $FN"
echo "== Fields that differ: before (captured before DEPLOY) -> live now. Environment values are hashed, never printed."
python3 - "$RB/handler-config.json" "$LIVE" <<'PY'
import hashlib, json, sys
def flat(v, p=""):
    if isinstance(v, dict):
        o = {}
        for k, x in v.items(): o.update(flat(x, p + "." + k if p else k))
        return o or {p: {}}
    if isinstance(v, list):
        o = {}
        for i, x in enumerate(v): o.update(flat(x, "%s[%d]" % (p, i)))
        return o or {p: []}
    return {p: v}
def show(k, v):
    if v is None: return "(absent)"
    if k.startswith("Environment.Variables."): return "value sha256:" + hashlib.sha256(json.dumps(v).encode()).hexdigest()[:12]
    return json.dumps(v)
skipped = ("CodeSha256", "LastModified", "Version", "RevisionId", "LastUpdateStatus", "State")  # removed by the pre-deployment capture
b = flat(json.load(open(sys.argv[1]))); a = {k: v for k, v in flat(json.load(open(sys.argv[2]))).items() if k.split(".")[0].split("[")[0] not in skipped}
rows = [k for k in sorted(set(b) | set(a)) if b.get(k) != a.get(k)]
for k in rows: print("  %s: %s -> %s" % (k, show(k, b.get(k)), show(k, a.get(k))))
print("  (no differences)" if not rows else "  %d field(s) differ" % len(rows))
expected = {"CodeSize"} | {k for k in rows if k.startswith("RuntimeVersionConfig.")}
other = [k for k in rows if k not in expected]
print("== Fields other than CodeSize / RuntimeVersionConfig: " + (", ".join(other) if other else "none"))
PY
echo "== Live state: $(jq -r '"State=\(.State) LastUpdateStatus=\(.LastUpdateStatus) Runtime=\(.Runtime)"' "$LIVE")"
echo "== Runtime update mode: $(aws lambda get-runtime-management-config --function-name "$FN" --query UpdateRuntimeOn --output text 2>&1)"
T=$(aws cloudformation get-template --stack-name Ogevia-prod-ServiceVerificationApi --template-stage Original --query TemplateBody --output json)
SEL='.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key | startswith("Handler"))) | .value.Properties.Code'
B=$(jq -r "$SEL | .S3Bucket | if type == \"object\" then .[\"Fn::Sub\"] else . end" <<<"$T"); K=$(jq -r "$SEL | .S3Key" <<<"$T")
B=${B//'${AWS::AccountId}'/$(aws sts get-caller-identity --query Account --output text)}; B=${B//'${AWS::Region}'/us-west-2}
SIZE=$(aws s3api head-object --bucket "$B" --key "$K" --query ContentLength --output text 2>&1)
SHA=$(aws s3 cp "s3://$B/$K" - --only-show-errors | python3 -c 'import sys, hashlib, base64; print(base64.b64encode(hashlib.sha256(sys.stdin.buffer.read()).digest()).decode())')
echo "== Deployment package in the live template: s3://$B/$K"
echo "   package size $SIZE, live CodeSize $(jq -r .CodeSize "$LIVE"), captured-before CodeSize $(jq -r .CodeSize "$RB/handler-config.json")"
echo "   package sha256 $SHA"
echo "   live CodeSha256 $(jq -r .CodeSha256 "$LIVE"), before $(jq -r .CodeSha256 "$RB/lambda.json")"
if [ "$SIZE" = "$(jq -r .CodeSize "$LIVE")" ] && [ "$SHA" = "$(jq -r .CodeSha256 "$LIVE")" ]; then echo "   => the live code IS exactly the deployed package"; else echo "   => MISMATCH: the live code is NOT the deployed package"; fi
} | tee "$OUT"
echo "Saved: $OUT"
