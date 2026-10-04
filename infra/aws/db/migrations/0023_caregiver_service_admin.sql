-- 0023 Care Team (caregiver records) and service administration, so ordinary
-- office work never needs database commands.
--
--   * caregivers.manage (Administrator, manager): add a caregiver record
--     (random caregiver code, legal and preferred name, starting status
--     onboarding / ready / active), edit names, change status with a reason.
--     Making a caregiver INACTIVE is refused while they have a visit in
--     progress; otherwise it ends their active assignments (from the agency's
--     local today) and suspends their caregiver sign-in in this agency, so a
--     departed caregiver loses access to client information at once.
--     Reactivating restores a suspended caregiver sign-in; assignments are
--     re-added deliberately (never silently restored). All audited.
--     Names already on past visits are snapshots and are not rewritten.
--   * services.manage (Administrator only: agency configuration): add a
--     service (code fixed once created, because payer records refer to it),
--     rename it, and deactivate or reactivate it with a reason. Deactivation is
--     refused while a current authorization for that service has not ended,
--     because visits under it would stop working. Service codes become unique
--     per agency (case-insensitive).
--   * Linking a caregiver record to an individual sign-in (inviting them) is
--     NOT here: it needs the API to create Cognito users, a separate security
--     decision.

do $$ begin
  if exists (select 1 from ogevia.services where deleted_at is null
             group by organization_id, lower(btrim(code)) having count(*) > 1) then
    raise exception 'Two services in one agency share a code; resolve that before 0023' using errcode = 'OGC09';
  end if;
end $$;
create unique index services_org_code_unique on ogevia.services (organization_id, lower(btrim(code))) where deleted_at is null;

insert into ogevia.permissions (key, description) values
  ('caregivers.manage', 'Add caregiver records, edit their names and change their status'),
  ('services.manage', 'Add, rename, deactivate and reactivate services');
insert into ogevia.role_permissions (role, permission_key) values
  ('organization_owner', 'caregivers.manage'),
  ('manager', 'caregivers.manage'),
  ('organization_owner', 'services.manage');

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------
create function ogevia_api.list_caregivers(p_organization_id uuid)
returns table (
  caregiver_record_id uuid, caregiver_code text, first_name text, last_name text, preferred_name text, status text,
  has_sign_in boolean, sign_in_status text, active_assignments integer, open_visits integer, updated_at timestamptz
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select cr.id, cr.caregiver_code, cr.first_name, cr.last_name, cr.preferred_name, cr.status,
         cr.linked_user_id is not null,
         m.status::text,
         (select count(*)::integer from ogevia.caregiver_assignments a
           where a.organization_id = cr.organization_id and a.caregiver_user_id = cr.linked_user_id and a.is_active
             and (a.effective_end is null or a.effective_end >= ogevia.organization_local_date(cr.organization_id, now()))),
         (select count(*)::integer from ogevia.service_visits v
           where v.organization_id = cr.organization_id and v.status = 'draft'
             and (v.caregiver_record_id = cr.id or (cr.linked_user_id is not null and v.caregiver_user_id = cr.linked_user_id))),
         cr.updated_at
  from ogevia.caregiver_records cr
  left join ogevia.organization_memberships m on m.organization_id = cr.organization_id and m.user_id = cr.linked_user_id and m.role = 'caregiver'
  where ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and ogevia.has_permission(p_organization_id, 'visits.read')
    and cr.organization_id = p_organization_id and cr.deleted_at is null
  order by case cr.status when 'active' then 0 when 'ready' then 1 when 'onboarding' then 2 else 3 end, lower(cr.last_name), lower(cr.first_name);
$$;

-- ---------------------------------------------------------------------------
-- Caregiver writes
-- ---------------------------------------------------------------------------
create function ogevia.caregiver_admin_guard(p_organization_id uuid)
returns uuid
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.require_actor();
begin
  if not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'caregivers.manage') then
    raise exception 'You do not have permission to manage the Care Team' using errcode = 'OGA03';
  end if;
  return v_actor;
end;
$$;

create function ogevia.check_caregiver_names(p_first text, p_last text, p_preferred text)
returns void
language plpgsql
immutable
set search_path = ogevia, pg_temp
as $$
begin
  if length(btrim(coalesce(p_first, ''))) not between 1 and 80 or length(btrim(coalesce(p_last, ''))) not between 1 and 80 then
    raise exception 'Enter a first and last name (up to 80 characters each)' using errcode = 'OGV22';
  end if;
  if p_preferred is not null and length(btrim(p_preferred)) > 80 then
    raise exception 'The preferred name can be up to 80 characters' using errcode = 'OGV22';
  end if;
end;
$$;

create function ogevia_api.create_caregiver(
  p_organization_id uuid, p_first_name text, p_last_name text, p_preferred_name text default null,
  p_status text default 'onboarding', p_idempotency_key uuid default null
)
returns table (caregiver_record_id uuid, caregiver_code text)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.caregiver_admin_guard(p_organization_id);
  v_first text := btrim(coalesce(p_first_name, ''));
  v_last text := btrim(coalesce(p_last_name, ''));
  v_pref text := nullif(btrim(coalesce(p_preferred_name, '')), '');
  v_fp text := concat_ws('|', p_organization_id, v_first, v_last, v_pref, p_status);
  v_prior jsonb;
  v_id uuid := gen_random_uuid();
  v_code text;
begin
  v_prior := ogevia.idempotency_begin('create_caregiver', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'caregiver_record_id')::uuid, v_prior ->> 'caregiver_code';
    return;
  end if;
  perform ogevia.check_caregiver_names(v_first, v_last, v_pref);
  if p_status is null or p_status not in ('onboarding', 'ready', 'active') then
    raise exception 'A new caregiver starts as onboarding, ready or active' using errcode = 'OGV22';
  end if;
  loop
    v_code := 'CG-' || upper(left(replace(gen_random_uuid()::text, '-', ''), 8));
    exit when not exists (select 1 from ogevia.caregiver_records r where r.organization_id = p_organization_id and r.caregiver_code = v_code);
  end loop;
  insert into ogevia.caregiver_records (id, organization_id, caregiver_code, first_name, last_name, preferred_name, status)
  values (v_id, p_organization_id, v_code, v_first, v_last, v_pref, p_status);
  perform ogevia.write_audit(p_organization_id, 'caregiver.created', 'caregiver_records', v_id, null,
    jsonb_build_object('caregiver_code', v_code, 'first_name', v_first, 'last_name', v_last, 'preferred_name', v_pref, 'status', p_status), null);
  perform ogevia.idempotency_finish('create_caregiver', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('caregiver_record_id', v_id, 'caregiver_code', v_code));
  return query select v_id, v_code;
end;
$$;

create function ogevia_api.update_caregiver(
  p_organization_id uuid, p_caregiver_record_id uuid, p_first_name text, p_last_name text,
  p_preferred_name text default null, p_idempotency_key uuid default null
)
returns void
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.caregiver_admin_guard(p_organization_id);
  v_first text := btrim(coalesce(p_first_name, ''));
  v_last text := btrim(coalesce(p_last_name, ''));
  v_pref text := nullif(btrim(coalesce(p_preferred_name, '')), '');
  v_fp text := concat_ws('|', p_organization_id, p_caregiver_record_id, v_first, v_last, v_pref);
  v_prior jsonb;
  v_before jsonb;
begin
  v_prior := ogevia.idempotency_begin('update_caregiver', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return; end if;
  select jsonb_build_object('first_name', r.first_name, 'last_name', r.last_name, 'preferred_name', r.preferred_name) into v_before
  from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null
  for update;
  if v_before is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  perform ogevia.check_caregiver_names(v_first, v_last, v_pref);
  update ogevia.caregiver_records set first_name = v_first, last_name = v_last, preferred_name = v_pref, updated_at = now()
  where id = p_caregiver_record_id;
  perform ogevia.write_audit(p_organization_id, 'caregiver.updated', 'caregiver_records', p_caregiver_record_id, v_before,
    jsonb_build_object('first_name', v_first, 'last_name', v_last, 'preferred_name', v_pref), null);
  perform ogevia.idempotency_finish('update_caregiver', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('ok', true));
end;
$$;

create function ogevia_api.set_caregiver_status(
  p_organization_id uuid, p_caregiver_record_id uuid, p_status text, p_reason text, p_idempotency_key uuid default null
)
returns table (ended_assignments integer, sign_in_status text)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.caregiver_admin_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_caregiver_record_id, p_status);
  v_prior jsonb;
  v_rec ogevia.caregiver_records%rowtype;
  v_today date := ogevia.organization_local_date(p_organization_id, now());
  v_ended integer := 0;
  v_sign_in text;
begin
  v_prior := ogevia.idempotency_begin('set_caregiver_status', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'ended_assignments')::integer, v_prior ->> 'sign_in_status';
    return;
  end if;
  if p_status is null or p_status not in ('onboarding', 'ready', 'active', 'inactive') then
    raise exception 'Choose a status' using errcode = 'OGV22';
  end if;
  if length(v_reason) not between 3 and 500 then
    raise exception 'Give a reason for the status change' using errcode = 'OGV22';
  end if;
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null for update;
  if v_rec.id is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  if v_rec.status = p_status then raise exception 'The caregiver already has this status' using errcode = 'OGC09'; end if;

  if p_status = 'inactive' then
    if exists (select 1 from ogevia.service_visits v where v.organization_id = p_organization_id and v.status = 'draft'
               and (v.caregiver_record_id = v_rec.id or (v_rec.linked_user_id is not null and v.caregiver_user_id = v_rec.linked_user_id))) then
      raise exception 'This caregiver has a visit in progress; end or close it first' using errcode = 'OGC09';
    end if;
    if v_rec.linked_user_id is not null then
      update ogevia.caregiver_assignments a
         set is_active = false, effective_end = greatest(a.effective_start, v_today), updated_at = now()
       where a.organization_id = p_organization_id and a.caregiver_user_id = v_rec.linked_user_id and a.is_active;
      get diagnostics v_ended = row_count;
      update ogevia.organization_memberships m set status = 'suspended', updated_at = now()
       where m.organization_id = p_organization_id and m.user_id = v_rec.linked_user_id and m.role = 'caregiver' and m.status = 'active';
    end if;
  elsif v_rec.status = 'inactive' and v_rec.linked_user_id is not null then
    update ogevia.organization_memberships m set status = 'active', updated_at = now()
     where m.organization_id = p_organization_id and m.user_id = v_rec.linked_user_id and m.role = 'caregiver' and m.status = 'suspended';
  end if;
  update ogevia.caregiver_records set status = p_status, updated_at = now() where id = v_rec.id;
  select m.status::text into v_sign_in from ogevia.organization_memberships m
   where m.organization_id = p_organization_id and m.user_id = v_rec.linked_user_id and m.role = 'caregiver';
  perform ogevia.write_audit(p_organization_id, 'caregiver.status_changed', 'caregiver_records', v_rec.id,
    jsonb_build_object('status', v_rec.status),
    jsonb_build_object('status', p_status, 'ended_assignments', v_ended, 'sign_in_status', v_sign_in), v_reason);
  perform ogevia.idempotency_finish('set_caregiver_status', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('ended_assignments', v_ended, 'sign_in_status', v_sign_in));
  return query select v_ended, v_sign_in;
end;
$$;

-- ---------------------------------------------------------------------------
-- Service writes (Administrator)
-- ---------------------------------------------------------------------------
create function ogevia.service_admin_guard(p_organization_id uuid)
returns uuid
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.require_actor();
begin
  if not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'services.manage') then
    raise exception 'Only the agency Administrator can change services' using errcode = 'OGA03';
  end if;
  return v_actor;
end;
$$;

create function ogevia_api.create_service(p_organization_id uuid, p_code text, p_name text, p_idempotency_key uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.service_admin_guard(p_organization_id);
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_name text := btrim(coalesce(p_name, ''));
  v_fp text := concat_ws('|', p_organization_id, v_code, v_name);
  v_prior jsonb;
  v_id uuid;
begin
  v_prior := ogevia.idempotency_begin('create_service', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return (v_prior ->> 'service_id')::uuid; end if;
  if v_code !~ '^[A-Z0-9][A-Z0-9._-]{0,19}$' then
    raise exception 'The service code must be 1 to 20 letters, numbers, dots, dashes or underscores' using errcode = 'OGV22';
  end if;
  if length(v_name) not between 2 and 80 then
    raise exception 'Enter a service name (2 to 80 characters)' using errcode = 'OGV22';
  end if;
  begin
    insert into ogevia.services (organization_id, code, name) values (p_organization_id, v_code, v_name) returning id into v_id;
  exception when unique_violation then
    raise exception 'This agency already has a service with code %', v_code using errcode = 'OGC09';
  end;
  perform ogevia.write_audit(p_organization_id, 'service.created', 'services', v_id, null, jsonb_build_object('code', v_code, 'name', v_name), null);
  perform ogevia.idempotency_finish('create_service', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('service_id', v_id));
  return v_id;
end;
$$;

create function ogevia_api.rename_service(p_organization_id uuid, p_service_id uuid, p_name text, p_idempotency_key uuid default null)
returns void
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.service_admin_guard(p_organization_id);
  v_name text := btrim(coalesce(p_name, ''));
  v_fp text := concat_ws('|', p_organization_id, p_service_id, v_name);
  v_prior jsonb;
  v_old text;
begin
  v_prior := ogevia.idempotency_begin('rename_service', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return; end if;
  select s.name into v_old from ogevia.services s
  where s.id = p_service_id and s.organization_id = p_organization_id and s.deleted_at is null for update;
  if v_old is null then raise exception 'Service not found' using errcode = 'OGN04'; end if;
  if length(v_name) not between 2 and 80 then
    raise exception 'Enter a service name (2 to 80 characters)' using errcode = 'OGV22';
  end if;
  update ogevia.services set name = v_name, updated_at = now() where id = p_service_id;
  perform ogevia.write_audit(p_organization_id, 'service.renamed', 'services', p_service_id,
    jsonb_build_object('name', v_old), jsonb_build_object('name', v_name), null);
  perform ogevia.idempotency_finish('rename_service', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('ok', true));
end;
$$;

create function ogevia_api.set_service_active(
  p_organization_id uuid, p_service_id uuid, p_active boolean, p_reason text, p_idempotency_key uuid default null
)
returns void
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.service_admin_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_service_id, p_active);
  v_prior jsonb;
  v_old boolean;
  v_today date := ogevia.organization_local_date(p_organization_id, now());
begin
  v_prior := ogevia.idempotency_begin('set_service_active', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return; end if;
  if p_active is null then raise exception 'Choose active or inactive' using errcode = 'OGV22'; end if;
  if length(v_reason) not between 3 and 500 then
    raise exception 'Give a reason for the change' using errcode = 'OGV22';
  end if;
  select s.is_active into v_old from ogevia.services s
  where s.id = p_service_id and s.organization_id = p_organization_id and s.deleted_at is null for update;
  if v_old is null then raise exception 'Service not found' using errcode = 'OGN04'; end if;
  if v_old = p_active then raise exception 'The service already has this status' using errcode = 'OGC09'; end if;
  if not p_active and exists (
    select 1 from ogevia.client_authorizations a
    where a.organization_id = p_organization_id and a.service_id = p_service_id
      and a.is_current and a.deleted_at is null and a.period_end >= v_today) then
    raise exception 'Clients still have current authorizations for this service; let them end or amend them first' using errcode = 'OGC09';
  end if;
  update ogevia.services set is_active = p_active, updated_at = now() where id = p_service_id;
  perform ogevia.write_audit(p_organization_id, case when p_active then 'service.reactivated' else 'service.deactivated' end,
    'services', p_service_id, jsonb_build_object('is_active', v_old), jsonb_build_object('is_active', p_active), v_reason);
  perform ogevia.idempotency_finish('set_service_active', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('ok', true));
end;
$$;

revoke all on function ogevia.caregiver_admin_guard(uuid) from public;
revoke all on function ogevia.check_caregiver_names(text, text, text) from public;
revoke all on function ogevia.service_admin_guard(uuid) from public;
revoke all on function ogevia_api.list_caregivers(uuid) from public;
revoke all on function ogevia_api.create_caregiver(uuid, text, text, text, text, uuid) from public;
revoke all on function ogevia_api.update_caregiver(uuid, uuid, text, text, text, uuid) from public;
revoke all on function ogevia_api.set_caregiver_status(uuid, uuid, text, text, uuid) from public;
revoke all on function ogevia_api.create_service(uuid, text, text, uuid) from public;
revoke all on function ogevia_api.rename_service(uuid, uuid, text, uuid) from public;
revoke all on function ogevia_api.set_service_active(uuid, uuid, boolean, text, uuid) from public;
grant execute on function ogevia_api.list_caregivers(uuid) to ogevia_app;
grant execute on function ogevia_api.create_caregiver(uuid, text, text, text, text, uuid) to ogevia_app;
grant execute on function ogevia_api.update_caregiver(uuid, uuid, text, text, text, uuid) to ogevia_app;
grant execute on function ogevia_api.set_caregiver_status(uuid, uuid, text, text, uuid) to ogevia_app;
grant execute on function ogevia_api.create_service(uuid, text, text, uuid) to ogevia_app;
grant execute on function ogevia_api.rename_service(uuid, uuid, text, uuid) to ogevia_app;
grant execute on function ogevia_api.set_service_active(uuid, uuid, boolean, text, uuid) to ogevia_app;
