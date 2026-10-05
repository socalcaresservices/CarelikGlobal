-- 0027 Agency continuity pack (outage continuity, pilot-readiness blocker 7).
--
-- Each agency keeps its OWN recent operational copy, downloaded while Ogevia is
-- up, so it can keep working when Ogevia is unavailable. AWS backups restore
-- data after an outage; they give an agency nothing during one.
--
--   * continuity.export: Administrator (organization_owner) and manager only.
--     Caregivers and schedulers never.
--   * create_continuity_pack: one agency only, derived from the signed-in
--     user's active membership and permission (the browser cannot ask for
--     another agency). Returns, with a server "data as of" time:
--       - the next 14 days of scheduled shifts (client code and label, service,
--         caregiver, coverage state);
--       - active clients (code, label, city; legal name ONLY with
--         clients.names.read);
--       - this month's authorized / reserved / used / remaining hours per
--         client and service (no rates, no dollar amounts);
--       - active Care Team members (code, name, status);
--       - a block of 25 pre-numbered outage visit record numbers, unique and
--         never reissued within the agency.
--     No date of birth, UCI, Medicaid or payer IDs, rates or money.
--     Every download is recorded and audited (who, when, data as of, block).
--     A retried request (same key) returns the same number block.
--   * get_continuity_status: when and by whom the latest pack was downloaded,
--     and how old it is (shown on the home screen; staff with the permission).

insert into ogevia.permissions (key, description) values
  ('continuity.export', 'Download the agency continuity pack for use when Ogevia is unavailable');
insert into ogevia.role_permissions (role, permission_key) values
  ('organization_owner', 'continuity.export'),
  ('manager', 'continuity.export');

create table ogevia.continuity_exports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  exported_by uuid not null references ogevia.app_users(id),
  request_key uuid not null,
  data_as_of timestamptz not null,
  outage_number_first integer not null check (outage_number_first >= 1),
  outage_number_last integer not null,
  shift_count integer not null,
  client_count integer not null,
  authorization_count integer not null,
  caregiver_count integer not null,
  includes_client_names boolean not null,
  created_at timestamptz not null default now(),
  unique (organization_id, request_key),
  unique (organization_id, outage_number_first),
  check (outage_number_last >= outage_number_first)
);
create index continuity_exports_org_time_idx on ogevia.continuity_exports (organization_id, created_at desc);
alter table ogevia.continuity_exports enable row level security;
create trigger continuity_exports_no_update before update on ogevia.continuity_exports
for each row execute function ogevia.forbid_update();
create trigger continuity_exports_no_delete before delete on ogevia.continuity_exports
for each row execute function ogevia.forbid_delete();
create policy readonly_select on ogevia.continuity_exports for select to ogevia_readonly using (true);
grant select on ogevia.continuity_exports to ogevia_readonly;

create function ogevia.continuity_guard(p_organization_id uuid)
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
  if not ogevia.has_permission(p_organization_id, 'continuity.export') then
    raise exception 'You do not have permission to download the continuity pack' using errcode = 'OGA03';
  end if;
  return v_actor;
end;
$$;

create function ogevia_api.create_continuity_pack(p_organization_id uuid, p_request_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.continuity_guard(p_organization_id);
  v_names boolean := ogevia.has_permission(p_organization_id, 'clients.names.read');
  v_org ogevia.organizations%rowtype;
  v_now timestamptz := now();
  v_today date;
  v_exp ogevia.continuity_exports%rowtype;
  v_first integer;
  v_shifts jsonb;
  v_clients jsonb;
  v_auths jsonb;
  v_care jsonb;
begin
  if p_request_key is null then
    raise exception 'A request key is required' using errcode = 'OGV22';
  end if;
  select * into v_org from ogevia.organizations o where o.id = p_organization_id;
  v_today := (v_now at time zone v_org.timezone)::date;

  select coalesce(jsonb_agg(x order by x ->> 'starts_at', x ->> 'client_code'), '[]') into v_shifts from (
    select jsonb_build_object(
             'local_date', (s.starts_at at time zone v_org.timezone)::date,
             'start', to_char(s.starts_at at time zone v_org.timezone, 'HH24:MI'),
             'end', to_char(s.ends_at at time zone v_org.timezone, 'HH24:MI'),
             'starts_at', s.starts_at,
             'client_code', c.client_code,
             'client_label', c.caregiver_display_code,
             'client_name', case when v_names then nullif(btrim(coalesce(n.legal_first_name, '') || ' ' || coalesce(n.legal_last_name, '')), '') end,
             'service', sv.name,
             'caregiver', case when cr.id is not null then coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name end,
             'caregiver_code', cr.caregiver_code,
             'coverage', ogevia.shift_coverage_state(s)) as x
    from ogevia.shifts s
    join ogevia.clients c on c.id = s.client_id
    left join ogevia.services sv on sv.id = s.service_id
    left join ogevia.caregiver_records cr on cr.organization_id = s.organization_id and cr.deleted_at is null
      and (cr.id = s.caregiver_record_id or (s.caregiver_record_id is null and cr.linked_user_id = s.caregiver_user_id))
    left join ogevia.client_private_names n on n.client_id = c.id
    where s.organization_id = p_organization_id and s.status = 'scheduled'
      and s.ends_at > v_now and s.starts_at < v_now + interval '14 days'
  ) q;

  select coalesce(jsonb_agg(x order by x ->> 'client_code'), '[]') into v_clients from (
    select jsonb_build_object(
             'client_code', c.client_code,
             'client_label', c.caregiver_display_code,
             'city', c.city,
             'client_name', case when v_names then nullif(btrim(coalesce(n.legal_first_name, '') || ' ' || coalesce(n.legal_last_name, '')), '') end) as x
    from ogevia.clients c
    left join ogevia.client_private_names n on n.client_id = c.id
    where c.organization_id = p_organization_id and c.deleted_at is null and c.status = 'active'
  ) q;

  select coalesce(jsonb_agg(x order by x ->> 'client_code', x ->> 'service'), '[]') into v_auths from (
    select jsonb_build_object(
             'client_code', c.client_code,
             'client_label', c.caregiver_display_code,
             'service', m.service_name,
             'period_start', m.authorization_period_start,
             'period_end', m.authorization_period_end,
             'authorized_minutes', m.authorized_minutes,
             'reserved_minutes', m.reserved_minutes,
             'billable_minutes', m.billable_minutes,
             'review_minutes', m.review_minutes,
             'remaining_minutes', m.remaining_minutes) as x
    from ogevia_api.list_monthly_service_summary(p_organization_id, date_trunc('month', v_today::timestamp)::date, null) m
    join ogevia.clients c on c.id = m.client_id and c.organization_id = p_organization_id
  ) q;

  select coalesce(jsonb_agg(x order by x ->> 'caregiver_code'), '[]') into v_care from (
    select jsonb_build_object(
             'caregiver_code', cr.caregiver_code,
             'name', coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name,
             'status', cr.status::text) as x
    from ogevia.caregiver_records cr
    where cr.organization_id = p_organization_id and cr.deleted_at is null and cr.status::text <> 'inactive'
  ) q;

  -- One number block per request; concurrent downloads in one agency never share numbers.
  perform pg_advisory_xact_lock(hashtextextended('ogevia.continuity:' || p_organization_id::text, 0));
  select * into v_exp from ogevia.continuity_exports e
  where e.organization_id = p_organization_id and e.request_key = p_request_key;
  if v_exp.id is null then
    select coalesce(max(e.outage_number_last), 0) + 1 into v_first
    from ogevia.continuity_exports e where e.organization_id = p_organization_id;
    insert into ogevia.continuity_exports (organization_id, exported_by, request_key, data_as_of, outage_number_first,
      outage_number_last, shift_count, client_count, authorization_count, caregiver_count, includes_client_names)
    values (p_organization_id, v_actor, p_request_key, v_now, v_first, v_first + 24,
      jsonb_array_length(v_shifts), jsonb_array_length(v_clients), jsonb_array_length(v_auths), jsonb_array_length(v_care), v_names)
    returning * into v_exp;
    perform ogevia.write_audit(p_organization_id, 'continuity.pack_downloaded', 'continuity_export', v_exp.id, null,
      jsonb_build_object('data_as_of', v_now, 'outage_numbers', v_exp.outage_number_first || '-' || v_exp.outage_number_last,
                         'shifts', v_exp.shift_count, 'clients', v_exp.client_count, 'authorizations', v_exp.authorization_count,
                         'caregivers', v_exp.caregiver_count, 'client_names', v_names));
  elsif v_exp.exported_by <> v_actor then
    raise exception 'This request key belongs to another download' using errcode = 'OGC09';
  end if;

  return jsonb_build_object(
    'agency', v_org.display_name,
    'timezone', v_org.timezone,
    'data_as_of', v_now,
    'export_id', v_exp.id,
    'exported_by', (select coalesce(u.display_name, 'Staff') from ogevia.app_users u where u.id = v_actor),
    'includes_client_names', v_names,
    'outage_numbers', jsonb_build_object('first', v_exp.outage_number_first, 'last', v_exp.outage_number_last),
    'shifts', v_shifts,
    'clients', v_clients,
    'authorizations', v_auths,
    'caregivers', v_care);
end;
$$;

create function ogevia_api.get_continuity_status(p_organization_id uuid)
returns table (last_downloaded_at timestamptz, last_downloaded_by text, hours_since numeric, downloads_last_7_days integer, outage_numbers_issued integer)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select l.created_at, l.who,
         case when l.created_at is not null then round((extract(epoch from (now() - l.created_at)) / 3600)::numeric, 1) end,
         (select count(*)::integer from ogevia.continuity_exports e where e.organization_id = p_organization_id and e.created_at > now() - interval '7 days'),
         (select coalesce(max(e.outage_number_last), 0)::integer from ogevia.continuity_exports e where e.organization_id = p_organization_id)
  from (select ogevia.continuity_guard(p_organization_id) as actor) g
  left join lateral (
    select e.created_at, coalesce(u.display_name, 'Staff') as who
    from ogevia.continuity_exports e left join ogevia.app_users u on u.id = e.exported_by
    where e.organization_id = p_organization_id order by e.created_at desc limit 1
  ) l on true
  where g.actor is not null;
$$;

revoke all on function ogevia.continuity_guard(uuid) from public;
revoke all on function ogevia_api.create_continuity_pack(uuid, uuid) from public;
revoke all on function ogevia_api.get_continuity_status(uuid) from public;
grant execute on function ogevia_api.create_continuity_pack(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.get_continuity_status(uuid) to ogevia_app;
