#!/usr/bin/env bash
# Opens the operator's own session to the ISOLATED TEST database and runs ONE command with the libpq variables set, then closes the tunnel and forgets the credential.
# It repeats the connection guards of OPERATOR_TEST_DB.sh (isolated-* modes) so the new 0109 tools use the same path and the same checks:
# account 300094796789; instance ogevia-postgres at the expected host, not public, the one expected security group; port-forward through the existing admin host.
# No security group is attached or changed. The master credential is read by this shell only, held in memory, never printed, never written to disk.
#
#   bash TEST_DB_SESSION.sh bash TEST_0109_LEDGER.sh probe
#   bash TEST_DB_SESSION.sh env OUT=$HOME/inv bash TEST_INVENTORY.sh
#   bash TEST_DB_SESSION.sh psql -X -At -c 'select count(*) from ogevia_meta.schema_migrations'
# The command runs with PGHOST/PGHOSTADDR/PGPORT/PGUSER/PGPASSWORD/PGDATABASE=ogevia_sv_test and verify-full TLS.
set -euo pipefail
set +x +H
umask 077
stop() { echo "STOP: $*" >&2; exit 2; }
[[ $# -ge 1 ]] || stop "usage: TEST_DB_SESSION.sh <command...>"
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER='' AWS_CLI_AUTO_PROMPT=off
A() { aws --cli-connect-timeout 5 --cli-read-timeout 30 "$@"; }
[[ "$(A sts get-caller-identity --query Account --output text)" == 300094796789 ]] || stop "wrong account"
HOST=ogevia-postgres.c50cageec7mv.us-west-2.rds.amazonaws.com
ADMIN_HOST_INSTANCE=i-0ce8db2d7e5839dd5
PORT="${LOCAL_TUNNEL_PORT:-15433}"
META="$(A rds describe-db-instances --db-instance-identifier ogevia-postgres --query 'DBInstances[0].{host:Endpoint.Address,public:PubliclyAccessible,secret:MasterUserSecret.SecretArn,groups:VpcSecurityGroups[].VpcSecurityGroupId}' --output json)"
[[ "$(jq -r .host <<<"$META")" == "$HOST" && "$(jq -r .public <<<"$META")" == false ]] || stop "target host or privacy mismatch"
jq -e '.groups == ["sg-0bc0f1315fd0feaf2"]' <<<"$META" >/dev/null || stop "the instance's security groups differ from the reviewed ones"
MASTER_ARN="$(jq -er '.secret | select(startswith("arn:"))' <<<"$META")" || stop "no managed master secret on the instance"

D="$(mktemp -d)"; TUNNEL=""
finish() { unset PGPASSWORD MASTER U P; if [[ -n "$TUNNEL" ]]; then pkill -P "$TUNNEL" 2>/dev/null || true; kill "$TUNNEL" 2>/dev/null || true; wait "$TUNNEL" 2>/dev/null || true; fi; rm -rf "$D"; }
trap finish EXIT
curl -fsS --connect-timeout 5 --max-time 30 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o "$D/ca.pem"
A ssm start-session --target "$ADMIN_HOST_INSTANCE" --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$HOST\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"$PORT\"]}" >"$D/tunnel.log" 2>&1 &
TUNNEL=$!; UP=0
for _ in $(seq 1 30); do if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then UP=1; break; fi; kill -0 "$TUNNEL" 2>/dev/null || break; sleep 1; done
[[ "$UP" == 1 ]] || { echo "STOP: the tunnel did not come up" >&2; sed -E 's#postgres://[^ ]*#postgres://<redacted>#g' "$D/tunnel.log" >&2; exit 2; }
MASTER="$(A secretsmanager get-secret-value --secret-id "$MASTER_ARN" --query SecretString --output text)"
U="$(jq -er .username <<<"$MASTER")"; P="$(jq -er .password <<<"$MASTER")"; unset MASTER
unset PGSERVICE PGSERVICEFILE PGPASSFILE
export PGHOST="$HOST" PGHOSTADDR=127.0.0.1 PGPORT="$PORT" PGSSLMODE=verify-full PGSSLROOTCERT="$D/ca.pem" PGCONNECT_TIMEOUT=10 PGUSER="$U" PGPASSWORD="$P" PGDATABASE=ogevia_sv_test PGOPTIONS='-c statement_timeout=120000'
"$@"
