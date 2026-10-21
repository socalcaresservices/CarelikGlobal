#!/usr/bin/env bash
# E: ROLLBACK of the production authentication separation. Order matters; each step is independent and idempotent:
#   1. bash b-admin-prd.sh undo        (once per relinked person: moves the person record back to the old sign-in; the ONLY database change of this release)
#   2. bash c-web-prd.sh rollback      (restores the previous index.html; the previous hashed files were never deleted)
#   3. OGEVIA_AUTH_PREVIOUS_TEMPLATES=<dir> bash a-deploy-prd.sh rollback-check     (READ-ONLY: proves redeploying the previous commit restores exactly the pre-change API)
#   4. OGEVIA_DEPLOY_APPROVAL=<ref> OGEVIA_PREVIOUS_CDK_DIR=<infra/aws of the PREVIOUS commit> bash e-rollback-prd.sh api
#        YELLOW: redeploys ONLY Ogevia-prd-ServiceVerificationApi from the previous commit (the old issuer, the legacy and old production clients, the old Lambda code). Typed phrase
#        ROLLBACK-Ogevia-prd-Api. The new pool stack (Ogevia-prd-Auth) is LEFT IN PLACE and RETAINED (empty of traffic): deleting a user pool is a separate RED action.
#   5. bash e-rollback-prd.sh post     READ-ONLY checks that production trusts the shared pool again.
# Nothing in this release deletes a pool, a client, a user, a person record, an agency or a bucket object, so a rollback loses nothing.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/common.sh"
MODE="${1:-}"; [[ $# -eq 1 && "$MODE" =~ ^(api|post)$ ]] || { echo "usage: bash e-rollback-prd.sh api|post   (see the header for steps 1-3)" >&2; exit 2; }
need aws jq timeout
CURL="${OGEVIA_CURL:-curl}"
check_account
case "$MODE" in
api)
  [[ "${OGEVIA_DEPLOY_APPROVAL:-}" =~ $APPROVAL_RE ]] || stop "set OGEVIA_DEPLOY_APPROVAL to the approval reference"
  [[ -s "$AB/rollback-gate.ok" ]] || stop "run the rollback-check first (a-deploy-prd.sh rollback-check): no marker"
  AGE=$(( $(date +%s) - $(cat "$AB/rollback-gate.ok") )); (( AGE >= 0 && AGE <= 3600 )) || stop "the rollback-check marker is ${AGE}s old (limit 3600). Run it again."
  PREV="${OGEVIA_PREVIOUS_CDK_DIR:-}"; [[ -f "$PREV/bin/ogevia.ts" && -f "$PREV/lib/config.ts" ]] || stop "set OGEVIA_PREVIOUS_CDK_DIR to infra/aws of the PREVIOUS commit"
  grep -q "dedicatedUserPool" "$PREV/lib/config.ts" && stop "that directory is the NEW code (it defines a dedicated user pool), not the previous commit"
  CDK="${OGEVIA_CDK_BIN:-npx cdk}"
  ARGV=($CDK deploy -c env=prd -c mode=deploy --exclusively "$API_STACK" --require-approval broadening --no-notices)
  for a in "${ARGV[@]}"; do case "$a" in --all|--force|--hotswap|--no-rollback|'*') stop "refused argument $a" ;; esac; done
  say "== PROPOSED (YELLOW: changes PRODUCTION): in $PREV run: OGEVIA_DEPLOY_APPROVAL=$OGEVIA_DEPLOY_APPROVAL ${ARGV[*]}"
  say "   Restores the old API authorizer and Lambda settings. $AUTH_STACK is left in place."
  read -r -p "Type ROLLBACK-Ogevia-prd-Api to redeploy the previous API (anything else stops): " ANS || true
  [[ "${ANS:-}" == ROLLBACK-Ogevia-prd-Api ]] || { say "Declined. Nothing was changed."; exit 0; }
  (cd "$PREV" && OGEVIA_DEPLOY_APPROVAL="$OGEVIA_DEPLOY_APPROVAL" "${ARGV[@]}") || stop "the redeploy failed; CloudFormation rolls back a failed update. Report the output."
  say "REDEPLOYED. Now: bash e-rollback-prd.sh post" ;;
post)
  API=$(stack_out "$API_STACK" ApiUrl | sed -E 's#^https://([a-z0-9]+)\..*#\1#'); OLD_CLIENT=$(stack_out "$WEB_STACK" TestAppClientId)
  AZ=$(A apigatewayv2 get-authorizers --api-id "$API" --output json 2>/dev/null | jq -c '[.Items[] | {i: .JwtConfiguration.Issuer, a: (.JwtConfiguration.Audience | sort)}]')
  [[ "$(jq -r '.[0].i' <<<"$AZ")" == "https://cognito-idp.us-west-2.amazonaws.com/$SHARED_POOL" ]] && ok "production trusts the shared pool again (issuer)" || nope "the production issuer is not the shared pool"
  [[ "$(jq -r --arg c "$OLD_CLIENT" '.[0].a | index($c) != null' <<<"$AZ")" == true ]] && ok "the production web client in the shared pool is accepted again" || nope "the old production client is not in the audience"
  code=$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 30 "$(stack_out "$API_STACK" ApiUrl)/v1/me"); [[ "$code" == 401 ]] && ok "anonymous GET /v1/me returns 401" || nope "anonymous GET /v1/me returned $code"
  [[ $bad == 0 ]] && say "ROLLBACK POST-CHECKS PASSED. Remember: b-admin-prd.sh undo for each relinked person, and c-web-prd.sh rollback." || { say "ROLLBACK POST-CHECKS FAILED."; exit 1; } ;;
esac
