-- ROLLBACK 0014_visit_access_from_scheduled_shift | CLASS: SAFE AUTOMATED
-- Functions only; 0014 stores no data. Restores the 0013/0006 definitions
-- (standing assignment required again) and drops the two new helpers.
create or replace function ogevia.match_scheduled_shift_for_visit(
  p_organization_id uuid,
  p_caregiver_record_id uuid,
  p_caregiver_user_id uuid,
  p_client_id uuid,
  p_service_id uuid,
  p_started_at timestamptz
)
returns uuid
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare
  -- How early a caregiver can sign in and still be matched to the shift.
  -- A matching window only: it never refuses or shortens a visit.
  c_early_arrival constant interval := interval '60 minutes';
  v_shift_id uuid;
begin
  select s.id into v_shift_id
  from ogevia.shifts s
  where s.organization_id = p_organization_id
    and s.client_id = p_client_id
    and s.service_id = p_service_id
    and s.status = 'scheduled'
    and (
      (p_caregiver_record_id is not null and s.caregiver_record_id = p_caregiver_record_id)
      or (p_caregiver_user_id is not null and s.caregiver_user_id = p_caregiver_user_id)
    )
    and p_started_at >= s.starts_at - c_early_arrival
    and p_started_at < s.ends_at
    and not ogevia.shift_is_called_out(s.id)
    and not exists (
      select 1 from ogevia.service_visits v
      where v.scheduled_shift_id = s.id
        and v.status not in ('voided', 'corrected')
    )
  order by
    (p_started_at >= s.starts_at) desc,
    abs(extract(epoch from (s.starts_at - p_started_at)))
  limit 1
  for update of s;
  return v_shift_id;
end;
$$;

create or replace function ogevia_api.list_assigned_visit_clients(p_organization_id uuid)
returns table (
  client_id uuid,
  client_code text,
  next_scheduled_starts_at timestamptz,
  next_scheduled_ends_at timestamptz,
  active_service_count integer
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with ctx as (
    select ogevia.require_actor() as actor,
           ogevia.has_permission(p_organization_id, 'visits.manage') as can_manage,
           ogevia.organization_local_date(p_organization_id, now()) as today
  )
  select
    c.id,
    coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code),
    next_shift.starts_at,
    next_shift.ends_at,
    (
      select count(distinct a.service_id)::integer
      from ogevia.client_authorizations a
      join ogevia.services sv on sv.id = a.service_id and sv.deleted_at is null and sv.is_active
      where a.organization_id = c.organization_id
        and a.client_id = c.id
        and a.is_current and a.deleted_at is null
        and ctx.today between a.period_start and a.period_end
        and (ctx.can_manage
             or ogevia.caregiver_has_active_assignment(p_organization_id, c.id, a.service_id))
    )
  from ctx
  cross join ogevia.clients c
  left join lateral (
    select s.starts_at, s.ends_at
    from ogevia.shifts s
    left join ogevia.caregiver_records cr
      on cr.id = s.caregiver_record_id and cr.deleted_at is null
    where s.organization_id = c.organization_id
      and s.client_id = c.id
      and s.status = 'scheduled'
      and ogevia.organization_local_date(p_organization_id, s.starts_at) = ctx.today
      and (ctx.can_manage or s.caregiver_user_id = ctx.actor or cr.linked_user_id = ctx.actor)
      and not ogevia.shift_is_called_out(s.id)
    order by s.starts_at
    limit 1
  ) next_shift on true
  where c.organization_id = p_organization_id
    and c.deleted_at is null
    and c.status = 'active'
    and ogevia.is_active_member(p_organization_id)
    and (ctx.can_manage or ogevia.caregiver_has_active_assignment(p_organization_id, c.id, null))
  order by next_shift.starts_at nulls last,
    coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code);
$$;

create or replace function ogevia_api.list_authorized_services_for_client(
  p_organization_id uuid,
  p_client_id uuid
)
returns table (
  service_id uuid,
  service_code text,
  service_name text,
  service_color text,
  authorization_id uuid,
  monthly_authorized_minutes integer,
  minutes_used_this_month bigint,
  minutes_scheduled_this_month bigint
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with ctx as (
    select ogevia.require_actor() as actor,
           ogevia.has_permission(p_organization_id, 'visits.manage') as can_manage,
           ogevia.organization_local_date(p_organization_id, now()) as today
  )
  select
    sv.id, sv.code, sv.name, sv.color, a.id, a.monthly_authorized_minutes,
    ogevia.authorization_month_usage(a.lineage_id, ctx.today),
    coalesce((
      select sum(floor(extract(epoch from (s.ends_at - s.starts_at)) / 60))::bigint
      from ogevia.shifts s
      where s.organization_id = a.organization_id
        and s.client_id = a.client_id
        and s.service_id = a.service_id
        and s.status = 'scheduled'
        and date_trunc('month', ogevia.organization_local_date(p_organization_id, s.starts_at)::timestamp)
            = date_trunc('month', ctx.today::timestamp)
        and not ogevia.shift_is_called_out(s.id)
    ), 0)
  from ctx
  cross join ogevia.client_authorizations a
  join ogevia.clients c on c.id = a.client_id and c.deleted_at is null and c.status = 'active'
  join ogevia.services sv on sv.id = a.service_id and sv.deleted_at is null and sv.is_active
  where a.organization_id = p_organization_id
    and a.client_id = p_client_id
    and a.is_current and a.deleted_at is null
    and ctx.today between a.period_start and a.period_end
    and ogevia.is_active_member(p_organization_id)
    and (ctx.can_manage
         or ogevia.caregiver_has_active_assignment(p_organization_id, p_client_id, a.service_id))
  order by sv.name, sv.code;
$$;

create or replace function ogevia_api.start_ad_hoc_service_visit(
  p_organization_id uuid,
  p_client_id uuid,
  p_service_id uuid,
  p_task_categories text[] default '{}',
  p_service_notes text default null,
  p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_started_at timestamptz := now();
  v_fingerprint text := concat_ws('|', p_organization_id, p_client_id, p_service_id);
  v_prior jsonb;
  v_client ogevia.clients%rowtype;
  v_auth ogevia.client_authorizations%rowtype;
  v_record ogevia.caregiver_records%rowtype;
  v_org ogevia.organizations%rowtype;
  v_is_caregiver boolean;
  v_can_manage boolean;
  v_service_date date;
  v_name text;
  v_visit_id uuid;
  v_shift_id uuid;
begin
  select * into v_org from ogevia.organizations o where o.id = p_organization_id and o.status = 'active';
  if v_org.id is null then
    raise exception 'Organization is not active' using errcode = 'OGA03';
  end if;
  v_is_caregiver := ogevia.is_active_caregiver(p_organization_id);
  v_can_manage := ogevia.has_permission(p_organization_id, 'visits.manage');
  if not v_is_caregiver and not v_can_manage then
    raise exception 'Only an active caregiver or visit manager can start a visit' using errcode = 'OGA03';
  end if;

  -- Serialize starts per caller; with the partial unique indexes this makes
  -- double taps and concurrent starts safe.
  perform pg_advisory_xact_lock(hashtextextended('ogevia.start:' || v_actor::text, 0));

  v_prior := ogevia.idempotency_begin('start_visit', p_idempotency_key, p_organization_id, v_fingerprint);
  if v_prior is not null then
    return (v_prior ->> 'visit_id')::uuid;
  end if;

  if exists (
    select 1 from ogevia.service_visits v
    where v.caregiver_user_id = v_actor and v.status in ('draft', 'awaiting_signature')
  ) then
    raise exception 'Finish your current visit before starting another client' using errcode = 'OGC09';
  end if;

  if not v_can_manage
     and not ogevia.caregiver_has_active_assignment(p_organization_id, p_client_id, p_service_id) then
    raise exception 'This client and service are not assigned to you' using errcode = 'OGA03';
  end if;

  select * into v_client from ogevia.clients c
  where c.id = p_client_id and c.organization_id = p_organization_id
    and c.deleted_at is null and c.status = 'active';
  if v_client.id is null then
    raise exception 'Client not found or inactive' using errcode = 'OGN04';
  end if;
  if not exists (
    select 1 from ogevia.services sv
    where sv.id = p_service_id and sv.organization_id = p_organization_id
      and sv.deleted_at is null and sv.is_active
  ) then
    raise exception 'Service not found or inactive' using errcode = 'OGN04';
  end if;

  v_service_date := ogevia.organization_local_date(p_organization_id, v_started_at);
  -- M-1 fix: CURRENT version only.
  select * into v_auth
  from ogevia.resolve_current_authorization(p_organization_id, p_client_id, p_service_id, v_service_date);
  if v_auth.id is null then
    raise exception 'No active authorization covers this client and service' using errcode = 'OGC09';
  end if;

  select cr.* into v_record
  from ogevia.caregiver_records cr
  where cr.organization_id = p_organization_id and cr.linked_user_id = v_actor and cr.deleted_at is null
  order by case when cr.status in ('active', 'ready') then 0 else 1 end, cr.updated_at desc
  limit 1;
  if v_is_caregiver and (v_record.id is null or v_record.status not in ('active', 'ready')) then
    raise exception 'Your Care Team profile is not active. Contact your agency manager before starting a visit.'
      using errcode = 'OGA03';
  end if;

  select coalesce(
    nullif(btrim(concat_ws(' ', coalesce(v_record.preferred_name, v_record.first_name), v_record.last_name)), ''),
    nullif(btrim(u.display_name), ''),
    'Caregiver'
  ) into v_name
  from ogevia.app_users u where u.id = v_actor;

  -- Link the visit to the caregiver's own scheduled shift for this client and
  -- service when one is in progress or about to start (server-side only).
  v_shift_id := ogevia.match_scheduled_shift_for_visit(
    p_organization_id, v_record.id, v_actor, p_client_id, p_service_id, v_started_at);

  insert into ogevia.service_visits (
    organization_id, client_id, client_code_snapshot, caregiver_user_id, caregiver_record_id,
    caregiver_name_snapshot, scheduled_shift_id, service_authorization_id, service_id,
    service_date, time_in, task_categories, service_notes, status, created_by, visit_number_snapshot
  ) values (
    p_organization_id, v_client.id,
    coalesce(nullif(btrim(v_client.caregiver_display_code), ''), v_client.client_code),
    v_actor, v_record.id, coalesce(v_name, 'Caregiver'), v_shift_id, v_auth.id, p_service_id,
    v_service_date, v_started_at, coalesce(p_task_categories, '{}'),
    nullif(btrim(p_service_notes), ''), 'draft', v_actor,
    coalesce(nullif(upper(left(regexp_replace(v_org.slug, '[^a-zA-Z0-9]', '', 'g'), 4)), ''), 'OGEV')
      || '-V-' || to_char(v_service_date, 'YYYYMMDD')
      || '-' || upper(substr(md5(gen_random_uuid()::text), 1, 4))
  ) returning id into v_visit_id;

  perform ogevia.write_audit(p_organization_id, 'service_visit.started', 'service_visits', v_visit_id,
    null, jsonb_build_object('status', 'draft', 'time_in', v_started_at,
                             'authorization_id', v_auth.id, 'service_id', p_service_id,
                             'scheduled_shift_id', v_shift_id));
  perform ogevia.idempotency_finish('start_visit', p_idempotency_key, p_organization_id, v_fingerprint,
    jsonb_build_object('visit_id', v_visit_id));
  return v_visit_id;
end;
$$;

drop function if exists ogevia.caregiver_has_current_shift(uuid, uuid, uuid);
drop function if exists ogevia.visit_shift_early_arrival();
