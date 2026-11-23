#!/usr/bin/env bash
# PRODUCTION: runs CORRECT_INVITATION_EMAIL.sh against ogevia_prd and the production user pool. The only production access change is TEMPORARY and reversible, as in the earlier production steps: the application database
# security group is attached to the admin host for the tunnel and removed again on exit (also on failure). Only the caregiver named by CAREGIVER_CODE can change, and only if the guards in the procedure hold.
#   REPO=<checkout> OGEVIA_RELEASE_COMMIT=<sha> WORK=<dir> CAREGIVER_CODE=<code> NEW_EMAIL=<corrected address> REASON=<why> OGEVIA_DEPLOY_APPROVAL=owner-production-invitation-email-go bash PRD_CORRECT_INVITATION_EMAIL.sh
set -euo pipefail
set +x +H
umask 077
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER="" PYTHONDONTWRITEBYTECODE=1
stop() { echo "STOP: $*" >&2; exit 2; }
PROCEDURE="${PROCEDURE:-correct}"
case "$PROCEDURE" in
  correct) [[ "${OGEVIA_DEPLOY_APPROVAL:-}" == owner-production-invitation-email-go ]] || stop "production owner authorization is required (OGEVIA_DEPLOY_APPROVAL=owner-production-invitation-email-go)";;
  check|lookup) [[ "${OGEVIA_DEPLOY_APPROVAL:-}" == owner-production-invitation-email-readonly ]] || stop "production owner authorization is required for the read-only check (OGEVIA_DEPLOY_APPROVAL=owner-production-invitation-email-readonly)";;
  *) stop "PROCEDURE must be correct, check or lookup";;
esac
: "${REPO:?set REPO}"; : "${OGEVIA_RELEASE_COMMIT:?set OGEVIA_RELEASE_COMMIT}"; : "${WORK:?set WORK}"
case "$PROCEDURE" in correct) : "${CAREGIVER_CODE:?set CAREGIVER_CODE}"; : "${NEW_EMAIL:?set NEW_EMAIL}"; : "${REASON:?set REASON}";; check) : "${CAREGIVER_CODE:?set CAREGIVER_CODE}";; lookup) : "${SEARCH:?set SEARCH}";; esac
[[ "$(git -C "$REPO" rev-parse HEAD)" == "$OGEVIA_RELEASE_COMMIT" ]] || stop "the checkout is not at the release commit"
[[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop "tracked files in the checkout are modified"
HERE="$REPO/docs/releases/2026-11-22-invitation-email-fix"; [[ -f "$HERE/CORRECT_INVITATION_EMAIL.sh" && -f "$HERE/LOOKUP_INVITATION.sh" ]] || stop "the procedure is missing from the checkout"
A() { timeout --foreground -k 5 "${OGEVIA_AWS_TIMEOUT:-300}" aws --cli-connect-timeout 5 --cli-read-timeout 120 "$@"; }
[[ "$(A sts get-caller-identity --query Account --output text)" == 300094796789 ]] || stop "wrong AWS account (expected 300094796789 in us-west-2)"
POOL=us-west-2_FHJoX71ca
# Production refers to its user pool through the Ogevia-prd-Auth stack (an import), not as a literal: check that the Auth stack owns the expected pool AND that the API uses it (literal id or that import).
[[ "$(A cloudformation describe-stacks --stack-name Ogevia-prd-Auth --query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text)" == "$POOL" ]] || stop "the production Auth stack does not own the expected user pool"
# (stored first, then searched: under pipefail a quiet grep that stops reading early makes the writer fail with a broken pipe, and a check that passed would be reported as failed)
API_TEMPLATE="$(A cloudformation get-template --stack-name Ogevia-prd-ServiceVerificationApi --template-stage Original --query TemplateBody --output json)"
grep -Eq "$POOL|Ogevia-prd-Auth:ExportsOutputRefUserPool" <<<"$API_TEMPLATE" || stop "the production API does not use the expected user pool"
HOST=ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com
IID=i-0ce8db2d7e5839dd5; ADMIN=sg-00e01e2ca80442c1f; APP=sg-064ffce3bcbe8eb3b
ATTACHED=0; TUNNEL=""
mkdir -p "$WORK"; chmod 700 "$WORK"
cleanup() {
  rc=$?; trap - EXIT; unset PGPASSWORD MASTER
  if [[ -n "$TUNNEL" ]]; then pkill -P "$TUNNEL" 2>/dev/null || true; kill "$TUNNEL" 2>/dev/null || true; wait "$TUNNEL" 2>/dev/null || true; fi
  if [[ "$ATTACHED" == 1 ]]; then
    groups=$(A ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text | tr '\t' '\n' | sort | xargs) || groups=''
    both=$(printf '%s\n%s\n' "$ADMIN" "$APP" | sort | xargs)
    if [[ "$groups" == "$ADMIN" ]]; then echo 'ADMIN HOST RESTORED';
    elif [[ "$groups" == "$both" ]] && A ec2 modify-instance-attribute --instance-id "$IID" --groups "$ADMIN" && [[ "$(A ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)" == "$ADMIN" ]]; then echo 'ADMIN HOST RESTORED';
    else echo "RESTORE FAILED: restore $ADMIN only on $IID"; rc=1; fi
  fi
  exit "$rc"
}
trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
A rds describe-db-instances --db-instance-identifier ogevia-prod-postgres --query 'DBInstances[0].{host:Endpoint.Address,public:PubliclyAccessible,status:DBInstanceStatus,master:MasterUserSecret.SecretArn}' --output json > "$WORK/rds.json"
jq -e --arg host "$HOST" '.host==$host and .public==false and .status=="available"' "$WORK/rds.json" >/dev/null || stop "the production database is not the expected private, available instance"
[[ "$(A ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)" == "$ADMIN" ]] || stop "the admin host's security groups differ from the expected single group"
curl -fsS --connect-timeout 10 --max-time 60 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o "$WORK/ca.pem"
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
ATTACHED=1; A ec2 modify-instance-attribute --instance-id "$IID" --groups "$ADMIN" "$APP"
sleep "${OGEVIA_SG_WAIT:-5}"
A ssm start-session --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters "{\"host\":[\"$HOST\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"$PORT\"]}" > "$WORK/tunnel.log" 2>&1 &
TUNNEL=$!; UP=0
for n in $(seq 1 30); do if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then UP=1; break; fi; kill -0 "$TUNNEL" 2>/dev/null || break; sleep 1; done
[[ "$UP" == 1 ]] || stop "the production tunnel did not start"
MASTER=$(A secretsmanager get-secret-value --secret-id "$(jq -er .master "$WORK/rds.json")" --query SecretString --output text)
export PGUSER; PGUSER=$(jq -er .username <<<"$MASTER")
export PGPASSWORD; PGPASSWORD=$(jq -er .password <<<"$MASTER"); unset MASTER
unset PGSERVICE PGSERVICEFILE PGPASSFILE
export PGHOST="$HOST" PGHOSTADDR=127.0.0.1 PGPORT="$PORT" PGSSLMODE=verify-full PGSSLROOTCERT="$WORK/ca.pem" PGCONNECT_TIMEOUT=15 PGDATABASE=ogevia_prd PGOPTIONS='-c statement_timeout=120000'
case "$PROCEDURE" in
  lookup) TARGET=production POOL="$POOL" SEARCH="$SEARCH" ${ORG_SLUG:+ORG_SLUG="$ORG_SLUG"} bash "$HERE/LOOKUP_INVITATION.sh";;
  check) TARGET=production INVITATION_MODE=check POOL="$POOL" CAREGIVER_CODE="$CAREGIVER_CODE" NEW_EMAIL="${NEW_EMAIL:-}" ${ORG_SLUG:+ORG_SLUG="$ORG_SLUG"} bash "$HERE/CORRECT_INVITATION_EMAIL.sh";;
  *) TARGET=production POOL="$POOL" CAREGIVER_CODE="$CAREGIVER_CODE" NEW_EMAIL="$NEW_EMAIL" REASON="$REASON" ${ORG_SLUG:+ORG_SLUG="$ORG_SLUG"} bash "$HERE/CORRECT_INVITATION_EMAIL.sh";;
esac
