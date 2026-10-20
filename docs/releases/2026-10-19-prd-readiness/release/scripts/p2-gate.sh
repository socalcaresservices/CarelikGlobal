#!/usr/bin/env bash
# P2 GATE (READ-ONLY). Re-reads the six production templates NOW, requires them to equal what p0 captured (production has not changed since the baseline), requires the five
# stacks other than the API stack to equal the release, and runs the EXPECTED-ONLY gate on Ogevia-prd-ServiceVerificationApi. Exit 0 only if the whole difference is the release's.
#   OGEVIA_ALLOW_PUBLIC_ROUTES='GET /v1/public/x,POST /v1/public/y' bash p2-gate.sh     (optional, only if the owner has reviewed added public routes)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need aws jq python3 timeout
STACKS=(Ogevia-prd-DatabaseSecret Ogevia-prd-EvidenceStorage Ogevia-prd-WebHosting Ogevia-prd-ServiceVerificationApi Ogevia-prd-Observability Ogevia-prod-NetworkEgress)
API=Ogevia-prd-ServiceVerificationApi
say "== P2 gate $(date -u +%FT%TZ) =="; check_account
[[ -d "$B/live" ]] || stop "run p0-baseline-capture.sh first ($B/live is missing)"
mkdir -p "$B/fresh"
for S in "${STACKS[@]}"; do
  ST=$(A cloudformation describe-stacks --stack-name "$S" --output json 2>/dev/null | jq -r '.Stacks[0].StackStatus // empty')
  [[ "$ST" == CREATE_COMPLETE || "$ST" == UPDATE_COMPLETE ]] || { nope "$S is '${ST:-unreadable}', not a settled status"; continue; }
  A cloudformation get-template --stack-name "$S" --template-stage Original --output json 2>/dev/null | jq '.TemplateBody // .' > "$B/fresh/$S.json" && jq -e 'has("Resources")' "$B/fresh/$S.json" >/dev/null 2>&1 || { nope "cannot read the live template of $S"; continue; }
  if python3 -I -B "$PKG_ROOT/scripts/tpl_diff.py" "$B/live/$S.json" "$B/fresh/$S.json" >/dev/null; then ok "$S is unchanged since the p0 baseline"; else nope "$S CHANGED since the p0 baseline: production was modified after the baseline; run p0 again and review"; fi
  if [[ "$S" != "$API" ]]; then
    if python3 -I -B "$PKG_ROOT/scripts/tpl_diff.py" "$B/fresh/$S.json" "$PKG_ROOT/release-templates/$S.json" >/dev/null; then ok "$S equals the release template (nothing to deploy)"; else nope "$S differs from the release template: the release was expected to leave it unchanged"; fi
  fi
done
ARGS=(); IFS=',' read -ra PR <<<"${OGEVIA_ALLOW_PUBLIC_ROUTES:-}"; for r in "${PR[@]}"; do [[ -n "$r" ]] && ARGS+=(--allow-public-route "$r"); done
if [[ -s "$B/fresh/$API.json" ]]; then
  OUT=$(python3 -I -B "$PKG_ROOT/scripts/prd_gate.py" --live "$B/fresh/$API.json" --new "$PKG_ROOT/release-templates/$API.json" "${ARGS[@]}"); rc=$?
  printf '%s\n' "$OUT" | tee -a "$LOG" "$B/gate-result.txt"
  [[ $rc == 0 ]] && ok "$API: the difference is exactly the release's expected change" || nope "$API: the difference is NOT the release's expected change"
fi
echo
if [[ $bad == 0 ]]; then say "GATE PASSED: only $API changes, and only by the release's expected change. Nothing was deployed."; exit 0; else say "STOP: the gate failed (see FAIL and VIOLATION lines). Nothing was deployed."; exit 1; fi
