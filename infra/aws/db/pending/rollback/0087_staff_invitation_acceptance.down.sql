-- ROLLBACK 0087 | CLASS: ADDITIVE. Restores the 0086 versions of the replaced functions and removes the two acceptance functions.
-- A membership left in status 'invited' by 0087 is NOT changed: under 0086 it is simply a membership that grants nothing until an Owner re-invites or removes it.
drop function if exists ogevia_api.accept_staff_invitation(uuid);
drop function if exists ogevia_api.list_my_staff_invitations();
drop function ogevia_api.complete_staff_invitation(uuid, uuid, text, text, boolean, text);
create function ogevia_api.complete_staff_invitation(
  p_organization_id uuid, p_profile_id uuid, p_email text, p_cognito_sub text, p_existing_account boolean, p_role text
)
returns table (profile_id uuid, existing_account boolean)
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.staff_guard(p_organization_id, true);
  v_email text := ogevia.normalize_invitation_email(p_email);
  v_role ogevia.system_role := ogevia.assignable_staff_role(p_role);
  v_p ogevia.staff_profiles%rowtype; v_user ogevia.app_users%rowtype; v_member ogevia.organization_memberships%rowtype;
begin
  if p_cognito_sub is null or p_cognito_sub !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Invalid sign-in identifier' using errcode = 'OGV22';
  end if;
  perform ogevia.staff_role_change_allowed(p_organization_id, v_actor, null, v_role::text);
  select * into v_p from ogevia.staff_profiles p where p.id = p_profile_id and p.organization_id = p_organization_id for update;
  if v_p.id is null then raise exception 'Staff member not found' using errcode = 'OGN04'; end if;
  if v_p.status = 'inactive' then raise exception 'This staff member is inactive; reactivate them before inviting' using errcode = 'OGC09'; end if;
  if v_p.user_id is not null then raise exception 'This staff member already has a sign-in' using errcode = 'OGC09'; end if;

  perform pg_advisory_xact_lock(hashtextextended('cognito_sub|' || p_cognito_sub, 0));
  select * into v_user from ogevia.app_users u where u.cognito_sub = p_cognito_sub;
  if v_user.id is null then
    insert into ogevia.app_users (cognito_sub) values (p_cognito_sub) returning * into v_user;
  elsif v_user.status <> 'active' then
    raise exception 'That sign-in is disabled' using errcode = 'OGC09';
  end if;
  select * into v_member from ogevia.organization_memberships m where m.organization_id = p_organization_id and m.user_id = v_user.id for update;
  if v_member.id is not null and v_member.status <> 'invited' then
    -- Never change an existing role here (it would be a role change by the back door) and never mix caregiver and staff access.
    raise exception 'That email already has access to this agency; change its role from the staff list instead' using errcode = 'OGC09';
  end if;
  if exists (select 1 from ogevia.staff_profiles p where p.organization_id = p_organization_id and p.user_id = v_user.id)
     or exists (select 1 from ogevia.caregiver_records r where r.organization_id = p_organization_id and r.linked_user_id = v_user.id and r.deleted_at is null) then
    raise exception 'That sign-in is already linked to someone in this agency' using errcode = 'OGC09';
  end if;
  if v_member.id is null then
    insert into ogevia.organization_memberships (organization_id, user_id, role, status) values (p_organization_id, v_user.id, v_role, 'active');
  else
    update ogevia.organization_memberships set role = v_role, status = 'active', updated_at = now() where id = v_member.id;
  end if;
  update ogevia.staff_profiles
     set user_id = v_user.id, login_email = v_email, invited_by = v_actor, invited_at = now(), last_sent_at = now(), send_count = 1, first_signed_in_at = null, updated_at = now()
   where id = v_p.id;
  perform ogevia.write_audit(p_organization_id, 'staff.invited', 'staff_profiles', v_p.id, null,
    jsonb_build_object('role', v_role::text, 'existing_account', coalesce(p_existing_account, false)), null);
  return query select v_p.id, coalesce(p_existing_account, false);
end;
$$;

revoke all on function ogevia_api.complete_staff_invitation(uuid, uuid, text, text, boolean, text) from public;
grant execute on function ogevia_api.complete_staff_invitation(uuid, uuid, text, text, boolean, text) to ogevia_app;
create or replace function ogevia_api.note_my_sign_in()
returns void
language sql
security definer
set search_path = ogevia, pg_temp
as $$
  update ogevia.caregiver_invitations set first_signed_in_at = now()
  where user_id = ogevia.require_actor() and first_signed_in_at is null;
  update ogevia.staff_profiles set first_signed_in_at = now()
  where user_id = ogevia.require_actor() and first_signed_in_at is null;
$$;

create or replace function ogevia_api.list_staff(p_organization_id uuid)
returns table (
  staff_key text, profile_id uuid, caregiver_record_id uuid, user_id uuid, display_name text, staff_type_id uuid, staff_type_name text,
  contact_email text, phone text, status text, system_role text, access_status text, invited_at timestamptz, first_signed_in_at timestamptz, is_self boolean
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare v_actor uuid := ogevia.staff_guard(p_organization_id, false);
begin
  return query
  select x.* from (
    select ('profile:' || p.id)::text as staff_key, p.id as profile_id, null::uuid as caregiver_record_id, p.user_id as user_id, p.display_name::text as display_name,
           t.id as staff_type_id, t.name::text as staff_type_name, p.contact_email::text as contact_email, p.phone::text as phone, p.status::text as status,
           m.role::text as system_role,
           (case when p.user_id is null then 'none'
                 when m.status in ('suspended', 'revoked') or u.status = 'disabled' then 'disabled'
                 when p.first_signed_in_at is null then 'invitation_pending'
                 else 'active' end)::text as access_status,
           p.invited_at as invited_at, p.first_signed_in_at as first_signed_in_at, (p.user_id is not distinct from v_actor) as is_self
      from ogevia.staff_profiles p
      join ogevia.staff_types t on t.id = p.staff_type_id and t.organization_id = p.organization_id
      left join ogevia.app_users u on u.id = p.user_id
      left join ogevia.organization_memberships m on m.organization_id = p.organization_id and m.user_id = p.user_id
     where p.organization_id = p_organization_id
    union all
    select ('caregiver:' || cr.id)::text, null::uuid, cr.id, cr.linked_user_id, (coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name)::text,
           ct.id, coalesce(ct.name, 'Caregiver')::text, null::text, null::text, (case when cr.status = 'inactive' then 'inactive' else 'active' end)::text,
           m.role::text,
           (case when cr.linked_user_id is null then 'none'
                 when m.status in ('suspended', 'revoked') or u.status = 'disabled' then 'disabled'
                 when i.id is not null and i.first_signed_in_at is null then 'invitation_pending'
                 else 'active' end)::text,
           i.invited_at, i.first_signed_in_at, (cr.linked_user_id is not distinct from v_actor)
      from ogevia.caregiver_records cr
      left join ogevia.staff_types ct on ct.organization_id = cr.organization_id and lower(ct.name) = 'caregiver'
      left join ogevia.app_users u on u.id = cr.linked_user_id
      left join ogevia.organization_memberships m on m.organization_id = cr.organization_id and m.user_id = cr.linked_user_id
      left join ogevia.caregiver_invitations i on i.organization_id = cr.organization_id and i.caregiver_record_id = cr.id
     where cr.organization_id = p_organization_id and cr.deleted_at is null
    union all
    select ('member:' || m.user_id)::text, null::uuid, null::uuid, m.user_id, coalesce(nullif(btrim(u.display_name), ''), 'Name not set')::text,
           null::uuid, null::text, null::text, null::text, 'active'::text, m.role::text,
           (case when m.status in ('suspended', 'revoked') or u.status = 'disabled' then 'disabled' when m.status = 'invited' then 'invitation_pending' else 'active' end)::text,
           null::timestamptz, null::timestamptz, (m.user_id = v_actor)
      from ogevia.organization_memberships m
      join ogevia.app_users u on u.id = m.user_id
     where m.organization_id = p_organization_id and m.status <> 'revoked'
       and m.role in ('organization_owner', 'organization_admin', 'manager', 'scheduler', 'coordinator', 'staff', 'read_only')
       and not exists (select 1 from ogevia.staff_profiles p where p.organization_id = m.organization_id and p.user_id = m.user_id)
       and not exists (select 1 from ogevia.caregiver_records cr where cr.organization_id = m.organization_id and cr.linked_user_id = m.user_id and cr.deleted_at is null)
  ) x
  order by (x.status = 'inactive'), lower(x.display_name), x.staff_key;
end;
$$;

create or replace function ogevia_api.update_staff(
  p_organization_id uuid, p_profile_id uuid, p_display_name text, p_staff_type_id uuid, p_contact_email text, p_phone text, p_status text
)
returns void
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.staff_guard(p_organization_id, true);
  v_name text := regexp_replace(btrim(coalesce(p_display_name, '')), '\s+', ' ', 'g');
  v_email text; v_phone text; v_p ogevia.staff_profiles%rowtype; v_type ogevia.staff_types%rowtype; v_old_type text; v_changed text[] := '{}';
begin
  if length(v_name) < 1 or length(v_name) > 120 then raise exception 'Enter the staff member''s name' using errcode = 'OGV22'; end if;
  if p_status is null or p_status not in ('active', 'inactive') then raise exception 'Choose active or inactive' using errcode = 'OGV22'; end if;
  select * into v_email, v_phone from ogevia.staff_validate_contact(p_contact_email, p_phone);
  perform pg_advisory_xact_lock(hashtextextended('staff_profile|' || p_organization_id::text, 0));
  select * into v_p from ogevia.staff_profiles p where p.id = p_profile_id and p.organization_id = p_organization_id for update;
  if v_p.id is null then raise exception 'Staff member not found' using errcode = 'OGN04'; end if;
  select * into v_type from ogevia.staff_types t where t.id = p_staff_type_id and t.organization_id = p_organization_id;
  if v_type.id is null then raise exception 'Staff type not found' using errcode = 'OGN04'; end if;
  if v_type.id <> v_p.staff_type_id and not v_type.is_active then raise exception 'That staff type is inactive; choose an active one' using errcode = 'OGC09'; end if;
  if v_email is not null and exists (select 1 from ogevia.staff_profiles p where p.organization_id = p_organization_id and p.contact_email = v_email and p.id <> v_p.id) then
    raise exception 'A staff member with that contact email already exists' using errcode = 'OGC09';
  end if;
  if v_name <> v_p.display_name then v_changed := array_append(v_changed, 'name'); end if;
  if v_type.id <> v_p.staff_type_id then v_changed := array_append(v_changed, 'staff_type'); end if;
  if v_email is distinct from v_p.contact_email then v_changed := array_append(v_changed, 'contact_email'); end if;
  if v_phone is distinct from v_p.phone then v_changed := array_append(v_changed, 'phone'); end if;
  if p_status <> v_p.status then v_changed := array_append(v_changed, 'status'); end if;
  if cardinality(v_changed) = 0 then return; end if;
  select t.name into v_old_type from ogevia.staff_types t where t.id = v_p.staff_type_id;
  update ogevia.staff_profiles set display_name = v_name, staff_type_id = v_type.id, contact_email = v_email, phone = v_phone, status = p_status, updated_at = now() where id = v_p.id;
  perform ogevia.write_audit(p_organization_id, 'staff.updated', 'staff_profiles', v_p.id,
    jsonb_build_object('staff_type', v_old_type, 'status', v_p.status), jsonb_build_object('staff_type', v_type.name, 'status', p_status, 'changed', to_jsonb(v_changed)), null);
end;
$$;

create or replace function ogevia_api.disable_account(p_organization_id uuid, p_user_id uuid, p_reason text)
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

create or replace function ogevia_api.list_accounts(p_organization_id uuid)
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
