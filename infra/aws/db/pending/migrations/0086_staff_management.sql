-- 0086 Staff management: agency-configurable staff types, staff profiles, supported system roles, staff invitations.
--
-- Owner direction (2026-10-25): Ogevia supports ALL agency staff, not only caregivers. One place (People > Staff) to add staff, edit profiles,
-- configure staff types, assign a supported system role, invite, and see status and history.
--
-- DESIGN (read this before changing it)
--   * A staff TYPE is a label (job title) an agency configures: Manager, Scheduler, Office Assistant ... It carries NO authority. There is no column,
--     function or trigger that turns a staff type into a role or a permission. Authority comes only from the person's SYSTEM ROLE
--     (organization_memberships.role), which only staff.manage can change. A new or renamed type, however named, grants nothing.
--   * Caregivers are NOT copied. Their record stays caregiver_records (one person, one record, one sign-in through caregiver_invitations).
--     list_staff shows them from that record; no second caregiver account or profile is created.
--   * A staff PROFILE (staff_profiles) is for non-caregiver staff: display name, a contact email and phone that are SEPARATE from the sign-in email,
--     a staff type and an active/inactive status. A profile may exist without any access. Inviting creates the sign-in through the existing
--     identity function (same path as caregivers), links the person, and gives the chosen supported system role.
--   * People who already have non-caregiver access but no profile (for example the owner) are listed too, and can be given a profile.
--   * Supported assignable roles: organization_admin, manager, scheduler, coordinator, staff, read_only. NEVER assignable here: organization_owner
--     (protected), platform_owner, caregiver (use the Care Team invitation), or the client-side roles. Only an organization_owner may grant or remove
--     organization_admin. Nobody changes their own role. One role per person per agency (the existing model): several roles per person are NOT supported.
--   * New permissions staff.read and staff.manage are held ONLY by organization_owner (the Administrator view). Widening that is an owner decision.
--   * Disable / enable access stays the existing accounts functions (0048). Nothing here deletes a person or their history.
--   * Every change is audited (no email, phone or sign-in secret in an audit row).

insert into ogevia.permissions (key, description) values
  ('staff.read', 'See the agency staff directory, staff types, system roles and staff history'),
  ('staff.manage', 'Add and edit staff and staff types, invite staff, and assign supported system roles');
insert into ogevia.role_permissions (role, permission_key) values
  ('organization_owner', 'staff.read'),
  ('organization_owner', 'staff.manage');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table ogevia.staff_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  name text not null check (name = btrim(name) and length(name) between 1 and 60),
  is_active boolean not null default true,
  sort_order integer not null default 100,
  created_by uuid references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index staff_types_org_name_idx on ogevia.staff_types (organization_id, lower(name));
alter table ogevia.staff_types enable row level security;

create table ogevia.staff_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  staff_type_id uuid not null,
  display_name text not null check (display_name = btrim(display_name) and length(display_name) between 1 and 120),
  contact_email text check (contact_email is null or length(contact_email) <= 254),
  phone text check (phone is null or phone ~ '^[0-9 +().-]{3,40}$'),
  status text not null default 'active' check (status in ('active', 'inactive')),
  user_id uuid references ogevia.app_users(id),
  login_email text check (login_email is null or length(login_email) <= 254),
  invited_by uuid references ogevia.app_users(id),
  invited_at timestamptz,
  last_sent_at timestamptz,
  send_count integer not null default 0 check (send_count >= 0),
  first_signed_in_at timestamptz,
  created_by uuid references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (staff_type_id, organization_id) references ogevia.staff_types (id, organization_id),
  unique (id, organization_id)
);
create unique index staff_profiles_org_user_idx on ogevia.staff_profiles (organization_id, user_id) where user_id is not null;
create unique index staff_profiles_org_login_email_idx on ogevia.staff_profiles (organization_id, login_email) where login_email is not null;
create index staff_profiles_org_status_idx on ogevia.staff_profiles (organization_id, status);
create index staff_profiles_type_idx on ogevia.staff_profiles (staff_type_id);
alter table ogevia.staff_profiles enable row level security;

-- ---------------------------------------------------------------------------
-- Default staff types (a starting list; every agency can rename, add and deactivate)
-- ---------------------------------------------------------------------------
create function ogevia.seed_default_staff_types(p_organization_id uuid)
returns void
language sql
set search_path = ogevia, pg_temp
as $$
  insert into ogevia.staff_types (organization_id, name, sort_order) values
    (p_organization_id, 'Administrator', 10), (p_organization_id, 'Manager', 20), (p_organization_id, 'Scheduler', 30),
    (p_organization_id, 'Coordinator', 40), (p_organization_id, 'Supervisor', 50), (p_organization_id, 'Office Assistant', 60),
    (p_organization_id, 'Caregiver', 70)
  on conflict do nothing;
$$;

create function ogevia.organizations_seed_staff_types()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.seed_default_staff_types(new.id);
  return new;
end;
$$;
create trigger organizations_seed_staff_types after insert on ogevia.organizations
for each row execute function ogevia.organizations_seed_staff_types();

select ogevia.seed_default_staff_types(o.id) from ogevia.organizations o;

-- ---------------------------------------------------------------------------
-- Guard and helpers
-- ---------------------------------------------------------------------------
create function ogevia.staff_guard(p_organization_id uuid, p_write boolean)
returns uuid
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.require_actor();
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, case when p_write then 'staff.manage' else 'staff.read' end) then
    raise exception 'Only an administrator can manage staff' using errcode = 'OGA03';
  end if;
  return v_actor;
end;
$$;

-- The system roles an administrator may assign to staff. Not organization_owner, platform_owner, caregiver or any client-side role.
create function ogevia.assignable_staff_role(p_role text)
returns ogevia.system_role
language plpgsql
immutable
set search_path = ogevia, pg_temp
as $$
begin
  if p_role is null or p_role not in ('organization_admin', 'manager', 'scheduler', 'coordinator', 'staff', 'read_only') then
    raise exception 'Choose a supported role' using errcode = 'OGV22';
  end if;
  return p_role::ogevia.system_role;
end;
$$;

-- Granting or removing organization_admin is for the Owner only.
create function ogevia.staff_role_change_allowed(p_organization_id uuid, p_actor uuid, p_old text, p_new text)
returns void
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
begin
  if ('organization_admin' in (coalesce(p_old, ''), coalesce(p_new, ''))) and not exists (
       select 1 from ogevia.organization_memberships m
        where m.organization_id = p_organization_id and m.user_id = p_actor and m.role = 'organization_owner' and m.status = 'active') then
    raise exception 'Only the Owner can grant or remove the Admin role' using errcode = 'OGA03';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Staff types
-- ---------------------------------------------------------------------------
create function ogevia_api.list_staff_types(p_organization_id uuid)
returns table (id uuid, name text, is_active boolean, sort_order integer, staff_count bigint)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare v_actor uuid := ogevia.staff_guard(p_organization_id, false);
begin
  return query
  select t.id, t.name, t.is_active, t.sort_order,
         (select count(*) from ogevia.staff_profiles p where p.organization_id = t.organization_id and p.staff_type_id = t.id and p.status = 'active')
    from ogevia.staff_types t
   where t.organization_id = p_organization_id
   order by t.sort_order, lower(t.name);
end;
$$;

create function ogevia_api.create_staff_type(p_organization_id uuid, p_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.staff_guard(p_organization_id, true);
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_id uuid;
begin
  if length(v_name) < 1 or length(v_name) > 60 then raise exception 'Enter a staff type name (up to 60 characters)' using errcode = 'OGV22'; end if;
  perform pg_advisory_xact_lock(hashtextextended('staff_type|' || p_organization_id::text, 0));
  if exists (select 1 from ogevia.staff_types t where t.organization_id = p_organization_id and lower(t.name) = lower(v_name)) then
    raise exception 'A staff type with that name already exists' using errcode = 'OGC09';
  end if;
  insert into ogevia.staff_types (organization_id, name, sort_order, created_by)
  values (p_organization_id, v_name,
          coalesce((select max(t.sort_order) + 10 from ogevia.staff_types t where t.organization_id = p_organization_id), 10), v_actor)
  returning id into v_id;
  perform ogevia.write_audit(p_organization_id, 'staff_type.created', 'staff_types', v_id, null, jsonb_build_object('name', v_name, 'grants_access', false), null);
  return v_id;
end;
$$;

create function ogevia_api.rename_staff_type(p_organization_id uuid, p_staff_type_id uuid, p_name text)
returns void
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.staff_guard(p_organization_id, true);
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_old text;
begin
  if length(v_name) < 1 or length(v_name) > 60 then raise exception 'Enter a staff type name (up to 60 characters)' using errcode = 'OGV22'; end if;
  perform pg_advisory_xact_lock(hashtextextended('staff_type|' || p_organization_id::text, 0));
  select t.name into v_old from ogevia.staff_types t where t.id = p_staff_type_id and t.organization_id = p_organization_id for update;
  if v_old is null then raise exception 'Staff type not found' using errcode = 'OGN04'; end if;
  if exists (select 1 from ogevia.staff_types t where t.organization_id = p_organization_id and lower(t.name) = lower(v_name) and t.id <> p_staff_type_id) then
    raise exception 'A staff type with that name already exists' using errcode = 'OGC09';
  end if;
  if v_old = v_name then return; end if;
  update ogevia.staff_types set name = v_name, updated_at = now() where id = p_staff_type_id;
  perform ogevia.write_audit(p_organization_id, 'staff_type.renamed', 'staff_types', p_staff_type_id, jsonb_build_object('name', v_old), jsonb_build_object('name', v_name), null);
end;
$$;

create function ogevia_api.set_staff_type_active(p_organization_id uuid, p_staff_type_id uuid, p_active boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.staff_guard(p_organization_id, true);
  v_old boolean;
begin
  if p_active is null then raise exception 'Choose active or inactive' using errcode = 'OGV22'; end if;
  select t.is_active into v_old from ogevia.staff_types t where t.id = p_staff_type_id and t.organization_id = p_organization_id for update;
  if v_old is null then raise exception 'Staff type not found' using errcode = 'OGN04'; end if;
  if v_old = p_active then return; end if;
  -- Existing staff keep the type; an inactive type just cannot be chosen for anyone new.
  update ogevia.staff_types set is_active = p_active, updated_at = now() where id = p_staff_type_id;
  perform ogevia.write_audit(p_organization_id, case when p_active then 'staff_type.activated' else 'staff_type.deactivated' end, 'staff_types', p_staff_type_id,
    jsonb_build_object('is_active', v_old), jsonb_build_object('is_active', p_active), null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Staff directory
--   staff_key: 'profile:<id>' (a staff profile), 'caregiver:<id>' (a Care Team record, read from caregiver_records, never copied),
--              'member:<user id>' (someone with non-caregiver access and no profile yet, for example the owner).
--   access_status: none | invitation_pending | active | disabled.
-- ---------------------------------------------------------------------------
create function ogevia_api.list_staff(p_organization_id uuid)
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

create function ogevia.staff_validate_contact(p_email text, p_phone text, out v_email text, out v_phone text)
language plpgsql
immutable
set search_path = ogevia, pg_temp
as $$
begin
  v_email := case when btrim(coalesce(p_email, '')) = '' then null else ogevia.normalize_invitation_email(p_email) end;
  v_phone := nullif(btrim(coalesce(p_phone, '')), '');
  if v_phone is not null and v_phone !~ '^[0-9 +().-]{3,40}$' then raise exception 'Enter a valid phone number' using errcode = 'OGV22'; end if;
end;
$$;

create function ogevia_api.create_staff(p_organization_id uuid, p_display_name text, p_staff_type_id uuid, p_contact_email text, p_phone text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.staff_guard(p_organization_id, true);
  v_name text := regexp_replace(btrim(coalesce(p_display_name, '')), '\s+', ' ', 'g');
  v_email text; v_phone text; v_type ogevia.staff_types%rowtype; v_id uuid;
begin
  if length(v_name) < 1 or length(v_name) > 120 then raise exception 'Enter the staff member''s name' using errcode = 'OGV22'; end if;
  select * into v_email, v_phone from ogevia.staff_validate_contact(p_contact_email, p_phone);
  select * into v_type from ogevia.staff_types t where t.id = p_staff_type_id and t.organization_id = p_organization_id;
  if v_type.id is null then raise exception 'Staff type not found' using errcode = 'OGN04'; end if;
  if not v_type.is_active then raise exception 'That staff type is inactive; choose an active one' using errcode = 'OGC09'; end if;
  perform pg_advisory_xact_lock(hashtextextended('staff_profile|' || p_organization_id::text, 0));
  if v_email is not null and exists (select 1 from ogevia.staff_profiles p where p.organization_id = p_organization_id and p.contact_email = v_email) then
    raise exception 'A staff member with that contact email already exists' using errcode = 'OGC09';
  end if;
  insert into ogevia.staff_profiles (organization_id, staff_type_id, display_name, contact_email, phone, created_by)
  values (p_organization_id, v_type.id, v_name, v_email, v_phone, v_actor) returning id into v_id;
  perform ogevia.write_audit(p_organization_id, 'staff.created', 'staff_profiles', v_id, null, jsonb_build_object('staff_type', v_type.name), null);
  return v_id;
end;
$$;

-- Gives a person who already has non-caregiver access, and no profile, a staff profile (no sign-in is created or changed).
create function ogevia_api.add_member_to_staff(p_organization_id uuid, p_user_id uuid, p_staff_type_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.staff_guard(p_organization_id, true);
  v_m ogevia.organization_memberships%rowtype; v_u ogevia.app_users%rowtype; v_type ogevia.staff_types%rowtype; v_id uuid; v_name text;
begin
  select * into v_m from ogevia.organization_memberships m where m.organization_id = p_organization_id and m.user_id = p_user_id and m.status <> 'revoked';
  if v_m.id is null then raise exception 'Person not found' using errcode = 'OGN04'; end if;
  if v_m.role not in ('organization_owner', 'organization_admin', 'manager', 'scheduler', 'coordinator', 'staff', 'read_only') then
    raise exception 'That person is not agency staff' using errcode = 'OGC09';
  end if;
  select * into v_type from ogevia.staff_types t where t.id = p_staff_type_id and t.organization_id = p_organization_id;
  if v_type.id is null then raise exception 'Staff type not found' using errcode = 'OGN04'; end if;
  if not v_type.is_active then raise exception 'That staff type is inactive; choose an active one' using errcode = 'OGC09'; end if;
  perform pg_advisory_xact_lock(hashtextextended('staff_profile|' || p_organization_id::text, 0));
  if exists (select 1 from ogevia.staff_profiles p where p.organization_id = p_organization_id and p.user_id = p_user_id)
     or exists (select 1 from ogevia.caregiver_records cr where cr.organization_id = p_organization_id and cr.linked_user_id = p_user_id and cr.deleted_at is null) then
    raise exception 'That person already has a staff or caregiver profile' using errcode = 'OGC09';
  end if;
  select * into v_u from ogevia.app_users u where u.id = p_user_id;
  v_name := coalesce(nullif(btrim(v_u.display_name), ''), 'Name not set');
  insert into ogevia.staff_profiles (organization_id, staff_type_id, display_name, user_id, created_by, first_signed_in_at)
  values (p_organization_id, v_type.id, v_name, p_user_id, v_actor, now()) returning id into v_id;
  perform ogevia.write_audit(p_organization_id, 'staff.profile_added', 'staff_profiles', v_id, null, jsonb_build_object('staff_type', v_type.name, 'user_id', p_user_id), null);
  return v_id;
end;
$$;

create function ogevia_api.update_staff(
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

-- ---------------------------------------------------------------------------
-- Invitations (the same two-step path as caregivers: database first, then the identity function, then the database links the sign-in)
-- ---------------------------------------------------------------------------
create function ogevia_api.begin_staff_invitation(p_organization_id uuid, p_profile_id uuid, p_email text, p_role text)
returns text
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.staff_guard(p_organization_id, true);
  v_email text := ogevia.normalize_invitation_email(p_email);
  v_role ogevia.system_role := ogevia.assignable_staff_role(p_role);
  v_p ogevia.staff_profiles%rowtype;
begin
  perform ogevia.staff_role_change_allowed(p_organization_id, v_actor, null, v_role::text);
  select * into v_p from ogevia.staff_profiles p where p.id = p_profile_id and p.organization_id = p_organization_id;
  if v_p.id is null then raise exception 'Staff member not found' using errcode = 'OGN04'; end if;
  if v_p.status = 'inactive' then raise exception 'This staff member is inactive; reactivate them before inviting' using errcode = 'OGC09'; end if;
  if v_p.user_id is not null then raise exception 'This staff member already has a sign-in' using errcode = 'OGC09'; end if;
  if exists (select 1 from ogevia.staff_profiles p where p.organization_id = p_organization_id and p.login_email = v_email and p.id <> v_p.id)
     or exists (select 1 from ogevia.caregiver_invitations i where i.organization_id = p_organization_id and i.email = v_email) then
    raise exception 'That email is already used by someone else in this agency' using errcode = 'OGC09';
  end if;
  return v_email;
end;
$$;

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

create function ogevia_api.begin_staff_invitation_resend(p_organization_id uuid, p_profile_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.staff_guard(p_organization_id, true);
  v_p ogevia.staff_profiles%rowtype;
begin
  select * into v_p from ogevia.staff_profiles p where p.id = p_profile_id and p.organization_id = p_organization_id;
  if v_p.id is null or v_p.login_email is null then raise exception 'This staff member has not been invited' using errcode = 'OGN04'; end if;
  if v_p.first_signed_in_at is not null then raise exception 'This person has already set up their sign-in; they can reset it from the sign-in page' using errcode = 'OGC09'; end if;
  if v_p.send_count >= 5 then raise exception 'The invitation was sent several times already; wait before sending again' using errcode = 'OGC09'; end if;
  return v_p.login_email;
end;
$$;

create function ogevia_api.record_staff_invitation_resent(p_organization_id uuid, p_profile_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.staff_guard(p_organization_id, true);
  v_n integer;
begin
  update ogevia.staff_profiles set send_count = send_count + 1, last_sent_at = now(), updated_at = now()
   where id = p_profile_id and organization_id = p_organization_id and login_email is not null returning send_count into v_n;
  if v_n is null then raise exception 'This staff member has not been invited' using errcode = 'OGN04'; end if;
  perform ogevia.write_audit(p_organization_id, 'staff.invitation_resent', 'staff_profiles', p_profile_id, null, jsonb_build_object('send_count', v_n), null);
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- System role assignment (one role per person per agency)
-- ---------------------------------------------------------------------------
create function ogevia_api.set_staff_role(p_organization_id uuid, p_user_id uuid, p_role text, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.staff_guard(p_organization_id, true);
  v_role ogevia.system_role := ogevia.assignable_staff_role(p_role);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_m ogevia.organization_memberships%rowtype;
begin
  if length(v_reason) < 3 then raise exception 'Enter a reason for the role change' using errcode = 'OGV22'; end if;
  perform pg_advisory_xact_lock(hashtextextended('account|' || p_user_id::text, 0));
  select * into v_m from ogevia.organization_memberships m where m.organization_id = p_organization_id and m.user_id = p_user_id and m.status <> 'revoked' for update;
  if v_m.id is null then raise exception 'Person not found' using errcode = 'OGN04'; end if;
  if p_user_id = v_actor then raise exception 'You cannot change your own role' using errcode = 'OGC09'; end if;
  if v_m.role in ('organization_owner', 'platform_owner') then raise exception 'The Owner role is protected and cannot be changed here' using errcode = 'OGC09'; end if;
  if v_m.role = 'caregiver' or v_m.role not in ('organization_admin', 'manager', 'scheduler', 'coordinator', 'staff', 'read_only') then
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

-- ---------------------------------------------------------------------------
-- Roles and permissions (read only) and staff history
-- ---------------------------------------------------------------------------
create function ogevia_api.list_role_permissions(p_organization_id uuid)
returns table (role text, member_count bigint, assignable boolean, permissions jsonb)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare v_actor uuid := ogevia.staff_guard(p_organization_id, false);
begin
  return query
  select r.role::text,
         (select count(*) from ogevia.organization_memberships m where m.organization_id = p_organization_id and m.role = r.role and m.status = 'active'),
         (r.role::text in ('organization_admin', 'manager', 'scheduler', 'coordinator', 'staff', 'read_only')),
         coalesce((select jsonb_agg(jsonb_build_object('key', p.key, 'description', p.description) order by p.key)
                     from ogevia.role_permissions rp join ogevia.permissions p on p.key = rp.permission_key where rp.role = r.role), '[]'::jsonb)
    from (select unnest(enum_range(null::ogevia.system_role)) as role) r
   where r.role::text in ('organization_owner', 'organization_admin', 'manager', 'scheduler', 'coordinator', 'staff', 'caregiver', 'read_only')
   order by array_position(array['organization_owner','organization_admin','manager','scheduler','coordinator','staff','read_only','caregiver'], r.role::text);
end;
$$;

create function ogevia_api.list_staff_audit(p_organization_id uuid, p_profile_id uuid default null)
returns table (occurred_at timestamptz, action text, actor_name text, reason text)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.staff_guard(p_organization_id, false);
  v_user uuid; v_membership uuid;
begin
  if p_profile_id is not null then
    select p.user_id into v_user from ogevia.staff_profiles p where p.id = p_profile_id and p.organization_id = p_organization_id;
    if not found then raise exception 'Staff member not found' using errcode = 'OGN04'; end if;
    select m.id into v_membership from ogevia.organization_memberships m where m.organization_id = p_organization_id and m.user_id = v_user;
  end if;
  return query
  select a.occurred_at, a.action, coalesce(nullif(btrim(u.display_name), ''), 'System')::text, a.reason
    from ogevia.audit_events a
    left join ogevia.app_users u on u.id = a.actor_user_id
   where a.organization_id = p_organization_id
     and (a.action like 'staff.%' or a.action like 'staff_type.%' or a.action like 'account.%')
     and (p_profile_id is null or a.entity_id = p_profile_id or (v_membership is not null and a.entity_id = v_membership))
   order by a.occurred_at desc, a.id desc
   limit 100;
end;
$$;

-- ---------------------------------------------------------------------------
-- First sign-in also marks a staff invitation (the caregiver behaviour is unchanged)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Privileges: the application role can run the API functions and nothing else
-- ---------------------------------------------------------------------------
revoke all on function ogevia.seed_default_staff_types(uuid) from public;
revoke all on function ogevia.organizations_seed_staff_types() from public;
revoke all on function ogevia.staff_guard(uuid, boolean) from public;
revoke all on function ogevia.assignable_staff_role(text) from public;
revoke all on function ogevia.staff_role_change_allowed(uuid, uuid, text, text) from public;
revoke all on function ogevia.staff_validate_contact(text, text) from public;
revoke all on function ogevia_api.list_staff_types(uuid) from public;
revoke all on function ogevia_api.create_staff_type(uuid, text) from public;
revoke all on function ogevia_api.rename_staff_type(uuid, uuid, text) from public;
revoke all on function ogevia_api.set_staff_type_active(uuid, uuid, boolean) from public;
revoke all on function ogevia_api.list_staff(uuid) from public;
revoke all on function ogevia_api.create_staff(uuid, text, uuid, text, text) from public;
revoke all on function ogevia_api.add_member_to_staff(uuid, uuid, uuid) from public;
revoke all on function ogevia_api.update_staff(uuid, uuid, text, uuid, text, text, text) from public;
revoke all on function ogevia_api.begin_staff_invitation(uuid, uuid, text, text) from public;
revoke all on function ogevia_api.complete_staff_invitation(uuid, uuid, text, text, boolean, text) from public;
revoke all on function ogevia_api.begin_staff_invitation_resend(uuid, uuid) from public;
revoke all on function ogevia_api.record_staff_invitation_resent(uuid, uuid) from public;
revoke all on function ogevia_api.set_staff_role(uuid, uuid, text, text) from public;
revoke all on function ogevia_api.list_role_permissions(uuid) from public;
revoke all on function ogevia_api.list_staff_audit(uuid, uuid) from public;
grant execute on function ogevia_api.list_staff_types(uuid) to ogevia_app;
grant execute on function ogevia_api.create_staff_type(uuid, text) to ogevia_app;
grant execute on function ogevia_api.rename_staff_type(uuid, uuid, text) to ogevia_app;
grant execute on function ogevia_api.set_staff_type_active(uuid, uuid, boolean) to ogevia_app;
grant execute on function ogevia_api.list_staff(uuid) to ogevia_app;
grant execute on function ogevia_api.create_staff(uuid, text, uuid, text, text) to ogevia_app;
grant execute on function ogevia_api.add_member_to_staff(uuid, uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.update_staff(uuid, uuid, text, uuid, text, text, text) to ogevia_app;
grant execute on function ogevia_api.begin_staff_invitation(uuid, uuid, text, text) to ogevia_app;
grant execute on function ogevia_api.complete_staff_invitation(uuid, uuid, text, text, boolean, text) to ogevia_app;
grant execute on function ogevia_api.begin_staff_invitation_resend(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.record_staff_invitation_resent(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.set_staff_role(uuid, uuid, text, text) to ogevia_app;
grant execute on function ogevia_api.list_role_permissions(uuid) to ogevia_app;
grant execute on function ogevia_api.list_staff_audit(uuid, uuid) to ogevia_app;
