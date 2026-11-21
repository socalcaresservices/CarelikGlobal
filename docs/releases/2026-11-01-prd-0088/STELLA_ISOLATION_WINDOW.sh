#!/usr/bin/env bash
# Cross-agency isolation check window (copy of STELLA_PART2_WINDOW.sh from 2026-10-30-caregiver-readiness; ONLY the SQL file and the output name differ). TEST only. NOT RUN.
# Does exactly this: (1) pre-checks, (2) attach the app security group, (3) open the documented SSM tunnel and wait for it,
# (4) connect to ogevia_sv_test ONLY and run STELLA_ISOLATION_READONLY.sql read-only (SET ROLE ogevia_readonly),
# (5) ALWAYS restore the original group and verify it (EXIT trap; also on Ctrl-C, termination and hangup).
# It never starts or stops a host, never touches ogevia_prd, never prints the master secret, never writes to any database.
# Run from CloudShell in this directory:  bash STELLA_PART2_WINDOW.sh        (needs aws, session-manager-plugin, psql, jq)
set +x +H
umask 077
export AWS_PAGER="" AWS_DEFAULT_REGION=us-west-2
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL="$HERE/STELLA_ISOLATION_READONLY.sql"
OUT="$HOME/isolation_results_$(date -u +%Y%m%dT%H%M%SZ).txt"

IID_EXPECT=i-0ce8db2d7e5839dd5; ADMIN_SG=sg-00e01e2ca80442c1f; APP_SG=sg-064ffce3bcbe8eb3b; RDS_SG=sg-00530a1f4f7648e65
RDS_ID=ogevia-prod-postgres; DB=ogevia_sv_test; ACCOUNT=300094796789; TAG=ogevia-db-admin-temp
LOCAL_PORT=15432
ATTACHED=0; TUNNEL=""; CLEANED=0; RDS_SRC_BEFORE=""

# Sorted, space-separated group ids for exact comparison.
host_groups() { aws ec2 describe-instances --instance-ids "$IID_EXPECT" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text 2>/dev/null | tr '\t' '\n' | sort | tr '\n' ' ' | sed 's/ $//'; }
rds_sources() { aws ec2 describe-security-groups --group-ids "$RDS_SG" --query 'SecurityGroups[0].IpPermissions[].UserIdGroupPairs[].GroupId' --output text 2>/dev/null | tr '\t' '\n' | sort | tr '\n' ' ' | sed 's/ $//'; }

cleanup() {                     # runs once, on EVERY exit: success, error, Ctrl-C (INT), TERM, HUP
  local rc=$?
  [[ "$CLEANED" == 1 ]] && exit "$rc"
  CLEANED=1
  trap '' INT TERM HUP          # do not let a second Ctrl-C interrupt the restore
  if [[ -n "$TUNNEL" ]]; then pkill -P "$TUNNEL" 2>/dev/null; kill "$TUNNEL" 2>/dev/null; wait "$TUNNEL" 2>/dev/null; fi
  unset PGPASSWORD PGUSER PGHOST PGPORT PGSSLMODE PGOPTIONS MASTER
  local bad=0
  if [[ "$ATTACHED" == 1 ]]; then
    echo "RESTORE: setting admin host groups back to $ADMIN_SG"
    if ! aws ec2 modify-instance-attribute --instance-id "$IID_EXPECT" --groups "$ADMIN_SG"; then
      echo "!!! RESTORE COMMAND FAILED. Run this by hand NOW:  aws ec2 modify-instance-attribute --instance-id $IID_EXPECT --groups $ADMIN_SG"
      bad=1
    fi
    sleep 3
  fi
  local now_groups now_src
  now_groups="$(host_groups)"; now_src="$(rds_sources)"
  echo "RE-CHECK admin host groups: '$now_groups' (expected '$ADMIN_SG')"
  echo "RE-CHECK RDS SG $RDS_SG ingress sources: '$now_src' (expected unchanged: '$RDS_SRC_BEFORE')"
  [[ "$now_groups" == "$ADMIN_SG" ]] || { echo "!!! ADMIN HOST GROUPS NOT RESTORED OR NOT VERIFIED. Fix by hand NOW and tell the owner."; bad=1; }
  if [[ -n "$RDS_SRC_BEFORE" ]]; then
    [[ "$now_src" == "$RDS_SRC_BEFORE" ]] || { echo "!!! RDS SECURITY GROUP SOURCES DIFFER FROM BEFORE. Do not change anything; tell the owner."; bad=1; }
  fi
  if [[ "$bad" == 0 ]]; then echo "RESTORE VERIFIED: admin host back to baseline, RDS SG unchanged."; else echo "RESTORE NOT VERIFIED (see lines marked !!!)"; [[ "$rc" == 0 ]] && rc=1; fi
  echo "WINDOW END (UTC): $(date -u +%FT%TZ)"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
stop() { echo "STOP: $*"; exit 2; }

echo "WINDOW START (UTC): $(date -u +%FT%TZ)"

# 0. Local checks before anything is changed.
for c in aws psql jq session-manager-plugin; do command -v "$c" >/dev/null 2>&1 || stop "missing required tool: $c (nothing was changed)"; done
[[ -f "$SQL" ]] || stop "cannot find $SQL"
grep -qiE '^begin read only;' "$SQL" || stop "SQL file does not start a read-only transaction"
grep -qiE '^set local role ogevia_readonly;' "$SQL" || stop "SQL file does not set role ogevia_readonly"
grep -qE '^[[:space:]]*\\' "$SQL" && stop "SQL file contains a psql meta-command (could change database or run a shell command)"
if sed -E 's/--.*$//' "$SQL" | grep -qiE '\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|call|do|vacuum|reindex|cluster|comment|merge)\b'; then stop "SQL file contains a write or DDL keyword outside comments"; fi
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT" ]] || stop "wrong AWS account"

# 1. Pre-checks (read-only). Never starts the host.
IID=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$TAG" "Name=instance-state-name,Values=running" --query 'Reservations[0].Instances[0].InstanceId' --output text)
[[ "$IID" == "$IID_EXPECT" ]] || stop "admin host is not the expected running instance ('$IID'). Do not start it."
[[ "$(host_groups)" == "$ADMIN_SG" ]] || stop "admin host groups are '$(host_groups)', expected only $ADMIN_SG"
RDS_SRC_BEFORE="$(rds_sources)"
[[ "$RDS_SRC_BEFORE" == "$APP_SG" ]] || stop "RDS SG ingress sources are '$RDS_SRC_BEFORE', expected only $APP_SG"
RDS_HOST=$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0].Endpoint.Address' --output text)
MASTER_ARN=$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)
[[ -n "$RDS_HOST" && "$RDS_HOST" != None && "$MASTER_ARN" == arn:* ]] || stop "could not resolve RDS endpoint or secret ARN"
[[ "$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0].PubliclyAccessible' --output text)" == "False" ]] || stop "RDS is publicly accessible: unexpected"

# 2. The one authorized change: attach the app security group (the trap restores it, even if this call fails midway).
ATTACHED=1
aws ec2 modify-instance-attribute --instance-id "$IID" --groups "$ADMIN_SG" "$APP_SG" || stop "attach failed"
sleep 5

# 3. Documented SSM port-forward to the private RDS instance; WAIT until the local port actually accepts connections.
aws ssm start-session --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$RDS_HOST,portNumber=5432,localPortNumber=$LOCAL_PORT" >/dev/null 2>&1 &
TUNNEL=$!
UP=0
for _ in $(seq 1 30); do
  kill -0 "$TUNNEL" 2>/dev/null || stop "tunnel process exited before the port opened"
  if (exec 3<>"/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null; then UP=1; break; fi
  sleep 1
done
[[ "$UP" == 1 ]] || stop "tunnel did not accept connections within 30 seconds"
echo "tunnel is accepting connections on 127.0.0.1:$LOCAL_PORT"

# 4. Master secret into memory only (never echoed or put on a command line); then ogevia_sv_test ONLY, read-only by default.
unset PGSERVICE PGSERVICEFILE PGDATABASE PGPASSFILE PGUSER PGPASSWORD
MASTER=$(aws secretsmanager get-secret-value --secret-id "$MASTER_ARN" --query SecretString --output text 2>/dev/null) || stop "could not read the secret"
export PGHOST=127.0.0.1 PGPORT="$LOCAL_PORT" PGSSLMODE=require PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=30000"
PGUSER="$(printf '%s' "$MASTER" | jq -r .username)"; PGPASSWORD="$(printf '%s' "$MASTER" | jq -r .password)"; export PGUSER PGPASSWORD   # builtin printf + pipe: no temp file, nothing on a command line
unset MASTER
[[ -n "$PGUSER" && "$PGUSER" != null && -n "$PGPASSWORD" && "$PGPASSWORD" != null ]] || stop "secret did not contain a username and password"
echo "LOGIN ROLE USED (name only): $PGUSER"
GOT=$(psql -X -At -d "$DB" -c "select current_database()") || stop "connection to $DB failed"
[[ "$GOT" == "$DB" ]] || stop "connected database is '$GOT', not $DB"
echo "V1 guard ok: $GOT"
psql -X -v ON_ERROR_STOP=1 -d "$DB" -f "$SQL" 2>&1 | tee "$OUT"
PSQL_RC=${PIPESTATUS[0]}
[[ "$PSQL_RC" == 0 ]] || stop "the verification SQL failed (psql exit $PSQL_RC); results, if any, are in $OUT"
echo "Results saved to $OUT (counts, slugs and settings only; read it before sending)."
