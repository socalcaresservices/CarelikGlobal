-- 0022 Client and authorization administration (ported from the Supabase
-- build's Clients and Authorizations screens), so ordinary office work never
-- needs database commands.
--
--   * clients.manage (Administrator, manager): create a client (random client
--     code, legal name, optional city and client type, optional caregiver-facing
--     label), edit those details, and change status (active / inactive /
--     discharged) with a reason. A client with an open visit cannot be made
--     inactive or discharged. Every change is audited with before and after.
--   * client_types: per-agency, configurable categories (no shared hard-coded
--     list). Used by utilisation breakdowns later.
--   * create_client_authorization (authorizations.update): a new lineage,
--     version 1. The existing exclusion constraint already refuses a second
--     current authorization for the same client and service with overlapping
--     dates (no duplicate allowance); the refusal is turned into a plain
--     message that says to amend instead. Monthly minutes must be 1..44,640 (a
--     31-day month), which catches hours typed as minutes.
--   * Rates: only authorizations.rates.manage (Administrator) may set a rate on
--     a new authorization. Amendments keep carrying the rate forward unchanged
--     (0006). list_client_authorizations returns the rate only with
--     billing.read (Administrator).
--   * Amendments use the existing ogevia_api.amend_client_authorization (0006):
--     versioned, immutable history, audited, with an impact report.
--   * Remaining balances are NOT recalculated here: screens use the existing
--     list_monthly_service_summary (0016) so there is one calculation.
-- Names and city are returned only with clients.names.read (Administrator,
-- manager); caregivers never call these functions successfully.

insert into ogevia.permissions (key, description) values
  ('clients.manage', 'Create clients, edit their details and change their status'),
  ('authorizations.rates.manage', 'Set the billing rate on a new authorization');
insert into ogevia.role_permissions (role, permission_key) values
  ('organization_owner', 'clients.manage'),
  ('manager', 'clients.manage'),
  ('organization_owner', 'authorizations.rates.manage');

-- ---------------------------------------------------------------------------
-- Client types and client details
-- ---------------------------------------------------------------------------
create table ogevia.client_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  name text not null check (length(btrim(name)) between 1 and 60),
  is_active boolean not null default true,
  created_by uuid not null references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index client_types_org_name_unique on ogevia.client_types (organization_id, lower(btrim(name)));
alter table ogevia.client_types enable row level security;
create policy readonly_select on ogevia.client_types for select to ogevia_readonly using (true);
grant select on ogevia.client_types to ogevia_readonly;

alter table ogevia.clients
  add column city text check (city is null or length(btrim(city)) between 1 and 80),
  add column client_type_id uuid,
  add constraint clients_client_type_fk foreign key (client_type_id, organization_id)
    references ogevia.client_types (id, organization_id);

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------
create function ogevia_api.list_client_types(p_organization_id uuid)
returns table (client_type_id uuid, name text, is_active boolean)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select t.id, t.name, t.is_active
  from ogevia.client_types t
  where ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and ogevia.has_permission(p_organization_id, 'visits.read')
    and t.organization_id = p_organization_id
  order by lower(t.name);
$$;

create function ogevia_api.list_services(p_organization_id uuid)
returns table (service_id uuid, code text, name text, is_active boolean)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select s.id, s.code, s.name, s.is_active
  from ogevia.services s
  where ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and ogevia.has_permission(p_organization_id, 'authorizations.read')
    and s.organization_id = p_organization_id and s.deleted_at is null
  order by s.is_active desc, lower(s.name);
$$;

create function ogevia_api.list_clients(p_organization_id uuid)
returns table (
  client_id uuid, client_code text, caregiver_display_code text, status ogevia.client_status,
  legal_first_name text, legal_last_name text, city text, client_type_id uuid, client_type_name text,
  current_authorizations integer, open_visits integer, updated_at timestamptz
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with ctx as (
    select ogevia.require_actor() as actor,
           ogevia.is_active_member(p_organization_id) and ogevia.has_permission(p_organization_id, 'visits.read') as can_list,
           ogevia.has_permission(p_organization_id, 'clients.names.read') as can_names
  )
  select c.id, c.client_code, c.caregiver_display_code, c.status,
         case when ctx.can_names then n.legal_first_name end,
         case when ctx.can_names then n.legal_last_name end,
         case when ctx.can_names then c.city end,
         c.client_type_id, t.name,
         (select count(*)::integer from ogevia.client_authorizations a
           where a.client_id = c.id and a.is_current and a.deleted_at is null and a.period_end >= current_date),
         (select count(*)::integer from ogevia.service_visits v where v.client_id = c.id and v.status = 'draft'),
         c.updated_at
  from ctx
  join ogevia.clients c on c.organization_id = p_organization_id and c.deleted_at is null
  left join ogevia.client_private_names n on n.client_id = c.id
  left join ogevia.client_types t on t.id = c.client_type_id
  where ctx.actor is not null and ctx.can_list
  order by c.status, c.client_code;
$$;

-- Every version of every authorization for one client (history included).
create function ogevia_api.list_client_authorizations(p_organization_id uuid, p_client_id uuid)
returns table (
  authorization_id uuid, lineage_id uuid, version_number integer, is_current boolean,
  supersedes_id uuid, superseded_by_id uuid, service_id uuid, service_code text, service_name text,
  payer text, authorization_number text, monthly_authorized_minutes integer,
  period_start date, period_end date, received_date date, source_reference text, change_reason text,
  created_at timestamptz, created_by_name text, hourly_rate_cents integer
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with ctx as (
    select ogevia.require_actor() as actor,
           ogevia.is_active_member(p_organization_id) and ogevia.has_permission(p_organization_id, 'authorizations.read') as can_read,
           ogevia.has_permission(p_organization_id, 'billing.read') as can_money
  )
  select a.id, a.lineage_id, a.version_number, a.is_current, a.supersedes_id, a.superseded_by_id,
         s.id, s.code, s.name, a.payer, a.authorization_number, a.monthly_authorized_minutes,
         a.period_start, a.period_end, a.received_date, a.source_reference, a.change_reason,
         a.created_at, u.display_name,
         case when ctx.can_money then a.hourly_rate_cents end
  from ctx
  join ogevia.client_authorizations a on a.organization_id = p_organization_id and a.client_id = p_client_id and a.deleted_at is null
  join ogevia.services s on s.id = a.service_id
  left join ogevia.app_users u on u.id = a.created_by
  where ctx.actor is not null and ctx.can_read
  order by a.is_current desc, a.period_start desc, s.name, a.lineage_id, a.version_number desc;
$$;

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------
create function ogevia.client_admin_guard(p_organization_id uuid)
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
  if not (ogevia.has_permission(p_organization_id, 'clients.manage') and ogevia.has_permission(p_organization_id, 'clients.names.manage')) then
    raise exception 'You do not have permission to manage clients' using errcode = 'OGA03';
  end if;
  return v_actor;
end;
$$;

create function ogevia.client_type_in_org(p_organization_id uuid, p_client_type_id uuid)
returns void
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
begin
  if p_client_type_id is not null and not exists (
    select 1 from ogevia.client_types t where t.id = p_client_type_id and t.organization_id = p_organization_id and t.is_active) then
    raise exception 'Choose one of this agency''s active client types' using errcode = 'OGV22';
  end if;
end;
$$;

create function ogevia_api.create_client_type(p_organization_id uuid, p_name text, p_idempotency_key uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.client_admin_guard(p_organization_id);
  v_name text := btrim(coalesce(p_name, ''));
  v_fp text := concat_ws('|', p_organization_id, lower(v_name));
  v_prior jsonb;
  v_id uuid;
begin
  v_prior := ogevia.idempotency_begin('create_client_type', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return (v_prior ->> 'client_type_id')::uuid; end if;
  if length(v_name) not between 1 and 60 then
    raise exception 'Enter a client type name (up to 60 characters)' using errcode = 'OGV22';
  end if;
  if exists (select 1 from ogevia.client_types t where t.organization_id = p_organization_id and lower(btrim(t.name)) = lower(v_name)) then
    raise exception 'That client type already exists' using errcode = 'OGC09';
  end if;
  insert into ogevia.client_types (organization_id, name, created_by) values (p_organization_id, v_name, v_actor) returning id into v_id;
  perform ogevia.write_audit(p_organization_id, 'client_type.created', 'client_types', v_id, null, jsonb_build_object('name', v_name), null);
  perform ogevia.idempotency_finish('create_client_type', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('client_type_id', v_id));
  return v_id;
end;
$$;

create function ogevia_api.create_client(
  p_organization_id uuid, p_first_name text, p_last_name text, p_city text default null,
  p_client_type_id uuid default null, p_caregiver_display_code text default null, p_idempotency_key uuid default null
)
returns table (client_id uuid, client_code text)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.client_admin_guard(p_organization_id);
  v_first text := btrim(coalesce(p_first_name, ''));
  v_last text := btrim(coalesce(p_last_name, ''));
  v_city text := nullif(btrim(coalesce(p_city, '')), '');
  v_label text := nullif(btrim(coalesce(p_caregiver_display_code, '')), '');
  v_fp text := concat_ws('|', p_organization_id, v_first, v_last, v_city, p_client_type_id, v_label);
  v_prior jsonb;
  v_id uuid;
  v_code text;
begin
  v_prior := ogevia.idempotency_begin('create_client', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'client_id')::uuid, v_prior ->> 'client_code';
    return;
  end if;
  if length(v_first) not between 1 and 80 or length(v_last) not between 1 and 80 then
    raise exception 'Enter a first and last name (up to 80 characters each)' using errcode = 'OGV22';
  end if;
  if v_city is not null and length(v_city) > 80 then
    raise exception 'City can be up to 80 characters' using errcode = 'OGV22';
  end if;
  if v_label is not null and length(v_label) not between 3 and 40 then
    raise exception 'The caregiver label must be 3 to 40 characters' using errcode = 'OGV22';
  end if;
  perform ogevia.client_type_in_org(p_organization_id, p_client_type_id);
  begin
    insert into ogevia.clients (organization_id, client_code, caregiver_display_code, city, client_type_id)
    values (p_organization_id, null, v_label, v_city, p_client_type_id)
    returning id, client_code into v_id, v_code;
  exception when unique_violation then
    raise exception 'That caregiver label is already used by another client' using errcode = 'OGC09';
  end;
  insert into ogevia.client_private_names (client_id, organization_id, legal_first_name, legal_last_name, updated_by)
  values (v_id, p_organization_id, v_first, v_last, v_actor);
  perform ogevia.write_audit(p_organization_id, 'client.created', 'clients', v_id, null,
    jsonb_build_object('client_code', v_code, 'legal_first_name', v_first, 'legal_last_name', v_last,
                       'city', v_city, 'client_type_id', p_client_type_id, 'caregiver_display_code', v_label), null);
  perform ogevia.idempotency_finish('create_client', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('client_id', v_id, 'client_code', v_code));
  return query select v_id, v_code;
end;
$$;

create function ogevia_api.update_client(
  p_organization_id uuid, p_client_id uuid, p_first_name text, p_last_name text, p_city text default null,
  p_client_type_id uuid default null, p_caregiver_display_code text default null, p_idempotency_key uuid default null
)
returns void
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.client_admin_guard(p_organization_id);
  v_first text := btrim(coalesce(p_first_name, ''));
  v_last text := btrim(coalesce(p_last_name, ''));
  v_city text := nullif(btrim(coalesce(p_city, '')), '');
  v_label text := nullif(btrim(coalesce(p_caregiver_display_code, '')), '');
  v_fp text := concat_ws('|', p_organization_id, p_client_id, v_first, v_last, v_city, p_client_type_id, v_label);
  v_prior jsonb;
  v_before jsonb;
begin
  v_prior := ogevia.idempotency_begin('update_client', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return; end if;
  select jsonb_build_object('legal_first_name', n.legal_first_name, 'legal_last_name', n.legal_last_name,
                            'city', c.city, 'client_type_id', c.client_type_id, 'caregiver_display_code', c.caregiver_display_code)
    into v_before
  from ogevia.clients c left join ogevia.client_private_names n on n.client_id = c.id
  where c.id = p_client_id and c.organization_id = p_organization_id and c.deleted_at is null
  for update of c;
  if v_before is null then raise exception 'Client not found' using errcode = 'OGN04'; end if;
  if length(v_first) not between 1 and 80 or length(v_last) not between 1 and 80 then
    raise exception 'Enter a first and last name (up to 80 characters each)' using errcode = 'OGV22';
  end if;
  if v_city is not null and length(v_city) > 80 then
    raise exception 'City can be up to 80 characters' using errcode = 'OGV22';
  end if;
  if v_label is not null and length(v_label) not between 3 and 40 then
    raise exception 'The caregiver label must be 3 to 40 characters' using errcode = 'OGV22';
  end if;
  perform ogevia.client_type_in_org(p_organization_id, p_client_type_id);
  begin
    update ogevia.clients set city = v_city, client_type_id = p_client_type_id, caregiver_display_code = v_label, updated_at = now()
    where id = p_client_id;
  exception when unique_violation then
    raise exception 'That caregiver label is already used by another client' using errcode = 'OGC09';
  end;
  insert into ogevia.client_private_names (client_id, organization_id, legal_first_name, legal_last_name, updated_by)
  values (p_client_id, p_organization_id, v_first, v_last, v_actor)
  on conflict (client_id) do update set legal_first_name = excluded.legal_first_name, legal_last_name = excluded.legal_last_name,
    updated_by = excluded.updated_by, updated_at = now();
  perform ogevia.write_audit(p_organization_id, 'client.updated', 'clients', p_client_id, v_before,
    jsonb_build_object('legal_first_name', v_first, 'legal_last_name', v_last, 'city', v_city,
                       'client_type_id', p_client_type_id, 'caregiver_display_code', v_label), null);
  perform ogevia.idempotency_finish('update_client', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('ok', true));
end;
$$;

create function ogevia_api.set_client_status(
  p_organization_id uuid, p_client_id uuid, p_status ogevia.client_status, p_reason text, p_idempotency_key uuid default null
)
returns void
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.client_admin_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_client_id, p_status);
  v_prior jsonb;
  v_old ogevia.client_status;
begin
  v_prior := ogevia.idempotency_begin('set_client_status', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return; end if;
  if p_status is null then raise exception 'Choose a status' using errcode = 'OGV22'; end if;
  if length(v_reason) not between 3 and 500 then
    raise exception 'Give a reason for the status change' using errcode = 'OGV22';
  end if;
  select c.status into v_old from ogevia.clients c
  where c.id = p_client_id and c.organization_id = p_organization_id and c.deleted_at is null for update;
  if v_old is null then raise exception 'Client not found' using errcode = 'OGN04'; end if;
  if v_old = p_status then raise exception 'The client already has this status' using errcode = 'OGC09'; end if;
  if p_status <> 'active' and exists (select 1 from ogevia.service_visits v where v.client_id = p_client_id and v.status = 'draft') then
    raise exception 'This client has a visit in progress; end or close it first' using errcode = 'OGC09';
  end if;
  update ogevia.clients set status = p_status, updated_at = now() where id = p_client_id;
  perform ogevia.write_audit(p_organization_id, 'client.status_changed', 'clients', p_client_id,
    jsonb_build_object('status', v_old), jsonb_build_object('status', p_status), v_reason);
  perform ogevia.idempotency_finish('set_client_status', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('ok', true));
end;
$$;

create function ogevia_api.create_client_authorization(
  p_organization_id uuid, p_client_id uuid, p_service_id uuid, p_payer text, p_monthly_authorized_minutes integer,
  p_period_start date, p_period_end date, p_authorization_number text default null, p_received_date date default null,
  p_source_reference text default null, p_hourly_rate_cents integer default null, p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_payer text := btrim(coalesce(p_payer, ''));
  v_number text := nullif(btrim(coalesce(p_authorization_number, '')), '');
  v_source text := nullif(btrim(coalesce(p_source_reference, '')), '');
  v_fp text := concat_ws('|', p_organization_id, p_client_id, p_service_id, v_payer, p_monthly_authorized_minutes,
                         p_period_start, p_period_end, v_number, p_received_date, v_source, p_hourly_rate_cents);
  v_prior jsonb;
  v_id uuid := gen_random_uuid();
begin
  if not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'authorizations.update') then
    raise exception 'You do not have permission to add authorizations' using errcode = 'OGA03';
  end if;
  if p_hourly_rate_cents is not null and not ogevia.has_permission(p_organization_id, 'authorizations.rates.manage') then
    raise exception 'Only the agency Administrator can set a billing rate' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('create_authorization', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return (v_prior ->> 'authorization_id')::uuid; end if;

  if not exists (select 1 from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id and c.deleted_at is null) then
    raise exception 'Client not found' using errcode = 'OGN04';
  end if;
  if not exists (select 1 from ogevia.services s where s.id = p_service_id and s.organization_id = p_organization_id
                 and s.deleted_at is null and s.is_active) then
    raise exception 'Choose one of this agency''s active services' using errcode = 'OGV22';
  end if;
  if length(v_payer) not between 1 and 120 then
    raise exception 'Enter the payer' using errcode = 'OGV22';
  end if;
  if p_monthly_authorized_minutes is null or p_monthly_authorized_minutes not between 1 and 44640 then
    raise exception 'Authorized time per month must be between 1 minute and 744 hours' using errcode = 'OGV22';
  end if;
  if p_period_start is null or p_period_end is null or p_period_end <= p_period_start then
    raise exception 'The end date must be after the start date' using errcode = 'OGV22';
  end if;
  if p_hourly_rate_cents is not null and p_hourly_rate_cents not between 0 and 100000 then
    raise exception 'The rate must be between $0 and $1,000 per hour' using errcode = 'OGV22';
  end if;
  begin
    insert into ogevia.client_authorizations (
      id, organization_id, client_id, service_id, version_number, is_current, payer, authorization_number,
      monthly_authorized_minutes, period_start, period_end, hourly_rate_cents, received_date, source_reference,
      change_reason, created_by
    ) values (
      v_id, p_organization_id, p_client_id, p_service_id, 1, true, v_payer, v_number,
      p_monthly_authorized_minutes, p_period_start, p_period_end, p_hourly_rate_cents, p_received_date, v_source,
      'Created', v_actor
    );
  exception when exclusion_violation then
    raise exception 'This client already has an authorization for this service that overlaps these dates; amend that one instead'
      using errcode = 'OGC09';
  end;
  perform ogevia.write_audit(p_organization_id, 'client_authorization.created', 'client_authorizations', v_id, null,
    jsonb_build_object('client_id', p_client_id, 'service_id', p_service_id, 'monthly_authorized_minutes', p_monthly_authorized_minutes,
                       'period_start', p_period_start, 'period_end', p_period_end, 'rate_set', p_hourly_rate_cents is not null), null);
  perform ogevia.idempotency_finish('create_authorization', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('authorization_id', v_id));
  return v_id;
end;
$$;

revoke all on function ogevia.client_admin_guard(uuid) from public;
revoke all on function ogevia.client_type_in_org(uuid, uuid) from public;
revoke all on function ogevia_api.list_client_types(uuid) from public;
revoke all on function ogevia_api.list_services(uuid) from public;
revoke all on function ogevia_api.list_clients(uuid) from public;
revoke all on function ogevia_api.list_client_authorizations(uuid, uuid) from public;
revoke all on function ogevia_api.create_client_type(uuid, text, uuid) from public;
revoke all on function ogevia_api.create_client(uuid, text, text, text, uuid, text, uuid) from public;
revoke all on function ogevia_api.update_client(uuid, uuid, text, text, text, uuid, text, uuid) from public;
revoke all on function ogevia_api.set_client_status(uuid, uuid, ogevia.client_status, text, uuid) from public;
revoke all on function ogevia_api.create_client_authorization(uuid, uuid, uuid, text, integer, date, date, text, date, text, integer, uuid) from public;
grant execute on function ogevia_api.list_client_types(uuid) to ogevia_app;
grant execute on function ogevia_api.list_services(uuid) to ogevia_app;
grant execute on function ogevia_api.list_clients(uuid) to ogevia_app;
grant execute on function ogevia_api.list_client_authorizations(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.create_client_type(uuid, text, uuid) to ogevia_app;
grant execute on function ogevia_api.create_client(uuid, text, text, text, uuid, text, uuid) to ogevia_app;
grant execute on function ogevia_api.update_client(uuid, uuid, text, text, text, uuid, text, uuid) to ogevia_app;
grant execute on function ogevia_api.set_client_status(uuid, uuid, ogevia.client_status, text, uuid) to ogevia_app;
grant execute on function ogevia_api.create_client_authorization(uuid, uuid, uuid, text, integer, date, date, text, date, text, integer, uuid) to ogevia_app;
