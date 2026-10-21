#!/usr/bin/env bash
# D: LIVE token checks (read-only HTTP GETs of /v1/me). Proves, with REAL tokens from REAL sign-ins:
#   production token -> production API      200   (the production administrator can sign in)
#   test-pool token  -> production API      401   (a test token is rejected by production)
#   production token -> pilot API           401   (a production token is rejected by the pilot)
#   test-pool token  -> pilot API           200   (the pilot still works)
#   no token         -> both APIs           401
# Tokens: sign in to each site in a browser, open the browser's developer tools, Network tab, click a /v1/me request and copy the value after "Bearer " in the Authorization header.
# They expire in 60 minutes. Paste them when asked (nothing is shown) or export OGEVIA_PRD_TOKEN / OGEVIA_TEST_TOKEN. They are never printed, never written to a file that
# outlives this script, and only HTTP status codes are shown. Use SYNTHETIC test users and your own production administrator only.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/common.sh"
[[ $# -eq 0 || "${1:-}" == tokens ]] || { echo "usage: bash d-verify-prd.sh [tokens]" >&2; exit 2; }
need aws jq
CURL="${OGEVIA_CURL:-curl}"
check_account
PRD_API=$(stack_out "$API_STACK" ApiUrl); PILOT_API=$(stack_out "$PILOT_API_STACK" ApiUrl)
[[ "$PRD_API" =~ ^https://[a-z0-9]+\.execute-api\.us-west-2\.amazonaws\.com$ && "$PILOT_API" =~ ^https://[a-z0-9]+\.execute-api\.us-west-2\.amazonaws\.com$ && "$PRD_API" != "$PILOT_API" ]] || stop "cannot read the two API addresses"
PRD_T="${OGEVIA_PRD_TOKEN:-}"; TEST_T="${OGEVIA_TEST_TOKEN:-}"
[[ -n "$PRD_T" ]] || { read -r -s -p "Paste the PRODUCTION access token (not shown; empty to skip): " PRD_T || true; echo; }
[[ -n "$TEST_T" ]] || { read -r -s -p "Paste a TEST-POOL (pilot) access token (not shown; empty to skip): " TEST_T || true; echo; }
status() {   # $1 = API url, $2 = token (may be empty); prints the HTTP status only
  local f; f=$(mktemp "$AB/hdr.XXXXXX"); chmod 600 "$f"
  if [[ -n "$2" ]]; then printf 'header = "Authorization: Bearer %s"\n' "$2" > "$f"; else : > "$f"; fi
  "$CURL" -s -o /dev/null -w '%{http_code}' --max-time 30 -K "$f" "$1/v1/me"; rm -f "$f"
}
expect() {   # label, expected, got
  [[ "$3" == "$2" ]] && ok "$1: HTTP $3 (expected $2)" || nope "$1: HTTP $3 (expected $2)"
}
expect "no token -> production API" 401 "$(status "$PRD_API" "")"
expect "no token -> pilot API" 401 "$(status "$PILOT_API" "")"
[[ -n "$PRD_T" ]] && { expect "production token -> production API (the administrator can sign in)" 200 "$(status "$PRD_API" "$PRD_T")"; expect "production token -> pilot API (rejected)" 401 "$(status "$PILOT_API" "$PRD_T")"; } || info "no production token supplied: those two checks were skipped"
[[ -n "$TEST_T" ]] && { expect "test-pool token -> production API (rejected)" 401 "$(status "$PRD_API" "$TEST_T")"; expect "test-pool token -> pilot API (still works)" 200 "$(status "$PILOT_API" "$TEST_T")"; } || info "no test-pool token supplied: those two checks were skipped"
unset PRD_T TEST_T OGEVIA_PRD_TOKEN OGEVIA_TEST_TOKEN
[[ $bad == 0 ]] && say "TOKEN CHECKS PASSED." || { say "TOKEN CHECKS FAILED."; exit 1; }
