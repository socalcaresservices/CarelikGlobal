#!/usr/bin/env bash
# =============================================================================
# PRODUCTION release 2026-10-26-redesign (read-only): the 13 new staff API routes refuse every call that carries no valid token. Only curl calls to the PRODUCTION API URL.
#   bash route-smoke.sh [API_URL]        (default: the captured $B/api-url-before.txt, which must name the production API zk527zk4ua)
# For each of the 13 route keys in new-route-keys.json (the same list the diff gate and the assembly check pin):
#   * no Authorization header                         -> HTTP 401
#   * a well-formed but forged JWT (random signature)  -> HTTP 401
# plus a CORS preflight (OPTIONS /v1/staff) from each of https://app.ogevia.com and https://admin.ogevia.com, which must answer 204 (or 200) with that origin allowed.
# The calls carry no credentials and an empty JSON body: the API Gateway authorizer answers before any code runs, so nothing can be created or changed.
# Exit 0 = every check passed; 1 = a check failed; 2 = usage.
# =============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
B="${OGEVIA_PRD_BEFORE:-${OGEVIA_BEFORE:-$HOME/ogevia-prd-before}}"
API="${1:-$(cat "$B/api-url-before.txt" 2>/dev/null)}"
API="${API%/}"
[[ "$API" =~ ^https://[A-Za-z0-9.-]+\.execute-api\.us-west-2\.amazonaws\.com$ ]] || { echo "usage: bash route-smoke-prd.sh https://<id>.execute-api.us-west-2.amazonaws.com" >&2; exit 2; }
[[ "$API" == https://zk527zk4ua.execute-api.us-west-2.amazonaws.com ]] || { echo "REFUSED: this smoke is for the PRODUCTION API (zk527zk4ua) only; got $API" >&2; exit 2; }
for t in curl jq; do command -v "$t" >/dev/null 2>&1 || { echo "FAIL missing tool '$t'"; exit 1; }; done
[[ -f "$HERE/new-route-keys.json" ]] || { echo "FAIL new-route-keys.json is missing"; exit 1; }
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
FORGED="$(printf '{"alg":"RS256","kid":"forged"}' | b64url).$(printf '{"sub":"forged","iss":"https://example.invalid","exp":4102444800}' | b64url).$(printf 'not-a-real-signature' | b64url)"
ZERO=00000000-0000-4000-8000-000000000000
bad=0; n=0
while IFS= read -r key; do
  method="${key%% *}"; path="${key#* }"
  path="${path//\{staffTypeId\}/$ZERO}"; path="${path//\{profileId\}/$ZERO}"; path="${path//\{userId\}/$ZERO}"
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
for ORIGIN in https://app.ogevia.com https://admin.ogevia.com; do
  HDR=$(curl -sS -D - -o /dev/null --max-time 30 -X OPTIONS "$API/v1/staff" -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: authorization' 2>/dev/null) || HDR=""
  CODE=$(head -1 <<<"$HDR" | grep -o ' [0-9]\{3\}' | tr -d ' ')
  if [[ "$CODE" == 204 || "$CODE" == 200 ]] && grep -qi "^access-control-allow-origin: $ORIGIN" <<<"$HDR"; then echo "PASS CORS preflight from $ORIGIN: $CODE and the origin is allowed"; else echo "FAIL CORS preflight from $ORIGIN: HTTP ${CODE:-none}, origin not allowed"; bad=1; fi
done
if [[ $bad == 0 && $n == 26 ]]; then echo "ROUTE SMOKE PASSED: 13 routes x 2 calls, all 401; CORS preflight ok for app. and admin."; exit 0; fi
echo "STOP: a route check failed (calls made: $n of 26). See Recovery."; exit 1
