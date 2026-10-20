#!/usr/bin/env bash
# =============================================================================
# F1: PRODUCTION OWNER TRANSITION for SoCal Care Services (database ogevia_prd). Gives a Cognito sign-in the organization_owner role and, later, suspends the old owner's PRODUCTION membership.
# YELLOW: every mode opens the same temporary, narrow database-access window as d1-migrate-prd.sh (one /32 rule on the shared RDS security group, always removed and verified), because even
# `inspect` reads production. It never touches Cognito (read-only admin-get-user only), TEST, passwords, or any other organization.
#   OGEVIA_DEPLOY_APPROVAL=<ref> OGEVIA_EXPECT_HOST_IP=<admin host IP> OGEVIA_NEW_OWNER_EMAIL=<email> [OGEVIA_OLD_OWNER_EMAIL=<email>] [OGEVIA_NEW_OWNER_NAME="<display name>"] bash f1-owner-transition-prd.sh inspect|grant|retire
#   bash f1-owner-transition-prd.sh --restore-only
#  inspect  READ-ONLY: the organization's memberships (role, status, name, sign-in id) and whether the new and old sign-ins are linked.
#  grant    adds the NEW sign-in as an ACTIVE organization_owner (creates its app_users row if missing) with an audit event. Refuses if the new sign-in already has a membership that is not an active owner
#           (resolve that first), if the Cognito account is not CONFIRMED and enabled, or if it is already an active owner (reports and changes nothing).
#  retire   suspends the OLD sign-in's membership (status 'suspended': reversible; the sign-in itself, its Cognito account and TEST are untouched) with an audit event. Refuses unless the NEW sign-in is an
#           ACTIVE owner and at least one other active owner would remain.
# Typed phrases: OPEN-5432-WINDOW-OWNER-GRANT / OPEN-5432-WINDOW-OWNER-RETIRE / OPEN-5432-WINDOW-OWNER-INSPECT. Exit codes as d1-migrate-prd.sh (3 = the temporary rule could not be verified removed).
# =============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib.sh"
ARG="${1:-}"; POOL_ID=us-west-2_849AYz5J7; ORG_SLUG=socal-care-services; MIGRATING=0
[[ $# -eq 1 && "$ARG" =~ ^(inspect|grant|retire|--restore-only)$ ]] || { echo "usage: bash f1-owner-transition-prd.sh inspect|grant|retire|--restore-only" >&2; exit 2; }
need aws jq psql sha256sum timeout
source "$HERE/window.sh"
case "$ARG" in inspect) WIN_PHRASE=OPEN-5432-WINDOW-OWNER-INSPECT ;; grant) WIN_PHRASE=OPEN-5432-WINDOW-OWNER-GRANT ;; retire) WIN_PHRASE=OPEN-5432-WINDOW-OWNER-RETIRE ;; esac
on_exit() { local rc=$?; win_close; [[ $RC != 0 ]] && exit "$RC"; exit "$rc"; }
trap on_exit EXIT
trap 'say "Interrupted: cleaning up."; exit 130' INT TERM HUP
say "== F1 owner transition: $ARG (PRODUCTION $DB_EXPECT) UTC $(date -u +%FT%TZ)"
check_account
if [[ "$ARG" == --restore-only ]]; then win_restore_only; exit "$RC"; fi
[[ ! -f "$WIN_OPEN" ]] || stop "an earlier window is marked OPEN ($WIN_OPEN). Run: bash f1-owner-transition-prd.sh --restore-only"
[[ "${OGEVIA_DEPLOY_APPROVAL:-}" =~ ^[A-Za-z0-9._-]{6,64}$ ]] || stop "set OGEVIA_DEPLOY_APPROVAL to the approval reference"
EMAIL_RE='^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
NEW_EMAIL="${OGEVIA_NEW_OWNER_EMAIL:-}"; OLD_EMAIL="${OGEVIA_OLD_OWNER_EMAIL:-}"
[[ "$NEW_EMAIL" =~ $EMAIL_RE ]] || stop "set OGEVIA_NEW_OWNER_EMAIL to the new owner's email"
[[ "$ARG" != retire || "$OLD_EMAIL" =~ $EMAIL_RE ]] || stop "set OGEVIA_OLD_OWNER_EMAIL to the email whose production membership is to be suspended"
[[ -z "$OLD_EMAIL" || "$OLD_EMAIL" =~ $EMAIL_RE ]] || stop "OGEVIA_OLD_OWNER_EMAIL is not a valid email"
[[ "$NEW_EMAIL" != "$OLD_EMAIL" ]] || stop "the new and old owner emails are the same"
NEW_NAME=$(printf '%s' "${OGEVIA_NEW_OWNER_NAME:-}" | tr -d "'\\\\\n\r" | cut -c1-120)
cog() {   # $1 = email -> prints "sub|status|enabled" (read-only admin-get-user)
  local j; j=$(A cognito-idp admin-get-user --user-pool-id "$POOL_ID" --username "$1" --output json 2>/dev/null) || return 1
  jq -r '[(.UserAttributes[] | select(.Name=="sub") | .Value), .UserStatus, (.Enabled|tostring)] | join("|")' <<<"$j"
}
SUBRE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
NC=$(cog "$NEW_EMAIL") || stop "cannot read the Cognito account for the new owner (does it exist in pool $POOL_ID?)"
NEW_SUB="${NC%%|*}"; NR="${NC#*|}"; NEW_STATUS="${NR%%|*}"; NEW_ENABLED="${NR##*|}"
[[ "$NEW_SUB" =~ $SUBRE ]] || stop "the new owner's Cognito sub is not a UUID"
say "new owner: Cognito sub $NEW_SUB, status $NEW_STATUS, enabled $NEW_ENABLED"
OLD_SUB=""
if [[ -n "$OLD_EMAIL" ]]; then OC=$(cog "$OLD_EMAIL") || stop "cannot read the Cognito account for the old owner"; OLD_SUB="${OC%%|*}"; [[ "$OLD_SUB" =~ $SUBRE ]] || stop "the old owner's Cognito sub is not a UUID"; say "old owner: Cognito sub $OLD_SUB"; [[ "$OLD_SUB" != "$NEW_SUB" ]] || stop "the two emails resolve to the same sign-in"; fi
if [[ "$ARG" == grant ]]; then [[ "$NEW_STATUS" == CONFIRMED && "$NEW_ENABLED" == true ]] || stop "the new owner's Cognito account must be CONFIRMED and enabled (it is $NEW_STATUS / enabled=$NEW_ENABLED). Sign in once with it first."; fi
win_preflight
win_propose "$(case $ARG in inspect) echo "read the memberships of $ORG_SLUG (read-only; nothing is written)" ;; grant) echo "add sign-in $NEW_SUB as an ACTIVE organization_owner of $ORG_SLUG with an audit event" ;; retire) echo "suspend the production membership of sign-in $OLD_SUB in $ORG_SLUG (after checking $NEW_SUB is an active owner and another active owner remains), with an audit event" ;; esac)"
win_open
Q_REPORT="select m.role::text, m.status::text, coalesce(u.display_name,'(no name)'), u.cognito_sub, case when u.cognito_sub = '$NEW_SUB' then 'NEW' when u.cognito_sub = '${OLD_SUB:-none}' then 'OLD' else '' end from ogevia.organization_memberships m join ogevia.app_users u on u.id = m.user_id join ogevia.organizations o on o.id = m.organization_id where o.slug = '$ORG_SLUG' order by m.role::text, u.display_name"
ORGN=$(RO -d "$DB_EXPECT" -c "select count(*) from ogevia.organizations where slug = '$ORG_SLUG'") || stop "cannot read the organizations"
[[ "$ORGN" == 1 ]] || stop "organization $ORG_SLUG is not present exactly once in $DB_EXPECT ($ORGN)"
report() { say "memberships of $ORG_SLUG (role | status | name | sign-in id | NEW/OLD):"; RO -d "$DB_EXPECT" -c "$Q_REPORT" | sed 's/^/   /' | tee -a "$LOG"; say "active owners: $(RO -d "$DB_EXPECT" -c "select count(*) from ogevia.organization_memberships m join ogevia.organizations o on o.id = m.organization_id where o.slug = '$ORG_SLUG' and m.role = 'organization_owner' and m.status = 'active'")"; }
report
NEW_M=$(RO -d "$DB_EXPECT" -c "select coalesce(m.role::text,'') || '|' || coalesce(m.status::text,'') from ogevia.app_users u join ogevia.organization_memberships m on m.user_id = u.id join ogevia.organizations o on o.id = m.organization_id where o.slug = '$ORG_SLUG' and u.cognito_sub = '$NEW_SUB'") || stop "cannot read the new owner's membership"
case "$ARG" in
  inspect) say "INSPECT DONE. New owner membership: ${NEW_M:-none}. Nothing was changed." ;;
  grant)
    if [[ "$NEW_M" == "organization_owner|active" ]]; then say "The new sign-in is already an ACTIVE organization_owner. Nothing was changed."
    elif [[ -n "$NEW_M" ]]; then stop "the new sign-in already has a membership ($NEW_M) in $ORG_SLUG; resolve it first (nothing was changed)"
    else
      MIGRATING=1
      RW -d "$DB_EXPECT" -v ON_ERROR_STOP=1 -v new_sub="$NEW_SUB" -v new_name="$NEW_NAME" -v ref="$OGEVIA_DEPLOY_APPROVAL" -v slug="$ORG_SLUG" -f - >"$B/f1-grant.out" 2>&1 <<'SQL' || { say "GRANT FAILED (rolled back): $(tail -2 "$B/f1-grant.out" | tr '\n' ' ' | cut -c1-300)"; stop "the grant did not complete; nothing was changed"; }
begin;
select set_config('ogevia.f1_sub', :'new_sub', true), set_config('ogevia.f1_name', :'new_name', true), set_config('ogevia.f1_ref', :'ref', true), set_config('ogevia.f1_slug', :'slug', true);
do $$
declare v_org uuid; v_user uuid; v_member uuid;
begin
  select id into v_org from ogevia.organizations where slug = current_setting('ogevia.f1_slug');
  if v_org is null then raise exception 'organization not found'; end if;
  insert into ogevia.app_users (cognito_sub, display_name) values (current_setting('ogevia.f1_sub'), nullif(btrim(current_setting('ogevia.f1_name')), ''))
    on conflict (cognito_sub) do nothing;
  select id into v_user from ogevia.app_users where cognito_sub = current_setting('ogevia.f1_sub');
  if exists (select 1 from ogevia.organization_memberships where organization_id = v_org and user_id = v_user) then raise exception 'a membership already exists'; end if;
  insert into ogevia.organization_memberships (organization_id, user_id, role, status) values (v_org, v_user, 'organization_owner', 'active') returning id into v_member;
  perform ogevia.write_audit(v_org, 'organization.owner_added', 'organization_memberships', v_member, null,
    jsonb_build_object('user_id', v_user, 'role', 'organization_owner', 'status', 'active', 'source', 'f1-owner-transition-prd.sh', 'approval', current_setting('ogevia.f1_ref')), null);
end $$;
commit;
SQL
      MIGRATING=0; say "GRANTED: the new sign-in is now an active organization_owner."
    fi
    report ;;
  retire)
    [[ "$NEW_M" == "organization_owner|active" ]] || stop "the NEW sign-in is not an ACTIVE owner (${NEW_M:-no membership}): run grant first. Nothing was changed."
    OLD_M=$(RO -d "$DB_EXPECT" -c "select m.role::text || '|' || m.status::text from ogevia.app_users u join ogevia.organization_memberships m on m.user_id = u.id join ogevia.organizations o on o.id = m.organization_id where o.slug = '$ORG_SLUG' and u.cognito_sub = '$OLD_SUB'") || stop "cannot read the old owner's membership"
    [[ -n "$OLD_M" ]] || stop "the old sign-in has no membership in $ORG_SLUG; nothing to retire"
    [[ "$OLD_M" != *"|suspended" && "$OLD_M" != *"|revoked" ]] || { say "The old sign-in's membership is already ${OLD_M#*|}. Nothing was changed."; report; exit 0; }
    OTHERS=$(RO -d "$DB_EXPECT" -c "select count(*) from ogevia.organization_memberships m join ogevia.organizations o on o.id = m.organization_id join ogevia.app_users u on u.id = m.user_id where o.slug = '$ORG_SLUG' and m.role = 'organization_owner' and m.status = 'active' and u.cognito_sub <> '$OLD_SUB'") || stop "cannot count the other owners"
    [[ "$OTHERS" -ge 1 ]] || stop "no other active owner would remain. Nothing was changed."
    MIGRATING=1
    RW -d "$DB_EXPECT" -v ON_ERROR_STOP=1 -v old_sub="$OLD_SUB" -v ref="$OGEVIA_DEPLOY_APPROVAL" -v slug="$ORG_SLUG" -f - >"$B/f1-retire.out" 2>&1 <<'SQL' || { say "RETIRE FAILED (rolled back): $(tail -2 "$B/f1-retire.out" | tr '\n' ' ' | cut -c1-300)"; stop "the retirement did not complete; nothing was changed"; }
begin;
select set_config('ogevia.f1_sub', :'old_sub', true), set_config('ogevia.f1_ref', :'ref', true), set_config('ogevia.f1_slug', :'slug', true);
do $$
declare v_org uuid; v_user uuid; v_m ogevia.organization_memberships%rowtype;
begin
  select id into v_org from ogevia.organizations where slug = current_setting('ogevia.f1_slug');
  select id into v_user from ogevia.app_users where cognito_sub = current_setting('ogevia.f1_sub');
  select * into v_m from ogevia.organization_memberships where organization_id = v_org and user_id = v_user for update;
  if v_m.id is null then raise exception 'membership not found'; end if;
  if not exists (select 1 from ogevia.organization_memberships o where o.organization_id = v_org and o.role = 'organization_owner' and o.status = 'active' and o.user_id <> v_user) then
    raise exception 'no other active owner would remain'; end if;
  update ogevia.organization_memberships set status = 'suspended', updated_at = now() where id = v_m.id;
  perform ogevia.write_audit(v_org, 'organization.owner_retired', 'organization_memberships', v_m.id,
    jsonb_build_object('role', v_m.role, 'status', v_m.status), jsonb_build_object('role', v_m.role, 'status', 'suspended', 'source', 'f1-owner-transition-prd.sh', 'approval', current_setting('ogevia.f1_ref')), null);
end $$;
commit;
SQL
    MIGRATING=0; say "RETIRED: the old sign-in's production membership is suspended (reversible)."
    report
    say "Undo (a separate approved step): set that membership's status back to 'active' with the same window procedure." ;;
esac
win_close
say "SECURITY GROUP: $([[ -f "$WIN_OPEN" ]] && echo 'NOT RESTORED, see the instructions above' || echo 'restored and verified identical to the original')"
exit "$RC"
