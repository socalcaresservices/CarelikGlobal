#!/usr/bin/env bash
# =============================================================================
# Ogevia: READ-ONLY migration-ledger check for ONE environment at a time. Run in AWS CloudShell (us-west-2).
#   bash ledger-check-readonly.sh test    TEST / pilot       stacks Ogevia-prod-*  database ogevia_sv_test  (synthetic data)
#   bash ledger-check-readonly.sh prod    PRODUCTION cand.   stacks Ogevia-prd-*   database ogevia_prd      (intended for real data)
#
# Answers one question: has any database applied a migration numbered 0053 or higher?
#   select version, checksum from ogevia_meta.schema_migrations where version >= '0053' order by version;     expected: no rows
#
# WHAT IT NEVER DOES: change an AWS resource, a security group, a secret, a stack, a Lambda, a bucket or any database object.
# Every `aws` call is describe-, list- or get-; the database part runs in one READ ONLY transaction that is rolled back.
# TWO SIDE EFFECTS REMAIN, and both only leave audit records (they change no setting):
#   1. aws secretsmanager get-secret-value   reads the RDS master credential into shell memory (never printed, never written to a
#                                            file; unset on exit). CloudTrail records the read.
#   2. aws ssm start-session                 opens a Session Manager port-forward from CloudShell to the private database through the
#                                            admin host. Session Manager history records it; it is closed on exit.
# It does NOT attach or detach any security group. If the admin host cannot already reach the database, it STOPS and says so
# (the repository's other scripts open a "DB window" that temporarily changes the host's security groups; this one will not).
#
# TEST and PRODUCTION are two DATABASES ON THE SAME RDS INSTANCE (ogevia-prod-postgres, same master credential). The script therefore
# proves which one it is connected to (current_database()) and that it matches the environment you named, before it queries.
# Output: ~/ogevia-ledger-check-<env>-<UTC>/RESULT.txt (mode 700 folder). No credentials are in it.
# =============================================================================
set -uo pipefail
ENV_NAME="${1:-}"
ACCOUNT=300094796789
REGION=us-west-2
RDS_ID=ogevia-prod-postgres
ADMIN_TAG=ogevia-db-admin-temp
case "$ENV_NAME" in
  test) LABEL="TEST / pilot (synthetic data)";        API_STACK=Ogevia-prod-ServiceVerificationApi; DB_EXPECT=ogevia_sv_test; ENV_MUST_BE_PRD=no ;;
  prod) LABEL="PRODUCTION candidate (real-data path)"; API_STACK=Ogevia-prd-ServiceVerificationApi;  DB_EXPECT=ogevia_prd;     ENV_MUST_BE_PRD=yes ;;
  *) echo "usage: bash ledger-check-readonly.sh test|prod   (one environment per run)" >&2; exit 2 ;;
esac
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION AWS_PAGER=""
OUT="${OGEVIA_LEDGER_DIR:-$HOME/ogevia-ledger-check-$ENV_NAME-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT"; chmod 700 "$OUT"
RESULT="$OUT/RESULT.txt"; : > "$RESULT"
LOCAL_PORT=${OGEVIA_LEDGER_PORT:-15439}
TUN=""; IID=""
say() { printf '%s\n' "$*" | tee -a "$RESULT"; }
stop() { say ""; say "STOPPED: $*"; say "Nothing was changed. Send this output to Claude."; exit 1; }
cleanup() { [[ -n "$TUN" ]] && kill "$TUN" 2>/dev/null; [[ -n "$IID" ]] && pkill -f "session-manager-plugin.*$IID" 2>/dev/null; unset PGPASSWORD PGUSER SEC; }
trap cleanup EXIT
for t in aws jq psql session-manager-plugin; do
  command -v "$t" >/dev/null 2>&1 || stop "missing tool '$t'. Install the PostgreSQL 15 client (CloudShell package name postgresql15) and the AWS Session Manager plugin (AWS documentation: 'Install the Session Manager plugin on Linux') yourself; this script installs nothing."
done

say "================================================================"
say "ENVIRONMENT REQUESTED : $ENV_NAME  =  $LABEL"
say "Expected database     : $DB_EXPECT   (API stack $API_STACK)"
say "UTC time              : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "================================================================"

say ""; say "== 1. AWS account and region"
IDENT=$(aws sts get-caller-identity --output json 2>/dev/null) || stop "no valid AWS credentials: sign in again and reopen CloudShell in us-west-2"
[[ "$(jq -r .Account <<<"$IDENT")" == "$ACCOUNT" ]] || stop "wrong AWS account $(jq -r .Account <<<"$IDENT") (expected $ACCOUNT)"
say "account $ACCOUNT, region $REGION: OK   caller role: $(jq -r .Arn <<<"$IDENT" | sed 's#.*assumed-role/\([^/]*\)/.*#\1#')"

say ""; say "== 2. This environment's API stack and the database its Lambda is configured for (names only; no other settings are printed)"
STATUS=$(aws cloudformation describe-stacks --stack-name "$API_STACK" --query 'Stacks[0].StackStatus' --output text 2>/dev/null) || stop "stack $API_STACK not found: this environment is not deployed under that name. Missing information: the real stack name or whether it exists."
say "stack $API_STACK: $STATUS"
API_URL=$(aws cloudformation describe-stacks --stack-name "$API_STACK" --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text 2>/dev/null)
say "API URL: ${API_URL:-unknown}"
FN=$(aws cloudformation list-stack-resources --stack-name "$API_STACK" --output json 2>/dev/null | jq -r '[.StackResourceSummaries[] | select(.ResourceType=="AWS::Lambda::Function" and (.LogicalResourceId|startswith("Handler")))][0].PhysicalResourceId // empty')
[[ -n "$FN" ]] || stop "API handler Lambda not found in $API_STACK"
CFG=$(aws lambda get-function-configuration --function-name "$FN" --output json 2>/dev/null) || stop "cannot read Lambda $FN"
L_DB=$(jq -r '.Environment.Variables.DB_NAME // empty' <<<"$CFG"); L_ENV=$(jq -r '.Environment.Variables.OGEVIA_ENV // empty' <<<"$CFG")
say "Lambda $FN: DB_NAME=${L_DB:-unset}  OGEVIA_ENV=${L_ENV:-unset}"
[[ "$L_DB" == "$DB_EXPECT" ]] || stop "the Lambda in $API_STACK serves database '${L_DB:-unset}', not '$DB_EXPECT'. The environment is not what was requested."
if [[ "$ENV_MUST_BE_PRD" == yes ]]; then [[ "$L_ENV" == prd ]] || stop "production stack but OGEVIA_ENV is '$L_ENV' (expected prd)"; else [[ "$L_ENV" != prd ]] || stop "TEST run but the Lambda says OGEVIA_ENV=prd"; fi
say "Environment identified: $LABEL. Its API serves $DB_EXPECT."

say ""; say "== 3. The database instance (shared by TEST and PRODUCTION) and whether the admin host can ALREADY reach it"
RDS=$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0]' --output json 2>/dev/null) || stop "cannot describe RDS $RDS_ID"
[[ "$(jq -r .DBInstanceStatus <<<"$RDS")" == available ]] || stop "RDS $RDS_ID is $(jq -r .DBInstanceStatus <<<"$RDS") (need available)"
[[ "$(jq -r .PubliclyAccessible <<<"$RDS")" == false ]] || stop "RDS is publicly accessible: unexpected, do not continue"
RDS_HOST=$(jq -r .Endpoint.Address <<<"$RDS"); RDS_SGS=$(jq -r '[.VpcSecurityGroups[].VpcSecurityGroupId] | join(" ")' <<<"$RDS")
say "RDS $RDS_ID available, private. Host ${RDS_HOST%%.*}... (this one instance holds BOTH ogevia_sv_test and ogevia_prd)"
HOST=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$ADMIN_TAG" "Name=instance-state-name,Values=running" --query 'Reservations[0].Instances[0].[InstanceId,SecurityGroups[].GroupId]' --output json 2>/dev/null)
[[ -n "$HOST" && "$HOST" != null && "$HOST" != "[null,null]" ]] || stop "admin host '$ADMIN_TAG' is not running. Starting it is a change this script will not make. Missing: a running admin host (or the owner's approval to start it)."
IID=$(jq -r '.[0]' <<<"$HOST"); HOST_SGS=$(jq -r '.[1] | join(" ")' <<<"$HOST")
say "admin host $IID, security groups: $HOST_SGS"
REACH=no
for sg in $RDS_SGS; do
  allowed=$(aws ec2 describe-security-groups --group-ids "$sg" --query 'SecurityGroups[0].IpPermissions[?FromPort<=`5432` && ToPort>=`5432`].UserIdGroupPairs[].GroupId' --output text 2>/dev/null)
  for h in $HOST_SGS; do grep -qw "$h" <<<"$allowed" && REACH=yes; done
done
if [[ "$REACH" != yes ]]; then
  say "The admin host's security groups are NOT allowed to reach the database on 5432 (RDS groups: $RDS_SGS)."
  say "The repository's database reads (owner-access-check.sh, pilot-lib.sh 'DB window') first ATTACH the app security group to the admin host. That is an AWS change, so this script stops here instead."
  stop "cannot read the ledger without a temporary security-group change. Decide: approve the repository's DB window for this read, or use another read path."
fi
say "The admin host can already reach the database: no security-group change is needed."

say ""; say "== 4. Connect (read-only) and PROVE which database this is"
command -v nc >/dev/null 2>&1 || true
aws ssm start-session --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$RDS_HOST,portNumber=5432,localPortNumber=$LOCAL_PORT" >/dev/null 2>&1 &
TUN=$!
for _ in $(seq 1 30); do (echo > "/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null && break; sleep 2; done
(echo > "/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null || stop "the Session Manager tunnel did not open"
SEC=$(aws secretsmanager get-secret-value --secret-id "$(jq -r .MasterUserSecret.SecretArn <<<"$RDS")" --query SecretString --output text 2>/dev/null) || stop "cannot read the RDS master secret (permission, or it is not RDS-managed). Missing: access to that credential."
export PGHOST=127.0.0.1 PGPORT=$LOCAL_PORT PGSSLMODE=require PGCONNECT_TIMEOUT=15
export PGUSER; PGUSER=$(jq -r .username <<<"$SEC")
export PGPASSWORD; PGPASSWORD=$(jq -r .password <<<"$SEC")
unset SEC
RO() { PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=20000" psql -X -q -At -F $'\t' -v ON_ERROR_STOP=1 "$@"; }
EXISTS=$(RO -d postgres -c "select string_agg(datname, ',' order by datname) from pg_database where datname in ('ogevia_sv_test','ogevia_prd')") || stop "cannot connect to the database server through the tunnel"
say "databases present on the instance (of the two Ogevia names): ${EXISTS:-none}"
grep -qw "$DB_EXPECT" <<<"${EXISTS//,/ }" || { say "RESULT: database $DB_EXPECT DOES NOT EXIST on $RDS_ID, so it has applied no migration."; say "(Production note: the Lambda being configured for ogevia_prd does not prove the database was created.)"; exit 0; }
WHO=$(RO -d "$DB_EXPECT" -c "select current_database() || ' | read_only=' || current_setting('transaction_read_only')") || stop "cannot connect to $DB_EXPECT"
say "connected: $WHO"
[[ "${WHO%% |*}" == "$DB_EXPECT" ]] || stop "connected to '${WHO%% |*}', not '$DB_EXPECT'"
[[ "$WHO" == *"read_only=on" ]] || stop "the session is not read-only: refusing to run anything"

say ""; say "== 5. The ledger query (single READ ONLY transaction, rolled back)"
SUMMARY=$(RO -d "$DB_EXPECT" -c "select count(*) || ' migrations applied, latest ' || coalesce(max(version), 'none') from ogevia_meta.schema_migrations") || stop "ogevia_meta.schema_migrations cannot be read in $DB_EXPECT"
say "ledger summary: $SUMMARY"
ROWS=$(RO -d "$DB_EXPECT" -c "begin transaction read only" -c "select version || '  ' || checksum || '  ' || name || '  applied ' || to_char(applied_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') from ogevia_meta.schema_migrations where version >= '0053' order by version" -c "rollback") || stop "the ledger query failed"
say ""
if [[ -z "$ROWS" ]]; then
  say "RESULT for $ENV_NAME ($DB_EXPECT): NO ROW has version >= 0053."
  say "No database in this environment has applied the compliance, attention/appearance, scheduling-pattern or recruiting migrations."
  say "Editing the unreleased migration files in place is safe FOR THIS ENVIRONMENT. (Repeat for the other environment.)"
else
  say "RESULT for $ENV_NAME ($DB_EXPECT): migrations numbered 0053 or higher ARE APPLIED:"
  say "$ROWS"
  say "STOP: do not edit migration files in place. Send this output to Claude."
fi
say ""; say "Changed by this run: nothing. Side effects: one secret read and one Session Manager session, both in the audit logs. Result file: $RESULT"
