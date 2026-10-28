-- 0087 (PENDING: infra/aws/db/pending, applied AFTER 0086, outside the ledger like 0086) | CLASS: ADDITIVE (replaces 0086 functions; adds 2; no table, row or data change)
-- Security-review findings on 0086 (SECURITY_REVIEW_0086_AI_SECOND_READ.md), Owner decision: Option B for M-1.
--   M-1  inviting an e-mail that already has a sign-in no longer grants access at once: the membership is created INVITED and becomes active only when that
--        person accepts after signing in (list_my_staff_invitations / accept_staff_invitation). A brand-new sign-in (which e-mails its owner) is active at once.
--   L-1  the invitation no longer reveals whether an e-mail already has a sign-in or whether it is disabled (no existing_account in the reply; no "disabled" refusal).
--   L-2  an existing membership of ANY status (including a pending invitation) is never overwritten by an invitation.
--   L-3  setting a staff profile inactive suspends that person's membership in this agency (reactivating does not restore it; use Accounts > Enable).
-- Also: list_staff shows a not-yet-accepted invitation as invitation_pending, and note_my_sign_in no longer marks a pending invitation as signed in.
-- Nothing is deleted or updated in existing rows. A membership created under 0086 stays as it is (active); this changes invitations made from now on.

drop function ogevia_api.complete_staff_invitation(uuid, uuid, text, text, boolean, text);
create function ogevia_api.complete_staff_invitation(
  p_organization_id uuid, p_profile_id uuid, p_email text, p_cognito_sub text, p_existing_account boolean, p_role text
)
returns table (profile_id uuid)
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
  v_new_user boolean := false; v_immediate boolean;
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
    v_new_user := true;
  end if;
  -- 0087 (L-1): a disabled sign-in is NOT reported to the inviter. The invitation is recorded the same way; the person simply cannot sign in or accept.
  select * into v_member from ogevia.organization_memberships m where m.organization_id = p_organization_id and m.user_id = v_user.id for update;
  if v_member.id is not null then
    -- 0087 (L-2): never touch an existing membership of ANY status (active, suspended, revoked or a pending invitation). A role is changed only by set_staff_role.
    raise exception 'That email already has access to this agency or a pending invitation; use the staff list instead' using errcode = 'OGC09';
  end if;
  if exists (select 1 from ogevia.staff_profiles p where p.organization_id = p_organization_id and p.user_id = v_user.id)
     or exists (select 1 from ogevia.caregiver_records r where r.organization_id = p_organization_id and r.linked_user_id = v_user.id and r.deleted_at is null) then
    raise exception 'That sign-in is already linked to someone in this agency' using errcode = 'OGC09';
  end if;
  -- 0087 (M-1): a brand-new sign-in (created by this invitation, which e-mails its owner) is active at once. An account that already existed, or that already
  -- belongs to any agency, gets an INVITED membership that grants nothing until that person accepts it after signing in.
  v_immediate := v_new_user or (not coalesce(p_existing_account, false) and v_user.status = 'active'
                                and not exists (select 1 from ogevia.organization_memberships o where o.user_id = v_user.id));
  insert into ogevia.organization_memberships (organization_id, user_id, role, status)
  values (p_organization_id, v_user.id, v_role, case when v_immediate then 'active'::ogevia.membership_status else 'invited'::ogevia.membership_status end);
  update ogevia.staff_profiles
     set user_id = v_user.id, login_email = v_email, invited_by = v_actor, invited_at = now(), last_sent_at = now(), send_count = 1, first_signed_in_at = null, updated_at = now()
   where id = v_p.id;
  perform ogevia.write_audit(p_organization_id, 'staff.invited', 'staff_profiles', v_p.id, null,
    jsonb_build_object('role', v_role::text, 'existing_account', coalesce(p_existing_account, false), 'access', case when v_immediate then 'active' else 'pending_acceptance' end), null);
  return query select v_p.id;
end;
$$;

create or replace function ogevia_api.note_my_sign_in()
returns void
language sql
security definer
set search_path = ogevia, pg_temp
as $$
  update ogevia.caregiver_invitations set first_signed_in_at = now()
  where user_id = ogevia.require_actor() and first_signed_in_at is null;
  -- 0087: a staff invitation is marked only where the membership is active. A pending invitation (invited) is marked by accept_staff_invitation.
  update ogevia.staff_profiles p set first_signed_in_at = now()
  where p.user_id = ogevia.require_actor() and p.first_signed_in_at is null
    and exists (select 1 from ogevia.organization_memberships m where m.organization_id = p.organization_id and m.user_id = p.user_id and m.status = 'active');
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
                 when m.status = 'invited' then 'invitation_pending'
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
  v_email text; v_phone text; v_p ogevia.staff_profiles%rowtype; v_type ogevia.staff_types%rowtype; v_old_type text; v_changed text[] := '{}'; v_m ogevia.organization_memberships%rowtype;
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
  -- 0087 (L-3): setting a person inactive also stops their access to THIS agency. Their membership is suspended (the same state as Accounts > Disable), so
  -- the application refuses them at the next request. Reactivating the profile does NOT bring access back by itself; use Accounts > Enable. Not applied to the
  -- Owner roles, to the person making the change, or to a pending invitation (an invited membership grants nothing, and acceptance is refused for an inactive profile).
  if p_status = 'inactive' and v_p.status <> 'inactive' and v_p.user_id is not null and v_p.user_id <> v_actor then
    perform pg_advisory_xact_lock(hashtextextended('account|' || v_p.user_id::text, 0));
    select * into v_m from ogevia.organization_memberships m
     where m.organization_id = p_organization_id and m.user_id = v_p.user_id and m.status = 'active'
       and m.role in ('organization_admin', 'manager', 'scheduler', 'coordinator', 'staff', 'read_only') for update;
    if v_m.id is not null then
      update ogevia.organization_memberships set status = 'suspended', updated_at = now() where id = v_m.id;
      perform ogevia.write_audit(p_organization_id, 'staff.access_suspended', 'organization_memberships', v_m.id,
        jsonb_build_object('membership_status', 'active'), jsonb_build_object('membership_status', 'suspended', 'user_id', v_p.user_id), 'Staff profile set to inactive');
    end if;
  end if;
end;
$$;

-- The invited person's side: what is waiting for them, and acceptance. Both act only on the signed-in person's own rows.
create function ogevia_api.list_my_staff_invitations()
returns table (organization_id uuid, organization_name text, role text, invited_at timestamptz)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select o.id, o.display_name::text, m.role::text, p.invited_at
    from ogevia.organization_memberships m
    join ogevia.staff_profiles p on p.organization_id = m.organization_id and p.user_id = m.user_id and p.status = 'active'
    join ogevia.organizations o on o.id = m.organization_id and o.status = 'active'
   where m.user_id = ogevia.require_actor() and m.status = 'invited'
   order by o.display_name, o.id;
$$;

create function ogevia_api.accept_staff_invitation(p_organization_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_m ogevia.organization_memberships%rowtype; v_p ogevia.staff_profiles%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('account|' || v_actor::text, 0));
  select * into v_m from ogevia.organization_memberships m where m.organization_id = p_organization_id and m.user_id = v_actor for update;
  select * into v_p from ogevia.staff_profiles p where p.organization_id = p_organization_id and p.user_id = v_actor for update;
  if v_m.id is null or v_p.id is null or v_p.status <> 'active'
     or not exists (select 1 from ogevia.organizations o where o.id = p_organization_id and o.status = 'active') then
    raise exception 'Invitation not found' using errcode = 'OGN04';
  end if;
  if v_m.status = 'active' and v_p.first_signed_in_at is not null then return v_m.role::text; end if;   -- a repeated accept (a lost response) changes nothing
  if v_m.status <> 'invited' then raise exception 'Invitation not found' using errcode = 'OGN04'; end if;
  update ogevia.organization_memberships set status = 'active', updated_at = now() where id = v_m.id;
  update ogevia.staff_profiles set first_signed_in_at = now(), updated_at = now() where id = v_p.id;
  perform ogevia.write_audit(p_organization_id, 'staff.invitation_accepted', 'staff_profiles', v_p.id,
    jsonb_build_object('membership_status', 'invited'), jsonb_build_object('membership_status', 'active', 'role', v_m.role::text), null);
  return v_m.role::text;
end;
$$;

revoke all on function ogevia_api.complete_staff_invitation(uuid, uuid, text, text, boolean, text) from public;
revoke all on function ogevia_api.list_my_staff_invitations() from public;
revoke all on function ogevia_api.accept_staff_invitation(uuid) from public;
grant execute on function ogevia_api.complete_staff_invitation(uuid, uuid, text, text, boolean, text) to ogevia_app;
grant execute on function ogevia_api.list_my_staff_invitations() to ogevia_app;
grant execute on function ogevia_api.accept_staff_invitation(uuid) to ogevia_app;
