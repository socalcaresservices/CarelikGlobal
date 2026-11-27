-- 0121: one email, one person. Within an agency an email address may belong to only one caregiver or staff member: contact address, sign-in address or pending invitation.
-- Found in TEST 2026-11-27: a caregiver's contact email was set to the admin's address, so the caregiver's alerts landed in the admin's inbox, and a separate sign-in later existed under the new address.
-- Only NEW writes are checked. Existing rows are not changed or blocked; the report script lists any that already share an address. The server messages never name the other person.
create or replace function ogevia.email_used_by_other(p_organization_id uuid, p_email text, p_caregiver_record_id uuid, p_staff_profile_id uuid)
returns boolean language sql stable set search_path = ogevia, pg_temp as $$
  select exists (select 1 from ogevia.caregiver_contacts c where c.organization_id = p_organization_id and lower(btrim(c.contact_email)) = lower(btrim(p_email)) and c.caregiver_record_id is distinct from p_caregiver_record_id)
      or exists (select 1 from ogevia.caregiver_invitations i where i.organization_id = p_organization_id and lower(btrim(i.email)) = lower(btrim(p_email)) and i.caregiver_record_id is distinct from p_caregiver_record_id)
      or exists (select 1 from ogevia.staff_profiles s where s.organization_id = p_organization_id and s.id is distinct from p_staff_profile_id and (lower(btrim(s.contact_email)) = lower(btrim(p_email)) or lower(btrim(s.login_email)) = lower(btrim(p_email))));
$$;
revoke all on function ogevia.email_used_by_other(uuid, text, uuid, uuid) from public;

create or replace function ogevia_api.create_staff(p_organization_id uuid, p_display_name text, p_staff_type_id uuid, p_contact_email text, p_phone text)
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
  if v_email is not null and ogevia.email_used_by_other(p_organization_id, v_email, null, null) then
    raise exception 'That email is already used by someone else in this agency. Each person needs their own email.' using errcode = 'OGC09';
  end if;
  insert into ogevia.staff_profiles (organization_id, staff_type_id, display_name, contact_email, phone, created_by)
  values (p_organization_id, v_type.id, v_name, v_email, v_phone, v_actor) returning id into v_id;
  perform ogevia.write_audit(p_organization_id, 'staff.created', 'staff_profiles', v_id, null, jsonb_build_object('staff_type', v_type.name), null);
  return v_id;
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
  if v_email is not null and ogevia.email_used_by_other(p_organization_id, v_email, null, v_p.id) then
    raise exception 'That email is already used by someone else in this agency. Each person needs their own email.' using errcode = 'OGC09';
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

create or replace function ogevia_api.begin_staff_invitation(p_organization_id uuid, p_profile_id uuid, p_email text, p_role text)
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
  if v_email is not null and ogevia.email_used_by_other(p_organization_id, v_email, null, v_p.id) then
    raise exception 'That email is already used by someone else in this agency. Each person needs their own email.' using errcode = 'OGC09';
  end if;
  return v_email;
end;
$$;

create or replace function ogevia_api.set_caregiver_contact(p_organization_id uuid, p_caregiver_record_id uuid, p_email text, p_phone text default null, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.caregiver_admin_guard(p_organization_id);
  v_email text := case when nullif(btrim(coalesce(p_email, '')), '') is null then null else ogevia.normalize_invitation_email(p_email) end;
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
begin
  if v_email is null and v_phone is null then raise exception 'Enter an email address' using errcode = 'OGV22'; end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9 ()-]{7,20}$' then raise exception 'Enter a valid phone number' using errcode = 'OGV22'; end if;
  if not exists (select 1 from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null) then
    raise exception 'Caregiver not found' using errcode = 'OGN04';
  end if;
  if v_email is not null and ogevia.email_used_by_other(p_organization_id, v_email, p_caregiver_record_id, null) then
    raise exception 'That email is already used by someone else in this agency. Each person needs their own email.' using errcode = 'OGC09';
  end if;
  insert into ogevia.caregiver_contacts (caregiver_record_id, organization_id, contact_email, contact_phone, updated_by)
  values (p_caregiver_record_id, p_organization_id, v_email, v_phone, v_actor)
  on conflict (caregiver_record_id) do update
    set contact_email = coalesce(excluded.contact_email, ogevia.caregiver_contacts.contact_email),
        contact_phone = coalesce(excluded.contact_phone, ogevia.caregiver_contacts.contact_phone),
        updated_by = excluded.updated_by, updated_at = now();
  -- The audit row records THAT a contact was set, never the value.
  perform ogevia.write_audit(p_organization_id, 'caregiver.contact_set', 'caregiver_records', p_caregiver_record_id, null,
    jsonb_build_object('email_set', v_email is not null, 'phone_set', v_phone is not null), null);
  return jsonb_build_object('hasEmail', ogevia.caregiver_has_contact(p_organization_id, p_caregiver_record_id));
end;
$$;

create or replace function ogevia_api.begin_caregiver_invitation(p_organization_id uuid, p_caregiver_record_id uuid, p_email text)
returns text
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.caregiver_admin_guard(p_organization_id);
  v_email text := ogevia.normalize_invitation_email(p_email);
  v_rec ogevia.caregiver_records%rowtype;
begin
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  if v_rec.id is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  if v_rec.status = 'inactive' then
    raise exception 'This caregiver is inactive; reactivate them before inviting' using errcode = 'OGC09';
  end if;
  if v_rec.linked_user_id is not null then
    raise exception 'This caregiver already has a sign-in' using errcode = 'OGC09';
  end if;
  if exists (select 1 from ogevia.caregiver_invitations i
             where i.organization_id = p_organization_id and i.email = v_email and i.caregiver_record_id <> v_rec.id) then
    raise exception 'That email is already used by another caregiver in this agency' using errcode = 'OGC09';
  end if;
  if v_email is not null and ogevia.email_used_by_other(p_organization_id, v_email, v_rec.id, null) then
    raise exception 'That email is already used by someone else in this agency. Each person needs their own email.' using errcode = 'OGC09';
  end if;
  return v_email;
end;
$$;
