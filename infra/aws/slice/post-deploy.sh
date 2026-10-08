#!/usr/bin/env bash
# =============================================================================
# Ogevia post-deploy steps, after `deploy-production.sh all` has succeeded.
# STATUS: PREPARED FOR REVIEW. NOT RUN. YELLOW actions (CLAUDE.md s.13): mode
# `cognito` changes one Cognito app client; mode `restore-test` creates, then
# deletes, one temporary RDS instance. Run from AWS CloudShell (us-west-2,
# AdministratorAccess), only with the owner's approval references.
#
#   bash post-deploy.sh plan            # read-only: preconditions and the exact change
#   OGEVIA_COGNITO_APPROVAL=<reference> bash post-deploy.sh cognito
#   OGEVIA_RESTORE_TEST_APPROVAL=<reference> bash post-deploy.sh restore-test
#   bash post-deploy.sh restore-test resume      # after an interruption
#
# cognito (GO_LIVE_RUNBOOK.md section 5), pool us-west-2_849AYz5J7, client ogevia-web:
#   callback URL    -> https://app.ogevia.com/auth/callback   (the old callback URL is REPLACED)
#   logout URL      -> https://app.ogevia.com/
#   auth flows      -> ALLOW_REFRESH_TOKEN_AUTH, ALLOW_USER_SRP_AUTH (removes ALLOW_USER_AUTH)
#   refresh token   -> 12 hours
# Every other field is sent back unchanged (update-user-pool-client resets any field
# not passed). Before changing anything it saves the full current client and writes a
# rollback input file; after changing it re-reads the client and compares every field.
# It refuses to run if: the client is not exactly ogevia-web with the recorded id, it
# has a secret, the production API does not exist or its JWT authorizer does not
# accept this client, pool MFA is not ON, or the client has unexpected auth flows.
# No secret is read or printed.
#
# restore-test: runs prd-restore-test.sh from the same folder (see PRD_RESTORE_TEST.md).
# =============================================================================
set -uo pipefail
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""
HERE="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:-}"
case "$MODE" in plan|cognito|restore-test) ;; *) echo "usage: bash post-deploy.sh plan | cognito | restore-test [resume]"; exit 2 ;; esac

ACCOUNT=300094796789
POOL=us-west-2_849AYz5J7
CLIENT_NAME=ogevia-web
EXPECT_CLIENT_ID=1i27abbina08fvg1i9u8vprgo9     # recorded 2026-10-01; verified live below
TARGET_CALLBACK=https://app.ogevia.com/auth/callback
TARGET_LOGOUT=https://app.ogevia.com/
TARGET_FLOWS='["ALLOW_REFRESH_TOKEN_AUTH","ALLOW_USER_SRP_AUTH"]'
TARGET_REFRESH_HOURS=12
API_STACK=Ogevia-prd-ServiceVerificationApi
OUT="$HOME/ogevia-phase7"; mkdir -p "$OUT"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOG="$OUT/post-deploy-$MODE-$STAMP.log"
exec 3>&1
exec > >(tee -a "$LOG") 2>&1
trap '' PIPE
STEP=start; STOPPED=""; DONE=""
say() { { printf '%s\n' "$*" >&3; } 2>/dev/null; printf '%s\n' "$*" >> "$LOG"; }
step() { STEP="$1"; echo; echo "== $1"; }
stop() { STOPPED=1; say "STOP in \"$STEP\": $*"; say "Log: $LOG"; exit 1; }
on_exit() { local rc=$?; [[ -z "$DONE" && -z "$STOPPED" ]] && say "EXITED UNEXPECTEDLY in \"$STEP\" (exit $rc). Log: $LOG"; }
trap on_exit EXIT

if [[ "$MODE" == restore-test ]]; then
  step "restore-test"
  [[ -f "$HERE/prd-restore-test.sh" ]] || stop "prd-restore-test.sh is not in $HERE; upload it next to this script"
  DONE=1
  bash "$HERE/prd-restore-test.sh" "${2:-run}"
  exit $?
fi

for t in aws jq; do command -v "$t" >/dev/null || stop "missing tool: $t"; done
NORM='walk(if type == "array" then sort else . end)'

# ---------------------------------------------------------------- step 1 ----
step "1 Identity and preconditions (read-only)"
ARN=$(aws sts get-caller-identity --query Arn --output text 2>/dev/null) || stop "AWS credentials are not valid: sign in again and reopen CloudShell (us-west-2)"
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT" && "$ARN" == *AdministratorAccess* ]] || stop "needs account $ACCOUNT with AdministratorAccess (current: $ARN)"

MFA=$(aws cognito-idp describe-user-pool --user-pool-id "$POOL" --query 'UserPool.MfaConfiguration' --output text) || stop "cannot read pool $POOL"
[[ "$MFA" == ON ]] || stop "pool MFA is '$MFA' (required: ON). This script does not change it"
echo "PASS pool $POOL: MFA ON"

STACK_ST=$(aws cloudformation describe-stacks --stack-name "$API_STACK" --query 'Stacks[0].StackStatus' --output text 2>/dev/null) || stop "stack $API_STACK does not exist: run deploy-production.sh all first"
[[ "$STACK_ST" == CREATE_COMPLETE || "$STACK_ST" == UPDATE_COMPLETE ]] || stop "stack $API_STACK is $STACK_ST"
API_ID=$(aws cloudformation list-stack-resources --stack-name "$API_STACK" --query "StackResourceSummaries[?ResourceType=='AWS::ApiGatewayV2::Api'].PhysicalResourceId | [0]" --output text)
[[ -n "$API_ID" && "$API_ID" != None ]] || stop "no HTTP API found in $API_STACK"
API_URL=$(aws cloudformation describe-stacks --stack-name "$API_STACK" --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue | [0]" --output text)
echo "PASS production API $API_STACK is $STACK_ST (ApiUrl $API_URL)"

CLIENT_IDS=$(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL" --max-results 60 --query "UserPoolClients[?ClientName=='$CLIENT_NAME'].ClientId" --output text)
[[ "$(wc -w <<<"$CLIENT_IDS")" == 1 ]] || stop "expected exactly one client named $CLIENT_NAME in $POOL, found: ${CLIENT_IDS:-none}"
CLIENT_ID=$CLIENT_IDS
[[ "$CLIENT_ID" == "$EXPECT_CLIENT_ID" ]] || stop "client $CLIENT_NAME has id $CLIENT_ID, not the recorded $EXPECT_CLIENT_ID. The Netlify variable VITE_COGNITO_CLIENT_ID must use the live id: tell Claude"
AUD=$(aws apigatewayv2 get-authorizers --api-id "$API_ID" --query 'Items[].JwtConfiguration.Audience[]' --output text)
grep -qw "$CLIENT_ID" <<<"$AUD" || stop "the production API's JWT authorizer does not accept client $CLIENT_ID (accepts: ${AUD:-none}); sign-in would fail"
echo "PASS client $CLIENT_NAME ($CLIENT_ID) exists once and the production API accepts its tokens"

# ---------------------------------------------------------------- step 2 ----
step "2 Current client and the exact change (read-only)"
BEFORE_FILE="$OUT/cognito-before-$STAMP.json"
aws cognito-idp describe-user-pool-client --user-pool-id "$POOL" --client-id "$CLIENT_ID" --output json > "$BEFORE_FILE" || stop "cannot read the client"
chmod 600 "$BEFORE_FILE"
[[ "$(jq -r '.UserPoolClient.ClientSecret // empty' "$BEFORE_FILE")" == "" ]] || { rm -f "$BEFORE_FILE"; stop "the client has a secret; this script is for the public web client only"; }
BAD=$(jq -r --argjson ok '["ALLOW_REFRESH_TOKEN_AUTH","ALLOW_USER_SRP_AUTH","ALLOW_USER_AUTH"]' '[.UserPoolClient.ExplicitAuthFlows[]? | select(. as $f | $ok | index($f) | not)] | join(",")' "$BEFORE_FILE")
[[ -z "$BAD" ]] || stop "the client has other auth flows ($BAD); removing them is an owner decision. Nothing changed"
INPUT_FILE="$OUT/cognito-update-input-$STAMP.json"
ROLLBACK_FILE="$OUT/cognito-rollback-input-$STAMP.json"
jq 'del(.UserPoolClient.ClientSecret, .UserPoolClient.CreationDate, .UserPoolClient.LastModifiedDate) | .UserPoolClient' "$BEFORE_FILE" > "$ROLLBACK_FILE"
jq --arg cb "$TARGET_CALLBACK" --arg lo "$TARGET_LOGOUT" --argjson flows "$TARGET_FLOWS" --argjson hrs "$TARGET_REFRESH_HOURS" '
  .UserPoolClient | del(.ClientSecret, .CreationDate, .LastModifiedDate)
  | .CallbackURLs = [$cb] | .LogoutURLs = [$lo] | .ExplicitAuthFlows = $flows
  | .RefreshTokenValidity = $hrs | .TokenValidityUnits = ((.TokenValidityUnits // {}) + {RefreshToken: "hours"})
  | if (.DefaultRedirectURI // null) != null then .DefaultRedirectURI = $cb else . end' "$BEFORE_FILE" > "$INPUT_FILE"
show() { jq -r "$1" "$2"; }
printf '%-22s | %-70s | %s\n' Setting Current Target
printf '%-22s | %-70s | %s\n' "Callback URLs" "$(show '(.UserPoolClient.CallbackURLs // []) | join(", ")' "$BEFORE_FILE")" "$TARGET_CALLBACK"
printf '%-22s | %-70s | %s\n' "Default redirect URI" "$(show '.UserPoolClient.DefaultRedirectURI // "none"' "$BEFORE_FILE")" "$(show '.DefaultRedirectURI // "none (unchanged)"' "$INPUT_FILE")"
printf '%-22s | %-70s | %s\n' "Logout URLs" "$(show '(.UserPoolClient.LogoutURLs // []) | join(", ")' "$BEFORE_FILE")" "$TARGET_LOGOUT"
printf '%-22s | %-70s | %s\n' "Auth flows" "$(show '.UserPoolClient.ExplicitAuthFlows | sort | join(", ")' "$BEFORE_FILE")" "$(jq -r 'join(", ")' <<<"$TARGET_FLOWS")"
printf '%-22s | %-70s | %s\n' "Refresh token" "$(show '"\(.UserPoolClient.RefreshTokenValidity) \(.UserPoolClient.TokenValidityUnits.RefreshToken // "days")"' "$BEFORE_FILE")" "$TARGET_REFRESH_HOURS hours"
echo "Every other field is sent back unchanged. The old callback URL stops working for sign-in after this change."
echo "Saved: $BEFORE_FILE (full current client), $ROLLBACK_FILE (rollback input)"

ALREADY=$(jq -n --slurpfile e "$INPUT_FILE" --slurpfile a <(jq '.UserPoolClient | del(.ClientSecret, .CreationDate, .LastModifiedDate)' "$BEFORE_FILE") "def n: $NORM; [\$e[0] | n | to_entries[] | select(.value != (\$a[0] | n)[.key])] | length")
if [[ "$ALREADY" == 0 ]]; then
  DONE=1; echo "PASS the client already has the target values. Nothing to change."; exit 0
fi
if [[ "$MODE" == plan ]]; then
  DONE=1; echo; echo "PLAN ONLY: nothing was changed. To apply: OGEVIA_COGNITO_APPROVAL=<reference> bash post-deploy.sh cognito"; exit 0
fi

# ---------------------------------------------------------------- step 3 ----
step "3 Approval and apply"
[[ "${OGEVIA_COGNITO_APPROVAL:-}" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || stop "set OGEVIA_COGNITO_APPROVAL to the owner's approval reference (6-64 letters, digits, . _ -)"
[[ -t 0 ]] || stop "run this from an interactive terminal (CloudShell)"
read -r -p "Approval ${OGEVIA_COGNITO_APPROVAL}: type UPDATE to apply the change shown above to client $CLIENT_NAME (anything else stops): " ans
[[ "$ans" == UPDATE ]] || { STOPPED=1; say "Not confirmed. Nothing was changed."; exit 0; }
if ! aws cognito-idp update-user-pool-client --cli-input-json "file://$INPUT_FILE" --output json > "$OUT/cognito-update-result-$STAMP.json"; then
  stop "the update was rejected by AWS (error above). The client is unchanged"
fi
echo "Update sent."

# ---------------------------------------------------------------- step 4 ----
step "4 Verify every field"
AFTER_FILE="$OUT/cognito-after-$STAMP.json"
aws cognito-idp describe-user-pool-client --user-pool-id "$POOL" --client-id "$CLIENT_ID" --output json > "$AFTER_FILE" || stop "the update was sent but the client cannot be re-read; compare in the console. Rollback: aws cognito-idp update-user-pool-client --cli-input-json file://$ROLLBACK_FILE"
DIFFS=$(jq -n --slurpfile e "$INPUT_FILE" --slurpfile a <(jq '.UserPoolClient' "$AFTER_FILE") "def n: $NORM; [\$e[0] | n | to_entries[] | select(.value != (\$a[0] | n)[.key]) | .key] | join(\", \")")
EXTRA=$(jq -n --slurpfile e "$INPUT_FILE" --slurpfile a <(jq '.UserPoolClient | del(.CreationDate, .LastModifiedDate)' "$AFTER_FILE") '[($a[0] | keys[]) as $k | select(($e[0] | has($k)) | not) | $k] | join(", ")')
if [[ -z "$DIFFS" || "$DIFFS" == '""' ]]; then
  echo "PASS every field of the client equals what was sent (target values applied, all other fields unchanged)"
  [[ -z "$EXTRA" || "$EXTRA" == '""' ]] || echo "INFO fields AWS added that were not sent: $EXTRA"
  RESULT=PASS
else
  echo "FAIL fields that differ from what was sent: $DIFFS"
  echo "Rollback: aws cognito-idp update-user-pool-client --cli-input-json file://$ROLLBACK_FILE"
  RESULT=FAIL
fi
{
  echo "Ogevia Cognito client change, $STAMP, approval reference $OGEVIA_COGNITO_APPROVAL"
  echo "pool $POOL, client $CLIENT_NAME ($CLIENT_ID)"
  echo "callback: $(jq -r '(.UserPoolClient.CallbackURLs // []) | join(", ")' "$BEFORE_FILE") -> $(jq -r '(.UserPoolClient.CallbackURLs // []) | join(", ")' "$AFTER_FILE")"
  echo "logout: $(jq -r '(.UserPoolClient.LogoutURLs // []) | join(", ")' "$BEFORE_FILE") -> $(jq -r '(.UserPoolClient.LogoutURLs // []) | join(", ")' "$AFTER_FILE")"
  echo "auth flows: $(jq -r '.UserPoolClient.ExplicitAuthFlows | sort | join(", ")' "$BEFORE_FILE") -> $(jq -r '.UserPoolClient.ExplicitAuthFlows | sort | join(", ")' "$AFTER_FILE")"
  echo "refresh token: $(jq -r '"\(.UserPoolClient.RefreshTokenValidity) \(.UserPoolClient.TokenValidityUnits.RefreshToken // "days")"' "$BEFORE_FILE") -> $(jq -r '"\(.UserPoolClient.RefreshTokenValidity) \(.UserPoolClient.TokenValidityUnits.RefreshToken // "days")"' "$AFTER_FILE")"
  echo "RESULT: $RESULT"
  echo "rollback input: $ROLLBACK_FILE"
} > "$OUT/cognito-change-$STAMP.txt"
DONE=1
echo; cat "$OUT/cognito-change-$STAMP.txt"
[[ "$RESULT" == PASS ]] || exit 1
echo "Next: the first administrator signs in with MFA, then: OGEVIA_RESTORE_TEST_APPROVAL=<reference> bash post-deploy.sh restore-test"
