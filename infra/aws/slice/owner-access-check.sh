#!/usr/bin/env bash
# =============================================================================
# Ogevia AWS TEST: owner / manager / finance access check. READ-ONLY FIRST.
#   Part A (read-only, no prompt): Cognito sign-ins in the TEST pool, the
#     account to check (default admin.ogevia@gmail.com), and which API build
#     is live.
#   Part B (needs READ-DB): agency memberships, roles and effective
#     permissions from the TEST database, in a READ ONLY transaction. The only
#     change is temporary: the app security group is attached to the admin
#     host for the tunnel and its original groups are restored on exit
#     (verified).
#   Part C (needs OWNER, shown in full first): the smallest owner fix, using
#     an EXISTING Cognito identity (never creates a sign-in). One transaction:
#     app user row if missing, an organization_owner membership in the pilot
#     agency, and an audit event. Writes an exact rollback file first.
# Prints: Account | Role | Can view | Can approve | Missing access.
# Never prints passwords or tokens. Never touches production, Netlify, Supabase.
# Log: ~/ogevia-access/access-<UTC>.log
# =============================================================================
set -uo pipefail
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""
CHECK_EMAIL="${OGEVIA_CHECK_EMAIL:-admin.ogevia@gmail.com}"
ORG_SLUG="${OGEVIA_ORG_SLUG:-scs-pilot-synthetic}"
ACCOUNT=300094796789
POOL=us-west-2_849AYz5J7
RDS_ID=ogevia-prod-postgres
DB=ogevia_sv_test
APP_SG=sg-064ffce3bcbe8eb3b
ADMIN_TAG=ogevia-db-admin-temp
PORT=${OGEVIA_ACCESS_LOCAL_PORT:-15435}   # OGEVIA_ACCESS_* overrides exist only for local rehearsal
OUT="$HOME/ogevia-access"; mkdir -p "$OUT"; chmod 700 "$OUT"
STAMP=$(date -u +%Y%m%dT%H%M%SZ); LOG="$OUT/access-$STAMP.log"
exec 3>&1
exec > >(tee -a "$LOG") 2>&1
trap '' PIPE
STEP=start; IID=""; BASE_SGS=""; TUN=""
say() { { printf '%s\n' "$*" >&3; } 2>/dev/null; printf '%s\n' "$*" >> "$LOG"; }
step() { STEP="$1"; echo; echo "== $1"; }
cleanup() {
  local rc=$?
  [[ -n "$TUN" ]] && kill "$TUN" 2>/dev/null
  [[ -n "$IID" ]] && pkill -f "session-manager-plugin.*$IID" 2>/dev/null
  unset PGPASSWORD
  if [[ -n "$IID" && -n "$BASE_SGS" ]]; then
    local now
    now=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text 2>/dev/null | tr -s ' \t' '\n' | sort | xargs)
    if [[ "$now" != "$BASE_SGS" ]]; then
      # shellcheck disable=SC2086
      aws ec2 modify-instance-attribute --instance-id "$IID" --groups $BASE_SGS && say "Admin host security groups restored: $BASE_SGS" \
        || say "WARNING: restore the admin host's security groups to $BASE_SGS (EC2 console)"
    fi
    now=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text 2>/dev/null | tr -s ' \t' '\n' | sort | xargs)
    [[ "$now" == "$BASE_SGS" ]] && say "Verified: admin host groups are the original ($now)." || say "WARNING: admin host groups are $now (expected $BASE_SGS)"
  fi
  [[ $rc != 0 && -z "${STOPPED:-}" && -z "${DONE:-}" ]] && say "EXITED UNEXPECTEDLY in \"$STEP\" (exit $rc). Log: $LOG"
}
trap cleanup EXIT
stop() { STOPPED=1; say "STOP in \"$STEP\": $*"; say "Log: $LOG"; exit 1; }

step "A1 Identity"
ARN=$(aws sts get-caller-identity --query Arn --output text 2>/dev/null) || stop "AWS credentials are not valid: sign in again and reopen CloudShell (us-west-2)"
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT" && "$ARN" == *AdministratorAccess* ]] || stop "needs account $ACCOUNT with AdministratorAccess (current: $ARN)"
echo "Account $ACCOUNT, us-west-2: OK"

step "A2 Cognito sign-ins in the TEST pool (no passwords or tokens exist in this output)"
USERS="$OUT/cognito-users-$STAMP.json"
aws cognito-idp list-users --user-pool-id "$POOL" --output json > "$USERS" 2>"$OUT/err" || stop "cannot list Cognito users: $(tail -1 "$OUT/err")"
jq -r '.Users[] | [ (.Attributes[]? | select(.Name=="email") | .Value) // "(no email)", .UserStatus, (if .Enabled then "enabled" else "DISABLED" end), (.Attributes[]? | select(.Name=="sub") | .Value) ] | @tsv' "$USERS" \
  | sort | awk -F'\t' '{printf "  %-42s %-22s %-9s sub %s\n", $1, $2, $3, substr($4,1,8)"..."}'
echo "  total: $(jq '.Users | length' "$USERS")"
CHECK_SUB=$(jq -r --arg e "$CHECK_EMAIL" '.Users[] | select(any(.Attributes[]?; .Name=="email" and (.Value|ascii_downcase)==($e|ascii_downcase))) | (.Attributes[] | select(.Name=="sub") | .Value)' "$USERS" | head -1)
if [[ -n "$CHECK_SUB" ]]; then
  CG_GROUPS=$(aws cognito-idp admin-list-groups-for-user --user-pool-id "$POOL" --username "$CHECK_SUB" --query 'Groups[].GroupName' --output text 2>/dev/null)
  echo "$CHECK_EMAIL: exists in Cognito (sub ${CHECK_SUB:0:8}...); Cognito groups: ${CG_GROUPS:-none} (Ogevia roles come from the database, not Cognito groups)"
else
  echo "$CHECK_EMAIL: NOT in the TEST Cognito pool"
fi

step "A3 Which API build is live"
FN=$(aws cloudformation list-stack-resources --stack-name Ogevia-prod-ServiceVerificationApi --query "StackResourceSummaries[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId | [0]" --output text 2>/dev/null)
LIVE_SHA=$(aws lambda get-function-configuration --function-name "$FN" --query CodeSha256 --output text 2>/dev/null)
CAP_SHA=$(jq -r .CodeSha256 "$HOME/ogevia-pilot-run/rollback/lambda.json" 2>/dev/null)
API_ID=$(aws cloudformation list-stack-resources --stack-name Ogevia-prod-ServiceVerificationApi --query "StackResourceSummaries[?ResourceType=='AWS::ApiGatewayV2::Api'].PhysicalResourceId | [0]" --output text 2>/dev/null)
CLOSE=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[?RouteKey=='POST /v1/visits/{visitId}/close'] | length(@)" --output text 2>/dev/null)
if [[ -n "$CAP_SHA" && "$LIVE_SHA" == "$CAP_SHA" ]]; then BUILD="the October 2 build (pilot NOT deployed)"; elif [[ "$CLOSE" == 1 ]]; then BUILD="the pilot build (close route live)"; else BUILD="unknown build"; fi
echo "Lambda CodeSha256 ${LIVE_SHA:0:12}... -> $BUILD"
echo "Billing routes in the live API: $(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[?contains(RouteKey,'billing')].RouteKey" --output text 2>/dev/null | tr '\t' ' ')"

step "B Database memberships and permissions (read-only queries)"
cat <<EOF
To read memberships the script needs a short database window:
  - attach $APP_SG to the admin host $ADMIN_TAG (temporary), open an SSM tunnel,
  - run SELECT queries in a READ ONLY transaction on $DB,
  - restore the admin host's original security groups and verify them.
Nothing in the database changes in this part.
EOF
read -r -p "Type READ-DB to run part B (anything else stops here): " ans
if [[ "$ans" != READ-DB ]]; then STOPPED=1; say "Stopped after the read-only part A (no database read). Log: $LOG"; exit 0; fi
for t in jq psql session-manager-plugin; do
  command -v "$t" >/dev/null && continue
  case "$t" in
    psql) sudo dnf install -y -q postgresql15 >/dev/null || stop "could not install psql" ;;
    session-manager-plugin) sudo dnf install -y -q https://s3.amazonaws.com/session-manager-downloads/plugin/latest/linux_64bit/session-manager-plugin.rpm >/dev/null || stop "could not install session-manager-plugin" ;;
    jq) stop "jq is missing" ;;
  esac
done
RDS=$(aws rds describe-db-instances --db-instance-identifier "$RDS_ID" --query 'DBInstances[0]' --output json) || stop "cannot read $RDS_ID"
IID=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$ADMIN_TAG" Name=instance-state-name,Values=running --query 'Reservations[0].Instances[0].InstanceId' --output text)
[[ "$IID" == i-* ]] || { IID=""; stop "admin host $ADMIN_TAG is not running: start it in EC2, then paste again"; }
NOW_SGS=$(aws ec2 describe-instances --instance-ids "$IID" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text)
BASE_SGS=$(tr -s ' \t' '\n' <<<"$NOW_SGS" | grep -v "^$APP_SG$" | sort | xargs)
[[ -n "$BASE_SGS" ]] || stop "cannot determine the admin host's own security group"
# shellcheck disable=SC2086
grep -qw "$APP_SG" <<<"$NOW_SGS" || aws ec2 modify-instance-attribute --instance-id "$IID" --groups $BASE_SGS "$APP_SG" || stop "could not attach $APP_SG"
aws ssm start-session --target "$IID" --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$(jq -r .Endpoint.Address <<<"$RDS"),portNumber=5432,localPortNumber=$PORT" >/dev/null &
TUN=$!
for _ in $(seq 1 30); do (echo > "/dev/tcp/127.0.0.1/$PORT") 2>/dev/null && break; sleep 2; done
(echo > "/dev/tcp/127.0.0.1/$PORT") 2>/dev/null || stop "SSM tunnel did not open"
SEC=$(aws secretsmanager get-secret-value --secret-id "$(jq -r .MasterUserSecret.SecretArn <<<"$RDS")" --query SecretString --output text) || stop "cannot read the master secret"
export PGHOST=127.0.0.1 PGPORT=$PORT PGSSLMODE=${OGEVIA_ACCESS_PGSSLMODE:-require} PGCONNECT_TIMEOUT=15 PGDATABASE=$DB
export PGUSER; PGUSER=$(jq -r .username <<<"$SEC")
export PGPASSWORD; PGPASSWORD=$(jq -r .password <<<"$SEC")
unset SEC
# Quiet (-q): no command tags such as "SET" in the output, only result rows.
RO() { psql -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -c "set default_transaction_read_only = on" -c "$1"; }
LEDGER=$(RO "select count(*) || ' migrations, latest ' || max(version) from ogevia_meta.schema_migrations") || stop "cannot query $DB"
echo "Migration ledger: $LEDGER"
MEM="$OUT/memberships-$STAMP.tsv"
RO "select o.slug, coalesce(u.cognito_sub,''), coalesce(u.display_name,''), u.status, m.role, m.status,
       coalesce((select string_agg(rp.permission_key, ',' order by rp.permission_key) from ogevia.role_permissions rp where rp.role = m.role), '')
    from ogevia.organization_memberships m
    join ogevia.organizations o on o.id = m.organization_id
    join ogevia.app_users u on u.id = m.user_id
    order by o.slug, m.role, u.display_name" > "$MEM" || stop "cannot read memberships"
ORGS=$(RO "select slug || ' (' || display_name || ', ' || status || ')' from ogevia.organizations order by slug")
echo "Agencies in $DB:"; sed 's/^/  /' <<<"$ORGS"

step "B2 Access table"
python3 - "$USERS" "$MEM" "$ORG_SLUG" <<'PY' | tee "$OUT/access-table-$STAMP.txt"
import json, sys
users, mem, focus = sys.argv[1], sys.argv[2], sys.argv[3]
email = {}
for u in json.load(open(users))["Users"]:
    a = {x["Name"]: x["Value"] for x in u.get("Attributes", [])}
    email[a.get("sub", "")] = (a.get("email", "(no email)"), u.get("UserStatus"), u.get("Enabled"))
rows = [l.rstrip("\n").split("\t") for l in open(mem) if l.strip()]
VIEW = [("visits.read", "visit records"), ("billing.visits.read", "billing review (no $)"), ("authorizations.read", "authorizations"),
        ("care_requests.read", "care requests")]
print(" | ".join(("Account", "Role (agency)", "Can view", "Can approve", "Missing access")))
print("-" * 200)
owners = {}
for org, sub, name, ustatus, role, mstatus, perms in rows:
    p = set(filter(None, perms.split(",")))
    e, cstatus, enabled = email.get(sub, ("(no Cognito sign-in)", None, None))
    if role == "organization_owner" and mstatus == "active":
        owners.setdefault(org, []).append(e)
    view = ", ".join(v for k, v in VIEW if k in p) or ("own assigned visits" if role == "caregiver" else "nothing")
    if "billing.approve" in p:
        approve = "permission granted, but AWS has NO approval operation"
    elif "visits.manage" in p:
        approve = "visit corrections/close-outs only"
    else:
        approve = "nothing"
    missing = []
    if mstatus != "active": missing.append("membership " + mstatus)
    if cstatus and cstatus != "CONFIRMED": missing.append("sign-in " + cstatus)
    if enabled is False: missing.append("sign-in disabled")
    if role in ("organization_owner", "manager"): missing.append("finance (no billing approval/export/revenue in AWS)")
    print(" | ".join((e, "%s (%s)" % (role, org), view, approve, "; ".join(missing) or "none")))
in_db = {r[1] for r in rows}
for sub, (e, cstatus, enabled) in sorted(email.items(), key=lambda x: x[1][0]):
    if sub not in in_db:
        print(" | ".join((e, "no agency membership", "nothing (signs in, no agency)", "nothing", "membership")))
print()
for org in sorted({r[0] for r in rows}):
    print("Owner of %s: %s" % (org, ", ".join(owners.get(org, [])) or "NONE"))
PY

step "C Owner fix for $ORG_SLUG (shown first; applied only with OWNER)"
OWNER_NOW=$(RO "select count(*) from ogevia.organization_memberships m join ogevia.organizations o on o.id = m.organization_id where o.slug = '$ORG_SLUG' and m.role = 'organization_owner' and m.status = 'active'")
ORG_ID=$(RO "select id from ogevia.organizations where slug = '$ORG_SLUG'")
[[ "$OWNER_NOW" =~ ^[0-9]+$ ]] || stop "unexpected owner count '$OWNER_NOW'"
[[ -z "$ORG_ID" || "$ORG_ID" =~ ^[0-9a-f-]{36}$ ]] || stop "unexpected agency id '$ORG_ID'"
if [[ -z "$ORG_ID" ]]; then STOPPED=1; say "Agency $ORG_SLUG does not exist in $DB: no owner fix proposed (send this to Claude)."; exit 0; fi
if [[ "$OWNER_NOW" != 0 ]]; then DONE=1; say "$ORG_SLUG already has an active owner: no change proposed."; exit 0; fi
if [[ -z "$CHECK_SUB" ]]; then STOPPED=1; say "$ORG_SLUG has NO owner, and $CHECK_EMAIL has no TEST sign-in. No account will be created. Tell Claude which EXISTING sign-in should be the owner."; exit 0; fi
CUR=$(RO "select coalesce(m.role::text, 'none') || '|' || coalesce(m.status::text, '-') || '|' || (u.id is not null)::text
          from (select 1) x left join ogevia.app_users u on u.cognito_sub = '$CHECK_SUB'
          left join ogevia.organization_memberships m on m.user_id = u.id and m.organization_id = '$ORG_ID'")
CUR_ROLE=${CUR%%|*}; REST=${CUR#*|}; CUR_STATUS=${REST%%|*}; HAS_USER=${REST#*|}
[[ "$CUR_ROLE" =~ ^[a-z_]+$ && "$HAS_USER" =~ ^(true|false)$ ]] || stop "unexpected membership read '$CUR'"
PILOT_MANAGER=$(bash -c 'source "$1" 2>/dev/null; printf %s "${M_EMAIL:-}"' _ "$HOME/ogevia-pilot-run/inputs.env")
cat <<EOF

PROPOSED CHANGE (TEST database $DB only; nothing else):
  identity: $CHECK_EMAIL (existing Cognito sign-in, sub ${CHECK_SUB:0:8}...). No sign-in is created.
  agency:   $ORG_SLUG
  now:      role $CUR_ROLE (membership $CUR_STATUS); app user row $( [[ "$HAS_USER" == true ]] && echo exists || echo "missing (will be created, linked to this sub)")
  after:    role organization_owner, membership active
  effective owner permissions: visits.read, visits.manage, authorizations.read, authorizations.update,
                               billing.visits.read, billing.approve
  audit:    one audit_events row (membership.owner_granted, before/after state, reason)
  rollback: written to $OUT/owner-rollback-$STAMP.sql before anything changes
EOF
if [[ "$CUR_ROLE" == manager && -n "$PILOT_MANAGER" && "${PILOT_MANAGER,,}" == "${CHECK_EMAIL,,}" ]]; then
  echo "  WARNING: $CHECK_EMAIL is also the pilot MANAGER sign-in. Promoting it leaves the pilot with no manager-only"
  echo "           account to test manager limits. Consider a different existing identity instead (stop and ask Claude)."
fi
echo "  Note: billing approval itself does not exist in the AWS build yet; owner access adds no approval screen."
read -r -p "Type OWNER to apply exactly this change (anything else leaves it unapplied): " ans
[[ "$ans" == OWNER ]] || { DONE=1; say "Owner fix NOT applied (as chosen). Log: $LOG"; exit 0; }
RB="$OUT/owner-rollback-$STAMP.sql"
if [[ "$CUR_ROLE" == none ]]; then
  RB_DESC="remove the membership that did not exist before"
  RB_STMT="delete from ogevia.organization_memberships where id = v_mid"
else
  RB_DESC="restore the previous role ($CUR_ROLE) and status ($CUR_STATUS)"
  RB_STMT="update ogevia.organization_memberships set role = '$CUR_ROLE', status = '$CUR_STATUS', updated_at = now() where id = v_mid"
fi
# The rollback is audited too, so the trail never ends at "owner granted".
cat > "$RB" <<RBSQL
-- Rollback of owner grant $STAMP: $RB_DESC.
begin;
set local role ogevia_owner;
do \$\$
declare v_mid uuid; v_before jsonb; v_after jsonb;
begin
  select m.id, to_jsonb(m) into v_mid, v_before from ogevia.organization_memberships m
   where m.organization_id = '$ORG_ID' and m.user_id = (select id from ogevia.app_users where cognito_sub = '$CHECK_SUB');
  if v_mid is null then raise exception 'membership not found; nothing rolled back'; end if;
  $RB_STMT;
  select to_jsonb(m) into v_after from ogevia.organization_memberships m where m.id = v_mid;
  insert into ogevia.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, reason, before_state, after_state)
  values ('$ORG_ID', null, 'membership.owner_grant_rolled_back', 'organization_membership', v_mid, 'Rollback of owner grant $STAMP', v_before, v_after);
end \$\$;
commit;
RBSQL
echo "Rollback saved: $RB"
NAME=$(jq -r --arg s "$CHECK_SUB" '.Users[] | select(any(.Attributes[]?; .Name=="sub" and .Value==$s)) | ((.Attributes[] | select(.Name=="name") | .Value) // "Owner")' "$USERS" | head -1)
psql -X -v ON_ERROR_STOP=1 -At \
  -v sub="$CHECK_SUB" -v org="$ORG_SLUG" -v name="${NAME:-Owner}" -v reason="Owner access for $CHECK_EMAIL (owner request $STAMP)" <<'SQL' || stop "the owner change failed and was rolled back (error above)"
begin;
set local role ogevia_owner;
\o /dev/null
select set_config('ogevia.fix_sub', :'sub', true), set_config('ogevia.fix_org', :'org', true),
       set_config('ogevia.fix_name', :'name', true), set_config('ogevia.fix_reason', :'reason', true);
\o
do $$
declare v_org uuid; v_user uuid; v_mid uuid; v_before jsonb; v_after jsonb;
begin
  select id into v_org from ogevia.organizations where slug = current_setting('ogevia.fix_org');
  if v_org is null then raise exception 'agency not found'; end if;
  insert into ogevia.app_users (cognito_sub, display_name) values (current_setting('ogevia.fix_sub'), current_setting('ogevia.fix_name'))
  on conflict (cognito_sub) do nothing;
  select id into v_user from ogevia.app_users where cognito_sub = current_setting('ogevia.fix_sub');
  select to_jsonb(m) into v_before from ogevia.organization_memberships m where m.organization_id = v_org and m.user_id = v_user;
  insert into ogevia.organization_memberships (organization_id, user_id, role, status)
  values (v_org, v_user, 'organization_owner', 'active')
  on conflict (organization_id, user_id) do update set role = 'organization_owner', status = 'active', updated_at = now()
  returning id into v_mid;
  select to_jsonb(m) into v_after from ogevia.organization_memberships m where m.id = v_mid;
  insert into ogevia.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, reason, before_state, after_state)
  values (v_org, null, 'membership.owner_granted', 'organization_membership', v_mid, current_setting('ogevia.fix_reason'), v_before, v_after);
end $$;
commit;
SQL
AFTER=$(RO "select m.role || ' ' || m.status from ogevia.organization_memberships m join ogevia.app_users u on u.id = m.user_id where u.cognito_sub = '$CHECK_SUB' and m.organization_id = '$ORG_ID'")
[[ "$AFTER" == "organization_owner active" ]] || stop "read-back is '$AFTER', not 'organization_owner active'; roll back with: psql ... -f $RB"
echo "Applied and read back: $CHECK_EMAIL is organization_owner (active) of $ORG_SLUG. Audit event written. Rollback file: $RB"
DONE=1
say "Done. Log: $LOG"
