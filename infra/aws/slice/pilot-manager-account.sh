#!/usr/bin/env bash
# =============================================================================
# Ogevia AWS TEST: one separate MANAGER sign-in for the SCS pilot agency, for
# permission testing (MANAGER VIEW, approve hours without dollar amounts).
# Read-only until you type MANAGER. Then:
#   1. Cognito (TEST pool): creates the individual sign-in if it does not exist
#      (email invitation with a temporary password; MFA is set up at first
#      sign-in). An existing sign-in is reused only if it has no role yet.
#   2. TEST database, one transaction: app user row, a `manager` membership in
#      scs-pilot-synthetic, an audit event. Never changes an existing role.
#   3. Read-back: role manager/active; no billing.read (rates and dollars) and
#      no organization.update (branding); the agency still has its owner.
# Writes an exact rollback file first (revoke membership, audited; disable the
# sign-in). Never deletes. Never touches production, Netlify or Supabase.
#   bash infra/aws/slice/pilot-manager-account.sh
# Default sign-in: ogemails+ogevia-pilot-manager@gmail.com (a plus-address of
# the owner's own inbox); override with OGEVIA_PILOT_MANAGER_EMAIL.
# =============================================================================
set -Eeuo pipefail
export OGEVIA_PILOT_RUN_DIR="${OGEVIA_INCREMENT_RUN_DIR:-$HOME/ogevia-increment-run}"
# shellcheck source=pilot-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/pilot-lib.sh"
ORG_SLUG=scs-pilot-synthetic
EMAIL="${OGEVIA_PILOT_MANAGER_EMAIL:-ogemails+ogevia-pilot-manager@gmail.com}"
DISPLAY_NAME="${OGEVIA_PILOT_MANAGER_NAME:-Pilot Manager (test)}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOG="$RUN/manager-account-$STAMP.log"
exec 3>&1
exec > >(tee -a "$LOG") 2>&1
trap '' PIPE
trap on_exit EXIT
trap 'die "unexpected error on line $LINENO (command: $BASH_COMMAND)"' ERR

phase "1/4 Identity and inputs (read-only)"
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$ACCOUNT" ]] || die "wrong AWS account (expected $ACCOUNT)"
[[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "not an email address: $EMAIL"
[[ "${EMAIL,,}" != "${TEST_MANAGER_EMAIL,,}" && "${EMAIL,,}" != "${TEST_CAREGIVER_EMAIL,,}" ]] \
  || die "$EMAIL is a test-slice account (used for the isolation check); choose another"
SUB=$(sub_of "$EMAIL")
echo "Manager sign-in: $EMAIL ($( [[ -n "$SUB" ]] && echo "exists in Cognito, sub ${SUB:0:8}..." || echo "does not exist yet; will be invited" ))"

phase "2/4 Current agency access (read-only, DB window)"
load_rds_and_host
trap 'rc=$?; trap - ERR; db_window_close; (exit $rc); on_exit' EXIT
trap 'db_window_close; die "unexpected error on line $LINENO (command: $BASH_COMMAND)"' ERR
db_window_open
ORG_ID=$(Q -d "$DB_NAME" -c "select id from ogevia.organizations where slug = '$ORG_SLUG'")
[[ "$ORG_ID" =~ ^[0-9a-f-]{36}$ ]] || die "agency $ORG_SLUG not found in $DB_NAME"
echo "Members of $ORG_SLUG now (role, status, count):"
Q -d "$DB_NAME" -c "select '  ' || role || ' ' || status || ': ' || count(*) from ogevia.organization_memberships where organization_id = '$ORG_ID' group by role, status order by 1"
OWNERS=$(Q -d "$DB_NAME" -c "select count(*) from ogevia.organization_memberships where organization_id = '$ORG_ID' and role = 'organization_owner' and status = 'active'")
[[ "$OWNERS" -ge 1 ]] || die "$ORG_SLUG has no active owner; the owner step must come first"
CUR="none"
if [[ -n "$SUB" ]]; then
  OTHER=$(Q -d "$DB_NAME" -c "select string_agg(o.slug || ':' || m.role, ', ') from ogevia.organization_memberships m join ogevia.app_users u on u.id = m.user_id join ogevia.organizations o on o.id = m.organization_id where u.cognito_sub = '$SUB'")
  CUR=$(Q -d "$DB_NAME" -c "select coalesce((select m.role || '/' || m.status from ogevia.organization_memberships m join ogevia.app_users u on u.id = m.user_id where u.cognito_sub = '$SUB' and m.organization_id = '$ORG_ID'), 'none')")
  if [[ "$CUR" == manager/active ]]; then
    echo "$EMAIL is already an active manager of $ORG_SLUG: nothing to change."
    is_done manager-account || done_ manager-account
    db_window_close; trap on_exit EXIT; trap 'die "unexpected error on line $LINENO (command: $BASH_COMMAND)"' ERR
    exit 0
  fi
  [[ -z "$OTHER" ]] || die "$EMAIL already has a role ($OTHER). This step never changes an existing role; choose a sign-in with no role"
fi
db_window_close
trap on_exit EXIT
trap 'die "unexpected error on line $LINENO (command: $BASH_COMMAND)"' ERR

phase "3/4 APPROVAL"
cat <<EOF

Exactly this will change in AWS TEST:
  1. Cognito $POOL: $( [[ -n "$SUB" ]] && echo "no change (existing sign-in reused)" || echo "create sign-in $EMAIL, invited by email (temporary password; MFA set up at first sign-in)" )
  2. Database $DB_NAME, one transaction: app user "$DISPLAY_NAME" linked to that sign-in,
     membership role manager (active) in $ORG_SLUG, one audit event (membership.manager_granted).
  Manager permissions: see visits, manage visits, approve billable HOURS. No rates or dollar amounts
  (billing.read is owner-only), no branding/logo (organization.update is owner-only).
  Rollback file (written first): revoke the membership (audited) and disable the sign-in. Nothing is deleted.
Not touched: the owner, the caregivers, the other test agency, Netlify, Supabase, production.
EOF
[[ -t 0 ]] || die "approval needs an interactive terminal"
read -r -p "Type MANAGER to apply exactly this (anything else cancels): " answer
[[ "$answer" == MANAGER ]] || die "not approved; nothing was changed"

phase "4/4 Create, link, read back"
if [[ -z "$SUB" ]]; then
  aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$EMAIL" \
    --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true --desired-delivery-mediums EMAIL >/dev/null
  SUB=$(sub_of "$EMAIL")
  echo "Invited $EMAIL (sub ${SUB:0:8}...)"
fi
[[ "$SUB" =~ ^[0-9a-f-]{36}$ ]] || die "the manager sign-in has no Cognito sub"
RBF="$RB/manager-account-rollback-$STAMP.sh"
cat > "$RBF" <<RBSH
#!/usr/bin/env bash
# Rollback of manager grant $STAMP: revoke the membership (audited) and disable the sign-in. Run inside a DB window.
set -euo pipefail
psql -X -v ON_ERROR_STOP=1 -d $DB_NAME <<'SQL'
begin;
set local role ogevia_owner;
do \$\$
declare v_mid uuid; v_before jsonb; v_after jsonb;
begin
  select m.id, to_jsonb(m) into v_mid, v_before from ogevia.organization_memberships m
   where m.organization_id = '$ORG_ID' and m.user_id = (select id from ogevia.app_users where cognito_sub = '$SUB');
  if v_mid is null then raise exception 'membership not found; nothing rolled back'; end if;
  update ogevia.organization_memberships set status = 'revoked', updated_at = now() where id = v_mid;
  select to_jsonb(m) into v_after from ogevia.organization_memberships m where m.id = v_mid;
  insert into ogevia.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, reason, before_state, after_state)
  values ('$ORG_ID', null, 'membership.manager_grant_rolled_back', 'organization_membership', v_mid, 'Rollback of manager grant $STAMP', v_before, v_after);
end \$\$;
commit;
SQL
aws cognito-idp admin-disable-user --user-pool-id $POOL --username '$EMAIL'
RBSH
chmod 700 "$RBF"
echo "Rollback saved: $RBF"

trap 'rc=$?; trap - ERR; db_window_close; (exit $rc); on_exit' EXIT
trap 'db_window_close; die "unexpected error on line $LINENO (command: $BASH_COMMAND)"' ERR
db_window_open
psql -X -q -v ON_ERROR_STOP=1 -At -d "$DB_NAME" -v sub="$SUB" -v org="$ORG_SLUG" -v name="$DISPLAY_NAME" \
  -v reason="Separate pilot manager sign-in for permission testing ($STAMP)" <<'SQL' || die "the manager change failed and was rolled back (error above)"
begin;
set local role ogevia_owner;
\o /dev/null
select set_config('ogevia.fix_sub', :'sub', true), set_config('ogevia.fix_org', :'org', true),
       set_config('ogevia.fix_name', :'name', true), set_config('ogevia.fix_reason', :'reason', true);
\o
do $$
declare v_org uuid; v_user uuid; v_mid uuid; v_after jsonb;
begin
  select id into v_org from ogevia.organizations where slug = current_setting('ogevia.fix_org');
  if v_org is null then raise exception 'agency not found'; end if;
  insert into ogevia.app_users (cognito_sub, display_name) values (current_setting('ogevia.fix_sub'), current_setting('ogevia.fix_name'))
  on conflict (cognito_sub) do nothing;
  select id into v_user from ogevia.app_users where cognito_sub = current_setting('ogevia.fix_sub');
  if exists (select 1 from ogevia.organization_memberships where user_id = v_user) then
    raise exception 'this sign-in already has a membership; no role is changed';
  end if;
  insert into ogevia.organization_memberships (organization_id, user_id, role, status)
  values (v_org, v_user, 'manager', 'active') returning id into v_mid;
  select to_jsonb(m) into v_after from ogevia.organization_memberships m where m.id = v_mid;
  insert into ogevia.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, reason, before_state, after_state)
  values (v_org, null, 'membership.manager_granted', 'organization_membership', v_mid, current_setting('ogevia.fix_reason'), null, v_after);
end $$;
commit;
SQL
AFTER=$(Q -d "$DB_NAME" -c "select m.role || '/' || m.status from ogevia.organization_memberships m join ogevia.app_users u on u.id = m.user_id where u.cognito_sub = '$SUB' and m.organization_id = '$ORG_ID'")
PERMS=$(Q -d "$DB_NAME" -c "select string_agg(permission_key, ' ' order by permission_key) from ogevia.role_permissions where role = 'manager'")
OWNERS=$(Q -d "$DB_NAME" -c "select count(*) from ogevia.organization_memberships where organization_id = '$ORG_ID' and role = 'organization_owner' and status = 'active'")
AUDIT=$(Q -d "$DB_NAME" -c "select count(*) from ogevia.audit_events a join ogevia.organization_memberships m on m.id = a.entity_id join ogevia.app_users u on u.id = m.user_id where u.cognito_sub = '$SUB' and a.action = 'membership.manager_granted'")
# Live money boundary, READ ONLY, acting as the new manager through the same
# request context the API uses: may approve hours, may not see rates or dollars.
MONEY_SQL="begin transaction read only;
set local role ogevia_owner;
select ogevia_api.begin_request('$SUB') is not null;
select ogevia.has_permission('$ORG_ID', 'billing.approve')::text || ' ' || ogevia.has_permission('$ORG_ID', 'billing.read')::text
       || ' ' || ogevia.has_permission('$ORG_ID', 'organization.update')::text;
select count(*) || ' ' || count(*) filter (where rate_cents is not null or amount_cents is not null)
  from ogevia_api.list_billing_approvals('$ORG_ID', date '2000-01-01', current_date + 366);
select count(*) || ' ' || count(*) filter (where billable_value_cents is not null or approved_value_cents is not null or unused_value_cents is not null)
  from ogevia_api.get_utilisation_overview('$ORG_ID', date_trunc('month', current_date)::date);
select ogevia_api.begin_request((select u.cognito_sub from ogevia.organization_memberships m join ogevia.app_users u on u.id = m.user_id
  where m.organization_id = '$ORG_ID' and m.role = 'organization_owner' and m.status = 'active' order by m.created_at limit 1)) is not null;
select count(*) filter (where billable_value_cents is not null or approved_value_cents is not null or unused_value_cents is not null)
  from ogevia_api.get_utilisation_overview('$ORG_ID', date_trunc('month', current_date)::date);
rollback;"
mapfile -t MONEY < <(Q -d "$DB_NAME" -f - <<<"$MONEY_SQL" | grep -vE '^(BEGIN|SET|ROLLBACK|t)$')
db_window_close
trap on_exit EXIT
trap 'die "unexpected error on line $LINENO (command: $BASH_COMMAND)"' ERR
admin_host_groups | grep -qw "$APP_SG" && die "$APP_SG is still attached to $IID: remove it in the EC2 console"
echo "Live check as the manager: can approve hours / can see money / can change branding = ${MONEY[0]:-?}"
echo "  billing approvals visible: ${MONEY[1]%% *}, of which with a rate or amount: ${MONEY[1]##* }"
echo "  utilisation rows visible: ${MONEY[2]%% *}, of which with a dollar value: ${MONEY[2]##* }"
echo "  for comparison, the Administrator sees dollar values on ${MONEY[3]:-?} utilisation rows$( [[ "${MONEY[3]:-0}" == 0 ]] && echo " (no rated authorization this month, so this live check cannot show the difference; the database and API tests cover it)")"
[[ "${MONEY[0]:-}" == "true false false" && "${MONEY[1]##* }" == 0 && "${MONEY[2]##* }" == 0 ]] \
  || die "the manager can see monetary information or cannot approve hours; stop and send this to Claude (rollback: $RBF)"
echo "Read back: $EMAIL is $AFTER in $ORG_SLUG; audit events: $AUDIT; agency owners: $OWNERS"
echo "Manager permissions: $PERMS"
[[ "$AFTER" == manager/active && "$AUDIT" == 1 && "$OWNERS" -ge 1 ]] || die "read-back did not match (rollback: bash $RBF inside a DB window)"
[[ " $PERMS " != *" billing.read "* && " $PERMS " != *" organization.update "* ]] || die "the manager role holds an owner-only permission; stop and send this to Claude"
done_ manager-account
echo "Done. Admin host groups: $(admin_host_groups). Log: $LOG"
echo "Next: the invitation email goes to $EMAIL. First sign-in: new password, then an authenticator app (MFA)."
