-- 0048 Sign-in account status and Admin enable/disable.
--
-- Owner decision (2026-10-11): an Admin (organization owner) can see each person's sign-in status in plain words and can disable or
-- re-enable a sign-in for people in THEIR OWN agency. Passwords are never shown, set or stored. The login email stays in Cognito only.
--   * New permission accounts.manage, held ONLY by organization_owner. A manager, scheduler or caregiver is refused by the database.
--   * list_accounts: one row per person with access to the agency, and one row per Care Team record that has no sign-in yet.
--     account_status: active | invitation_pending (invited, has not signed in yet) | disabled | setup_required (no sign-in exists).
--   * disable_account: suspends the person's membership in THIS agency (immediate: get_my_context and every permission check require an
--     active membership). Only when that was their last active access anywhere is app_users.status set to 'disabled' (begin_request then
--     refuses them at once) and the caller told to switch the Cognito sign-in off. A sign-in shared with another agency is never switched off
--     by this agency. Refused: yourself; the last active owner. Reason required. Audited (no email, no password).
--   * prepare_account_enable / enable_account: re-enable. The sign-in is switched on in Cognito FIRST (the API calls the identity function
--     between the two), then the membership and the app user are restored and the change audited.
--   * Disabling is database-first (the safe direction): if the Cognito call fails the person is already blocked in Ogevia and a retry is safe.
--   * Nothing is deleted. History, assignments and visits stay as they were.

insert into ogevia.permissions (key, description) values
  ('accounts.manage', 'See sign-in account status and disable or re-enable sign-ins for people in this agency');
insert into ogevia.role_permissions (role, permission_key) values
  ('organization_owner', 'accounts.manage');

create function ogevia.accounts_manage_guard(p_organization_id uuid)
returns uuid
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.require_actor();
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'accounts.manage') then
    raise exception 'Only an administrator can manage sign-in accounts' using errcode = 'OGA03';
  end if;
  return v_actor;
end;
$$;

create function ogevia_api.list_accounts(p_organization_id uuid)
returns table (
  user_id uuid, display_name text, role text, membership_status text, account_status text,
  caregiver_record_id uuid, caregiver_code text, caregiver_name text,
  invited_at timestamptz, first_signed_in_at timestamptz, is_self boolean
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.accounts_manage_guard(p_organization_id);
begin
  return query
  select x.* from (
    select u.id as user_id,
           coalesce(nullif(btrim(u.display_name), ''), case when cr.id is not null then coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name end) as display_name,
           m.role::text as role, m.status::text as membership_status,
           case when m.status = 'suspended' or u.status = 'disabled' then 'disabled'
                when m.status = 'invited' or (i.id is not null and i.first_signed_in_at is null) then 'invitation_pending'
                else 'active' end as account_status,
           cr.id as caregiver_record_id, cr.caregiver_code as caregiver_code,
           case when cr.id is not null then coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name end as caregiver_name,
           i.invited_at as invited_at, i.first_signed_in_at as first_signed_in_at, (u.id = v_actor) as is_self
    from ogevia.organization_memberships m
    join ogevia.app_users u on u.id = m.user_id
    left join ogevia.caregiver_records cr on cr.organization_id = m.organization_id and cr.linked_user_id = u.id and cr.deleted_at is null
    left join ogevia.caregiver_invitations i on i.organization_id = m.organization_id and i.user_id = u.id
    where m.organization_id = p_organization_id and m.status <> 'revoked'
    union all
    select null::uuid, coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name, 'caregiver', 'none', 'setup_required',
           cr.id, cr.caregiver_code, coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name, null::timestamptz, null::timestamptz, false
    from ogevia.caregiver_records cr
    where cr.organization_id = p_organization_id and cr.linked_user_id is null and cr.deleted_at is null and cr.status <> 'inactive'
  ) x
  order by (x.account_status = 'disabled'), lower(coalesce(x.display_name, '')), x.caregiver_code;
end;
$$;

create function ogevia_api.disable_account(p_organization_id uuid, p_user_id uuid, p_reason text)
returns table (cognito_sub text, disable_sign_in boolean)
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.accounts_manage_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_m ogevia.organization_memberships%rowtype;
  v_u ogevia.app_users%rowtype;
  v_disable boolean;
begin
  if length(v_reason) < 3 then raise exception 'Enter a reason for disabling this account' using errcode = 'OGV22'; end if;
  perform pg_advisory_xact_lock(hashtextextended('account|' || p_user_id::text, 0));
  select * into v_m from ogevia.organization_memberships m
   where m.organization_id = p_organization_id and m.user_id = p_user_id and m.status <> 'revoked' for update;
  if v_m.id is null then raise exception 'Person not found' using errcode = 'OGN04'; end if;
  if p_user_id = v_actor then raise exception 'You cannot disable your own sign-in' using errcode = 'OGC09'; end if;
  if v_m.role = 'organization_owner' and v_m.status = 'active' and not exists (
       select 1 from ogevia.organization_memberships o
        where o.organization_id = p_organization_id and o.role = 'organization_owner' and o.status = 'active' and o.user_id <> p_user_id) then
    raise exception 'This is the only active owner. Add another owner before disabling this account' using errcode = 'OGC09';
  end if;
  select * into v_u from ogevia.app_users u where u.id = p_user_id for update;
  if v_m.status <> 'suspended' then
    update ogevia.organization_memberships set status = 'suspended', updated_at = now() where id = v_m.id;
    perform ogevia.write_audit(p_organization_id, 'account.disabled', 'organization_memberships', v_m.id,
      jsonb_build_object('membership_status', v_m.status), jsonb_build_object('membership_status', 'suspended', 'user_id', p_user_id), v_reason);
  end if;
  -- The sign-in itself is switched off only when this was the person's last active access anywhere.
  v_disable := not exists (select 1 from ogevia.organization_memberships o where o.user_id = p_user_id and o.id <> v_m.id and o.status = 'active');
  if v_disable and v_u.status <> 'disabled' then
    update ogevia.app_users set status = 'disabled', updated_at = now() where id = p_user_id;
  end if;
  return query select v_u.cognito_sub, v_disable;
end;
$$;

create function ogevia_api.prepare_account_enable(p_organization_id uuid, p_user_id uuid)
returns table (cognito_sub text, sign_in_disabled boolean)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.accounts_manage_guard(p_organization_id);
  v_u ogevia.app_users%rowtype;
begin
  select u.* into v_u from ogevia.app_users u
   where u.id = p_user_id and exists (select 1 from ogevia.organization_memberships m
                                      where m.organization_id = p_organization_id and m.user_id = p_user_id and m.status <> 'revoked');
  if v_u.id is null then raise exception 'Person not found' using errcode = 'OGN04'; end if;
  return query select v_u.cognito_sub, (v_u.status = 'disabled');
end;
$$;

create function ogevia_api.enable_account(p_organization_id uuid, p_user_id uuid, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.accounts_manage_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_m ogevia.organization_memberships%rowtype;
begin
  if length(v_reason) < 3 then raise exception 'Enter a reason for enabling this account' using errcode = 'OGV22'; end if;
  perform pg_advisory_xact_lock(hashtextextended('account|' || p_user_id::text, 0));
  select * into v_m from ogevia.organization_memberships m
   where m.organization_id = p_organization_id and m.user_id = p_user_id and m.status <> 'revoked' for update;
  if v_m.id is null then raise exception 'Person not found' using errcode = 'OGN04'; end if;
  update ogevia.app_users set status = 'active', updated_at = now() where id = p_user_id and status = 'disabled';
  if v_m.status = 'suspended' then
    update ogevia.organization_memberships set status = 'active', updated_at = now() where id = v_m.id;
    perform ogevia.write_audit(p_organization_id, 'account.enabled', 'organization_memberships', v_m.id,
      jsonb_build_object('membership_status', 'suspended'), jsonb_build_object('membership_status', 'active', 'user_id', p_user_id), v_reason);
  end if;
  return 'active';
end;
$$;

revoke all on function ogevia_api.list_accounts(uuid) from public;
revoke all on function ogevia_api.disable_account(uuid, uuid, text) from public;
revoke all on function ogevia_api.prepare_account_enable(uuid, uuid) from public;
revoke all on function ogevia_api.enable_account(uuid, uuid, text) from public;
grant execute on function ogevia_api.list_accounts(uuid) to ogevia_app;
grant execute on function ogevia_api.disable_account(uuid, uuid, text) to ogevia_app;
grant execute on function ogevia_api.prepare_account_enable(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.enable_account(uuid, uuid, text) to ogevia_app;
