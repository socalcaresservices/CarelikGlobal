-- A caregiver keeps the primary membership used by visit and assignment guards.
alter table ogevia.organization_memberships add column caregiver_office_role ogevia.system_role;
alter table ogevia.organization_memberships add constraint caregiver_office_role_valid check (
  caregiver_office_role is null or
  (role = 'caregiver' and caregiver_office_role in ('organization_admin','manager','scheduler','coordinator','staff','read_only'))
);

create or replace function ogevia.has_permission(p_organization_id uuid, p_permission text)
returns boolean
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select exists (
    select 1
    from ogevia.organization_memberships m
    join ogevia.role_permissions rp on rp.role in (m.role, m.caregiver_office_role)
    join ogevia.organizations o on o.id = m.organization_id
    where m.organization_id = p_organization_id
      and m.user_id = ogevia.current_user_id()
      and m.status = 'active'
      and o.status = 'active'
      and rp.permission_key = p_permission
  );
$$;

create or replace function ogevia_api.get_my_context()
returns table (
  organization_id uuid,
  organization_slug text,
  organization_name text,
  organization_timezone text,
  role ogevia.system_role,
  permissions text[]
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select o.id, o.slug, o.display_name, o.timezone, coalesce(m.caregiver_office_role, m.role),
         coalesce(array(
           select distinct rp.permission_key from ogevia.role_permissions rp
           where rp.role in (m.role, m.caregiver_office_role) order by rp.permission_key
         ), '{}')
  from ogevia.organization_memberships m
  join ogevia.organizations o on o.id = m.organization_id
  where m.user_id = ogevia.require_actor()
    and m.status = 'active'
    and o.status = 'active'
  order by o.display_name, o.id;
$$;

-- Include caregiver contact details in the existing agency-scoped Staff roster.
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
                 when m.status = 'invited' then 'invitation_pending'
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
           ct.id, coalesce(ct.name, 'Caregiver')::text, cc.contact_email, cc.contact_phone, (case when cr.status = 'inactive' then 'inactive' else 'active' end)::text,
           coalesce(m.caregiver_office_role, m.role)::text,
           (case when cr.linked_user_id is null then 'none'
                 when m.status in ('suspended', 'revoked') or u.status = 'disabled' then 'disabled'
                 when i.id is not null and i.first_signed_in_at is null then 'invitation_pending'
                 else 'active' end)::text,
           i.invited_at, i.first_signed_in_at, (cr.linked_user_id is not distinct from v_actor)
      from ogevia.caregiver_records cr
      left join ogevia.caregiver_contacts cc on cc.caregiver_record_id = cr.id and cc.organization_id = cr.organization_id
      left join ogevia.staff_types ct on ct.organization_id = cr.organization_id and lower(ct.name) = 'caregiver'
      left join ogevia.app_users u on u.id = cr.linked_user_id
      left join ogevia.organization_memberships m on m.organization_id = cr.organization_id and m.user_id = cr.linked_user_id
      left join ogevia.caregiver_invitations i on i.organization_id = cr.organization_id and i.caregiver_record_id = cr.id
     where cr.organization_id = p_organization_id and cr.deleted_at is null
    union all
    select ('member:' || m.user_id)::text, null::uuid, null::uuid, m.user_id, coalesce(nullif(btrim(u.display_name), ''), 'Name not set')::text,
           null::uuid, null::text, null::text, null::text, 'active'::text, coalesce(m.caregiver_office_role, m.role)::text,
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


create or replace function ogevia_api.set_staff_role(p_organization_id uuid, p_user_id uuid, p_role text, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.staff_guard(p_organization_id, true);
  v_role ogevia.system_role;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_m ogevia.organization_memberships%rowtype;
begin
  if length(v_reason) < 3 then raise exception 'Enter a reason for the role change' using errcode = 'OGV22'; end if;
  perform pg_advisory_xact_lock(hashtextextended('account|' || p_user_id::text, 0));
  select * into v_m from ogevia.organization_memberships m where m.organization_id = p_organization_id and m.user_id = p_user_id and m.status <> 'revoked' for update;
  if v_m.id is null then raise exception 'Person not found' using errcode = 'OGN04'; end if;
  if p_user_id = v_actor then raise exception 'You cannot change your own role' using errcode = 'OGC09'; end if;
  if v_m.role in ('organization_owner', 'platform_owner') then raise exception 'The Owner role is protected and cannot be changed here' using errcode = 'OGC09'; end if;
  if v_m.role = 'caregiver' then
    v_role := case when p_role = 'caregiver' then null else ogevia.assignable_staff_role(p_role) end;
    perform ogevia.staff_role_change_allowed(p_organization_id, v_actor, v_m.caregiver_office_role::text, v_role::text);
    if v_m.caregiver_office_role is not distinct from v_role then return coalesce(v_role::text, 'caregiver'); end if;
    update ogevia.organization_memberships set caregiver_office_role = v_role, updated_at = now() where id = v_m.id;
    perform ogevia.write_audit(p_organization_id, 'staff.role_changed', 'organization_memberships', v_m.id,
      jsonb_build_object('role', coalesce(v_m.caregiver_office_role::text, 'caregiver'), 'user_id', p_user_id),
      jsonb_build_object('role', coalesce(v_role::text, 'caregiver'), 'user_id', p_user_id, 'retains_caregiver', true), v_reason);
    return coalesce(v_role::text, 'caregiver');
  end if;
  v_role := ogevia.assignable_staff_role(p_role);
  if v_m.role not in ('organization_admin', 'manager', 'scheduler', 'coordinator', 'staff', 'read_only') then
    raise exception 'Only agency staff roles can be changed here' using errcode = 'OGC09';
  end if;
  perform ogevia.staff_role_change_allowed(p_organization_id, v_actor, v_m.role::text, v_role::text);
  if v_m.role = v_role then return v_role::text; end if;
  update ogevia.organization_memberships set role = v_role, updated_at = now() where id = v_m.id;
  perform ogevia.write_audit(p_organization_id, 'staff.role_changed', 'organization_memberships', v_m.id,
    jsonb_build_object('role', v_m.role::text), jsonb_build_object('role', v_role::text, 'user_id', p_user_id), v_reason);
  return v_role::text;
end;
$$;
