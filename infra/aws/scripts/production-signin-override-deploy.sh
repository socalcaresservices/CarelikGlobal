#!/usr/bin/env bash
# PRODUCTION: enable the sign-in override by adding exactly two API Gateway routes (docs/releases/2026-11-15-signin-override-production/).
# Run it in AWS CloudShell, in us-west-2, as `bash production-signin-override-deploy.sh <mode> ...` (a script: set -e only ends the script, never your terminal).
#
#   plan     <verify-output-file>   read-only checks, builds the change from the LIVE template, creates (does not execute) a CloudFormation change set and guards it
#   apply    <workspace>            re-checks, executes that change set, verifies it, and rolls back by itself if the smoke check fails
#   rollback <workspace>            removes exactly the two routes again (guarded)
#
# Required for every mode:  export OGEVIA_DEPLOY_APPROVAL=owner-signin-override-go     (the owner's GO)
# Required for plan:        export OGEVIA_RELEASE_SHA=<40-character commit SHA the GO covers>; this checkout must be exactly that commit, tracked files clean,
#                           and <verify-output-file> must be the saved output of VERIFY_PRODUCTION_DB.sql from the last 2 hours with the line "VERDICT: PASS".
# Never runs `cdk deploy` (the CDK code lacks six routes production serves today). Changes nothing but the two routes. No secret value is read or printed.
set -euo pipefail
set +H
umask 077
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER='' AWS_CLI_AUTO_PROMPT=off
ACCOUNT=300094796789
STACK=Ogevia-prd-ServiceVerificationApi
ASSETS=cdk-hnb659fds-assets-300094796789-us-west-2
EXPECT_API_ID=zk527zk4ua
LOG_GROUP=Ogevia-prd-ServiceVerificationApi-HandlerLogGroup881018CA-SPB7CscZPXJI
NIL=00000000-0000-4000-8000-000000000000
A() { aws --cli-connect-timeout 5 --cli-read-timeout 60 "$@"; }
stop() { echo "STOP: $*" >&2; exit 1; }
say() { echo "== $*"; }

HERE=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
PLAN="$HERE/production-signin-override-release.py"
[[ -f "$PLAN" ]] || stop 'production-signin-override-release.py must sit beside this script'
REPO=$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null) || stop 'run this from the checked-out repository'
MODE="${1:-}"

[[ "${OGEVIA_DEPLOY_APPROVAL:-}" == owner-signin-override-go ]] || stop 'the owner approval is missing: export OGEVIA_DEPLOY_APPROVAL=owner-signin-override-go'
[[ "$(A sts get-caller-identity --query Account --output text)" == "$ACCOUNT" ]] || stop "wrong AWS account (must be $ACCOUNT)"

workspace() {
  local w="${1:-}"
  [[ "$w" =~ ^/tmp/ogevia-signin-override\.[A-Za-z0-9]+$ && -d "$w" && ! -L "$w" && -O "$w" && -s "$w/state.env" ]] || stop 'invalid or missing workspace: use the path printed by plan'
  WORK="$w"
  # state.env was written by `plan` (mode 600, same user); only the keys below are read, as data.
  local k v
  while IFS='=' read -r k v; do
    case "$k" in
      SHA|PREFIX|CHANGE|API_ID|FN) [[ "$v" =~ ^[A-Za-z0-9._/-]+$ ]] || stop "bad value for $k"; printf -v "$k" '%s' "$v";;
      *) stop "unexpected key in state.env: $k";;
    esac
  done < "$WORK/state.env"
  [[ -n "${SHA:-}" && -n "${PREFIX:-}" && -n "${CHANGE:-}" && -n "${API_ID:-}" ]] || stop 'incomplete state.env'
}

checkout_is_release() {
  [[ "${1:-}" =~ ^[0-9a-f]{40}$ ]] || stop 'OGEVIA_RELEASE_SHA must be the full 40-character commit SHA'
  [[ "$(git -C "$REPO" rev-parse HEAD)" == "$1" ]] || stop 'this checkout is not at the release SHA'
  [[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop 'tracked files are modified in this checkout'
}

stack_template() { A cloudformation get-template --stack-name "$STACK" --template-stage Original --query TemplateBody --output json > "$1"; }

# Waits (up to ~90 s) for an unauthenticated call to answer $2 (API Gateway needs a moment to publish a new route).
expect_code() {
  local label="$1" want="$2" code="" n; shift 2
  for n in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 20 "$@" || true)
    [[ "$code" == "$want" ]] && { echo "   $label: $code"; return 0; }
    sleep "${OGEVIA_SMOKE_SLEEP:-5}"
  done
  echo "   $label: $code (wanted $want)"; return 1
}

smoke() {
  local url="https://$API_ID.execute-api.us-west-2.amazonaws.com" ok=0
  expect_code 'GET  no token    ' 401 "$url/v1/signin-overrides?organizationId=$NIL" || ok=1
  expect_code 'GET  forged token' 401 -H 'authorization: Bearer forged.token.value' "$url/v1/signin-overrides?organizationId=$NIL" || ok=1
  expect_code 'POST no token    ' 401 -X POST -H 'content-type: application/json' -d '{}' "$url/v1/caregivers/$NIL/signin-override" || ok=1
  local jwt
  jwt=$(A apigatewayv2 get-routes --api-id "$API_ID" --query "Items[?contains(RouteKey,'signin-override')].AuthorizationType" --output text | tr '\t' '\n' | grep -v '^$' | sort | uniq -c | tr -s ' ' | tr '\n' ' ')
  echo "   route authorization types: ${jwt:-none}"
  [[ "$jwt" == " 2 JWT " || "$jwt" == "2 JWT " ]] || ok=1
  return $ok
}

run_change_set() { # run_change_set <name> <template-key> <expected-guard>   creates, waits, describes, guards; leaves it ready to execute
  local name="$1" key="$2" guard="$3"
  A cloudformation create-change-set --stack-name "$STACK" --change-set-name "$name" --change-set-type UPDATE \
    --template-url "https://$ASSETS.s3.us-west-2.amazonaws.com/$PREFIX/$key" --parameters "file://$WORK/previous-parameters.json" \
    --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM > "$WORK/$name.created.json"
  A cloudformation wait change-set-create-complete --stack-name "$STACK" --change-set-name "$name"
  A cloudformation describe-change-set --stack-name "$STACK" --change-set-name "$name" --output json > "$WORK/$name.json"
  if ! python3 "$PLAN" "$guard" "$WORK/$name.json"; then
    A cloudformation delete-change-set --stack-name "$STACK" --change-set-name "$name" || true
    stop "the change set $name is not exactly the two routes; it was deleted and nothing was changed"
  fi
}

do_rollback() {
  say 'ROLLBACK: removing exactly the two sign-in override routes'
  local rb="ogevia-signin-override-rollback-$(date -u +%Y%m%dT%H%M%SZ)"
  run_change_set "$rb" rollback.template.json rollback-changes
  A cloudformation execute-change-set --stack-name "$STACK" --change-set-name "$rb"
  A cloudformation wait stack-update-complete --stack-name "$STACK"
  stack_template "$WORK/live.rolledback.json"
  python3 "$PLAN" equal "$WORK/live.before.json" "$WORK/live.rolledback.json"
  python3 "$PLAN" routes "$WORK/live.rolledback.json" absent
  echo "ROLLED BACK: the production API is back to its captured template. Override records already written, if any, are kept on purpose (append-only)."
}

case "$MODE" in
plan)
  VERIFY="${2:-}"
  checkout_is_release "${OGEVIA_RELEASE_SHA:-}"
  [[ -f "$VERIFY" ]] || stop 'give the saved output of VERIFY_PRODUCTION_DB.sql as the second argument'
  [[ -n "$(find "$VERIFY" -mmin -120 2>/dev/null)" ]] || stop 'the database verification output is older than 2 hours: run it again'
  grep -q '^VERDICT: PASS$' "$VERIFY" && ! grep -q '^VERDICT: FAIL' "$VERIFY" || stop 'the database verification did not print VERDICT: PASS (production is NOT ready: nothing was changed)'
  grep -q 'ogevia_prd' "$VERIFY" || stop 'the verification output does not name ogevia_prd'
  WORK=$(mktemp -d /tmp/ogevia-signin-override.XXXXXX); chmod 700 "$WORK"
  cp "$VERIFY" "$WORK/verify-before.txt"
  say "workspace $WORK"
  say '1/6 synthesize the candidate to the workspace (the repository cdk.out is never touched)'
  (cd "$REPO" && corepack pnpm@9.15.4 install --frozen-lockfile --filter @carelik/infra-aws...)
  (cd "$REPO/infra/aws" && npx cdk synth --quiet -c env=prd -c mode=plan --output "$WORK/cdk.out") > "$WORK/synth.log" 2>&1 || { tail -20 "$WORK/synth.log" >&2; stop 'synth failed'; }
  [[ -s "$WORK/cdk.out/Ogevia-prd-ServiceVerificationApi.template.json" ]] || stop 'no candidate template was produced'
  say '2/6 capture the live stack and its rollback inputs (read-only)'
  local_status=$(A cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text)
  [[ "$local_status" == UPDATE_COMPLETE || "$local_status" == CREATE_COMPLETE ]] || stop "the stack is $local_status, not settled"
  stack_template "$WORK/live.before.json"
  A cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Parameters[].ParameterKey' --output json | jq 'map({ParameterKey: ., UsePreviousValue: true})' > "$WORK/previous-parameters.json"
  FN=$(A cloudformation describe-stack-resources --stack-name "$STACK" --query "StackResources[?starts_with(LogicalResourceId,'Handler') && ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text)
  [[ "$FN" =~ ^[A-Za-z0-9._-]+$ ]] || stop 'could not identify the production Handler'
  A lambda get-function-configuration --function-name "$FN" --query '[CodeSha256,Environment.Variables.DB_NAME,Environment.Variables.OGEVIA_ENV]' --output text | tee "$WORK/handler.before.txt"
  grep -qE $'\togevia_prd\tprd$' "$WORK/handler.before.txt" || stop 'the Handler is not the production Handler (DB_NAME ogevia_prd, OGEVIA_ENV prd)'
  API_ID=$(A cloudformation describe-stack-resources --stack-name "$STACK" --query "StackResources[?ResourceType=='AWS::ApiGatewayV2::Api'].PhysicalResourceId" --output text)
  [[ "$API_ID" == "$EXPECT_API_ID" ]] || stop "the API is $API_ID, expected $EXPECT_API_ID"
  python3 "$PLAN" routes "$WORK/live.before.json" absent
  say '3/6 live template plus exactly the two routes'
  python3 "$PLAN" patch "$WORK/live.before.json" "$WORK/cdk.out/Ogevia-prd-ServiceVerificationApi.template.json" "$WORK/candidate.template.json"
  PREFIX="ogevia-production-release/signin-override-$(date -u +%Y%m%dT%H%M%SZ)"
  for f in live.before.json:rollback.template.json candidate.template.json:candidate.template.json previous-parameters.json:previous-parameters.json verify-before.txt:verify-before.txt; do
    A s3 cp "$WORK/${f%%:*}" "s3://$ASSETS/$PREFIX/${f##*:}" --only-show-errors
  done
  say '4/6 nobody changed the stack meanwhile'
  stack_template "$WORK/live.recheck.json"
  python3 "$PLAN" equal "$WORK/live.before.json" "$WORK/live.recheck.json"
  say '5/6 create the change set and guard it (nothing is applied)'
  CHANGE="ogevia-signin-override-$(date -u +%Y%m%dT%H%M%SZ)"
  run_change_set "$CHANGE" candidate.template.json changes
  umask 077
  printf 'SHA=%s\nPREFIX=%s\nCHANGE=%s\nAPI_ID=%s\nFN=%s\n' "$OGEVIA_RELEASE_SHA" "$PREFIX" "$CHANGE" "$API_ID" "$FN" > "$WORK/state.env"
  say '6/6 PLAN READY. Nothing is changed yet.'
  echo "Review $WORK/$CHANGE.json if you wish, then run:"
  echo "  OGEVIA_DEPLOY_APPROVAL=owner-signin-override-go bash $HERE/production-signin-override-deploy.sh apply $WORK"
  ;;

apply)
  workspace "${2:-}"
  [[ "${OGEVIA_RELEASE_SHA:-}" == "$SHA" ]] || stop "OGEVIA_RELEASE_SHA must be the SHA that was planned ($SHA): the owner's GO covers one commit"
  checkout_is_release "$SHA"
  say '1/5 re-check: the stack is unchanged since the plan and the change set is still exactly the two routes'
  stack_template "$WORK/live.now.json"
  python3 "$PLAN" equal "$WORK/live.before.json" "$WORK/live.now.json"
  A cloudformation describe-change-set --stack-name "$STACK" --change-set-name "$CHANGE" --output json > "$WORK/$CHANGE.recheck.json"
  python3 "$PLAN" changes "$WORK/$CHANGE.recheck.json" || stop 'the change set changed since the plan: nothing was applied; run plan again'
  say '2/5 execute the change set'
  A cloudformation execute-change-set --stack-name "$STACK" --change-set-name "$CHANGE"
  if ! A cloudformation wait stack-update-complete --stack-name "$STACK"; then
    echo "The stack update did not complete. Do NOT run anything else: CloudFormation rolls an update back by itself. Send the output of:" >&2
    echo "  aws cloudformation describe-stack-events --stack-name $STACK --max-items 15 --region us-west-2" >&2
    exit 1
  fi
  say '3/5 the stack is exactly the planned template and both routes exist'
  stack_template "$WORK/live.after.json"
  if ! { python3 "$PLAN" equal "$WORK/candidate.template.json" "$WORK/live.after.json" && python3 "$PLAN" routes "$WORK/live.after.json" present; }; then
    echo 'The live stack differs from the planned template: rolling back.' >&2; do_rollback; exit 1
  fi
  say '4/5 smoke: the two routes now answer 401 without a valid token (they answered 404 before)'
  if ! smoke; then
    echo 'SMOKE FAILED: rolling back.' >&2; do_rollback; exit 1
  fi
  say '5/5 new 5xx in the last 10 minutes (information; the notifications/attention errors of 2026-11-14 may still show if not yet fixed)'
  A logs filter-log-events --log-group-name "$LOG_GROUP" --start-time $(( ($(date +%s) - 600) * 1000 )) --filter-pattern '"internal_error"' --max-items 5 --query 'events[].message' --output text | cut -c1-240 || true
  echo
  echo 'SIGN-IN OVERRIDE ROUTES ARE LIVE IN PRODUCTION.'
  echo 'Owner acceptance (RUNBOOK.md section 7): open Care Team as an owner or administrator, on a caregiver with a clear background check who has not signed in; the action'
  echo '"Approve by override" is shown, needs a reason of 5+ characters, and records the badge. Managers and schedulers do not see it. Do not create a throw-away record.'
  echo "To undo, run:  OGEVIA_DEPLOY_APPROVAL=owner-signin-override-go bash $HERE/production-signin-override-deploy.sh rollback $WORK"
  ;;

rollback)
  workspace "${2:-}"
  do_rollback
  ;;

*) stop 'usage: plan <verify-output-file> | apply <workspace> | rollback <workspace>' ;;
esac
