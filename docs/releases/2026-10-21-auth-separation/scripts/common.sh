#!/usr/bin/env bash
# Shared helpers for the production authentication-separation package. Sourced; never run directly. It reuses the production release package's helper library
# (lib.sh: account check, timeouts, PASS/FAIL logging) and database window library (window.sh) UNCHANGED, from vendor/ inside the package or, in the repository,
# from the release package directory.
HERE_COMMON="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$HERE_COMMON/vendor/lib.sh" ]]; then VENDOR="$HERE_COMMON/vendor"; else VENDOR="${OGEVIA_RELEASE_SCRIPTS:-$HERE_COMMON/../../2026-10-19-prd-readiness/release/scripts}"; fi
[[ -f "$VENDOR/lib.sh" && -f "$VENDOR/window.sh" ]] || { echo "STOP: the release helper scripts (lib.sh, window.sh) were not found at $VENDOR" >&2; exit 1; }
source "$VENDOR/lib.sh"
AUTH_STACK=Ogevia-prd-Auth; API_STACK=Ogevia-prd-ServiceVerificationApi; WEB_STACK=Ogevia-prd-WebHosting; PILOT_API_STACK=Ogevia-prod-ServiceVerificationApi
SHARED_POOL=us-west-2_849AYz5J7          # the pilot/test pool: never used by production after this change
PRD_IDENTITY_FN=Ogevia-prd-IdentityAdmin
AB="$B/auth"; mkdir -p "$AB" && chmod 700 "$AB"
stack_json() { A cloudformation describe-stacks --stack-name "$1" --output json 2>/dev/null; }
stack_out() { stack_json "$1" | jq -r --arg k "$2" '.Stacks[0].Outputs[]? | select(.OutputKey==$k) | .OutputValue' | head -1; }
APPROVAL_RE='^[A-Za-z0-9._-]{6,64}$'
