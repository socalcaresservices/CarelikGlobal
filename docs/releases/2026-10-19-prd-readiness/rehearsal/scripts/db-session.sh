#!/usr/bin/env bash
# Sourced by r3-r6 after setting MODE=ro or MODE=rw. Opens a Session Manager tunnel from the admin host to the REHEARSAL COPY (never to ogevia-prod-postgres), reads the master
# credential into shell memory only, and defines P (psql). In ro mode every statement runs with default_transaction_read_only=on. Connects to nothing else.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need aws jq psql sha256sum timeout python3
[[ "${MODE:-}" == ro || "${MODE:-}" == rw ]] || stop "internal: MODE must be ro or rw"
check_account
REH=$(state_get REH_ID); EP=$(state_get REH_ENDPOINT); SG=$(state_get SG_ID)
valid_reh_id "${REH:-}" || stop "no valid rehearsal instance in $STATE (run r2-restore.sh first)"
[[ -n "$EP" && -s "$OUT/r0.json" ]] || stop "no rehearsal endpoint or no r0.json: run r2-restore.sh verify"
PROD_EP=$(jq -r .endpoint "$OUT/r0.json"); ADM_ID=$(jq -r .adminInstanceId "$OUT/r0.json"); SECRET_ARN="${OGEVIA_REHEARSAL_SECRET_ARN:-$(jq -r .masterSecretArn "$OUT/r0.json")}"
[[ "$EP" != "$PROD_EP" ]] || stop "the recorded endpoint equals production's: refusing to connect"
[[ "$SECRET_ARN" =~ ^arn:aws:secretsmanager:us-west-2:$ACCOUNT:secret:[A-Za-z0-9/_+=.@!-]+$ ]] || stop "the master secret ARN is missing or malformed"
D=$(A rds describe-db-instances --db-instance-identifier "$REH" --output json 2>/dev/null | jq -c '.DBInstances[0]') && [[ -n "$D" && "$D" != null ]] || stop "cannot describe $REH"
[[ "$(jq -r .DBInstanceStatus <<<"$D")" == available && "$(jq -r '.Endpoint.Address // empty' <<<"$D")" == "$EP" ]] || stop "$REH is not available at the recorded endpoint"
[[ "$(jq -r '[.VpcSecurityGroups[].VpcSecurityGroupId] | join(" ")' <<<"$D")" == "$SG" && "$SG" != "$PROD_RDS_SG" ]] || stop "$REH's security groups are not exactly its own group"
[[ "$(jq -r '[.TagList[]? | select(.Key=="purpose") | .Value] | first // empty' <<<"$D")" == rehearsal-delete-after ]] || stop "$REH is not tagged purpose=rehearsal-delete-after"
LOCAL_PORT="${OGEVIA_REHEARSAL_PORT:-15441}"; TUN=""
cleanup() { [[ -n "$TUN" ]] && kill "$TUN" 2>/dev/null; unset PGPASSWORD PGUSER SEC; }
trap cleanup EXIT
say "opening the tunnel to the REHEARSAL copy $REH ($EP) via admin host $ADM_ID on 127.0.0.1:$LOCAL_PORT"
aws ssm start-session --target "$ADM_ID" --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters "host=$EP,portNumber=5432,localPortNumber=$LOCAL_PORT" >/dev/null 2>&1 &
TUN=$!
for _ in $(seq 1 "${OGEVIA_TUNNEL_WAIT:-30}"); do (echo > "/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null && break; sleep 1; done
(echo > "/dev/tcp/127.0.0.1/$LOCAL_PORT") 2>/dev/null || stop "the Session Manager tunnel did not open in time"
SEC=$(A secretsmanager get-secret-value --secret-id "$SECRET_ARN" --output json 2>/dev/null | jq -r .SecretString) && [[ -n "$SEC" && "$SEC" != null ]] || stop "cannot read the master secret"
export PGHOST=127.0.0.1 PGPORT=$LOCAL_PORT PGSSLMODE=require PGCONNECT_TIMEOUT=15
export PGUSER; PGUSER=$(jq -r .username <<<"$SEC"); export PGPASSWORD; PGPASSWORD=$(jq -r .password <<<"$SEC"); unset SEC
if [[ "$MODE" == ro ]]; then PGOPT="-c default_transaction_read_only=on -c statement_timeout=120000"; else PGOPT="-c statement_timeout=0"; fi
P() { PGOPTIONS="$PGOPT" timeout --foreground -k 5 "${OGEVIA_PSQL_TIMEOUT:-900}" psql -X -q -At -F $'\t' -v ON_ERROR_STOP=1 "$@"; }
P -d postgres -c "select 1" >/dev/null 2>&1 || stop "cannot log in to the copy with the source master credential. The restored instance may not accept it (README, R2 note); setting a new master password is a separate YELLOW step this package does not do"
DBS=$(P -d postgres -c "select string_agg(datname, ',' order by datname) from pg_database where datname in ('$PRD_DB','$TEST_DB')") || stop "cannot list databases on the copy"
say "databases on the copy: ${DBS:-none}"
grep -qw "$PRD_DB" <<<"${DBS//,/ }" || stop "$PRD_DB does not exist on the copy"
WHO=$(P -d "$PRD_DB" -c "select current_database() || ' | read_only=' || current_setting('transaction_read_only')") || stop "cannot connect to $PRD_DB"
[[ "${WHO%% |*}" == "$PRD_DB" ]] || stop "connected to '${WHO%% |*}', not $PRD_DB"
if [[ "$MODE" == ro ]]; then [[ "$WHO" == *"read_only=on" ]] || stop "the session is not read-only: refusing"; fi
say "connected to the copy: $WHO"
ledger_now() { P -d "$PRD_DB" -c "select count(*) || '|' || coalesce(max(version), 'none') from ogevia_meta.schema_migrations"; }
