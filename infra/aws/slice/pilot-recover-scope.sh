#!/usr/bin/env bash
# Resume the pilot run after the phase-7 stop: install the reviewed scope gate
# (commit 736b2f3; CDK-metadata-tolerant, live-route evidence), show the live
# route evidence, then resume pilot-deploy.sh. Saved details, passed checks,
# rollback capture and the DEPLOY prompt are all kept. No GitHub, no AWS change.
set -uo pipefail
REPO="${OGEVIA_PILOT_REPO:-/tmp/ogevia-pilot}"
RUN="${OGEVIA_PILOT_RUN_DIR:-$HOME/ogevia-pilot-run}"
EXPECT="${PILOT_COMMIT:-87a9be2bf87e83750d235bfe943b18d5e702cac2}"
GATE_SHA=bcae6584c46d8d4d1d22932ef401e75de0ce526b5b9f2d9ca992550b324c41f0
API=Ogevia-prod-ServiceVerificationApi
[[ -e "$REPO/.git" && "$(git -C "$REPO" rev-parse HEAD 2>/dev/null)" == "$EXPECT"* ]] || { echo "STOP: $REPO missing or not at ${EXPECT:0:12}; run ~/ogevia-bootstrap.sh"; exit 1; }
for f in inputs.env "state/tests-${EXPECT:0:12}" state/rollback-captured "rollback/templates/$API.json" rollback/routes.json; do
  [[ -e "$RUN/$f" ]] || { echo "STOP: $RUN/$f is missing"; exit 1; }
done
echo "Kept: pilot details, quality-gate pass for ${EXPECT:0:12}, rollback capture. DEPLOY approval given: $([[ -f "$RUN/state/approved" ]] && echo yes || echo no)"
[[ "$(sha256sum "$RUN/tools/pilot_diff_gate.py" | cut -d' ' -f1)" == "$GATE_SHA" ]] || { echo "STOP: gate file checksum mismatch (paste the whole block again)"; exit 1; }

echo "== Live API evidence (captured before any change)"
echo "Live routes: $(jq length "$RUN/rollback/routes.json") ($(jq '[.[] | select(.[1]=="NONE")] | length' "$RUN/rollback/routes.json") public)"
for r in "GET /v1/public/care-portals/{token}/requests" "POST /v1/visits/{visitId}/close"; do
  echo "  $r: $(jq -r --arg r "$r" 'if any(.[]; .[0]==$r) then "LIVE" else "not live (this deployment adds it)" end' "$RUN/rollback/routes.json")"
done

cp "$RUN/tools/pilot_diff_gate.py" "$REPO/infra/aws/slice/pilot_diff_gate.py"
echo "Scope gate updated to the reviewed version (sha256 ${GATE_SHA:0:12}...)."
echo "== Scope gate against the captured live templates"
python3 "$REPO/infra/aws/slice/pilot_diff_gate.py" --cdk-out "$REPO/infra/aws/cdk.out" --deployed "$RUN/rollback/templates" \
  || { echo "STOP: the scope gate still fails (output above). Nothing was changed. Send this output to Claude."; exit 1; }

echo "== Resuming the deployment (details kept; DEPLOY is still required)"
export NODE_OPTIONS=--max-old-space-size=1536
cd "$REPO" || exit 1
bash infra/aws/slice/pilot-deploy.sh
rc=$?
echo "pilot-deploy.sh exit code: $rc"
exit "$rc"
