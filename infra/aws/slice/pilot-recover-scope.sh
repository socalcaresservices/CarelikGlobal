#!/usr/bin/env bash
# =============================================================================
# Resume the SCS pilot run after the phase-7 stop, with the STRICT scope gate.
# Keeps: saved pilot details, the quality-gate pass for 87a9be2, the rollback
# capture, and the DEPLOY prompt. Stops if an approval marker already exists.
# No GitHub, no AWS change before DEPLOY.
#   1. installs the strict gate (verified by sha256; written beside this file);
#   2. patches ONE line of pilot-deploy.sh in the checkout so synth can use the
#      LIVE ogevia:deployment-status value (tags stay identical; verified);
#   3. derives that value from the captured live templates (one value, valid);
#   4. prints live-route evidence, re-synthesizes, runs the gate;
#   5. resumes pilot-deploy.sh, which asks for DEPLOY.
# =============================================================================
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
REPO="${OGEVIA_PILOT_REPO:-/tmp/ogevia-pilot}"
RUN="${OGEVIA_PILOT_RUN_DIR:-$HOME/ogevia-pilot-run}"
EXPECT="${PILOT_COMMIT:-87a9be2bf87e83750d235bfe943b18d5e702cac2}"
GATE_SHA=484b7dfcf74ad2d2e9e3a77d3d4eceaf27fc6a1733c4041c41996138aae0203c
API=Ogevia-prod-ServiceVerificationApi
stop() { echo "STOP: $*"; echo "Nothing was changed in AWS."; exit 1; }

[[ -e "$REPO/.git" && "$(git -C "$REPO" rev-parse HEAD 2>/dev/null)" == "$EXPECT"* ]] || stop "$REPO missing or not at ${EXPECT:0:12}; run ~/ogevia-bootstrap.sh"
for f in inputs.env "state/tests-${EXPECT:0:12}" state/rollback-captured "rollback/templates/$API.json" rollback/routes.json; do
  [[ -e "$RUN/$f" ]] || stop "$RUN/$f is missing"
done
[[ ! -e "$RUN/state/approved" ]] || stop "an approval marker already exists ($RUN/state/approved: $(tr '\n' ' ' < "$RUN/APPROVAL.txt" 2>/dev/null)). A previous DEPLOY must not carry over to a new scope; send this to Claude."
echo "Kept: pilot details ($(grep -c '_EMAIL=' "$RUN/inputs.env") sign-ins), quality-gate pass for ${EXPECT:0:12}, rollback capture. No approval marker: DEPLOY will be asked."

GATE="$RUN/tools/pilot_diff_gate.py"
[[ "$(sha256sum "$GATE" 2>/dev/null | cut -d' ' -f1)" == "$GATE_SHA" ]] || stop "strict gate file checksum mismatch (paste the whole block again)"
cp "$GATE" "$REPO/infra/aws/slice/pilot_diff_gate.py"

DEPLOY_SH="$REPO/infra/aws/slice/pilot-deploy.sh"
OLD_LINE='export OGEVIA_DEPLOY_APPROVAL="pilot-test-$COMMIT"'
NEW_LINE='export OGEVIA_DEPLOY_APPROVAL="${OGEVIA_PILOT_TAG_REF:-pilot-test-$COMMIT}"'
if grep -qxF "$OLD_LINE" "$DEPLOY_SH"; then
  sed -i "s|^export OGEVIA_DEPLOY_APPROVAL=\"pilot-test-\$COMMIT\"\$|$NEW_LINE|" "$DEPLOY_SH"
fi
[[ "$(grep -c '^export OGEVIA_DEPLOY_APPROVAL=' "$DEPLOY_SH")" == 1 ]] && grep -qxF "$NEW_LINE" "$DEPLOY_SH" \
  || stop "could not apply the one-line synth patch to pilot-deploy.sh"
[[ "$(git -C "$REPO" diff --numstat -- infra/aws/slice/pilot-deploy.sh | awk '{print $1+$2}')" == 2 ]] \
  || stop "pilot-deploy.sh differs from ${EXPECT:0:12} by more than the one patched line"
echo "Installed: strict scope gate (sha256 ${GATE_SHA:0:12}...); pilot-deploy.sh synth uses the live tag value (1 line)."

TAGS=$(python3 - "$RUN/rollback/templates" <<'PY'
import json, glob, sys
vals = set()
for f in glob.glob(sys.argv[1] + "/*.json"):
    for r in json.load(open(f)).get("Resources", {}).values():
        for t in (r.get("Properties", {}).get("Tags") or []):
            if isinstance(t, dict) and t.get("Key") == "ogevia:deployment-status":
                vals.add(t.get("Value"))
print("\n".join(sorted(vals)))
PY
)
[[ "$(wc -l <<<"$TAGS")" == 1 && "$TAGS" == approved-* ]] || stop "live ogevia:deployment-status values are not one consistent value: $(tr '\n' ' ' <<<"$TAGS")"
export OGEVIA_PILOT_TAG_REF="${TAGS#approved-}"
[[ "$OGEVIA_PILOT_TAG_REF" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || stop "live approval tag value is not a valid reference: $TAGS"
echo "Live ogevia:deployment-status: $TAGS (kept unchanged; this approval is recorded in $RUN/APPROVAL.txt)"

echo "== Live API evidence (captured before any change)"
echo "Live routes: $(jq length "$RUN/rollback/routes.json") ($(jq '[.[] | select(.[1]=="NONE")] | length' "$RUN/rollback/routes.json") public)"
for r in "GET /v1/public/care-portals/{token}/requests" "POST /v1/visits/{visitId}/close" "POST /v1/visits/{visitId}/end"; do
  echo "  $r: $(jq -r --arg r "$r" 'if any(.[]; .[0]==$r) then "LIVE" else "not live" end' "$RUN/rollback/routes.json")"
done

echo "== Re-synthesizing with the live tag value, then the strict scope gate"
export NODE_OPTIONS=--max-old-space-size=1536
(cd "$REPO/infra/aws" && OGEVIA_DEPLOY_APPROVAL="$OGEVIA_PILOT_TAG_REF" npx cdk synth --quiet --no-notices -c env=prod -c mode=deploy >/dev/null) \
  || stop "cdk synth failed"
python3 "$REPO/infra/aws/slice/pilot_diff_gate.py" --cdk-out "$REPO/infra/aws/cdk.out" --deployed "$RUN/rollback/templates" \
  || stop "the strict scope gate does not pass (output above). Send this output to Claude."

echo "== Resuming the deployment (details kept; DEPLOY is still required)"
cd "$REPO" || exit 1
bash infra/aws/slice/pilot-deploy.sh
rc=$?
echo "pilot-deploy.sh exit code: $rc"
exit "$rc"
