#!/usr/bin/env bash
# G: FOLLOW-UP fix, found after the authentication separation was deployed (2026-10-22). The website's CloudFront security header (Content-Security-Policy connect-src) still
# listed only the SHARED pilot sign-in domain, so the browser blocked the sign-in code exchange: "Could not reach the sign-in service". This changes ONE value in ONE stack
# (Ogevia-prd-WebHosting): the policy now allows production's own sign-in domain INSTEAD of the shared one. Nothing else is redeployed.
#   bash g-web-headers-prd.sh check     READ-ONLY: the live templates of all seven stacks vs the packaged templates; passes only if the sole difference is that header value
#   OGEVIA_DEPLOY_APPROVAL=<ref> OGEVIA_PREDEPLOY_SNAPSHOT_ID=<id> bash g-web-headers-prd.sh deploy     YELLOW: re-runs the gate, runs exactly
#       cdk deploy -c env=prd -c mode=deploy --exclusively Ogevia-prd-WebHosting ...   after the typed phrase DEPLOY-Ogevia-prd-WebHosting-Headers
#   bash g-web-headers-prd.sh post      READ-ONLY: the live policy and the served page's response header allow the dedicated domain and not the shared one
# Environment: OGEVIA_AUTH_NEW_TEMPLATES (default: <package>/templates/new), OGEVIA_CDK_DIR (default: <package>/new/infra/aws). Exit: 0 ok; 1 refused/failed; 2 usage.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/common.sh"
MODE="${1:-}"
[[ $# -eq 1 && "$MODE" =~ ^(check|deploy|post)$ ]] || { echo "usage: bash g-web-headers-prd.sh check|deploy|post" >&2; exit 2; }
need aws jq python3 timeout curl
STACKS=(Ogevia-prd-DatabaseSecret Ogevia-prd-EvidenceStorage Ogevia-prd-WebHosting Ogevia-prd-ServiceVerificationApi Ogevia-prd-Observability Ogevia-prod-NetworkEgress Ogevia-prd-Auth)
GATE="$HERE/web_headers_gate.py"; MARK="$AB/web-headers-gate.ok"; PHRASE=DEPLOY-Ogevia-prd-WebHosting-Headers
PKG_TEMPLATES="$HERE/../../../../../templates"
NEW="${OGEVIA_AUTH_NEW_TEMPLATES:-$PKG_TEMPLATES/new}"
CDK_DIR="${OGEVIA_CDK_DIR:-$HERE/../../../../infra/aws}"; CDK="${OGEVIA_CDK_BIN:-npx cdk}"
CURL="${OGEVIA_CURL:-curl}"

capture_live() {
  rm -rf "$AB/live-web" && mkdir -p "$AB/live-web" && chmod 700 "$AB/live-web"
  for S in "${STACKS[@]}"; do
    local st; st=$(stack_json "$S" | jq -r '.Stacks[0].StackStatus // empty')
    [[ "$st" == CREATE_COMPLETE || "$st" == UPDATE_COMPLETE ]] && ok "$S is $st" || nope "$S is '${st:-missing}' (expected CREATE_COMPLETE or UPDATE_COMPLETE)"
    A cloudformation get-template --stack-name "$S" --template-stage Original --output json 2>/dev/null | jq '.TemplateBody // .' > "$AB/live-web/$S.json" || nope "cannot read the template of $S"
    [[ -s "$AB/live-web/$S.json" ]] || nope "empty template for $S"
  done
}
run_gate() { python3 -I -B "$GATE" --live-dir "$AB/live-web" --new-dir "$NEW" --shared-pool "$SHARED_POOL" | tee -a "$LOG"; }
auth_domain() { stack_out "$AUTH_STACK" ManagedLoginDomain; }

live_policy_csp() {   # the live policy's CSP, via the distribution (READ-ONLY)
  local dist pol; dist=$(stack_out "$WEB_STACK" DistributionId); [[ -n "$dist" ]] || return 1
  pol=$(A cloudfront get-distribution-config --id "$dist" --query 'DistributionConfig.DefaultCacheBehavior.ResponseHeadersPolicyId' --output text 2>/dev/null) || return 1
  [[ -n "$pol" && "$pol" != None ]] || return 1
  A cloudfront get-response-headers-policy --id "$pol" --query 'ResponseHeadersPolicy.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy' --output text 2>/dev/null
}
csp_allows() {   # $1 = csp text, $2 = domain: connect-src and form-action list the domain; the shared domain is gone
  local shared="https://$(tr -d '_' <<<"$SHARED_POOL" | tr 'A-Z' 'a-z').auth.us-west-2.amazoncognito.com" c f
  c=$(tr ';' '\n' <<<"$1" | grep -E '^ *connect-src' | head -1); f=$(tr ';' '\n' <<<"$1" | grep -E '^ *form-action' | head -1)
  [[ "$c" == *"$2"* && "$f" == *"$2"* && "$c" != *"$shared"* && "$f" != *"$shared"* ]]
}

case "$MODE" in
check)
  say "== G check $(date -u +%FT%TZ) =="; check_account
  [[ -d "$NEW" && -s "$NEW/$WEB_STACK.json" && -s "$NEW/$AUTH_STACK.json" ]] || stop "the packaged templates were not found ($NEW). Set OGEVIA_AUTH_NEW_TEMPLATES."
  capture_live
  [[ $bad == 0 ]] || stop "the live account is not in the state this package expects (see FAIL lines). Nothing was changed."
  if run_gate; then ok "expected-only gate"; else nope "expected-only gate"; fi
  [[ $bad == 0 ]] || stop "CHECK FAILED. Nothing was changed."
  sha256sum "$NEW/$WEB_STACK.json" | cut -d' ' -f1 | tr '\n' ' ' > "$MARK"; date +%s >> "$MARK"
  say "CHECK PASSED. Marker written: $MARK (valid 60 minutes). Nothing was changed." ;;
deploy)
  say "== G deploy $(date -u +%FT%TZ) =="; check_account
  [[ "${OGEVIA_DEPLOY_APPROVAL:-}" =~ $APPROVAL_RE ]] || stop "set OGEVIA_DEPLOY_APPROVAL to the owner's approval reference for THIS change"
  [[ -s "$MARK" ]] || stop "run 'bash g-web-headers-prd.sh check' first (no gate marker)"
  AGE=$(( $(date +%s) - $(awk '{print $2}' "$MARK") )); (( AGE >= 0 && AGE <= 3600 )) || stop "the gate marker is ${AGE}s old (limit 3600). Run check again."
  SNAP="${OGEVIA_PREDEPLOY_SNAPSHOT_ID:-}"; [[ "$SNAP" =~ ^[A-Za-z][A-Za-z0-9-]{5,200}$ ]] || stop "set OGEVIA_PREDEPLOY_SNAPSHOT_ID to an available snapshot of ogevia-prod-postgres (the one from the authentication release is fine)"
  S=$(A rds describe-db-snapshots --db-snapshot-identifier "$SNAP" --output json 2>/dev/null | jq -c '.DBSnapshots[0] // empty'); [[ -n "$S" ]] || stop "snapshot $SNAP not found"
  [[ "$(jq -r .Status <<<"$S")" == available && "$(jq -r .DBInstanceIdentifier <<<"$S")" == ogevia-prod-postgres ]] || stop "snapshot $SNAP is not an available snapshot of ogevia-prod-postgres"
  ok "snapshot $SNAP is available (this change touches no data; it is only a recovery anchor)"
  capture_live; run_gate || nope "gate repeated"
  [[ $bad == 0 ]] || stop "the repeated check failed. Nothing was changed."
  ARGV=($CDK deploy -c env=prd -c mode=deploy --exclusively "$WEB_STACK" --require-approval broadening --no-notices)
  for a in "${ARGV[@]}"; do case "$a" in --all|--force|--hotswap|--no-rollback|'*') stop "refused argument $a" ;; esac; done
  say ""; say "== PROPOSED (YELLOW: changes PRODUCTION): in $CDK_DIR run:"; say "   OGEVIA_DEPLOY_APPROVAL=$OGEVIA_DEPLOY_APPROVAL ${ARGV[*]}"
  say "   Updates ONE CloudFront response-headers policy in place (no replacement): connect-src and form-action allow $(auth_domain) instead of the shared pilot domain. No data, user, pool or API change."
  read -r -p "Type $PHRASE to deploy (anything else stops, nothing changed): " ANS || true
  [[ "${ANS:-}" == "$PHRASE" ]] || { say "Declined. Nothing was changed."; exit 0; }
  (cd "$CDK_DIR" && OGEVIA_DEPLOY_APPROVAL="$OGEVIA_DEPLOY_APPROVAL" "${ARGV[@]}") || stop "cdk deploy failed. CloudFormation rolls a failed update back by itself; run 'bash g-web-headers-prd.sh post' and report the output."
  say "DEPLOYED. CloudFront needs a few minutes to apply a header policy change. Now run: bash g-web-headers-prd.sh post" ;;
post)
  say "== G post-checks $(date -u +%FT%TZ) =="; check_account
  st=$(stack_json "$WEB_STACK" | jq -r '.Stacks[0].StackStatus // empty'); [[ "$st" == UPDATE_COMPLETE ]] && ok "$WEB_STACK is $st" || nope "$WEB_STACK is '${st:-missing}'"
  DOMAIN=$(auth_domain); [[ "$DOMAIN" =~ ^https://[a-z0-9-]+\.auth\.us-west-2\.amazoncognito\.com$ ]] || stop "cannot read the production sign-in domain from $AUTH_STACK"
  CSP=$(live_policy_csp) || stop "cannot read the live response-headers policy"
  csp_allows "$CSP" "$DOMAIN" && ok "the live policy allows the production sign-in domain (connect-src and form-action) and no longer the shared pilot domain" || nope "the live policy does not allow $DOMAIN, or still allows the shared domain"
  SITE=$(stack_out "$WEB_STACK" WebOrigin); served=""
  for i in $(seq 1 "${OGEVIA_HEADER_WAIT_TRIES:-10}"); do
    served=$("$CURL" -fsS --max-time 30 -D - -o /dev/null "$SITE/" 2>/dev/null | tr -d '\r' | grep -i '^content-security-policy:' | head -1 | cut -d: -f2-)
    [[ -n "$served" ]] && csp_allows "$served" "$DOMAIN" && break
    [[ $i -lt ${OGEVIA_HEADER_WAIT_TRIES:-10} ]] && { say "   the served header does not allow the domain yet (CloudFront is still applying it); waiting..."; sleep "${OGEVIA_HEADER_WAIT:-30}"; }
  done
  [[ -n "$served" ]] && csp_allows "$served" "$DOMAIN" && ok "the SERVED page carries a Content-Security-Policy that allows the production sign-in domain" || nope "the served Content-Security-Policy does not (yet) allow $DOMAIN"
  [[ $bad == 0 ]] && say "POST-CHECKS PASSED. Now test a real sign-in (private window)." || { say "POST-CHECKS FAILED."; exit 1; } ;;
esac
