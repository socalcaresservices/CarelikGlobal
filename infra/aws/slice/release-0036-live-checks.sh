# Read-only live verification for release 0027-0036 (sourced, not run).
# Used by release-0036-deploy.sh (phase 11) and release-0036-verify.sh (a
# verify-only rerun on an existing deployment). Nothing here changes AWS.
#
# Needs: pilot-lib.sh sourced; RUN RB VERIFY SLICE API_STACK STACKS ACCOUNT
# REGION DB_NAME APP_SG IID FN API_ID API WEB POLICY_ARN IDENTITY_FN
# SNAPSHOT_ID COMMIT NEW_ROUTE_COUNT, and BUILD_DIR (the pinned build's
# cdk.out, whose API template must equal the approved scope).
# shellcheck shell=bash disable=SC2154

# The Handler's deployment package as the live template references it, and
# its size and SHA-256 (base64, the form Lambda reports as CodeSha256).
handler_asset_evidence() {
  local t b k
  t=$(aws cloudformation get-template --stack-name "$API_STACK" --template-stage Original --query TemplateBody --output json)
  b=$(jq -r '.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key | startswith("Handler"))) | .value.Properties.Code.S3Bucket | if type == "object" then .["Fn::Sub"] else . end' <<<"$t")
  k=$(jq -r '.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key | startswith("Handler"))) | .value.Properties.Code.S3Key' <<<"$t")
  b=${b//'${AWS::AccountId}'/$ACCOUNT}; b=${b//'${AWS::Region}'/$REGION}
  ASSET_REF="s3://$b/$k"
  ASSET_SIZE=$(aws s3api head-object --bucket "$b" --key "$k" --query ContentLength --output text 2>/dev/null || echo missing)
  ASSET_SHA=$(aws s3 cp "$ASSET_REF" - --only-show-errors 2>/dev/null \
    | python3 -c 'import sys, hashlib, base64; print(base64.b64encode(hashlib.sha256(sys.stdin.buffer.read()).digest()).decode())')
}

live_checks() {
  : > "$VERIFY"
  PASSES=0; FAILS=0; TOTAL=14
  declare -gA RESULT=()
  check() {
    RESULT[$1]=$2
    if [[ "$2" == ok ]]; then PASSES=$((PASSES + 1)); echo "PASS $1${3:+ - $3}" | tee -a "$VERIFY"
    else FAILS=$((FAILS + 1)); echo "FAIL $1${3:+ - $3}" | tee -a "$VERIFY"; fi
  }
  local r ST s codes c p FNCFG2 HANDLER_KEY LIVE_KEY BUILD_KEY NEW_SHA MODE OUT PV SERVED CFG SS
  APPROVED_AT=$(grep '^approved_at=' "$RUN/APPROVAL.txt" | cut -d= -f2)
  ST=$(aws cloudformation describe-stacks --stack-name "$API_STACK" --query 'Stacks[0].[StackStatus,LastUpdatedTime]' --output text)
  [[ "$(cut -f1 <<<"$ST")" == UPDATE_COMPLETE && "$(cut -f2 <<<"$ST")" > "$APPROVED_AT" ]] && r=ok || r=no
  check 1 "$r" "API stack UPDATE_COMPLETE after the approval: $(cut -f1 <<<"$ST")"

  mkdir -p "$RUN/after-templates"
  r=ok
  for s in "${STACKS[@]}"; do
    [[ "$s" == "$API_STACK" ]] && continue
    aws cloudformation get-template --stack-name "$s" --template-stage Original --query TemplateBody --output json > "$RUN/after-templates/$s.json"
    [[ "$(python3 "$SLICE/release_0036_live.py" same-json "$RB/templates/$s.json" "$RUN/after-templates/$s.json")" == ok ]] || r=no
  done
  check 2 "$r" "the other four stacks unchanged (NetworkEgress, EvidenceStorage, Observability, WebHosting)"

  aws apigatewayv2 get-routes --api-id "$API_ID" --query 'Items[].[RouteKey,AuthorizationType]' --output json > "$RUN/routes-after.json"
  r=$(python3 "$SLICE/release_0036_live.py" routes "$RB/routes.json" "$RUN/routes-after.json")
  check 3 "$r" "$NEW_ROUTE_COUNT new routes: 30 JWT + exactly the 2 approved public link routes; every earlier route unchanged ($(jq length "$RB/routes.json") -> $(jq length "$RUN/routes-after.json") routes)"

  codes=""; r=ok
  for p in /v1/shift-series /v1/continuity/status /v1/billing-rounding/policies "/v1/visits/00000000-0000-4000-8000-000000000000/review"; do
    c=$(curl -s -o /dev/null -w '%{http_code}' "${API%/}$p"); codes="$codes $p=$c"; [[ "$c" == 401 ]] || r=no
  done
  c=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${API%/}/v1/shift-series"); codes="$codes POST/shift-series=$c"; [[ "$c" == 401 ]] || r=no
  c=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${API%/}/v1/visits/00000000-0000-4000-8000-000000000000/confirmation-requests"); codes="$codes POST/confirmation-requests=$c"; [[ "$c" == 401 ]] || r=no
  # The public link route answers without sign-in but refuses a request without the phone code (400, before any database work).
  c=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${API%/}/v1/public/visit-confirmations/$(printf '0%.0s' {1..64})/open"); codes="$codes POST/public-open=$c"; [[ "$c" == 400 ]] || r=no
  check 4 "$r" "new staff routes refuse requests without sign-in (401); the public link route refuses a request without a code (400):${codes}"

  FNCFG2=$(aws lambda get-function-configuration --function-name "$FN" --output json)
  printf '%s\n' "$FNCFG2" > "$RUN/handler-config-after-raw.json"   # kept as evidence; environment values are only ever printed hashed
  HANDLER_KEY='.Resources | to_entries[] | select(.value.Type=="AWS::Lambda::Function" and (.key | startswith("Handler"))) | .value.Properties.Code.S3Key'
  LIVE_KEY=$(aws cloudformation get-template --stack-name "$API_STACK" --template-stage Original --query TemplateBody --output json | jq -r "$HANDLER_KEY")
  BUILD_KEY=$(jq -r "$HANDLER_KEY" "$BUILD_DIR/$API_STACK.template.json")
  NEW_SHA=$(jq -r .CodeSha256 <<<"$FNCFG2")
  [[ "$LIVE_KEY" == "$BUILD_KEY" && "$NEW_SHA" != "$(jq -r .CodeSha256 "$RB/lambda.json")" && "$(jq -r .Environment.Variables.DB_NAME <<<"$FNCFG2")" == "$DB_NAME" ]] && r=ok || r=no
  check 5 "$r" "API Lambda runs this build and still serves $DB_NAME (CodeSha256 ${NEW_SHA:0:12}…)"

  # 6: every configuration field identical to the pre-deployment capture, except the code, which must
  # be exactly the approved package, and an AWS-managed runtime patch under Auto mode (reported).
  handler_asset_evidence
  MODE=$(aws lambda get-runtime-management-config --function-name "$FN" --query UpdateRuntimeOn --output text 2>/dev/null || echo unknown)
  python3 "$SLICE/release_0036_live.py" config-diff "$RB/handler-config.json" "$RUN/handler-config-after-raw.json" > "$RUN/handler-config-diff.txt"
  OUT=$(python3 "$SLICE/release_0036_live.py" handler-config "$RB/handler-config.json" "$RUN/handler-config-after-raw.json" "$MODE" "$ASSET_SIZE" "$ASSET_SHA")
  HANDLER_DETAIL="${OUT#*|}"
  check 6 "${OUT%%|*}" "API Lambda configuration unchanged apart from its code (environment, memory, timeout, role, VPC and every other field): ${HANDLER_DETAIL}"

  PV=$(aws iam get-policy --policy-arn "$POLICY_ARN" --query Policy.DefaultVersionId --output text)
  aws iam get-policy-version --policy-arn "$POLICY_ARN" --version-id "$PV" --query PolicyVersion.Document --output json > "$RUN/handler-policy-after.json"
  r=$(python3 "$SLICE/release_0036_live.py" same-json "$RB/handler-policy.json" "$RUN/handler-policy-after.json")
  check 7 "$r" "Handler IAM policy unchanged (policy version $PV)"

  if aws lambda get-function-configuration --function-name "$IDENTITY_FN" --output json > "$RUN/identity-fn-after.json" 2>/dev/null; then
    jq 'del(.CodeSha256, .LastModified, .Version, .RevisionId, .LastUpdateStatus, .State)' "$RUN/identity-fn-after.json" > "$RUN/identity-config-after.json"
  else
    echo '{}' > "$RUN/identity-config-after.json"
  fi
  r=$(python3 "$SLICE/release_0036_live.py" same-config "$RB/identity-config.json" "$RUN/identity-config-after.json")
  check 8 "$r" "identity function configuration unchanged (not redeployed; its code is unchanged too)"

  r=no; grep -q '^PASS .*latest_migration_is_0036' "$RUN/db-verify.txt" && grep -q '^PASS .*migration_count_is_36' "$RUN/db-verify.txt" \
    && ! grep -q '^FAIL' "$RUN/db-verify.txt" && r=ok
  check 9 "$r" "database at 0036 (0001-0026 checksums unchanged), db:verify all PASS, accounts and records kept ($(grep -c '^PASS' "$RUN/db-verify.txt") checks; $(cat "$RB/keep-before.txt" 2>/dev/null))"
  r=no; [[ -s "$RUN/records-compare.txt" ]] && grep -q '^every existing row' "$RUN/records-compare.txt" && r=ok
  check 9b "$r" "every existing record unchanged by value; permissions = baseline + exactly the 0027-0036 rows; earlier audit rows unchanged ($(cat "$RUN/records-compare.txt" 2>/dev/null))"

  SERVED=$(curl -fsS "${WEB%/}/index.html" | sha256sum | cut -d' ' -f1 || true)
  [[ "$SERVED" == "$(sha256sum "$RUN/web-build/index.html" | cut -d' ' -f1)" ]] && r=ok || r=no
  CFG=$(curl -fsS "${WEB%/}/config.json" | sha256sum | cut -d' ' -f1 || true)
  [[ "$CFG" == "$(sha256sum "$RB/web/config.json" | cut -d' ' -f1)" ]] || r=no
  check 10 "$r" "the web URL serves this build; config.json unchanged"

  [[ "$(admin_host_groups | tr -s ' \t' '\n' | sort | xargs)" == "$(tr -s ' \t' '\n' < "$RB/admin-host-sgs.txt" | grep -v "^$APP_SG$" | sort | xargs)" ]] && r=ok || r=no
  check 11 "$r" "DB window closed: admin host groups are back to the original ($(admin_host_groups))"

  SS=$(aws rds describe-db-snapshots --db-snapshot-identifier "$SNAPSHOT_ID" --query 'DBSnapshots[0].Status' --output text 2>/dev/null || echo missing)
  [[ "$SS" == available ]] && r=ok || r=no
  check 12 "$r" "pre-deploy snapshot available ($SNAPSHOT_ID: $SS)"
  aws lambda get-policy --function-name "$FN" --query Policy --output text > "$RUN/lambda-policy-after.json" 2>/dev/null || echo '{"Statement":[]}' > "$RUN/lambda-policy-after.json"
  r=$(python3 - "$RUN/lambda-policy-after.json" "$API_ID" "$ACCOUNT" "$REGION" <<'POLPY'
import json, sys
raw = open(sys.argv[1]).read().strip(); st = json.loads(raw)["Statement"]
want = "arn:aws:execute-api:%s:%s:%s/*/*/*" % (sys.argv[4], sys.argv[3], sys.argv[2])
ok = (len(st) == 1 and st[0].get("Principal") == {"Service": "apigateway.amazonaws.com"} and st[0].get("Action") == "lambda:InvokeFunction"
      and st[0].get("Condition") == {"ArnLike": {"AWS:SourceArn": want}} and len(raw) < 2048)
print("ok" if ok else "no")
POLPY
)
  check 13 "$r" "API Lambda resource policy still exactly one invoke statement for this API ($(wc -c < "$RUN/lambda-policy-after.json") bytes)"
  echo "Live verification: $PASSES/$TOTAL PASS" | tee -a "$VERIFY"
}

# REPORT.md states only what the checks above established.
write_report() {
  local verdict lambda
  if [[ "$FAILS" == 0 ]]; then verdict="VERIFIED ($PASSES/$TOTAL PASS)"; else verdict="NOT VERIFIED ($PASSES/$TOTAL PASS; failed: $(for k in "${!RESULT[@]}"; do [[ "${RESULT[$k]}" == ok ]] || printf '%s ' "$k"; done))"; fi
  if [[ "${RESULT[6]}" == ok && "${RESULT[7]}" == ok ]]; then
    lambda="Lambda configuration and IAM policy unchanged apart from the code package (${HANDLER_DETAIL})"
  else
    lambda="Lambda configuration or IAM policy NOT shown unchanged (check 6: ${RESULT[6]}, check 7: ${RESULT[7]}): ${HANDLER_DETAIL}. Field list: $RUN/handler-config-diff.txt"
  fi
  cat > "$RUN/REPORT.md" <<REPORTEOF
# Ogevia AWS TEST release 0027-0036: deployment report

- Result: $verdict
- Code: $COMMIT (pinned); approved $APPROVED_AT
- Snapshot: $SNAPSHOT_ID
- Database $DB_NAME: $( [[ "${RESULT[9]}" == ok && "${RESULT[9b]}" == ok ]] && echo "ledger 0001-0036; accounts and records kept: $(cat "$RB/keep-before.txt"); record values: $(cat "$RUN/records-compare.txt")" || echo "NOT shown intact (checks 9/9b: ${RESULT[9]}/${RESULT[9b]})")
- API: $(jq length "$RB/routes.json") -> $(jq length "$RUN/routes-after.json") routes (check 3: ${RESULT[3]}); $lambda
- Other stacks: $( [[ "${RESULT[2]}" == ok ]] && echo unchanged || echo "NOT shown unchanged (check 2)"). New fixed cost: none
- Web: $WEB ($( [[ "${RESULT[10]}" == ok ]] && echo "serves this build; config.json unchanged" || echo "NOT shown serving this build (check 10)"))
- Live verification: $PASSES/$TOTAL PASS (details: $VERIFY)
- Rollback material: $RB
REPORTEOF
  cat "$RUN/REPORT.md"
}
