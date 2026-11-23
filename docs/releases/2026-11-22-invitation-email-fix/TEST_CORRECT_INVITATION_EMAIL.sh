#!/usr/bin/env bash
# TEST ONLY: runs CORRECT_INVITATION_EMAIL.sh against the isolated TEST database and the TEST user pool, through the existing TEST database session (TEST_DB_SESSION.sh).
#   REPO=<checkout> CAREGIVER_CODE=<code> NEW_EMAIL=<corrected address> REASON=<why> bash TEST_CORRECT_INVITATION_EMAIL.sh                  (default: the correction)
#   PROCEDURE=check  REPO=<checkout> CAREGIVER_CODE=<code> [NEW_EMAIL=<address>] bash TEST_CORRECT_INVITATION_EMAIL.sh       (read-only checks only; changes nothing)
#   PROCEDURE=lookup REPO=<checkout> SEARCH=<part of a name or the code> bash TEST_CORRECT_INVITATION_EMAIL.sh                   (read-only: finds the caregiver code and shows whether the account is still pending)
set -euo pipefail
set +x +H
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""
stop() { echo "STOP: $*" >&2; exit 2; }
: "${REPO:?set REPO to the checkout}"
PROCEDURE="${PROCEDURE:-correct}"; case "$PROCEDURE" in correct) : "${CAREGIVER_CODE:?set CAREGIVER_CODE}"; : "${NEW_EMAIL:?set NEW_EMAIL}"; : "${REASON:?set REASON}";; check) : "${CAREGIVER_CODE:?set CAREGIVER_CODE}";; lookup) : "${SEARCH:?set SEARCH}";; *) stop "PROCEDURE must be correct, check or lookup";; esac
HERE="$REPO/docs/releases/2026-11-22-invitation-email-fix"; TC="$REPO/docs/releases/2026-11-20-test-plan/toolchain"
[[ -f "$HERE/CORRECT_INVITATION_EMAIL.sh" && -f "$HERE/LOOKUP_INVITATION.sh" && -f "$TC/TEST_DB_SESSION.sh" ]] || stop "the checkout is missing the procedure or the TEST database session script"
[[ "$(aws sts get-caller-identity --query Account --output text)" == 300094796789 ]] || stop "wrong AWS account"
POOL="$(aws cloudformation get-template --stack-name Ogevia-prod-ServiceVerificationApi --template-stage Original --query TemplateBody --output json | grep -o 'us-west-2_[A-Za-z0-9]*' | sort -u)"
[[ "$(wc -l <<<"$POOL")" == 1 && "$POOL" =~ ^us-west-2_[A-Za-z0-9]+$ && "$POOL" != us-west-2_FHJoX71ca ]] || stop "could not identify the TEST user pool (or it is the production pool)"
case "$PROCEDURE" in
  lookup) exec env TARGET=test POOL="$POOL" SEARCH="$SEARCH" ${ORG_SLUG:+ORG_SLUG="$ORG_SLUG"} bash "$TC/TEST_DB_SESSION.sh" bash "$HERE/LOOKUP_INVITATION.sh";;
  check) exec env TARGET=test INVITATION_MODE=check POOL="$POOL" CAREGIVER_CODE="$CAREGIVER_CODE" NEW_EMAIL="${NEW_EMAIL:-}" ${ORG_SLUG:+ORG_SLUG="$ORG_SLUG"} bash "$TC/TEST_DB_SESSION.sh" bash "$HERE/CORRECT_INVITATION_EMAIL.sh";;
  *) exec env TARGET=test POOL="$POOL" CAREGIVER_CODE="$CAREGIVER_CODE" NEW_EMAIL="$NEW_EMAIL" REASON="$REASON" ${ORG_SLUG:+ORG_SLUG="$ORG_SLUG"} bash "$TC/TEST_DB_SESSION.sh" bash "$HERE/CORRECT_INVITATION_EMAIL.sh";;
esac
