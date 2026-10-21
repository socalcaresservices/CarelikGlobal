#!/usr/bin/env bash
# Fake curl for the authentication-separation script tests. For https://<api>.execute-api... it answers /v1/me from a rule table keyed by the token marker found in the -K header
# file; for anything else (file:// URLs) it runs the real curl. Tokens are never written anywhere by this mock.
args=("$@"); url="${args[-1]}"
if [[ "$url" == https://*execute-api* ]]; then
  tok=""; for ((i=0;i<${#args[@]};i++)); do [[ "${args[$i]}" == -K ]] && tok=$(sed -n 's/.*Bearer \(.*\)".*/\1/p' "${args[$((i+1))]}"); done
  host=$(sed -E 's#https://([a-z0-9]+)\..*#\1#' <<<"$url")
  code=$(jq -r --arg h "$host" --arg t "${tok:-none}" '.[$h][$t] // .[$h]["*"] // 401' "$MOCK_DIR/state/api-rules.json")
  for ((i=0;i<${#args[@]};i++)); do [[ "${args[$i]}" == -w ]] && printf '%s' "$code"; done
  exit 0
fi
exec "$REAL_CURL" "$@"
