#!/usr/bin/env bash
# E1: READ-ONLY verification and DEPLOYED RECORD for the production release. Run after d1 (migration), deploy-guard-prd.sh deploy+post (API) and d3-web-prd.sh publish (web).
#   OGEVIA_DEPLOY_APPROVAL=<ref> OGEVIA_EXPECT_COMMIT=<40 hex code commit> OGEVIA_TARBALL_SHA256=<64 hex of ogevia-prd-release.tar.gz> bash e1-record-deployed-prd.sh
# Checks: the 85|0085 marker and the API post-check marker exist; the live Handler asset is the release's pinned build and the Lambda code changed; all six stacks settled; the ComplianceSweep rule is ENABLED
# and the Handler's log group (read from the function's LoggingConfig.LogGroup) holds no ERROR event in the last 30 minutes; the served web is the release build (d3 verify). Writes $B/DEPLOYED_RECORD.txt.
# AWS verbs: sts, cloudformation describe-stacks/get-template/list-stack-resources, lambda get-function-configuration, events describe-rule, logs filter-log-events. Exit 0 = every artifact maps to the commit.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need aws jq curl sha256sum timeout; check_account
SITE=$(cat "$B/web-url-before.txt" 2>/dev/null); API_URL=$(cat "$B/api-url-before.txt" 2>/dev/null)
CODE_COMMIT=e80b770210c54e423d28ecf48e00f1dda9506cec; API=Ogevia-prd-ServiceVerificationApi
[[ "${OGEVIA_EXPECT_COMMIT:-}" == "$CODE_COMMIT" && "${OGEVIA_TARBALL_SHA256:-}" =~ ^[0-9a-f]{64}$ && "${OGEVIA_DEPLOY_APPROVAL:-}" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || { echo "usage: set OGEVIA_EXPECT_COMMIT ($CODE_COMMIT), OGEVIA_TARBALL_SHA256 (64 hex) and OGEVIA_DEPLOY_APPROVAL" >&2; exit 2; }
RELEASE_KEY=$(jq -r .release_handler_asset "$PKG_ROOT/BUILD_INFO.json"); [[ "$RELEASE_KEY" =~ ^[0-9a-f]{64}\.zip$ ]] || stop "BUILD_INFO has no release handler asset"
[[ "$(cat "$B/db-at-0085.ok" 2>/dev/null)" == "85|0085" ]] && ok "the migration marker says 85|0085 (snapshot $(cat "$B/db-at-0085.snapshot" 2>/dev/null))" || nope "no 85|0085 marker"
[[ -s "$B/api-at-release.ok" ]] && ok "the API post-check marker exists" || nope "no API post-check marker"
FN=$(cat "$B/handler-function-name.txt" 2>/dev/null); CFG=$(A lambda get-function-configuration --function-name "$FN" --output json 2>/dev/null) || { nope "cannot read the Lambda configuration"; CFG='{}'; }
B64=$(jq -r '.CodeSha256 // empty' <<<"$CFG"); OLD=$(jq -r '.CodeSha256 // empty' "$B/lambda-config-before.json" 2>/dev/null); HEX=$(printf '%s' "$B64" | base64 -d 2>/dev/null | od -An -tx1 | tr -d ' \n')
[[ -n "$B64" && "$B64" != "$OLD" ]] && ok "Lambda CodeSha256 $B64 (before: ${OLD:-unknown})" || nope "the Lambda CodeSha256 is empty or equals the one before the release"
[[ "$(jq -r '.Environment.Variables.DB_NAME + "|" + .Environment.Variables.OGEVIA_ENV' <<<"$CFG")" == "ogevia_prd|prd" && "$(jq -r .LastUpdateStatus <<<"$CFG")" == Successful ]] && ok "the Lambda serves ogevia_prd (OGEVIA_ENV=prd), LastUpdateStatus Successful" || nope "the Lambda's database/environment or update status is wrong"
TPL=$(A cloudformation get-template --stack-name "$API" --template-stage Original --output json 2>/dev/null | jq '.TemplateBody // .') || TPL='{}'
KEY=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key|startswith("Handler"))) | .value.Properties.Code.S3Key][0] // empty' <<<"$TPL")
[[ "$KEY" == "$RELEASE_KEY" ]] && ok "the DEPLOYED stack's Handler asset is the release's pinned build $KEY" || nope "the deployed Handler asset is '$KEY', not $RELEASE_KEY"
ST=""; for s in Ogevia-prd-DatabaseSecret Ogevia-prd-EvidenceStorage Ogevia-prd-WebHosting Ogevia-prd-ServiceVerificationApi Ogevia-prd-Observability Ogevia-prod-NetworkEgress; do
  x=$(A cloudformation describe-stacks --stack-name "$s" --output json 2>/dev/null | jq -r '.Stacks[0].StackStatus // "unreadable"'); ST+="$s $x"$'\n'; [[ "$x" == CREATE_COMPLETE || "$x" == UPDATE_COMPLETE ]] || nope "$s is $x"
done
RULE=$(A cloudformation list-stack-resources --stack-name "$API" --output json 2>/dev/null | jq -r '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Events::Rule")][0].PhysicalResourceId // empty')
[[ -n "$RULE" && "$(A events describe-rule --name "$RULE" --output json 2>/dev/null | jq -r .State)" == ENABLED ]] && ok "the ComplianceSweep rule $RULE is ENABLED" || nope "no ENABLED ComplianceSweep rule"
LG=$(jq -r '.LoggingConfig.LogGroup // empty' <<<"$CFG")
if [[ -n "$LG" ]]; then
  SINCE=$(( ($(date -u +%s) - ${OGEVIA_SWEEP_LOOKBACK:-1800}) * 1000 ))
  EV=$(A logs filter-log-events --log-group-name "$LG" --start-time "$SINCE" --filter-pattern ERROR --output json 2>/dev/null) && NERR=$(jq '.events | length' <<<"$EV") || NERR=""
  [[ "$NERR" == 0 ]] && ok "no ERROR event in the last $(( ${OGEVIA_SWEEP_LOOKBACK:-1800} / 60 )) minutes in $LG (the sweep runs every 15 minutes)" || nope "ERROR events in $LG: '${NERR:-unreadable}' (message text not printed here: read the log group)"
else nope "the Lambda has no LoggingConfig.LogGroup"; fi
WV=$(bash "$PKG_ROOT/scripts/d3-web-prd.sh" verify 2>&1); [[ $? == 0 ]] && ok "the served web is the release build (d3 verify)" || { nope "web verification failed"; echo "$WV" | tail -5; }
{
  echo "DEPLOYED SHA          : $OGEVIA_EXPECT_COMMIT"; echo "approval reference    : $OGEVIA_DEPLOY_APPROVAL"; echo "recorded (UTC)        : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "package tarball sha256: $OGEVIA_TARBALL_SHA256"; echo "package BUILD_INFO    : $(jq -c . "$PKG_ROOT/BUILD_INFO.json")"
  echo "pre-release snapshot  : $(cat "$B/db-at-0085.snapshot" 2>/dev/null)"; echo "ledger marker         : $(cat "$B/db-at-0085.ok" 2>/dev/null)"
  echo "production web URL    : $SITE"; echo "production API URL    : $API_URL"; echo "Lambda function       : $FN"
  echo "Lambda CodeSha256 (b64): $B64"; echo "Lambda CodeSha256 (hex): $HEX"; echo "Lambda LastModified   : $(jq -r .LastModified <<<"$CFG")"; echo "Handler asset in stack: $KEY"
  echo "stacks:"; printf '%s' "$ST" | sed 's/^/  /'
} > "$B/DEPLOYED_RECORD.txt"; cat "$B/DEPLOYED_RECORD.txt" | tee -a "$LOG" >/dev/null; cat "$B/DEPLOYED_RECORD.txt"
[[ $bad == 0 ]] && { say "RECORDED: every deployed artifact maps to $OGEVIA_EXPECT_COMMIT ($B/DEPLOYED_RECORD.txt)"; exit 0; } || { say "STOP: an artifact does not map to the approved commit."; exit 1; }
