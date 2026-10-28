#!/usr/bin/env bash
# READ-ONLY verification and DEPLOYED RECORD for the production release 2026-10-26-redesign. Run after apply-0086-prd.sh, deploy-guard-prd.sh deploy+post (Auth, then API) and web-prd.sh publish (web).
#   OGEVIA_DEPLOY_APPROVAL=<ref> OGEVIA_EXPECT_COMMIT=<40 hex code commit> OGEVIA_TARBALL_SHA256=<64 hex of the operator tarball> bash record-deployed-prd.sh
# Checks: the 85|0085|0086|0087 marker and the API post-check marker exist; the live Handler asset is the release's pinned build and the Lambda code changed; all six stacks settled; the ComplianceSweep rule is ENABLED
# and the Handler's log group (read from the function's LoggingConfig.LogGroup) holds no ERROR event in the last 30 minutes; the served web is the release build (web-prd.sh verify). Writes $B/DEPLOYED_RECORD.txt and $B/release-record.state.
# STATUS WORDS (never interchangeable): DEPLOYED - RECORD COMPLETE (exit 0: every artifact maps to the commit); DEPLOYED - RECORD INCOMPLETE (exit 3: the pinned Handler build is live but a record check failed; nothing is redeployed,
# the script is read-only and is simply re-run once the cause is understood); NOT DEPLOYED OR NOT PROVABLE (exit 1: the pinned build is not live). Once the state is written, deploy-guard-prd.sh deploy, apply-0086-prd.sh apply and web-prd.sh publish refuse to run.
# AWS verbs: sts, cloudformation describe-stacks/get-template/list-stack-resources, lambda get-function-configuration, events describe-rule, logs filter-log-events. Exit 0 = every artifact maps to the commit.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need aws jq curl sha256sum timeout; check_account
SITE=$(cat "$B/web-url-before.txt" 2>/dev/null); API_URL=$(cat "$B/api-url-before.txt" 2>/dev/null)
CODE_COMMIT="${OGEVIA_EXPECT_COMMIT:-}"; API=Ogevia-prd-ServiceVerificationApi; RELEASE_KEY=94b73574c5a681d5a8c22b4264742f64e5a6d40aa1ace783be12e7383b9d8a9e.zip
[[ "$CODE_COMMIT" =~ ^[0-9a-f]{40}$ && "$(jq -r .code_commit "$TB_ROOT/BUILD_INFO.json" 2>/dev/null)" == "$CODE_COMMIT" && "${OGEVIA_TARBALL_SHA256:-}" =~ ^[0-9a-f]{64}$ && "${OGEVIA_DEPLOY_APPROVAL:-}" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || { echo "usage: set OGEVIA_EXPECT_COMMIT (the 40-hex code commit named in BUILD_INFO.json), OGEVIA_TARBALL_SHA256 (64 hex) and OGEVIA_DEPLOY_APPROVAL" >&2; exit 2; }
[[ "$(cat "$B/db-0086.ok" 2>/dev/null)" == "85|0085|0086|0087" ]] && ok "the migration marker says 85|0085|0086|0087 (snapshot $(cat "$B/db-0086.snapshot" 2>/dev/null))" || nope "no 85|0085|0086|0087 marker"
[[ -s "$B/api-at-release.ok" ]] && ok "the API post-check marker exists" || nope "no API post-check marker"
FN=$(cat "$B/handler-function-name.txt" 2>/dev/null); CFG=$(A lambda get-function-configuration --function-name "$FN" --output json 2>/dev/null) || { nope "cannot read the Lambda configuration"; CFG='{}'; }
B64=$(jq -r '.CodeSha256 // empty' <<<"$CFG"); OLD=$(jq -r '.CodeSha256 // empty' "$B/lambda-config-before.json" 2>/dev/null); HEX=$(printf '%s' "$B64" | base64 -d 2>/dev/null | od -An -tx1 | tr -d ' \n')
[[ -n "$B64" && "$B64" != "$OLD" ]] && ok "Lambda CodeSha256 $B64 (before: ${OLD:-unknown})" || nope "the Lambda CodeSha256 is empty or equals the one before the release"
[[ "$(jq -r '.Environment.Variables.DB_NAME + "|" + .Environment.Variables.OGEVIA_ENV' <<<"$CFG")" == "ogevia_prd|prd" && "$(jq -r .LastUpdateStatus <<<"$CFG")" == Successful ]] && ok "the Lambda serves ogevia_prd (OGEVIA_ENV=prd), LastUpdateStatus Successful" || nope "the Lambda's database/environment or update status is wrong"
TPL=$(A cloudformation get-template --stack-name "$API" --template-stage Original --output json 2>/dev/null | jq '.TemplateBody // .') || TPL='{}'
KEY=$(jq -r '[.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key|startswith("Handler"))) | .value.Properties.Code.S3Key][0] // empty' <<<"$TPL")
[[ "$KEY" == "$RELEASE_KEY" ]] && ok "the DEPLOYED stack's Handler asset is the release's pinned build $KEY" || nope "the deployed Handler asset is '$KEY', not $RELEASE_KEY"
ST=""; for s in Ogevia-prd-Auth Ogevia-prd-DatabaseSecret Ogevia-prd-EvidenceStorage Ogevia-prd-WebHosting Ogevia-prd-ServiceVerificationApi Ogevia-prd-Observability Ogevia-prod-NetworkEgress; do
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
WV=$(bash "$PKG_ROOT/scripts/web-prd.sh" verify 2>&1); [[ $? == 0 ]] && ok "the served web is the release build (web-prd.sh verify)" || { nope "web verification failed"; echo "$WV" | tail -5; }
if [[ $bad == 0 ]]; then STATUS="DEPLOYED - RECORD COMPLETE"; RC=0
elif [[ "$KEY" == "$RELEASE_KEY" ]]; then STATUS="DEPLOYED - RECORD INCOMPLETE"; RC=3
else STATUS="NOT DEPLOYED OR NOT PROVABLE"; RC=1; fi
{
  echo "STATUS                : $STATUS"
  echo "DEPLOYED SHA          : $OGEVIA_EXPECT_COMMIT"; echo "approval reference    : $OGEVIA_DEPLOY_APPROVAL"; echo "recorded (UTC)        : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "package tarball sha256: $OGEVIA_TARBALL_SHA256"; echo "package BUILD_INFO    : $(jq -c . "$TB_ROOT/BUILD_INFO.json")"
  echo "pre-release snapshot  : $(cat "$B/db-0086.snapshot" 2>/dev/null)"; echo "migration marker      : $(cat "$B/db-0086.ok" 2>/dev/null) (0086 applied outside the ledger; the ledger reads 85 / 0085)"
  echo "production web URL    : $SITE"; echo "production API URL    : $API_URL"; echo "Lambda function       : $FN"
  echo "Lambda CodeSha256 (b64): $B64"; echo "Lambda CodeSha256 (hex): $HEX"; echo "Lambda LastModified   : $(jq -r .LastModified <<<"$CFG")"; echo "Handler asset in stack: $KEY"
  echo "stacks:"; printf '%s' "$ST" | sed 's/^/  /'
  echo "unchanged and not re-verified here: any production part this release did not touch keeps the commit mapping given in the production as-found baseline (unknown mappings stay NOT VERIFIED)"
} > "$B/DEPLOYED_RECORD.txt"; cat "$B/DEPLOYED_RECORD.txt" | tee -a "$LOG" >/dev/null; cat "$B/DEPLOYED_RECORD.txt"
case "$RC" in
  0) printf 'DEPLOYED-RECORD-COMPLETE %s %s\n' "$OGEVIA_EXPECT_COMMIT" "$(date -u +%FT%TZ)" > "$B/release-record.state"
     say "DEPLOYED - RECORD COMPLETE: every deployed artifact maps to $OGEVIA_EXPECT_COMMIT ($B/DEPLOYED_RECORD.txt). Next: the development session commits the record to the repository; until then the release is not closed."; exit 0 ;;
  3) printf 'DEPLOYED-RECORD-INCOMPLETE %s %s\n' "$OGEVIA_EXPECT_COMMIT" "$(date -u +%FT%TZ)" > "$B/release-record.state"
     say "DEPLOYED - RECORD INCOMPLETE: the release build is live but a record check failed (see FAIL lines). Do NOT run any deploy, apply or publish step again: they now refuse. Fix the cause, re-run this read-only script, and report the status as incomplete until it exits 0."; exit 3 ;;
  *) say "STOP: NOT DEPLOYED OR NOT PROVABLE: the pinned Handler build is not what the stack holds, so no deployed state was recorded."; exit 1 ;;
esac
