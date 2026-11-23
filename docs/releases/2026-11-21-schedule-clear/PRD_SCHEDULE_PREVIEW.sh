#!/usr/bin/env bash
# PRODUCTION, READ-ONLY PREVIEW of the schedule clear. Changes no data. It runs PREVIEW_SCHEDULE_CLEAR.sql (SELECT statements only, checked below) against ogevia_prd.
# The ONE production change it makes is TEMPORARY and reversible, the same as the earlier production releases: it attaches the application database security group to the admin host
# so the host can reach the private database, then removes it again (also on any failure) and checks that the admin host is back to its single group.
#   REPO=<checkout at the release commit> OGEVIA_RELEASE_COMMIT=<full sha> WORK=<work dir> [ORG_SLUG=<agency slug>] bash PRD_SCHEDULE_PREVIEW.sh
# Needs psql 16 or newer, aws, jq, python3, curl and the session-manager plugin (CloudShell has them). OGEVIA_NO_CONFIRM=1 is for the automated test only.
set -euo pipefail
set +x +H
umask 077
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER="" PYTHONDONTWRITEBYTECODE=1
stop() { echo "STOP: $*" >&2; exit 2; }
: "${REPO:?set REPO}"; : "${OGEVIA_RELEASE_COMMIT:?set OGEVIA_RELEASE_COMMIT}"; : "${WORK:?set WORK}"
[[ "$(git -C "$REPO" rev-parse HEAD)" == "$OGEVIA_RELEASE_COMMIT" ]] || stop "the checkout is not at the release commit"
[[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ]] || stop "tracked files in the checkout are modified"
SQL="$REPO/docs/releases/2026-11-21-schedule-clear/PREVIEW_SCHEDULE_CLEAR.sql"; [[ -f "$SQL" ]] || stop "the preview SQL is missing"
A() { timeout --foreground -k 5 "${OGEVIA_AWS_TIMEOUT:-300}" aws --cli-connect-timeout 5 --cli-read-timeout 120 "$@"; }
[[ "$(A sts get-caller-identity --query Account --output text)" == 300094796789 ]] || stop "wrong AWS account (expected 300094796789 in us-west-2)"
# The SQL may only: begin, create temp table ... as select, do (a guard), set transaction read only, select, rollback, and psql \echo / \set / \if lines. Anything else stops the run.
python3 - "$SQL" <<'PY' || stop "the preview SQL contains a statement that is not read-only"
import re, sys
t = open(sys.argv[1]).read()
t = re.sub(r"--[^\n]*", "", t); t = "\n".join(l for l in t.splitlines() if not l.lstrip().startswith("\\"))
ok = re.compile(r"^(begin|rollback|set transaction read only|select\b.*|do \$\$.*\$\$|create temp table _\w+ on commit drop as\s+select\b.*|with\b.*)$", re.I | re.S)
for stmt in [s.strip() for s in re.split(r";\s*(?:\n|$)", t) if s.strip()]:
    scan = re.sub(r"on commit drop", "", stmt.split("$$")[0] if stmt.lower().startswith("do") else stmt, flags=re.I)
    if not ok.match(stmt) or re.search(r"\b(insert|update|delete|drop|alter|truncate|grant|revoke|copy|vacuum|call)\b", scan, re.I):
        print("NOT ALLOWED:", stmt[:100]); sys.exit(1)
print("preview SQL: SELECT-only (plus session-local temporary tables); sha256", __import__("hashlib").sha256(open(sys.argv[1], "rb").read()).hexdigest()[:16])
PY
confirm() { local got; echo; echo "$2"; if [[ "${OGEVIA_NO_CONFIRM:-}" == 1 ]]; then return 0; fi
  printf 'Type exactly  %s  to continue: ' "$1" > /dev/tty; read -r got < /dev/tty; [[ "$got" == "$1" ]] || stop "confirmation not given"; }
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
confirm "RUN-READ-ONLY-PREVIEW" "This READS production data (shift counts, client codes, visit numbers; no names, no notes) and changes none. It temporarily attaches the application database security group to the admin host to open a tunnel, then removes it again."
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
[[ "$(psql -X -qAt --no-password -c 'select current_database()')" == ogevia_prd ]] || stop "connected to the wrong database"
echo "=== PREVIEW (read-only) $(date -u +%FT%TZ) ==="
psql -X -At -F '|' --no-password -v ON_ERROR_STOP=1 -v "org_slug=${ORG_SLUG:-}" -f "$SQL" 2>&1 | tee "$WORK/preview-$(date -u +%Y%m%dT%H%M%SZ).txt"
echo "=== END OF PREVIEW: nothing was changed ==="
