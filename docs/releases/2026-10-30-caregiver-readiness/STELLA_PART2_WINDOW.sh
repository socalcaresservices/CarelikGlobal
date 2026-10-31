#!/usr/bin/env bash
# Part 2b window script (owner decision D14, DECISION_RECORD A7). Operator: Stella Okereke only. NOT RUN.
# Does exactly this: (1) check the admin host, (2) attach the app security group, (3) open the documented SSM tunnel,
# (4) connect to ogevia_sv_test ONLY and run STELLA_READONLY_VERIFICATION.sql (read-only, SET ROLE ogevia_readonly),
# (5) ALWAYS restore the original group and re-check (EXIT trap). It never starts or stops a host, never touches ogevia_prd,
# never prints the master secret, and never writes to any database. Read it fully before running it.
# Run from CloudShell in this directory:  bash STELLA_PART2_WINDOW.sh        (needs aws, psql, jq)
set +x +H
export AWS_PAGER="" AWS_DEFAULT_REGION=us-west-2
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL="$HERE/STELLA_READONLY_VERIFICATION.sql"
OUT="$HOME/part2_results_$(date -u +%Y%m%dT%H%M%SZ).txt"

IID_EXPECT=i-0ce8db2d7e5839dd5; ADMIN_SG=sg-00e01e2ca80442c1f; APP_SG=sg-064ffce3bcbe8eb3b; RDS_SG=sg-00530a1f4f7648e65
RDS_ID=ogevia-prod-postgres; DB=ogevia_sv_test; ACCOUNT=300094796789; TAG=ogevia-db-admin-temp
ATTACHED=0; TUNNEL=""

restore() {                     # runs on EVERY exit, including errors and Ctrl-C
  [[ -n "$TUNNEL" ]] && kill "$TUNNEL" 2>/dev/null
  unset PGPASSWORD PGUSER PGHOST PGPORT PGSSLMODE MASTER
  if [[ "$ATTACHED" == 1 ]]; then
    echo "RESTORE: setting admin host groups back to $ADMIN_SG"
    aws ec2 modify-instance-attribute --instance-id "$IID_EXPECT" --groups "$ADMIN_SG" || echo "RESTORE FAILED: restore by hand NOW: aws ec2 modify-instance-attribute --instance-id $IID_EXPECT --groups $ADMIN_SG"
    sleep 3
  fi
  echo "RE-CHECK admin host groups (expect only $ADMIN_SG):"
  aws ec2 describe-instances --instance-ids "$IID_EXPECT" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text
  echo "RE-CHECK RDS SG ingress sources for $RDS_SG (expect only $APP_SG, unchanged):"
  aws ec2 describe-security-groups --group-ids "$RDS_SG" --query 'SecurityGroups[0].IpPermissions[].UserIdGroupPairs[].GroupId' --output text
  echo "WINDOW END (UTC): $(date -u +%FT%TZ)"
}
trap restore EXIT
stop() { echo "STOP: $*"; exit 2; }

echo "WINDOW START (UTC): $(date -u +%FT%TZ)"
[[ -f "$SQL" ]] || stop "cannot find $SQL"
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT" ]] || stop "wrong AWS account"

# 1. Pre-checks (read-only). Never starts the host.
IID=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$TAG" "Name=instance-state-name,Values=running" --query 'Reservations[0].Instances[0].InstanceId' --output text)
[[ "$IID" == "$IID_EXPECT" ]] || stop "admin host is not the expected running instance ($IID). Do not start it."
GROUPS_NOW=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)
[[ "$GROUPS_NOW" == "$ADMIN_SG" ]] || stop "admin host groups are '$GROUPS_NOW', expected only $ADMIN_SG"
RDS_HOST=$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0].Endpoint.Address' --output text)
MASTER_ARN=$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)
[[ -n "$RDS_HOST" && "$MASTER_ARN" == arn:* ]] || stop "could not resolve RDS endpoint or secret ARN"
[[ "$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0].PubliclyAccessible' --output text)" == "False" ]] || stop "RDS is publicly accessible: unexpected"

# 2. The one authorized change: attach the app security group (restored by the trap).
ATTACHED=1
aws ec2 modify-instance-attribute --instance-id "$IID" --groups "$ADMIN_SG" "$APP_SG" || stop "attach failed"
sleep 5

# 3. Documented SSM port-forward to the private RDS instance.
aws ssm start-session --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$RDS_HOST,portNumber=5432,localPortNumber=15432" >/dev/null &
TUNNEL=$!; sleep 8
kill -0 "$TUNNEL" 2>/dev/null || stop "tunnel did not start"

# 4. Master secret into memory only (never echoed); then ogevia_sv_test ONLY.
MASTER=$(aws secretsmanager get-secret-value --secret-id "$MASTER_ARN" --query SecretString --output text) || stop "could not read the secret"
export PGHOST=127.0.0.1 PGPORT=15432 PGSSLMODE=require PGUSER="$(jq -r .username <<<"$MASTER")" PGPASSWORD="$(jq -r .password <<<"$MASTER")"
unset MASTER
echo "LOGIN ROLE USED (name only): $PGUSER"
GOT=$(psql -X -At -d "$DB" -c "select current_database()") || stop "connection to $DB failed"
[[ "$GOT" == "$DB" ]] || stop "connected database is '$GOT', not $DB"
echo "V1 guard ok: $GOT"
psql -X -v ON_ERROR_STOP=1 -d "$DB" -f "$SQL" 2>&1 | tee "$OUT"
echo "Results saved to $OUT (counts, slugs and settings only; read it before sending)."
