#!/usr/bin/env bash
# =============================================================================
# TEST release 2026-10-26-redesign, STEP 12 (read-only): the new staff API route(s) of this upgrade refuse every call that carries no valid token. Only curl calls to the TEST API URL.
#   bash route-smoke.sh [API_URL]        (default: the captured $OGEVIA_BEFORE/api-url-before.txt)
# For each route key in new-route-keys.json (the same list the diff gate and the assembly check pin):
#   * no Authorization header                         -> HTTP 401
#   * a well-formed but forged JWT (random signature)  -> HTTP 401
# plus one CORS preflight (OPTIONS /v1/staff with Origin https://demo.ogevia.com) which must answer 204 with that origin allowed (decision D2).
# The calls carry no credentials and an empty JSON body: the API Gateway authorizer answers before any code runs, so nothing can be created or changed.
# Exit 0 = every check passed; 1 = a check failed; 2 = usage.
# =============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
B="${OGEVIA_BEFORE:-$HOME/ogevia-before}"
API="${1:-$(cat "$B/api-url-before.txt" 2>/dev/null)}"
API="${API%/}"
[[ "$API" =~ ^https://[A-Za-z0-9.-]+\.execute-api\.us-west-2\.amazonaws\.com$ ]] || { echo "usage: bash route-smoke.sh https://<id>.execute-api.us-west-2.amazonaws.com" >&2; exit 2; }
[[ "$API" != *zk527zk4ua* ]] || { echo "REFUSED: that is the PRODUCTION API (zk527zk4ua); this smoke is for TEST only" >&2; exit 2; }
for t in curl jq; do command -v "$t" >/dev/null 2>&1 || { echo "FAIL missing tool '$t'"; exit 1; }; done
[[ -f "$HERE/new-route-keys.json" ]] || { echo "FAIL new-route-keys.json is missing"; exit 1; }
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
FORGED="$(printf '{"alg":"RS256","kid":"forged"}' | b64url).$(printf '{"sub":"forged","iss":"https://example.invalid","exp":4102444800}' | b64url).$(printf 'not-a-real-signature' | b64url)"
ZERO=00000000-0000-4000-8000-000000000000
bad=0; n=0
while IFS= read -r key; do
  method="${key%% *}"; path="${key#* }"
  path="${path//\{staffTypeId\}/$ZERO}"; path="${path//\{profileId\}/$ZERO}"; path="${path//\{userId\}/$ZERO}"; path="${path//\{organizationId\}/$ZERO}"
  [[ "$path" != *"{"* ]] || { echo "FAIL unresolved placeholder in $key"; bad=1; continue; }
  for mode in none forged; do
    args=(-sS -o /dev/null -w '%{http_code}' --max-time 30 -X "$method" "$API$path?organizationId=$ZERO")
    [[ "$method" == POST ]] && args+=(-H 'content-type: application/json' --data '{}')
    [[ "$mode" == forged ]] && args+=(-H "authorization: Bearer $FORGED")
    code=$(curl "${args[@]}" 2>/dev/null) || code="curl-failed"
    n=$((n + 1))
    if [[ "$code" == 401 ]]; then echo "PASS $key ($mode token): 401"; else echo "FAIL $key ($mode token): HTTP $code, expected 401"; bad=1; fi
  done
done < <(jq -r '.[]' "$HERE/new-route-keys.json")
HDR=$(curl -sS -D - -o /dev/null --max-time 30 -X OPTIONS "$API/v1/staff" -H 'Origin: https://demo.ogevia.com' -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: authorization' 2>/dev/null) || HDR=""
CODE=$(head -1 <<<"$HDR" | grep -o ' [0-9]\{3\}' | tr -d ' ')
if [[ "$CODE" == 204 || "$CODE" == 200 ]] && grep -qi '^access-control-allow-origin: https://demo.ogevia.com' <<<"$HDR"; then echo "PASS CORS preflight from https://demo.ogevia.com: $CODE and the origin is allowed"; else echo "FAIL CORS preflight from https://demo.ogevia.com: HTTP ${CODE:-none}, origin not allowed (decision D2)"; bad=1; fi
if [[ $bad == 0 && $n == 2 ]]; then echo "ROUTE SMOKE PASSED: 1 route x 2 calls, all 401; CORS preflight ok"; exit 0; fi
echo "STOP: a route check failed (calls made: $n of 2). See Recovery."; exit 1
