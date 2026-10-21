#!/usr/bin/env bash
# A: DEPLOY the production authentication separation. Exactly two stacks, only ever together: Ogevia-prd-Auth (NEW: the production user pool, domain, client) and
# Ogevia-prd-ServiceVerificationApi (changed: the API's issuer/audience, the Lambda settings, the identity function's pool and permissions).
#   bash a-deploy-prd.sh check     READ-ONLY: saves the live templates, checks that the live account is exactly as the package expects, and runs the expected-only gate
#                                  (auth_cutover_gate.py) against the templates synthesized from the approved commit. Writes the marker $B/auth/gate.ok.
#   bash a-deploy-prd.sh deploy    YELLOW, changes PRODUCTION. Needs: OGEVIA_DEPLOY_APPROVAL, OGEVIA_PREDEPLOY_SNAPSHOT_ID (a fresh, available snapshot), a gate marker younger
#                                  than 60 minutes (the gate is repeated), and the typed phrase DEPLOY-Ogevia-prd-Auth-and-Api. Runs exactly: cdk deploy -c env=prd -c mode=deploy
#                                  --exclusively Ogevia-prd-Auth Ogevia-prd-ServiceVerificationApi --require-approval broadening. Never --all, --force, --hotswap or --no-rollback.
#   bash a-deploy-prd.sh post      READ-ONLY checks after the deployment (sections below).
#   bash a-deploy-prd.sh rollback-check   READ-ONLY: with OGEVIA_AUTH_PREVIOUS_TEMPLATES (templates synthesized from the PREVIOUS commit) proves that redeploying the previous commit
#                                  restores exactly the pre-change state (the reverse gate). Rollback itself is e-rollback-prd.sh.
# Environment: OGEVIA_AUTH_NEW_TEMPLATES (dir of templates from `npx tsx test/dump-templates.ts <dir>` at the approved commit); OGEVIA_CDK_DIR (infra/aws of that commit; default ../../../../infra/aws);
# OGEVIA_CDK_BIN (default: npx cdk). Exit: 0 ok; 1 refused/failed; 2 usage.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/common.sh"
MODE="${1:-}"
[[ $# -eq 1 && "$MODE" =~ ^(check|deploy|post|rollback-check)$ ]] || { echo "usage: bash a-deploy-prd.sh check|deploy|post|rollback-check" >&2; exit 2; }
need aws jq python3 timeout
STACKS=(Ogevia-prd-DatabaseSecret Ogevia-prd-EvidenceStorage Ogevia-prd-WebHosting Ogevia-prd-ServiceVerificationApi Ogevia-prd-Observability Ogevia-prod-NetworkEgress)
GATE="$HERE/auth_cutover_gate.py"; MARK="$AB/gate.ok"; PHRASE=DEPLOY-Ogevia-prd-Auth-and-Api
CDK_DIR="${OGEVIA_CDK_DIR:-$HERE/../../../../infra/aws}"; CDK="${OGEVIA_CDK_BIN:-npx cdk}"

capture_live() {   # $1 = absent (before the change) | present (rollback check). Saves every live template and the facts the post-checks compare with
  mkdir -p "$AB/live"; rm -f "$AB/live"/*.json
  for S in "${STACKS[@]}"; do
    local st; st=$(stack_json "$S" | jq -r '.Stacks[0].StackStatus // empty'); local tp; tp=$(stack_json "$S" | jq -r '.Stacks[0].EnableTerminationProtection // false')
    [[ "$st" == CREATE_COMPLETE || "$st" == UPDATE_COMPLETE ]] && ok "$S is $st" || { nope "$S is '${st:-unreadable}', not a settled status"; continue; }
    [[ "$tp" == true ]] && ok "$S has termination protection" || nope "$S has NO termination protection"
    A cloudformation get-template --stack-name "$S" --template-stage Original --output json 2>/dev/null | jq '.TemplateBody // .' > "$AB/live/$S.json" && jq -e 'has("Resources")' "$AB/live/$S.json" >/dev/null 2>&1 || nope "cannot read the live template of $S"
  done
  local have=no; [[ -n "$(stack_json "$AUTH_STACK" | jq -r '.Stacks[0].StackName // empty')" ]] && have=yes
  if [[ "${1:-absent}" == absent ]]; then [[ $have == no ]] && ok "$AUTH_STACK does not exist yet (it will be created)" || nope "$AUTH_STACK already exists"
  else [[ $have == yes ]] && { ok "$AUTH_STACK exists"; A cloudformation get-template --stack-name "$AUTH_STACK" --template-stage Original --output json 2>/dev/null | jq '.TemplateBody // .' > "$AB/live/$AUTH_STACK.json"; } || nope "$AUTH_STACK does not exist"; fi
  A cognito-idp list-user-pool-clients --user-pool-id "$SHARED_POOL" --max-results 20 --output json 2>/dev/null | jq -S '[.UserPoolClients[] | {ClientId, ClientName}] | sort_by(.ClientId)' > "$AB/shared-pool-clients-before.json" && ok "shared pool clients recorded: $(jq length "$AB/shared-pool-clients-before.json")" || nope "cannot list the shared pool's clients"
  local pilot_api; pilot_api=$(stack_out "$PILOT_API_STACK" ApiUrl | sed -E 's#^https://([a-z0-9]+)\..*#\1#')
  [[ -n "$pilot_api" ]] && A apigatewayv2 get-authorizers --api-id "$pilot_api" --output json 2>/dev/null | jq -S '[.Items[] | {Issuer: .JwtConfiguration.Issuer, Audience: (.JwtConfiguration.Audience | sort)}]' > "$AB/pilot-authorizer-before.json" && ok "pilot API authorizer recorded (it must not change)" || nope "cannot read the pilot API authorizer"
}

case "$MODE" in
check)
  say "== A check $(date -u +%FT%TZ) =="; check_account
  NEW="${OGEVIA_AUTH_NEW_TEMPLATES:-}"; [[ -d "$NEW" && -s "$NEW/$API_STACK.json" && -s "$NEW/$AUTH_STACK.json" ]] || stop "set OGEVIA_AUTH_NEW_TEMPLATES to the directory made by 'npx tsx test/dump-templates.ts <dir>' at the approved commit"
  capture_live
  [[ $bad == 0 ]] || stop "the live account is not in the state this package expects (see FAIL lines). Nothing was changed."
  if python3 -I -B "$GATE" --live-dir "$AB/live" --new-dir "$NEW" --shared-pool "$SHARED_POOL" | tee -a "$LOG"; then ok "expected-only gate"; else nope "expected-only gate"; fi
  [[ $bad == 0 ]] || stop "CHECK FAILED. Nothing was changed."
  sha256sum "$NEW/$API_STACK.json" "$NEW/$AUTH_STACK.json" | cut -d' ' -f1 | tr '\n' ' ' > "$MARK"; date +%s >> "$MARK"
  say "CHECK PASSED. Marker written: $MARK (valid 60 minutes). Nothing was changed." ;;
deploy)
  say "== A deploy $(date -u +%FT%TZ) =="; check_account
  [[ "${OGEVIA_DEPLOY_APPROVAL:-}" =~ $APPROVAL_RE ]] || stop "set OGEVIA_DEPLOY_APPROVAL to the owner's approval reference"
  [[ -s "$MARK" ]] || stop "run 'bash a-deploy-prd.sh check' first (no gate marker)"
  AGE=$(( $(date +%s) - $(awk '{print $3}' "$MARK") )); (( AGE >= 0 && AGE <= 3600 )) || stop "the gate marker is ${AGE}s old (limit 3600). Run check again."
  SNAP="${OGEVIA_PREDEPLOY_SNAPSHOT_ID:-}"; [[ "$SNAP" =~ ^[A-Za-z][A-Za-z0-9-]{5,200}$ ]] || stop "set OGEVIA_PREDEPLOY_SNAPSHOT_ID to a fresh snapshot of ogevia-prod-postgres"
  S=$(A rds describe-db-snapshots --db-snapshot-identifier "$SNAP" --output json 2>/dev/null | jq -c '.DBSnapshots[0] // empty'); [[ -n "$S" ]] || stop "snapshot $SNAP not found"
  [[ "$(jq -r .Status <<<"$S")" == available && "$(jq -r .DBInstanceIdentifier <<<"$S")" == ogevia-prod-postgres ]] || stop "snapshot $SNAP is not an available snapshot of ogevia-prod-postgres"
  SNAP_AGE=$(( $(date +%s) - $(date -u -d "$(jq -r .SnapshotCreateTime <<<"$S")" +%s) )); (( SNAP_AGE <= 86400 )) || stop "snapshot $SNAP is $((SNAP_AGE/3600)) hours old (limit 24)"
  ok "snapshot $SNAP is available and fresh"
  NEW="${OGEVIA_AUTH_NEW_TEMPLATES:-}"; capture_live; python3 -I -B "$GATE" --live-dir "$AB/live" --new-dir "$NEW" --shared-pool "$SHARED_POOL" | tee -a "$LOG" || nope "gate repeated"
  [[ $bad == 0 ]] || stop "the repeated check failed. Nothing was changed."
  ARGV=($CDK deploy -c env=prd -c mode=deploy --exclusively "$AUTH_STACK" "$API_STACK" --require-approval broadening --no-notices)
  for a in "${ARGV[@]}"; do case "$a" in --all|--force|--hotswap|--no-rollback|'*') stop "refused argument $a" ;; esac; done
  say ""; say "== PROPOSED (YELLOW: changes PRODUCTION): in $CDK_DIR run:"; say "   OGEVIA_DEPLOY_APPROVAL=$OGEVIA_DEPLOY_APPROVAL ${ARGV[*]}"
  say "   Creates $AUTH_STACK (user pool, domain, client, branding; the pool is RETAINED if the stack is ever deleted) and updates $API_STACK in place. No database change. The pilot is untouched."
  read -r -p "Type $PHRASE to deploy (anything else stops, nothing changed): " ANS || true
  [[ "${ANS:-}" == "$PHRASE" ]] || { say "Declined. Nothing was changed."; exit 0; }
  (cd "$CDK_DIR" && OGEVIA_DEPLOY_APPROVAL="$OGEVIA_DEPLOY_APPROVAL" "${ARGV[@]}") || stop "cdk deploy failed. CloudFormation rolls a failed update back by itself; run 'bash a-deploy-prd.sh post' and report the output."
  say "DEPLOYED. Now run: bash a-deploy-prd.sh post" ;;
post)
  say "== A post-checks $(date -u +%FT%TZ) =="; check_account
  for S in "$AUTH_STACK" "$API_STACK"; do st=$(stack_json "$S" | jq -r '.Stacks[0].StackStatus // empty'); [[ "$st" == CREATE_COMPLETE || "$st" == UPDATE_COMPLETE ]] && ok "$S is $st" || nope "$S is '${st:-unreadable}'"; done
  POOL=$(stack_out "$AUTH_STACK" UserPoolId); CLIENT=$(stack_out "$AUTH_STACK" AppClientId); DOMAIN=$(stack_out "$AUTH_STACK" ManagedLoginDomain)
  [[ "$POOL" =~ ^us-west-2_[A-Za-z0-9]+$ && "$POOL" != "$SHARED_POOL" ]] && ok "production has its own pool (not the shared pilot pool)" || nope "the production pool id is missing or equals the shared pool"
  [[ "$CLIENT" =~ ^[a-z0-9]{26}$ ]] && ok "production client exists" || nope "production client id missing"
  P=$(A cognito-idp describe-user-pool --user-pool-id "$POOL" --output json 2>/dev/null | jq -c '.UserPool // empty')
  [[ -n "$P" ]] || nope "cannot read the production pool"
  [[ "$(jq -r .MfaConfiguration <<<"$P")" == ON ]] && ok "MFA ON" || nope "MFA is not ON"
  [[ "$(jq -r .DeletionProtection <<<"$P")" == ACTIVE ]] && ok "deletion protection ACTIVE" || nope "deletion protection is not ACTIVE"
  [[ "$(jq -r .AdminCreateUserConfig.AllowAdminCreateUserOnly <<<"$P")" == true ]] && ok "self sign-up disabled (admin-create only)" || nope "self sign-up is NOT disabled"
  [[ "$(jq -r .UserPoolTier <<<"$P")" == ESSENTIALS ]] && ok "tier ESSENTIALS" || nope "unexpected tier $(jq -r .UserPoolTier <<<"$P")"
  CL=$(A cognito-idp list-user-pool-clients --user-pool-id "$POOL" --max-results 20 --output json 2>/dev/null | jq -c '.UserPoolClients')
  [[ "$(jq length <<<"$CL")" == 1 && "$(jq -r '.[0].ClientId' <<<"$CL")" == "$CLIENT" ]] && ok "the production pool has exactly one client" || nope "the production pool does not have exactly one client"
  WEB=$(stack_out "$WEB_STACK" WebOrigin)
  CD=$(A cognito-idp describe-user-pool-client --user-pool-id "$POOL" --client-id "$CLIENT" --output json 2>/dev/null | jq -c '.UserPoolClient')
  [[ "$(jq -c '.CallbackURLs' <<<"$CD")" == "[\"$WEB/auth/callback\"]" && "$(jq -c '.LogoutURLs' <<<"$CD")" == "[\"$WEB/\"]" ]] && ok "callback and logout return only to the production site" || nope "the client's callback/logout URLs are not exactly the production site"
  [[ "$(jq -r '.ClientSecret // "none"' <<<"$CD")" == none ]] && ok "public client (no secret)" || nope "the client has a secret"
  API=$(stack_out "$API_STACK" ApiUrl | sed -E 's#^https://([a-z0-9]+)\..*#\1#')
  AZ=$(A apigatewayv2 get-authorizers --api-id "$API" --output json 2>/dev/null | jq -c '[.Items[] | {i: .JwtConfiguration.Issuer, a: .JwtConfiguration.Audience}]')
  [[ "$AZ" == "[{\"i\":\"https://cognito-idp.us-west-2.amazonaws.com/$POOL\",\"a\":[\"$CLIENT\"]}]" ]] && ok "production API: issuer = production pool, audience = the one production client" || nope "production API authorizer is not exactly the production pool and client"
  FN=$(A cloudformation list-stack-resources --stack-name "$API_STACK" --output json 2>/dev/null | jq -r '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId | startswith("Handler")))][0].PhysicalResourceId // empty')
  E=$(A lambda get-function-configuration --function-name "$FN" --output json 2>/dev/null | jq -c '.Environment.Variables // {}')
  [[ "$(jq -r .COGNITO_USER_POOL_ID <<<"$E")" == "$POOL" && "$(jq -r .COGNITO_APP_CLIENT_ID <<<"$E")" == "$CLIENT" && "$(jq -r .OGEVIA_FORBIDDEN_POOL_IDS <<<"$E")" == "$SHARED_POOL" ]] && ok "API Lambda: production pool and client, shared pool forbidden" || nope "API Lambda settings are wrong"
  [[ "$(jq -r .OGEVIA_ENV <<<"$E")" == prd && "$(jq -r .DB_NAME <<<"$E")" == ogevia_prd ]] && ok "API Lambda still on ogevia_prd (OGEVIA_ENV=prd)" || nope "API Lambda environment/database changed"
  IE=$(A lambda get-function-configuration --function-name "$PRD_IDENTITY_FN" --output json 2>/dev/null | jq -c '.Environment.Variables // {}')
  [[ "$(jq -r .COGNITO_USER_POOL_ID <<<"$IE")" == "$POOL" && "$(jq -S 'keys' <<<"$IE" | tr -d ' \n')" == '["COGNITO_USER_POOL_ID"]' ]] && ok "production invitations: the identity function acts on the production pool only" || nope "the production identity function is not on the production pool"
  [[ "$(A cognito-idp list-user-pool-clients --user-pool-id "$SHARED_POOL" --max-results 20 --output json 2>/dev/null | jq -S '[.UserPoolClients[] | {ClientId, ClientName}] | sort_by(.ClientId)')" == "$(cat "$AB/shared-pool-clients-before.json" 2>/dev/null)" ]] && ok "the shared pool's clients are unchanged" || nope "the shared pool's clients changed (or the before-capture is missing)"
  PILOT_API=$(stack_out "$PILOT_API_STACK" ApiUrl | sed -E 's#^https://([a-z0-9]+)\..*#\1#')
  [[ "$(A apigatewayv2 get-authorizers --api-id "$PILOT_API" --output json 2>/dev/null | jq -S '[.Items[] | {Issuer: .JwtConfiguration.Issuer, Audience: (.JwtConfiguration.Audience | sort)}]')" == "$(cat "$AB/pilot-authorizer-before.json" 2>/dev/null)" ]] && ok "the pilot API authorizer is unchanged" || nope "the pilot API authorizer changed (or the before-capture is missing)"
  for U in "$(stack_out "$API_STACK" ApiUrl)" "$(stack_out "$PILOT_API_STACK" ApiUrl)"; do code=$("${OGEVIA_CURL:-curl}" -s -o /dev/null -w '%{http_code}' --max-time 30 "$U/v1/me"); [[ "$code" == 401 ]] && ok "anonymous GET /v1/me on $(sed -E 's#https://([a-z0-9]+)\..*#\1#' <<<"$U") returns 401" || nope "anonymous GET /v1/me on $U returned $code"; done
  [[ $bad == 0 ]] && say "POST-CHECKS PASSED. Next: b-admin-prd.sh, then c-web-prd.sh." || { say "POST-CHECKS FAILED: see FAIL lines; do not continue. Rollback: e-rollback-prd.sh."; exit 1; } ;;
rollback-check)
  say "== A rollback-check $(date -u +%FT%TZ) =="; check_account
  PREV="${OGEVIA_AUTH_PREVIOUS_TEMPLATES:-}"; [[ -d "$PREV" && -s "$PREV/$API_STACK.json" ]] || stop "set OGEVIA_AUTH_PREVIOUS_TEMPLATES to templates synthesized from the PREVIOUS commit"
  capture_live present
  python3 -I -B "$GATE" --reverse --live-dir "$AB/live" --new-dir "$PREV" --shared-pool "$SHARED_POOL" | tee -a "$LOG" && ok "reverse gate" || nope "reverse gate"
  [[ $bad == 0 ]] || { say "ROLLBACK CHECK FAILED."; exit 1; }
  date +%s > "$AB/rollback-gate.ok"; say "ROLLBACK CHECK PASSED: the previous commit restores exactly the pre-change state. Marker written (valid 60 minutes)." ;;
esac
