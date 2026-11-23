#!/usr/bin/env bash
# PRODUCTION SCHEDULE CLEAR. Owner GO: "All steps go" (2026-11-21), after the read-only preview matched the stated rule (no visits, Care Request shifts, call-outs, make-ups or pickups in the window).
# Cancels (never deletes) every unworked shift dated 2026-11-01 or later and ends the recurring series from 2026-11-01. Clients, caregivers, authorizations and every worked/verified visit are untouched; the SQL proves it before it commits.
# Order: verified logical backup to the private encrypted bucket -> CLEAR_SCHEDULE.sql in ONE transaction (all or nothing) -> the preview again, which must show nothing left to clear.
# Undo: cancelled shifts cannot be un-cancelled in the app; the only full undo is restoring from the backup this script saves. New shifts can be added again from the Schedule.
#   REPO=<checkout at the release commit> OGEVIA_RELEASE_COMMIT=<full sha> WORK=<work dir> EXPECT_NOV=<n> EXPECT_DEC=<n> EXPECT_SERIES=<n> [ORG_SLUG=<slug>] OGEVIA_DEPLOY_APPROVAL=owner-production-schedule-clear-go bash PRD_SCHEDULE_CLEAR.sh
set -euo pipefail
set +x +H
umask 077
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER="" PYTHONDONTWRITEBYTECODE=1
stop() { echo "STOP: $*" >&2; exit 2; }
[[ "${OGEVIA_DEPLOY_APPROVAL:-}" == owner-production-schedule-clear-go ]] || stop "production owner authorization is required (OGEVIA_DEPLOY_APPROVAL=owner-production-schedule-clear-go)"
: "${REPO:?set REPO}"; : "${OGEVIA_RELEASE_COMMIT:?set OGEVIA_RELEASE_COMMIT}"; : "${WORK:?set WORK}"
: "${EXPECT_NOV:?set EXPECT_NOV from the preview}"; : "${EXPECT_DEC:?set EXPECT_DEC from the preview}"; : "${EXPECT_SERIES:?set EXPECT_SERIES from the preview}"
[[ "$EXPECT_NOV" =~ ^[0-9]+$ && "$EXPECT_DEC" =~ ^[0-9]+$ && "$EXPECT_SERIES" =~ ^[0-9]+$ ]] || stop "the expected counts must be whole numbers"
[[ "$(git -C "$REPO" rev-parse HEAD)" == "$OGEVIA_RELEASE_COMMIT" ]] || stop "the checkout is not at the release commit"
[[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop "tracked files in the checkout are modified"
CLEAR="$REPO/docs/releases/2026-11-21-schedule-clear/CLEAR_SCHEDULE.sql"; PREVIEW="$REPO/docs/releases/2026-11-21-schedule-clear/PREVIEW_SCHEDULE_CLEAR.sql"
[[ "$(sha256sum "$CLEAR" | cut -d' ' -f1)" == 7796f4b62f9b231cfc62396b78fefb0f9ec62d4b20a6cdb42476f6e437833778 ]] || stop "CLEAR_SCHEDULE.sql differs from the reviewed bytes"
[[ "$(sha256sum "$PREVIEW" | cut -d' ' -f1)" == 7fa223679a93246f2760f967418417281e01a65e345aa704faa1593c3665af4e ]] || stop "PREVIEW_SCHEDULE_CLEAR.sql differs from the reviewed bytes"
A() { timeout --foreground -k 5 "${OGEVIA_AWS_TIMEOUT:-300}" aws --cli-connect-timeout 5 --cli-read-timeout 120 "$@"; }
[[ "$(A sts get-caller-identity --query Account --output text)" == 300094796789 ]] || stop "wrong AWS account (expected 300094796789 in us-west-2)"
confirm() { local got; echo; echo "$2"; if [[ "${OGEVIA_NO_CONFIRM:-}" == 1 ]]; then return 0; fi
  printf 'Type exactly  %s  to continue: ' "$1" > /dev/tty; read -r got < /dev/tty; [[ "$got" == "$1" ]] || stop "confirmation not given"; }
HOST=ogevia-prod-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com
IID=i-0ce8db2d7e5839dd5; ADMIN=sg-00e01e2ca80442c1f; APP=sg-064ffce3bcbe8eb3b
ASSETS=cdk-hnb659fds-assets-300094796789-us-west-2
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
A rds describe-db-instances --db-instance-identifier ogevia-prod-postgres --query 'DBInstances[0].{host:Endpoint.Address,public:PubliclyAccessible,status:DBInstanceStatus,days:BackupRetentionPeriod,encrypted:StorageEncrypted,protected:DeletionProtection,master:MasterUserSecret.SecretArn}' --output json > "$WORK/rds.json"
jq -e --arg host "$HOST" '.host==$host and .public==false and .status=="available" and .days>=7 and .encrypted and .protected' "$WORK/rds.json" >/dev/null || stop "the production database is not the expected private, protected instance"
[[ "$(A ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)" == "$ADMIN" ]] || stop "the admin host's security groups differ from the expected single group"
A s3api get-public-access-block --bucket "$ASSETS" --query PublicAccessBlockConfiguration --output json | jq -e '.BlockPublicAcls and .IgnorePublicAcls and .BlockPublicPolicy and .RestrictPublicBuckets' >/dev/null || stop "the backup bucket must be private"
A s3api get-bucket-encryption --bucket "$ASSETS" --query 'ServerSideEncryptionConfiguration.Rules' --output json | jq -e 'length>0 and all(.[]; .ApplyServerSideEncryptionByDefault.SSEAlgorithm=="AES256" or .ApplyServerSideEncryptionByDefault.SSEAlgorithm=="aws:kms")' >/dev/null || stop "the backup bucket must be encrypted"
major=$(pg_dump --version 2>/dev/null | sed -E 's/.* ([0-9]+)\..*/\1/' || true)
[[ "$major" =~ ^[0-9]+$ && "$major" -ge 18 ]] || stop "PostgreSQL 18 or newer pg_dump is required (the earlier blocks installed it)"
confirm CLEAR-PRODUCTION-SCHEDULE "PRODUCTION DATA CHANGE (owner GO): save a verified backup of ogevia_prd, then in ONE transaction cancel every unworked shift dated 2026-11-01 or later (expected: $EXPECT_NOV in November, $EXPECT_DEC from December 1) and end $EXPECT_SERIES recurring series. Nothing is deleted; authorizations, clients, caregivers and worked visits are untouched. Undo = restore the backup. It temporarily attaches the application database security group to the admin host and removes it again."
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
export PGHOST="$HOST" PGHOSTADDR=127.0.0.1 PGPORT="$PORT" PGSSLMODE=verify-full PGSSLROOTCERT="$WORK/ca.pem" PGCONNECT_TIMEOUT=15 PGDATABASE=ogevia_prd PGOPTIONS='-c statement_timeout=300000'
[[ "$(psql -X -qAt --no-password -c 'select current_database()')" == ogevia_prd ]] || stop "connected to the wrong database"
SZ=$(psql -X -qAt --no-password -c 'select pg_database_size(current_database())'); FREE=$(df -Pk "$WORK" | awk 'NR==2{print $4*1024}')
echo "production database bytes: $SZ   free bytes: $FREE"; [[ "$FREE" -gt $((SZ + 200*1024*1024)) ]] || stop "not enough free space for the backup"
echo "=== 1. verified backup ==="
pg_dump --no-password --format=custom --file="$WORK/production-before-clear.dump"
pg_restore --list "$WORK/production-before-clear.dump" > "$WORK/backup-toc.txt"
grep -Eq '^;[[:space:]]*dbname: ogevia_prd$' "$WORK/backup-toc.txt" || stop "the backup is not production"
(cd "$WORK" && sha256sum production-before-clear.dump > production-before-clear.dump.sha256 && sha256sum --check --quiet production-before-clear.dump.sha256)
PREFIX="s3://$ASSETS/ogevia-production-release/schedule-clear-$(date -u +%Y%m%dT%H%M%SZ)"
A s3 cp "$WORK/production-before-clear.dump" "$PREFIX/production-before-clear.dump" --only-show-errors
A s3 cp "$WORK/production-before-clear.dump.sha256" "$PREFIX/production-before-clear.dump.sha256" --only-show-errors
A s3api head-object --bucket "$ASSETS" --key "${PREFIX#s3://$ASSETS/}/production-before-clear.dump" --query ContentLength --output text | grep -Eq '^[1-9][0-9]*$' || stop "the backup was not saved to the private bucket"
echo "PRIVATE BACKUP SAVED: $PREFIX/production-before-clear.dump"
echo "=== 2. the clear (one transaction) ==="
CLEAR_OUT="$WORK/clear-$(date -u +%Y%m%dT%H%M%SZ).txt"
if ! psql -X -At -F '|' --no-password -v ON_ERROR_STOP=1 -v "org_slug=${ORG_SLUG:-}" -v "expect_nov=$EXPECT_NOV" -v "expect_dec=$EXPECT_DEC" -v "expect_series=$EXPECT_SERIES" -f "$CLEAR" > "$CLEAR_OUT" 2>&1; then
  cat "$CLEAR_OUT"; stop "the clear stopped; its transaction rolled back and nothing was changed (see the message above)"
fi
cat "$CLEAR_OUT"
echo "=== 3. the preview again: nothing may be left to clear ==="
psql -X -At -F '|' --no-password -v ON_ERROR_STOP=1 -v "org_slug=${ORG_SLUG:-}" -f "$PREVIEW" > "$WORK/after-$(date -u +%Y%m%dT%H%M%SZ).txt" 2>&1; cat "$WORK"/after-*.txt
echo "=== END: the schedule clear is complete; send everything above. Undo = restore $PREFIX/production-before-clear.dump ==="
