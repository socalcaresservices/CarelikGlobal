#!/usr/bin/env bash
# PRODUCTION: turn the request-cleanup switch ON by adding exactly three API Gateway routes to the LIVE Ogevia-prd-ServiceVerificationApi template.
# Owner authorization: "Yes, prepare it" (2026-11-21) for the switch-ON change; the run itself needs the typed owner approval below.
# Derived from production-signin-override-deploy.sh (the 2026-11-15 production release, branch claude/keen-hawking-e9o2jg): same plan / apply / rollback with a CloudFormation change set that is guarded to be exactly
# the routes, a smoke check, and an automatic rollback. Differences: three routes, no cdk synth (the helper builds the routes from a live sibling route and was proven equal to the CDK
# synthesis with the switch on), and a check that the deployed Handler is the release code. No Lambda code, IAM, permission, parameter, database or website change. Never runs `cdk deploy`.
#   plan                    read-only checks, builds the change from the LIVE template, creates (does not execute) a change set and guards it
#   apply    <workspace>    re-checks, executes that change set, verifies it, smokes it, and rolls back by itself if the smoke check fails
#   rollback <workspace>    removes exactly the three routes again (guarded)
# Required for every mode:  export OGEVIA_DEPLOY_APPROVAL=owner-production-request-cleanup-go
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
PLAN="$HERE/production-request-cleanup-routes-release.py"
[[ -f "$PLAN" ]] || stop 'production-request-cleanup-routes-release.py must sit beside this script'
RELEASE_SHA=ef90a2a42c21e2c68e6fbf3f361e618806699b8d
MODE="${1:-}"

[[ "${OGEVIA_DEPLOY_APPROVAL:-}" == owner-production-request-cleanup-go ]] || stop 'the owner approval is missing: export OGEVIA_DEPLOY_APPROVAL=owner-production-request-cleanup-go'
[[ "$(A sts get-caller-identity --query Account --output text)" == "$ACCOUNT" ]] || stop "wrong AWS account (must be $ACCOUNT)"

workspace() {
  local w="${1:-}"
  [[ "$w" =~ ^/tmp/ogevia-request-cleanup\.[A-Za-z0-9]+$ && -d "$w" && ! -L "$w" && -O "$w" && -s "$w/state.env" ]] || stop 'invalid or missing workspace: use the path printed by plan'
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
  expect_code 'POST care-notifications/read no token ' 401 -X POST -H 'content-type: application/json' -d '{}' "$url/v1/care-notifications/read" || ok=1
  expect_code 'POST documents/{id}/cancel no token   ' 401 -X POST -H 'content-type: application/json' -d '{}' "$url/v1/documents/$NIL/cancel" || ok=1
  expect_code 'POST document-types/{id}/retire no tok' 401 -X POST -H 'content-type: application/json' -d '{}' "$url/v1/document-types/$NIL/retire" || ok=1
  expect_code 'POST retire forged token              ' 401 -X POST -H 'authorization: Bearer forged.token.value' -H 'content-type: application/json' -d '{}' "$url/v1/document-types/$NIL/retire" || ok=1
  expect_code 'GET  /v1/me no token (unchanged)      ' 401 "$url/v1/me" || ok=1
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
    stop "the change set $name is not exactly the three routes; it was deleted and nothing was changed"
  fi
}

do_rollback() {
  say 'ROLLBACK: removing exactly the three request-cleanup routes'
  local rb="ogevia-request-cleanup-rollback-$(date -u +%Y%m%dT%H%M%SZ)"
  run_change_set "$rb" rollback.template.json rollback-changes
  A cloudformation execute-change-set --stack-name "$STACK" --change-set-name "$rb"
  A cloudformation wait stack-update-complete --stack-name "$STACK"
  stack_template "$WORK/live.rolledback.json"
  python3 "$PLAN" equal "$WORK/live.before.json" "$WORK/live.rolledback.json"
  python3 "$PLAN" routes "$WORK/live.rolledback.json" absent
  echo "ROLLED BACK: the production API is back to its captured template. The database objects of migration 0109 stay (inert); cancelled requests and retired types stay as recorded."
}

case "$MODE" in
plan)
  [[ "${OGEVIA_RELEASE_SHA:-}" == "$RELEASE_SHA" ]] || stop "OGEVIA_RELEASE_SHA must be $RELEASE_SHA (the owner's GO covers this one commit)"
  WORK=$(mktemp -d /tmp/ogevia-request-cleanup.XXXXXX); chmod 700 "$WORK"
  say "workspace $WORK"
  say '1/5 capture the live stack and its rollback inputs (read-only)'
  local_status=$(A cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text)
  [[ "$local_status" == UPDATE_COMPLETE || "$local_status" == CREATE_COMPLETE ]] || stop "the stack is $local_status, not settled"
  stack_template "$WORK/live.before.json"
  A cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Parameters[].ParameterKey' --output json | jq 'map({ParameterKey: ., UsePreviousValue: true})' > "$WORK/previous-parameters.json"
  # list-stack-resources pages through every resource; describe-stack-resources returns only the first 100 and this stack has about 270.
  FN=$(A cloudformation list-stack-resources --stack-name "$STACK" --query "StackResourceSummaries[?starts_with(LogicalResourceId,'Handler') && ResourceType=='AWS::Lambda::Function'].PhysicalResourceId" --output text)
  [[ "$FN" =~ ^[A-Za-z0-9._-]+$ ]] || stop 'could not identify the production Handler'
  A lambda get-function-configuration --function-name "$FN" --query '[CodeSha256,Environment.Variables.DB_NAME,Environment.Variables.OGEVIA_ENV]' --output text | tee "$WORK/handler.before.txt"
  grep -qE $'\togevia_prd\tprd$' "$WORK/handler.before.txt" || stop 'the Handler is not the production Handler (DB_NAME ogevia_prd, OGEVIA_ENV prd)'
  API_ID=$(A cloudformation list-stack-resources --stack-name "$STACK" --query "StackResourceSummaries[?ResourceType=='AWS::ApiGatewayV2::Api'].PhysicalResourceId" --output text)
  [[ "$API_ID" == "$EXPECT_API_ID" ]] || stop "the API is $API_ID, expected $EXPECT_API_ID"
  python3 "$PLAN" routes "$WORK/live.before.json" absent
  say '2/5 the production Handler is the release code (the routes need it behind them)'
  CODE_URL=$(A lambda get-function --function-name "$FN" --query Code.Location --output text)
  curl -fsS --connect-timeout 10 --max-time 120 "$CODE_URL" -o "$WORK/handler.live.zip"; unset CODE_URL
  python3 "$PLAN" deployed "$WORK/handler.live.zip"
  say '3/5 live template plus exactly the three routes'
  python3 "$PLAN" patch "$WORK/live.before.json" "$WORK/candidate.template.json"
  PREFIX="ogevia-production-release/request-cleanup-$(date -u +%Y%m%dT%H%M%SZ)"
  for f in live.before.json:rollback.template.json candidate.template.json:candidate.template.json previous-parameters.json:previous-parameters.json; do
    A s3 cp "$WORK/${f%%:*}" "s3://$ASSETS/$PREFIX/${f##*:}" --only-show-errors
  done
  say '4/5 nobody changed the stack meanwhile'
  stack_template "$WORK/live.recheck.json"
  python3 "$PLAN" equal "$WORK/live.before.json" "$WORK/live.recheck.json"
  say '5/5 create the change set and guard it (nothing is applied)'
  CHANGE="ogevia-request-cleanup-$(date -u +%Y%m%dT%H%M%SZ)"
  run_change_set "$CHANGE" candidate.template.json changes
  umask 077
  printf 'SHA=%s\nPREFIX=%s\nCHANGE=%s\nAPI_ID=%s\nFN=%s\n' "$RELEASE_SHA" "$PREFIX" "$CHANGE" "$API_ID" "$FN" > "$WORK/state.env"
  say 'PLAN READY. Nothing is changed yet.'
  echo "Review $WORK/$CHANGE.json if you wish, then run:"
  echo "  OGEVIA_DEPLOY_APPROVAL=owner-production-request-cleanup-go bash $HERE/production-request-cleanup-routes-deploy.sh apply $WORK"
  ;;

apply)
  workspace "${2:-}"
  [[ "$SHA" == "$RELEASE_SHA" ]] || stop 'the planned commit is not the release commit'
  say '1/5 re-check: the stack is unchanged since the plan and the change set is still exactly the three routes'
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
  say '3/5 the stack is exactly the planned template and all three routes exist'
  stack_template "$WORK/live.after.json"
  if ! { python3 "$PLAN" equal "$WORK/candidate.template.json" "$WORK/live.after.json" && python3 "$PLAN" routes "$WORK/live.after.json" present; }; then
    echo 'The live stack differs from the planned template: rolling back.' >&2; do_rollback; exit 1
  fi
  say '4/5 smoke: the three routes now answer 401 without a valid token (they answered 404 before)'
  if ! smoke; then
    echo 'SMOKE FAILED: rolling back.' >&2; do_rollback; exit 1
  fi
  say '5/5 new 5xx in the last 10 minutes (information; the notifications/attention errors of 2026-11-14 may still show if not yet fixed)'
  A logs filter-log-events --log-group-name "$LOG_GROUP" --start-time $(( ($(date +%s) - 600) * 1000 )) --filter-pattern '"internal_error"' --max-items 5 --query 'events[].message' --output text | cut -c1-240 || true
  echo
  echo 'REQUEST CLEANUP IS ON IN PRODUCTION (three routes).'
  echo 'Owner check in the app: Documents > Cancel request (reason required) on a request with no upload; Retire on a duplicate type (refused for the CPR/TB type and with open requests); Care requests > Mark read. Do not create throw-away records.'
  echo "To undo, run:  OGEVIA_DEPLOY_APPROVAL=owner-production-request-cleanup-go bash $HERE/production-request-cleanup-routes-deploy.sh rollback $WORK"
  ;;

rollback)
  workspace "${2:-}"
  do_rollback
  ;;

*) stop 'usage: plan | apply <workspace> | rollback <workspace>' ;;
esac
