#!/usr/bin/env bash
# =============================================================================
# Ogevia SCS PILOT -> AWS TEST: rollback, one layer at a time, newest first.
# Uses ONLY what pilot-deploy.sh captured before it changed anything
# (~/ogevia-pilot-run/rollback). Each layer asks you to type its name.
#
#   bash infra/aws/slice/pilot-rollback.sh status
#   bash infra/aws/slice/pilot-rollback.sh web      # previous web files + config
#   bash infra/aws/slice/pilot-rollback.sh api      # previous API stack template
#   bash infra/aws/slice/pilot-rollback.sh users    # disable the 3 pilot sign-ins
#   bash infra/aws/slice/pilot-rollback.sh db       # migrations 0018..0012 down
#
# Never deletes users, snapshots, stacks or the database. A full database
# restore goes to a NEW instance from the pre-pilot snapshot (printed by
# `status`; not automated).
# =============================================================================
set -Eeuo pipefail
# shellcheck source=pilot-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/pilot-lib.sh"
LOG="$RUN/rollback-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$LOG") 2>&1
trap 'die "unexpected error on line $LINENO (command: $BASH_COMMAND)"' ERR
[[ -f "$RB/MANIFEST.json" ]] || die "no rollback capture in $RB (pilot-deploy.sh never reached its capture step)"
LAYER="${1:-status}"
confirm() {
  [[ -t 0 ]] || die "needs an interactive terminal"
  local a; read -r -p "Type ROLLBACK $1 to proceed (anything else cancels): " a
  [[ "$a" == "ROLLBACK $1" ]] || die "cancelled; nothing changed"
}
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT" ]] || die "wrong AWS account"

case "$LAYER" in
  status)
    phase "Rollback status"
    jq . "$RB/MANIFEST.json"
    FN=$(jq -r .lambda "$RB/MANIFEST.json")
    printf 'Lambda code now %s, before %s\n' \
      "$(aws lambda get-function-configuration --function-name "$FN" --query CodeSha256 --output text | cut -c1-12)" \
      "$(jq -r .CodeSha256 "$RB/lambda.json" | cut -c1-12)"
    echo "Completed deploy steps: $(find "$STATE" -type f -printf "%f ")"
    echo "Full DB restore (new instance, never in place):"
    echo "  aws rds restore-db-instance-from-db-snapshot --db-snapshot-identifier $(jq -r .snapshot "$RB/MANIFEST.json") --db-instance-identifier ogevia-prod-postgres-restore --no-publicly-accessible"
    ;;

  web)
    phase "Rollback: web files"
    BUCKET=$(jq -r .siteBucket "$RB/MANIFEST.json"); DIST=$(jq -r .distribution "$RB/MANIFEST.json")
    [[ -f "$RB/web/index.html" ]] || die "no captured web files"
    confirm web
    aws s3 sync "$RB/web/assets" "s3://$BUCKET/assets" --only-show-errors --cache-control "public,max-age=31536000,immutable"
    aws s3 sync "$RB/web" "s3://$BUCKET" --only-show-errors --exclude "assets/*" --exclude "index.html" --exclude "config.json"
    [[ -f "$RB/web/config.json" ]] && aws s3 cp "$RB/web/config.json" "s3://$BUCKET/config.json" --only-show-errors --content-type application/json --cache-control "no-store"
    aws s3 cp "$RB/web/index.html" "s3://$BUCKET/index.html" --only-show-errors --content-type "text/html; charset=utf-8" --cache-control "no-cache"
    INV=$(aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" --query Invalidation.Id --output text)
    aws cloudfront wait invalidation-completed --distribution-id "$DIST" --id "$INV"
    echo "Previous web build restored."
    ;;

  api)
    phase "Rollback: API stack to the captured template"
    T="$RB/templates/$API_STACK.json"
    [[ -f "$T" ]] || die "no captured API template"
    BOOT="cdk-hnb659fds-assets-$ACCOUNT-$REGION"
    # The previous Lambda package must still be in the CDK asset bucket.
    for key in $(jq -r '.Resources[] | select(.Type=="AWS::Lambda::Function") | .Properties.Code.S3Key | strings' "$T"); do
      aws s3api head-object --bucket "$BOOT" --key "$key" >/dev/null || die "previous Lambda package $key is missing from $BOOT"
    done
    confirm api
    KEY="pilot-rollback/$(date -u +%Y%m%dT%H%M%SZ)/$API_STACK.json"
    aws s3 cp "$T" "s3://$BOOT/$KEY" --only-show-errors
    PARAMS=$(jq -r '(.Parameters // {}) | keys[] | "ParameterKey=\(.),UsePreviousValue=true"' "$T" | xargs)
    # shellcheck disable=SC2086
    aws cloudformation update-stack --stack-name "$API_STACK" --template-url "https://$BOOT.s3.$REGION.amazonaws.com/$KEY" \
      ${PARAMS:+--parameters $PARAMS} --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND >/dev/null
    aws cloudformation wait stack-update-complete --stack-name "$API_STACK" || die "stack update did not complete (CloudFormation rolls back on failure)"
    FN=$(jq -r .lambda "$RB/MANIFEST.json")
    [[ "$(aws lambda get-function-configuration --function-name "$FN" --query CodeSha256 --output text)" == "$(jq -r .CodeSha256 "$RB/lambda.json")" ]] \
      || die "the Lambda code is not the captured version"
    echo "API stack and Lambda code restored to the captured version."
    ;;

  users)
    phase "Rollback: disable the pilot sign-ins"
    # shellcheck disable=SC1091
    source "$RUN/inputs.env"
    confirm users
    for e in "$M_EMAIL" "$A_EMAIL" "$B_EMAIL"; do
      if [[ -n "$(sub_of "$e")" ]]; then aws cognito-idp admin-disable-user --user-pool-id "$POOL" --username "$e"; echo "Disabled $e"; fi
    done
    ;;

  db)
    phase "Rollback: database migrations 0018..0012 on $DB_NAME"
    echo "0018, 0017, 0016, 0014, 0013, 0012 restore functions only."
    echo "0015 also DROPS time_out_entered_by / time_out_reason (who closed a missed clock-out, and why)."
    echo "The pre-pilot snapshot holds them. Synthetic data only."
    load_rds_and_host
    confirm db
    trap 'db_window_close' EXIT
    trap 'db_window_close; die "unexpected error on line $LINENO (command: $BASH_COMMAND)"' ERR
    db_window_open
    for v in 0018 0017 0016 0015 0014 0013 0012; do
      f=$(ls "$HERE/db/rollback/${v}_"*.down.sql)
      if [[ -z "$(Q -d "$DB_NAME" -c "select 1 from ogevia_meta.schema_migrations where version = '$v'")" ]]; then
        echo "$v: not applied"; continue
      fi
      {
        echo "set local role ogevia_owner;"
        sed -E 's/delete from ogevia_meta[^;]*;//' "$f"
        echo "reset role;"
        echo "delete from ogevia_meta.schema_migrations where version = '$v';"
      } | psql -X -q -v ON_ERROR_STOP=1 -1 -d "$DB_NAME" -f - >/dev/null || die "rollback $v failed (its transaction rolled back)"
      echo "$v: rolled back"
    done
    echo "Ledger now: $(Q -d "$DB_NAME" -c "select max(version) from ogevia_meta.schema_migrations")"
    db_window_close
    trap - EXIT
    ;;

  *) sed -n '2,17p' "$0"; exit 2 ;;
esac
