#!/usr/bin/env bash
# Shared by pilot-deploy.sh and pilot-rollback.sh (sourced, not run).
# Constants, stop/resume helpers, and the DB window: temporarily attach the
# app security group to the admin host, open an SSM tunnel to the private RDS
# endpoint, hold the RDS-managed master credentials in shell memory only, and
# ALWAYS restore the admin host's original security groups afterwards.
# OGEVIA_PILOT_LOCAL_PORT / _PGSSLMODE / _NODE_SSLMODE exist only so the
# workflow can be rehearsed against a local PostgreSQL; never set them in AWS.
# shellcheck disable=SC2034  # variables are used by the scripts that source this

ACCOUNT=300094796789
REGION=us-west-2
POOL=us-west-2_849AYz5J7
COGNITO_DOMAIN=https://us-west-2849ayz5j7.auth.us-west-2.amazoncognito.com
RDS_ID=ogevia-prod-postgres
APP_SG=sg-064ffce3bcbe8eb3b
ADMIN_TAG=ogevia-db-admin-temp
DB_NAME=ogevia_sv_test
LOCAL_PORT=${OGEVIA_PILOT_LOCAL_PORT:-15432}
API_STACK=Ogevia-prod-ServiceVerificationApi
STACKS=(Ogevia-prod-EvidenceStorage Ogevia-prod-NetworkEgress Ogevia-prod-WebHosting Ogevia-prod-ServiceVerificationApi Ogevia-prod-Observability)
TEST_CAREGIVER_EMAIL=ogemails+ogevia-caregiver@gmail.com
TEST_MANAGER_EMAIL=ogemails+ogevia-manager@gmail.com
FINAL_MIGRATION=0018

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"      # infra/aws
REPO="$(cd "$HERE/../.." && pwd)"
SLICE="$HERE/slice"
RUN="${OGEVIA_PILOT_RUN_DIR:-$HOME/ogevia-pilot-run}"
STATE="$RUN/state"; RB="$RUN/rollback"
mkdir -p "$STATE" "$RB/templates"
chmod 700 "$RUN"
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION AWS_PAGER="" CDK_DISABLE_CLI_TELEMETRY=true

PHASE="start"
phase() { PHASE="$1"; printf '\n\033[1m=== %s\033[0m\n' "$1"; }
done_() { touch "$STATE/$1"; }
is_done() { [[ -f "$STATE/$1" ]]; }
die() {
  local msg
  msg=$(printf '\n\033[1;31mSTOPPED in "%s": %s\033[0m\nNothing after this point ran. Log: %s\nFix the cause (or send the log to Claude) and re-run the same command; completed steps are skipped.\n' "$PHASE" "$*" "${LOG:-}")
  DIED=1
  # Straight to the terminal (fd 3, if saved) and the log as well, so the
  # message survives even if the tee logging pipe has been killed.
  { printf '%s\n' "$msg" >&3; } 2>/dev/null || printf '%s\n' "$msg"
  [[ -n "${LOG:-}" ]] && printf '%s\n' "$msg" >> "$LOG"
  exit 1
}

# --- web label guard (begin) -------------------------------------------------------------------------------------------
# A web build published to the TEST environment (stacks Ogevia-prod-*) must carry the label "test". The live /config.json of
# TEST has no VITE_APP_ENV key (it was written before 2026-10-07), so the BUILD value decides whether the "TEST - synthetic data
# only" banner shows; a build labelled "production" shows no banner and looks like production. The banner TEXT is in the code of
# every build, so searching for it proves nothing; the baked-in value does (verified 2026-10-16 by building both).
assert_test_web_label() {   # <build dir>
  local d=$1
  grep -rqE 'VITE_APP_ENV:[[:space:]]*"test"' "$d/assets" 2>/dev/null \
    || die "the web build in $d is not labelled test (VITE_APP_ENV:\"test\" not found). Refusing to publish it to the TEST environment."
  if grep -rqE 'VITE_APP_ENV:[[:space:]]*"production"' "$d/assets" 2>/dev/null; then
    die "the web build in $d is labelled production. Refusing to publish it to the TEST environment."; fi
}
assert_live_config_label() {   # <web origin>: read-only GET of the live /config.json
  local v
  v=$(curl -fsS -m 20 "${1%/}/config.json" | jq -r '.VITE_APP_ENV // empty') || die "cannot read ${1%/}/config.json"
  [[ -z "$v" || "$v" == test || "$v" == development ]] || die "the live config.json says VITE_APP_ENV=$v; a TEST site must not claim to be production."
}
# --- web label guard (end) ---------------------------------------------------------------------------------------------
# An exit that did not go through die() (for example a killed child that took
# the shell's pipeline down) still says so, with the exit code.
on_exit() {
  local rc=$?
  [[ $rc == 0 || -n "${DIED:-}" ]] && return 0
  local hint="" msg
  [[ $rc == 137 ]] && hint=", killed: likely out of memory"
  msg="EXITED UNEXPECTEDLY in \"$PHASE\" (exit $rc$hint). Log: ${LOG:-}. Re-run the same command to resume."
  { printf '%s\n' "$msg" >&3; } 2>/dev/null || printf '%s\n' "$msg"
  [[ -n "${LOG:-}" ]] && printf '%s\n' "$msg" >> "$LOG"
}
out() { aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }
sub_of() { aws cognito-idp admin-get-user --user-pool-id "$POOL" --username "$1" --query 'UserAttributes[?Name==`sub`].Value' --output text 2>/dev/null || true; }
admin_host_groups() { aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text; }

load_rds_and_host() {
  RDS=$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0]' --output json)
  RDS_HOST=$(jq -r .Endpoint.Address <<<"$RDS")
  MASTER_SECRET_ARN=$(jq -r '.MasterUserSecret.SecretArn // empty' <<<"$RDS")
  [[ -n "$MASTER_SECRET_ARN" ]] || die "RDS-managed master secret not found"
  IID=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$ADMIN_TAG" "Name=instance-state-name,Values=running" \
    --query 'Reservations[0].Instances[0].InstanceId' --output text)
  [[ "$IID" == i-* ]] || die "admin host $ADMIN_TAG is not running (start it in the EC2 console, then re-run)"
}

db_window_close() {
  [[ -n "${TUNNEL:-}" ]] && kill "$TUNNEL" 2>/dev/null || true
  TUNNEL=""
  pkill -f "session-manager-plugin.*${IID:-none}" 2>/dev/null || true
  unset PGPASSWORD DBURL
  [[ -f "$RB/admin-host-sgs.txt" && -n "${IID:-}" ]] || return 0
  local want now
  want=$(tr -s ' \t' '\n' < "$RB/admin-host-sgs.txt" | grep -v "^$APP_SG$" | sort | xargs)
  now=$(admin_host_groups | tr -s ' \t' '\n' | sort | xargs)
  if [[ "$now" != "$want" ]]; then
    # shellcheck disable=SC2086
    aws ec2 modify-instance-attribute --instance-id "$IID" --groups $want && echo "Admin host security groups restored: $want"
  fi
}

# Opens the window; the caller must `trap db_window_close EXIT` first.
db_window_open() {
  local orig
  orig=$(admin_host_groups)
  [[ -f "$RB/admin-host-sgs.txt" ]] || echo "$orig" > "$RB/admin-host-sgs.txt"
  # shellcheck disable=SC2086
  grep -qw "$APP_SG" <<<"$orig" || aws ec2 modify-instance-attribute --instance-id "$IID" --groups $orig "$APP_SG"
  echo "Opening the SSM tunnel to RDS (private; nothing is exposed)..."
  aws ssm start-session --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters "host=$RDS_HOST,portNumber=5432,localPortNumber=$LOCAL_PORT" >/dev/null &
  TUNNEL=$!
  local _
  for _ in $(seq 1 30); do (echo > "/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null && break; sleep 2; done
  local master
  master=$(aws secretsmanager get-secret-value --secret-id "$MASTER_SECRET_ARN" --query SecretString --output text)
  export PGHOST=127.0.0.1 PGPORT=$LOCAL_PORT PGSSLMODE=${OGEVIA_PILOT_PGSSLMODE:-require}
  export PGUSER; PGUSER=$(jq -r .username <<<"$master")
  export PGPASSWORD; PGPASSWORD=$(jq -r .password <<<"$master")
  # Node through the local tunnel: the RDS certificate names the RDS host, not
  # 127.0.0.1, so certificate verification is relaxed ONLY on this tunnel.
  DBURL="postgres://$(jq -rn --arg u "$PGUSER" '$u|@uri'):$(jq -rn --arg p "$PGPASSWORD" '$p|@uri')@127.0.0.1:$LOCAL_PORT/$DB_NAME?sslmode=${OGEVIA_PILOT_NODE_SSLMODE:-no-verify}"
  psql -X -At -d postgres -c "select 1" >/dev/null || die "cannot reach RDS through the tunnel"
}

Q() { psql -X -v ON_ERROR_STOP=1 -At "$@"; }
