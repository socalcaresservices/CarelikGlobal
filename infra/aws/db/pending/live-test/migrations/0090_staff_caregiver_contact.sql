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
           m.role::text,
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
