#!/usr/bin/env bash
# =============================================================================
# Ogevia AWS TEST release 0027-0036: rollback, one layer at a time, in this
# order: web, api, (db only if really needed).
# Uses ONLY what release-0036-deploy.sh captured before it changed anything
# (~/ogevia-release-0036-run/rollback). Earlier run folders are not used.
#
#   bash infra/aws/slice/release-0036-rollback.sh status   # read-only
#   bash infra/aws/slice/release-0036-rollback.sh export   # read-only copy of records made since DEPLOY
#   bash infra/aws/slice/release-0036-rollback.sh web      # previous web files (config.json untouched)
#   bash infra/aws/slice/release-0036-rollback.sh api      # previous API template: removes the 32 routes;
#                                                          # previous Lambda code
#   bash infra/aws/slice/release-0036-rollback.sh db       # 0036..0027 down; REFUSES while their records exist
#
# Records made after the deployment are kept:
# - web and api rollbacks change no data. The previous API never calls the new
#   functions or tables, so they stop being used and remain.
# - db: each down script refuses while records it cannot keep exist (0036
#   confirmation requests, responses or reviews; 0035 daylight-saving skipped
#   dates; 0034 shift series; 0033 custom reminder days; 0031 review decisions; 0030 hire type,
#   flexible scheduling or family relationships; 0029 rounding policies or
#   adjustments; 0028 outage records; 0027 continuity exports - see headers).
# - Nothing here deletes S3 objects (the evidence bucket is versioned).
# - A full restore goes to a NEW instance from the pre-deploy snapshot, never
#   in place (command printed by `status`).
# =============================================================================
set -Eeuo pipefail
export OGEVIA_PILOT_RUN_DIR="${OGEVIA_RELEASE_RUN_DIR:-$HOME/ogevia-release-0036-run}"
# shellcheck source=pilot-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/pilot-lib.sh"
LOG="$RUN/rollback-$(date -u +%Y%m%dT%H%M%SZ).log"
exec > >(tee -a "$LOG") 2>&1
trap 'die "unexpected error on line $LINENO (command: $BASH_COMMAND)"' ERR
[[ -f "$RB/MANIFEST.json" ]] || die "no rollback capture in $RB (release-0036-deploy.sh never reached its capture step)"
LAYER="${1:-status}"
confirm() {
  [[ -t 0 ]] || die "needs an interactive terminal"
  local a; read -r -p "Type ROLLBACK $1 to proceed (anything else cancels): " a
  [[ "$a" == "ROLLBACK $1" ]] || die "cancelled; nothing changed"
}
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT" ]] || die "wrong AWS account"
APPROVED_AT=$(grep '^approved_at=' "$RUN/APPROVAL.txt" 2>/dev/null | cut -d= -f2 || true)

case "$LAYER" in
  status)
    phase "Rollback status (read-only)"
    jq . "$RB/MANIFEST.json"
    FN=$(jq -r .lambda "$RB/MANIFEST.json")
    printf 'Lambda code now %s, before %s\n' \
      "$(aws lambda get-function-configuration --function-name "$FN" --query CodeSha256 --output text | cut -c1-12)" \
      "$(jq -r .CodeSha256 "$RB/lambda.json" | cut -c1-12)"
    echo "Deployment approved at: ${APPROVED_AT:-not approved}"
    echo "Completed deploy steps: $(find "$STATE" -type f -printf "%f ")"
    echo "Full DB restore (to a NEW instance, never in place):"
    echo "  aws rds restore-db-instance-from-db-snapshot --db-snapshot-identifier $(jq -r .snapshot "$RB/MANIFEST.json") --db-instance-identifier ogevia-prod-postgres-restore --no-publicly-accessible"
    ;;

  export)
    phase "Export records created since the deployment (read-only)"
    load_rds_and_host
    OUT="$RUN/export-$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -p "$OUT"; chmod 700 "$OUT"
    trap 'db_window_close' EXIT
    trap 'db_window_close; die "unexpected error on line $LINENO (command: $BASH_COMMAND)"' ERR
    db_window_open
    for t in shift_series shift_series_skipped_dates shifts authorization_reservations visit_review_decisions billing_rounding_policies billing_rounding_adjustments outage_visit_records continuity_exports caregiver_assignments caregiver_records billing_approvals document_types staff_documents; do
      if [[ -n "$(Q -d "$DB_NAME" -c "select to_regclass('ogevia.$t')")" ]]; then
        psql -X -q -v ON_ERROR_STOP=1 -d "$DB_NAME" -c "\\copy (select * from ogevia.$t) to '$OUT/$t.csv' csv header"
        echo "$t: $(($(wc -l < "$OUT/$t.csv") - 1)) rows"
      fi
    done
    psql -X -q -v ON_ERROR_STOP=1 -d "$DB_NAME" -c "\\copy (select * from ogevia.organizations) to '$OUT/organizations.csv' csv header"
    psql -X -q -v ON_ERROR_STOP=1 -d "$DB_NAME" -c "\\copy (select * from ogevia.audit_events where occurred_at >= '${APPROVED_AT:-1970-01-01}') to '$OUT/audit_events_since_deploy.csv' csv header"
    echo "audit events since the deployment: $(($(wc -l < "$OUT/audit_events_since_deploy.csv") - 1)) rows"
    db_window_close
    trap - EXIT
    echo "Exported to $OUT (mode 700; TEST synthetic data only). S3 document and logo files stay in the versioned bucket."
    ;;

  web)
    phase "Rollback: web files (config.json is not changed)"
    BUCKET=$(jq -r .siteBucket "$RB/MANIFEST.json"); DIST=$(jq -r .distribution "$RB/MANIFEST.json")
    [[ -f "$RB/web/index.html" ]] || die "no captured web files"
    confirm web
    aws s3 sync "$RB/web/assets" "s3://$BUCKET/assets" --only-show-errors --cache-control "public,max-age=31536000,immutable"
    aws s3 sync "$RB/web" "s3://$BUCKET" --only-show-errors --exclude "assets/*" --exclude "index.html" --exclude "config.json"
    aws s3 cp "$RB/web/index.html" "s3://$BUCKET/index.html" --only-show-errors --content-type "text/html; charset=utf-8" --cache-control "no-cache"
    INV=$(aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" --query Invalidation.Id --output text)
    aws cloudfront wait invalidation-completed --distribution-id "$DIST" --id "$INV"
    echo "Previous web build restored. No data changed."
    ;;

  api)
    phase "Rollback: API stack to the captured template"
    T="$RB/templates/$API_STACK.json"
    [[ -f "$T" ]] || die "no captured API template"
    BOOT="cdk-hnb659fds-assets-$ACCOUNT-$REGION"
    for key in $(jq -r '.Resources[] | select(.Type=="AWS::Lambda::Function") | .Properties.Code.S3Key | strings' "$T"); do
      aws s3api head-object --bucket "$BOOT" --key "$key" >/dev/null || die "previous Lambda package $key is missing from $BOOT"
    done
    echo "Removes the 32 routes and restores the previous Lambda code. No data changes."
    confirm api
    KEY="release-0036-rollback/$(date -u +%Y%m%dT%H%M%SZ)/$API_STACK.json"
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

  db)
    phase "Rollback: database migrations 0036..0027 on $DB_NAME"
    echo "Each down script REFUSES while records it cannot keep exist (see the header of this script)."
    echo "Run 'export' first. Leaving the database at 0036 after an api/web rollback is safe and keeps every record."
    load_rds_and_host
    confirm db
    trap 'db_window_close' EXIT
    trap 'db_window_close; die "unexpected error on line $LINENO (command: $BASH_COMMAND)"' ERR
    db_window_open
    for v in 0036 0035 0034 0033 0032 0031 0030 0029 0028 0027; do
      f=$(ls "$HERE/db/rollback/${v}_"*.down.sql)
      if [[ -z "$(Q -d "$DB_NAME" -c "select 1 from ogevia_meta.schema_migrations where version = '$v'")" ]]; then
        echo "$v: not applied"; continue
      fi
      if ! { echo "set local role ogevia_owner;"; cat "$f"; echo "reset role;"; echo "delete from ogevia_meta.schema_migrations where version = '$v';"; } \
          | psql -X -q -v ON_ERROR_STOP=1 -1 -d "$DB_NAME" -f - 2>&1 | tee "$RUN/db-rollback-$v.txt"; then
        die "$v was not rolled back and nothing in it changed: $(grep -m1 -oE '(Refusing|ROLLBACK REFUSED)[^.]*' "$RUN/db-rollback-$v.txt" || tail -1 "$RUN/db-rollback-$v.txt"). Keep 0036, or restore the snapshot to a new instance"
      fi
      echo "$v: rolled back"
    done
    echo "Ledger now: $(Q -d "$DB_NAME" -c "select max(version) from ogevia_meta.schema_migrations")"
    db_window_close
    trap - EXIT
    ;;

  *) sed -n '2,24p' "$0"; exit 2 ;;
esac
