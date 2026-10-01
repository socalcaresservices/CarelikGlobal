-- 0006 - Service Verification API (RDS equivalents of current-main RPCs).
--
-- Every function: SECURITY DEFINER (runs as ogevia_owner), pinned search_path,
-- derives the actor from ogevia_api.begin_request (never from arguments),
-- derives the organization from the target row where one exists, and writes
-- an audit event for each state change. Error SQLSTATEs (Phase 4 maps them to
-- HTTP): OGA01 unauthenticated, OGA03 forbidden, OGN04 not found,
-- OGC09 state conflict, OGV22 validation, OGI09 idempotency-key reuse.

-- ---------------------------------------------------------------------------
-- Idempotency helpers
-- ---------------------------------------------------------------------------

create function ogevia.idempotency_begin(
  p_operation text,
  p_key uuid,
  p_organization_id uuid,
  p_fingerprint text
)
returns jsonb
language plpgsql
set search_path = ogevia, pg_temp
as $$
declare
  existing ogevia.idempotency_records%rowtype;
begin
  if p_key is null then
    return null;
  end if;
  -- Concurrent retries with one key wait here, then see the first result.
  perform pg_advisory_xact_lock(hashtextextended(
    'ogevia.idempotency:' || ogevia.require_actor()::text || ':' || p_operation || ':' || p_key::text, 0));
  select * into existing
  from ogevia.idempotency_records r
  where r.actor_user_id = ogevia.current_user_id()
    and r.operation = p_operation
    and r.idempotency_key = p_key;
  if existing.idempotency_key is null then
    return null;
  end if;
  if existing.request_fingerprint <> p_fingerprint or existing.organization_id <> p_organization_id then
    raise exception 'Idempotency key was already used for a different request' using errcode = 'OGI09';
  end if;
  return existing.response;
end;
$$;

create function ogevia.idempotency_finish(
  p_operation text,
  p_key uuid,
  p_organization_id uuid,
  p_fingerprint text,
  p_response jsonb
)
returns void
language sql
set search_path = ogevia, pg_temp
as $$
  insert into ogevia.idempotency_records (
    actor_user_id, operation, idempotency_key, organization_id, request_fingerprint, response
  )
  select ogevia.current_user_id(), p_operation, p_key, p_organization_id, p_fingerprint, p_response
  where p_key is not null;
$$;

-- ---------------------------------------------------------------------------
-- Reads for the caregiver screen
-- ---------------------------------------------------------------------------

-- current main: get_active_service_visit_v3
create function ogevia_api.get_active_service_visit(p_organization_id uuid)
returns table (
  visit_id uuid,
  visit_number text,
  client_code text,
  service_code text,
  service_name text,
  scheduled_starts_at timestamptz,
  scheduled_ends_at timestamptz,
  time_in timestamptz,
  time_out timestamptz,
  worked_minutes integer,
  visit_status ogevia.service_visit_status,
  monthly_authorized_minutes integer,
  confirmed_minutes_this_month bigint
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select
    v.id, v.visit_number_snapshot, v.client_code_snapshot, sv.code, sv.name,
    s.starts_at, s.ends_at, v.time_in, v.time_out, v.worked_minutes, v.status,
    cur.monthly_authorized_minutes,
    ogevia.authorization_month_usage(bound.lineage_id, v.service_date, v.id)
  from ogevia.service_visits v
  join ogevia.services sv on sv.id = v.service_id
  join ogevia.client_authorizations bound on bound.id = v.service_authorization_id
  left join lateral (
    select a.monthly_authorized_minutes
    from ogevia.client_authorizations a
    where a.lineage_id = bound.lineage_id and a.is_current and a.deleted_at is null
      and v.service_date between a.period_start and a.period_end
  ) cur on true
  left join ogevia.shifts s on s.id = v.scheduled_shift_id
  where ogevia.require_actor() is not null
    and v.organization_id = p_organization_id
    and v.caregiver_user_id = ogevia.current_user_id()
    and ogevia.is_active_member(p_organization_id)
    and v.status in ('draft', 'awaiting_signature')
  order by v.time_in desc
  limit 1;
$$;

-- current main: list_assigned_visit_clients (20260824210000). Code-only.
create function ogevia_api.list_assigned_visit_clients(p_organization_id uuid)
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

-- current main: list_authorized_services_for_client (v3). CURRENT versions
-- only; usage summed over the lineage; exact minutes instead of hours.
create function ogevia_api.list_authorized_services_for_client(
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

-- ---------------------------------------------------------------------------
-- Start (current main: start_ad_hoc_service_visit, v3)
-- ---------------------------------------------------------------------------

create function ogevia_api.start_ad_hoc_service_visit(
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

  insert into ogevia.service_visits (
    organization_id, client_id, client_code_snapshot, caregiver_user_id, caregiver_record_id,
    caregiver_name_snapshot, scheduled_shift_id, service_authorization_id, service_id,
    service_date, time_in, task_categories, service_notes, status, created_by, visit_number_snapshot
  ) values (
    p_organization_id, v_client.id,
    coalesce(nullif(btrim(v_client.caregiver_display_code), ''), v_client.client_code),
    v_actor, v_record.id, coalesce(v_name, 'Caregiver'), null, v_auth.id, p_service_id,
    v_service_date, v_started_at, coalesce(p_task_categories, '{}'),
    nullif(btrim(p_service_notes), ''), 'draft', v_actor,
    coalesce(nullif(upper(left(regexp_replace(v_org.slug, '[^a-zA-Z0-9]', '', 'g'), 4)), ''), 'OGEV')
      || '-V-' || to_char(v_service_date, 'YYYYMMDD')
      || '-' || upper(substr(md5(gen_random_uuid()::text), 1, 4))
  ) returning id into v_visit_id;

  perform ogevia.write_audit(p_organization_id, 'service_visit.started', 'service_visits', v_visit_id,
    null, jsonb_build_object('status', 'draft', 'time_in', v_started_at,
                             'authorization_id', v_auth.id, 'service_id', p_service_id));
  perform ogevia.idempotency_finish('start_visit', p_idempotency_key, p_organization_id, v_fingerprint,
    jsonb_build_object('visit_id', v_visit_id));
  return v_visit_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- End (current main: end_service_visit, v3). Retry-safe without a key.
-- ---------------------------------------------------------------------------

create function ogevia_api.end_service_visit(
  p_visit_id uuid,
  p_task_categories text[] default null,
  p_service_notes text default null
)
returns table (visit_id uuid, worked_minutes integer, time_in timestamptz, time_out timestamptz)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.require_actor();
  v_visit ogevia.service_visits%rowtype;
  v_ended_at timestamptz := now();
  v_minutes integer;
begin
  select * into v_visit from ogevia.service_visits sv where sv.id = p_visit_id for update;
  if v_visit.id is null or not ogevia.is_active_member(v_visit.organization_id) then
    raise exception 'Visit not found' using errcode = 'OGN04';
  end if;
  if v_visit.caregiver_user_id is distinct from v_actor
     and not ogevia.has_permission(v_visit.organization_id, 'visits.manage') then
    raise exception 'You cannot end another caregiver''s visit' using errcode = 'OGA03';
  end if;

  if v_visit.status = 'awaiting_signature' and v_visit.time_out is not null then
    return query select v_visit.id, v_visit.worked_minutes, v_visit.time_in, v_visit.time_out;
    return;
  end if;
  if v_visit.status <> 'draft' then
    raise exception 'Visit has already been ended' using errcode = 'OGC09';
  end if;

  v_minutes := floor(extract(epoch from (v_ended_at - v_visit.time_in)) / 60)::integer;
  if v_minutes < 1 then
    raise exception 'A visit must last at least one minute before it can be ended' using errcode = 'OGC09';
  end if;
  if v_minutes > 1440 then
    raise exception 'This visit has been open for over 24 hours - contact a manager to resolve it'
      using errcode = 'OGC09';
  end if;

  update ogevia.service_visits sv
  set time_out = v_ended_at,
      worked_minutes = v_minutes,
      caregiver_attested_at = v_ended_at,
      status = 'awaiting_signature',
      task_categories = coalesce(p_task_categories, sv.task_categories),
      service_notes = coalesce(nullif(btrim(p_service_notes), ''), sv.service_notes)
  where sv.id = v_visit.id;

  perform ogevia.write_audit(v_visit.organization_id, 'service_visit.ended', 'service_visits', v_visit.id,
    jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'awaiting_signature', 'time_out', v_ended_at, 'worked_minutes', v_minutes));
  return query select v_visit.id, v_minutes, v_visit.time_in, v_ended_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- Evidence registration (replaces the storage.objects existence check)
-- ---------------------------------------------------------------------------

create function ogevia_api.register_visit_evidence(
  p_visit_id uuid,
  p_object_key text,
  p_object_version_id text,
  p_content_type text,
  p_byte_size integer,
  p_sha256_hex text,
  p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_visit ogevia.service_visits%rowtype;
  v_fingerprint text := concat_ws('|', p_visit_id, p_object_key, p_object_version_id, p_sha256_hex);
  v_prior jsonb;
  v_evidence_id uuid;
begin
  select * into v_visit from ogevia.service_visits sv where sv.id = p_visit_id for update;
  if v_visit.id is null or not ogevia.is_active_member(v_visit.organization_id) then
    raise exception 'Visit not found' using errcode = 'OGN04';
  end if;
  if v_visit.caregiver_user_id is distinct from v_actor then
    raise exception 'Only the caregiver who recorded this visit can submit its client confirmation'
      using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('register_evidence', p_idempotency_key, v_visit.organization_id, v_fingerprint);
  if v_prior is not null then
    return (v_prior ->> 'evidence_id')::uuid;
  end if;
  if v_visit.status <> 'awaiting_signature' then
    raise exception 'Visit is already locked or is not ready for confirmation' using errcode = 'OGC09';
  end if;
  if p_object_key is distinct from
     v_visit.organization_id::text || '/' || v_visit.id::text || '/client-signature.png' then
    raise exception 'Signature object key does not belong to this visit' using errcode = 'OGV22';
  end if;

  insert into ogevia.visit_evidence (
    organization_id, visit_id, object_key, object_version_id, content_type,
    byte_size, sha256_hex, registered_by, request_id
  ) values (
    v_visit.organization_id, v_visit.id, p_object_key, nullif(btrim(p_object_version_id), ''),
    p_content_type, p_byte_size, lower(p_sha256_hex), v_actor, ogevia.current_request_id()
  ) returning id into v_evidence_id;

  perform ogevia.write_audit(v_visit.organization_id, 'visit_evidence.registered', 'visit_evidence',
    v_evidence_id, null,
    jsonb_build_object('visit_id', v_visit.id, 'byte_size', p_byte_size, 'sha256', lower(p_sha256_hex),
                       'object_version_id', p_object_version_id));
  perform ogevia.idempotency_finish('register_evidence', p_idempotency_key, v_visit.organization_id,
    v_fingerprint, jsonb_build_object('evidence_id', v_evidence_id));
  return v_evidence_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Confirm (current main: confirm_service_visit, v3) + M-1 lineage fix
-- ---------------------------------------------------------------------------

create function ogevia_api.confirm_service_visit(
  p_visit_id uuid,
  p_signer_role ogevia.visit_signer_role,
  p_confirmation_method text,
  p_evidence_id uuid default null,
  p_typed_signer_name text default null,
  p_signer_relationship text default null,
  p_confirmation_reason text default null,
  p_idempotency_key uuid default null
)
returns table (
  visit_id uuid,
  status ogevia.service_visit_status,
  authorization_status ogevia.visit_authorization_status,
  worked_minutes integer,
  billable_minutes integer,
  month_to_date_minutes bigint,
  remaining_minutes bigint
)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.require_actor();
  v_visit ogevia.service_visits%rowtype;
  v_bound ogevia.client_authorizations%rowtype;
  v_current ogevia.client_authorizations%rowtype;
  v_service ogevia.services%rowtype;
  v_method text := lower(btrim(coalesce(p_confirmation_method, '')));
  v_signer_name text := nullif(btrim(coalesce(p_typed_signer_name, '')), '');
  v_relationship text := nullif(btrim(coalesce(p_signer_relationship, '')), '');
  v_reason text := nullif(btrim(coalesce(p_confirmation_reason, '')), '');
  v_fingerprint text;
  v_prior jsonb;
  v_confirmed boolean;
  v_prior_minutes bigint;
  v_cap integer;
  v_potential integer;
  v_allowed integer;
  v_auth_status ogevia.visit_authorization_status;
  v_status ogevia.service_visit_status;
  v_timezone text;
  v_response jsonb;
begin
  if v_method not in ('draw', 'typed', 'verbal', 'assisted_mark', 'unable_to_confirm') then
    raise exception 'Choose a valid confirmation method' using errcode = 'OGV22';
  end if;
  v_fingerprint := concat_ws('|', p_visit_id, p_signer_role, v_method, p_evidence_id, v_signer_name, v_reason);

  select * into v_visit from ogevia.service_visits sv where sv.id = p_visit_id for update;
  if v_visit.id is null or not ogevia.is_active_member(v_visit.organization_id) then
    raise exception 'Visit not found' using errcode = 'OGN04';
  end if;
  if v_visit.caregiver_user_id is distinct from v_actor then
    raise exception 'Only the caregiver who recorded this visit can submit its client confirmation'
      using errcode = 'OGA03';
  end if;

  v_prior := ogevia.idempotency_begin('confirm_visit', p_idempotency_key, v_visit.organization_id, v_fingerprint);
  if v_prior is not null then
    return query select (v_prior ->> 'visit_id')::uuid,
      (v_prior ->> 'status')::ogevia.service_visit_status,
      (v_prior ->> 'authorization_status')::ogevia.visit_authorization_status,
      (v_prior ->> 'worked_minutes')::integer, (v_prior ->> 'billable_minutes')::integer,
      (v_prior ->> 'month_to_date_minutes')::bigint, (v_prior ->> 'remaining_minutes')::bigint;
    return;
  end if;

  if v_visit.status <> 'awaiting_signature' then
    raise exception 'Visit is already locked or is not ready for confirmation' using errcode = 'OGC09';
  end if;

  v_confirmed := v_method in ('draw', 'assisted_mark');
  if v_confirmed then
    -- The evidence must be this visit's MOST RECENT registered upload.
    if p_evidence_id is null or p_evidence_id is distinct from (
      select e.id from ogevia.visit_evidence e
      where e.visit_id = v_visit.id order by e.registered_at desc, e.id desc limit 1
    ) then
      raise exception 'A signature or mark is required' using errcode = 'OGV22';
    end if;
  elsif p_evidence_id is not null then
    raise exception 'Evidence applies only to drawn signatures and assisted marks' using errcode = 'OGV22';
  elsif v_method in ('typed', 'verbal') and v_signer_name is null then
    raise exception 'Enter the name of the person confirming the visit' using errcode = 'OGV22';
  elsif v_method = 'unable_to_confirm' and v_reason is null then
    raise exception 'Explain why confirmation could not be obtained' using errcode = 'OGV22';
  end if;

  select * into v_bound from ogevia.client_authorizations a where a.id = v_visit.service_authorization_id;
  perform ogevia.lock_authorization_lineage(v_bound.lineage_id);
  -- M-1 fix: cap from the CURRENT version of the visit's lineage that covers
  -- the service date; usage across the whole lineage.
  select * into v_current
  from ogevia.client_authorizations a
  where a.lineage_id = v_bound.lineage_id and a.is_current and a.deleted_at is null
    and v_visit.service_date between a.period_start and a.period_end;

  v_prior_minutes := ogevia.authorization_month_usage(v_bound.lineage_id, v_visit.service_date, v_visit.id);
  if v_current.id is null then
    -- An amendment removed coverage for this date: nothing is billable until
    -- an administrator reviews it.
    v_cap := 0;
  else
    v_cap := v_current.monthly_authorized_minutes;
  end if;
  v_potential := greatest(0, least(v_visit.worked_minutes::bigint, v_cap - v_prior_minutes))::integer;

  if v_potential < v_visit.worked_minutes then
    v_auth_status := 'exceeds_authorization';
  elsif v_prior_minutes + v_potential >= v_cap then
    v_auth_status := 'limit_reached';
  else
    v_auth_status := 'within_authorization';
  end if;

  if v_confirmed then
    v_allowed := v_potential;
    v_status := case when v_potential < v_visit.worked_minutes then 'administrator_review' else 'signed' end;
  else
    -- No client signature/mark: zero billable, administrator review.
    v_allowed := 0;
    v_status := 'administrator_review';
  end if;

  select * into v_service from ogevia.services s where s.id = v_visit.service_id;
  select coalesce(o.timezone, 'America/Los_Angeles') into v_timezone
  from ogevia.organizations o where o.id = v_visit.organization_id;

  insert into ogevia.visit_confirmations (
    organization_id, visit_id, signer_role, confirmation_method, evidence_id,
    typed_signer_name, signer_relationship, confirmation_reason,
    confirmed_visit_snapshot, confirmation_version, confirmed_by, request_id
  ) values (
    v_visit.organization_id, v_visit.id, p_signer_role, v_method,
    case when v_confirmed then p_evidence_id end,
    v_signer_name, v_relationship, v_reason,
    jsonb_build_object(
      'clientCode', v_visit.client_code_snapshot,
      'caregiverName', v_visit.caregiver_name_snapshot,
      'serviceName', v_service.name,
      'serviceCode', v_service.code,
      'serviceDate', v_visit.service_date,
      'timeIn', v_visit.time_in,
      'timeOut', v_visit.time_out,
      'workedMinutes', v_visit.worked_minutes,
      'verifiedMinutes', case when v_confirmed then v_visit.worked_minutes else 0 end,
      'billableMinutes', v_allowed,
      'signerRole', p_signer_role,
      'confirmationMethod', v_method,
      'caregiverAttestedAt', v_visit.caregiver_attested_at,
      'timeZone', v_timezone,
      'confirmationVersion', 4,
      'authorizationId', coalesce(v_current.id, v_bound.id),
      'authorizationLineageId', v_bound.lineage_id,
      'monthToDateBeforeMinutes', v_prior_minutes,
      'monthToDateAfterMinutes', v_prior_minutes + v_allowed,
      'authorizedMinutes', v_cap,
      'remainingMinutes', greatest(0, v_cap - v_prior_minutes - v_allowed)
    ),
    4, v_actor, ogevia.current_request_id()
  );

  update ogevia.service_visits sv
  set verified_minutes = case when v_confirmed then v_visit.worked_minutes else 0 end,
      billable_minutes = v_allowed,
      status = v_status,
      authorization_status = v_auth_status,
      service_authorization_id = coalesce(v_current.id, v_bound.id),
      signed_at = now(),
      locked_at = now()
  where sv.id = v_visit.id;

  perform ogevia.write_audit(v_visit.organization_id, 'service_visit.confirmed', 'service_visits', v_visit.id,
    jsonb_build_object('status', 'awaiting_signature', 'authorization_id', v_bound.id),
    jsonb_build_object('status', v_status, 'authorization_status', v_auth_status,
                       'authorization_id', coalesce(v_current.id, v_bound.id),
                       'confirmation_method', v_method, 'evidence_id', p_evidence_id,
                       'billable_minutes', v_allowed, 'worked_minutes', v_visit.worked_minutes));

  v_response := jsonb_build_object(
    'visit_id', v_visit.id, 'status', v_status, 'authorization_status', v_auth_status,
    'worked_minutes', v_visit.worked_minutes, 'billable_minutes', v_allowed,
    'month_to_date_minutes', v_prior_minutes + v_allowed,
    'remaining_minutes', greatest(0, v_cap - v_prior_minutes - v_allowed));
  perform ogevia.idempotency_finish('confirm_visit', p_idempotency_key, v_visit.organization_id,
    v_fingerprint, v_response);

  return query select v_visit.id, v_status, v_auth_status, v_visit.worked_minutes, v_allowed,
    v_prior_minutes + v_allowed, greatest(0, v_cap - v_prior_minutes - v_allowed);
end;
$$;

-- ---------------------------------------------------------------------------
-- Void (current main: void_service_visit, 20260813061500)
-- ---------------------------------------------------------------------------

create function ogevia_api.void_service_visit(p_visit_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_visit ogevia.service_visits%rowtype;
begin
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required to void a visit' using errcode = 'OGV22';
  end if;
  select * into v_visit from ogevia.service_visits sv where sv.id = p_visit_id for update;
  if v_visit.id is null or not ogevia.is_active_member(v_visit.organization_id) then
    raise exception 'Visit not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v_visit.organization_id, 'visits.manage') then
    raise exception 'Only an administrator can void a visit' using errcode = 'OGA03';
  end if;
  if v_visit.status not in ('draft', 'awaiting_signature') then
    raise exception 'A signed visit cannot be voided - use a correction instead' using errcode = 'OGC09';
  end if;
  update ogevia.service_visits sv
  set status = 'voided', voided_at = now(), voided_by = v_actor, void_reason = btrim(p_reason)
  where sv.id = v_visit.id;
  perform ogevia.write_audit(v_visit.organization_id, 'service_visit.voided', 'service_visits', v_visit.id,
    jsonb_build_object('status', v_visit.status), jsonb_build_object('status', 'voided'), btrim(p_reason));
end;
$$;

-- ---------------------------------------------------------------------------
-- Correct (current main: correct_service_visit, v3) + M-1 lineage fix
-- ---------------------------------------------------------------------------

create function ogevia_api.correct_service_visit(
  p_visit_id uuid,
  p_new_time_in timestamptz,
  p_new_time_out timestamptz,
  p_reason text,
  p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_original ogevia.service_visits%rowtype;
  v_auth ogevia.client_authorizations%rowtype;
  v_auth_end ogevia.client_authorizations%rowtype;
  v_fingerprint text := concat_ws('|', p_visit_id, p_new_time_in, p_new_time_out, btrim(coalesce(p_reason, '')));
  v_prior jsonb;
  v_minutes integer;
  v_start_date date;
  v_end_date date;
  v_was_confirmed boolean;
  v_prior_minutes bigint;
  v_allowed integer;
  v_auth_status ogevia.visit_authorization_status;
  v_status ogevia.service_visit_status;
  v_before jsonb;
  v_after jsonb;
  v_corrected_id uuid;
begin
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required to correct a visit' using errcode = 'OGV22';
  end if;
  if p_new_time_in is null or p_new_time_out is null or p_new_time_out <= p_new_time_in then
    raise exception 'Time out must be after time in' using errcode = 'OGV22';
  end if;
  if p_new_time_out > now() then
    raise exception 'Corrected time out cannot be in the future' using errcode = 'OGV22';
  end if;

  select * into v_original from ogevia.service_visits sv where sv.id = p_visit_id for update;
  if v_original.id is null or not ogevia.is_active_member(v_original.organization_id) then
    raise exception 'Visit not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v_original.organization_id, 'visits.manage') then
    raise exception 'You do not have permission to correct visits for this organization' using errcode = 'OGA03';
  end if;

  v_prior := ogevia.idempotency_begin('correct_visit', p_idempotency_key, v_original.organization_id, v_fingerprint);
  if v_prior is not null then
    return (v_prior ->> 'corrected_visit_id')::uuid;
  end if;

  if v_original.status not in ('signed', 'administrator_review') then
    raise exception 'Only a submitted visit can be corrected' using errcode = 'OGC09';
  end if;

  v_minutes := floor(extract(epoch from (p_new_time_out - p_new_time_in)) / 60)::integer;
  if v_minutes < 1 or v_minutes > 1440 then
    raise exception 'Corrected duration must be between 1 minute and 24 hours' using errcode = 'OGV22';
  end if;

  v_start_date := ogevia.organization_local_date(v_original.organization_id, p_new_time_in);
  v_end_date := ogevia.organization_local_date(v_original.organization_id, p_new_time_out);
  -- M-1 fix: CURRENT authorization covering BOTH corrected dates.
  select * into v_auth from ogevia.resolve_current_authorization(
    v_original.organization_id, v_original.client_id, v_original.service_id, v_start_date);
  select * into v_auth_end from ogevia.resolve_current_authorization(
    v_original.organization_id, v_original.client_id, v_original.service_id, v_end_date);
  if v_auth.id is null or v_auth_end.id is distinct from v_auth.id then
    raise exception 'The corrected time is outside an active authorization period' using errcode = 'OGC09';
  end if;
  perform ogevia.lock_authorization_lineage(v_auth.lineage_id);

  if exists (
    select 1 from ogevia.service_visits v
    where v.organization_id = v_original.organization_id
      and v.id <> v_original.id
      and v.status not in ('voided', 'corrected')
      and ((v_original.caregiver_user_id is not null and v.caregiver_user_id = v_original.caregiver_user_id)
           or (v_original.caregiver_record_id is not null and v.caregiver_record_id = v_original.caregiver_record_id))
      and v.time_in < p_new_time_out
      and coalesce(v.time_out, now()) > p_new_time_in
  ) then
    raise exception 'The corrected time overlaps another visit for this caregiver' using errcode = 'OGC09';
  end if;

  -- A correction keeps the ORIGINAL client confirmation. Typed/verbal only
  -- counted as confirmed on legacy (version 1-2) records, as on current main.
  select exists (
    select 1 from ogevia.visit_confirmations vc
    where vc.visit_id in (v_original.id, v_original.original_visit_id)
      and (vc.confirmation_method in ('draw', 'assisted_mark')
           or (vc.confirmation_method in ('typed', 'verbal') and vc.confirmation_version <= 2))
  ) into v_was_confirmed;

  v_prior_minutes := ogevia.authorization_month_usage(v_auth.lineage_id, v_start_date, v_original.id);
  if v_was_confirmed then
    v_allowed := greatest(0, least(v_minutes::bigint, v_auth.monthly_authorized_minutes - v_prior_minutes))::integer;
  else
    v_allowed := 0;
  end if;

  if not v_was_confirmed then
    v_auth_status := case
      when greatest(0, least(v_minutes::bigint, v_auth.monthly_authorized_minutes - v_prior_minutes)) < v_minutes
        then 'exceeds_authorization'
      when v_prior_minutes + v_minutes >= v_auth.monthly_authorized_minutes then 'limit_reached'
      else 'within_authorization'
    end;
    v_status := 'administrator_review';
  elsif v_allowed < v_minutes then
    v_auth_status := 'exceeds_authorization';
    v_status := 'administrator_review';
  else
    v_auth_status := 'administrator_override';
    v_status := 'signed';
  end if;

  v_before := jsonb_build_object(
    'visitId', v_original.id, 'visitNumber', v_original.visit_number_snapshot,
    'timeIn', v_original.time_in, 'timeOut', v_original.time_out,
    'workedMinutes', v_original.worked_minutes, 'verifiedMinutes', v_original.verified_minutes,
    'billableMinutes', v_original.billable_minutes, 'status', v_original.status,
    'authorizationStatus', v_original.authorization_status,
    'authorizationId', v_original.service_authorization_id);
  v_after := jsonb_build_object(
    'timeIn', p_new_time_in, 'timeOut', p_new_time_out, 'workedMinutes', v_minutes,
    'verifiedMinutes', case when v_was_confirmed then v_minutes else 0 end,
    'billableMinutes', v_allowed, 'status', v_status, 'authorizationStatus', v_auth_status,
    'authorizationId', v_auth.id, 'managerCorrected', true,
    'clientConfirmationSourceVisitId',
      case when v_was_confirmed then coalesce(v_original.original_visit_id, v_original.id) end);

  update ogevia.service_visits sv set status = 'corrected' where sv.id = v_original.id;

  insert into ogevia.service_visits (
    organization_id, client_id, client_code_snapshot, caregiver_user_id, caregiver_record_id,
    caregiver_name_snapshot, scheduled_shift_id, service_authorization_id, service_id, service_date,
    time_in, time_out, worked_minutes, verified_minutes, billable_minutes, task_categories,
    service_notes, caregiver_attested_at, status, authorization_status, signed_at, locked_at,
    original_visit_id, correction_reason, created_by, visit_number_snapshot
  ) values (
    v_original.organization_id, v_original.client_id, v_original.client_code_snapshot,
    v_original.caregiver_user_id, v_original.caregiver_record_id, v_original.caregiver_name_snapshot,
    v_original.scheduled_shift_id, v_auth.id, v_original.service_id, v_start_date,
    p_new_time_in, p_new_time_out, v_minutes,
    case when v_was_confirmed then v_minutes else 0 end, v_allowed, v_original.task_categories,
    v_original.service_notes, v_original.caregiver_attested_at, v_status, v_auth_status, now(), now(),
    coalesce(v_original.original_visit_id, v_original.id), btrim(p_reason), v_actor,
    v_original.visit_number_snapshot
  ) returning id into v_corrected_id;

  insert into ogevia.visit_corrections (
    organization_id, original_visit_id, corrected_visit_id, corrected_by, reason,
    before_snapshot, after_snapshot, request_id
  ) values (
    v_original.organization_id, v_original.id, v_corrected_id, v_actor, btrim(p_reason),
    v_before, v_after, ogevia.current_request_id()
  );

  perform ogevia.write_audit(v_original.organization_id, 'service_visit.corrected', 'service_visits',
    v_corrected_id, v_before, v_after, btrim(p_reason));
  perform ogevia.idempotency_finish('correct_visit', p_idempotency_key, v_original.organization_id,
    v_fingerprint, jsonb_build_object('corrected_visit_id', v_corrected_id));
  return v_corrected_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Amend authorization (current main: amend_client_authorization)
-- ---------------------------------------------------------------------------

create function ogevia_api.amend_client_authorization(
  p_authorization_id uuid,
  p_monthly_authorized_minutes integer,
  p_period_start date,
  p_period_end date,
  p_payer text,
  p_reason text,
  p_authorization_number text default null,
  p_received_date date default null,
  p_source_reference text default null,
  p_idempotency_key uuid default null
)
returns table (
  new_authorization_id uuid,
  new_version_number integer,
  affected_visit_id uuid,
  affected_visit_status ogevia.service_visit_status,
  affected_service_date date,
  affected_worked_minutes integer,
  affected_billable_minutes integer,
  impact_kind text
)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.require_actor();
  v_old ogevia.client_authorizations%rowtype;
  v_new_id uuid;
  v_fingerprint text := concat_ws('|', p_authorization_id, p_monthly_authorized_minutes,
                                  p_period_start, p_period_end, p_payer);
  v_prior jsonb;
  v_moved_up boolean;
begin
  if p_period_start is null or p_period_end is null or p_period_end <= p_period_start then
    raise exception 'Period end must be after period start' using errcode = 'OGV22';
  end if;
  if p_monthly_authorized_minutes is null or p_monthly_authorized_minutes < 0 then
    raise exception 'Authorized minutes cannot be negative' using errcode = 'OGV22';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required to amend an authorization' using errcode = 'OGV22';
  end if;

  select * into v_old from ogevia.client_authorizations a where a.id = p_authorization_id for update;
  if v_old.id is null or not ogevia.is_active_member(v_old.organization_id) then
    raise exception 'Authorization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v_old.organization_id, 'authorizations.update') then
    raise exception 'You do not have permission to amend authorizations for this organization'
      using errcode = 'OGA03';
  end if;
  perform ogevia.lock_authorization_lineage(v_old.lineage_id);

  v_prior := ogevia.idempotency_begin('amend_authorization', p_idempotency_key, v_old.organization_id, v_fingerprint);
  if v_prior is not null then
    return query select (v_prior ->> 'new_authorization_id')::uuid, (v_prior ->> 'new_version_number')::integer,
      null::uuid, null::ogevia.service_visit_status, null::date, null::integer, null::integer, null::text;
    return;
  end if;

  if not v_old.is_current then
    raise exception 'This authorization has already been superseded by a later amendment' using errcode = 'OGC09';
  end if;
  if v_old.deleted_at is not null then
    raise exception 'This authorization has been removed' using errcode = 'OGC09';
  end if;

  v_moved_up := p_monthly_authorized_minutes > v_old.monthly_authorized_minutes;
  v_new_id := gen_random_uuid();

  -- Retire the old version first so the exclusion constraint admits the new one.
  update ogevia.client_authorizations a set is_current = false, updated_at = now() where a.id = v_old.id;
  insert into ogevia.client_authorizations (
    id, organization_id, client_id, service_id, lineage_id, version_number, is_current, supersedes_id,
    payer, authorization_number, monthly_authorized_minutes, period_start, period_end, hourly_rate_cents,
    received_date, source_reference, change_reason, created_by
  ) values (
    v_new_id, v_old.organization_id, v_old.client_id, v_old.service_id, v_old.lineage_id,
    v_old.version_number + 1, true, v_old.id, p_payer, p_authorization_number,
    p_monthly_authorized_minutes, p_period_start, p_period_end, v_old.hourly_rate_cents,
    p_received_date, p_source_reference, btrim(p_reason), v_actor
  );
  update ogevia.client_authorizations a set superseded_by_id = v_new_id, updated_at = now() where a.id = v_old.id;

  perform ogevia.write_audit(v_old.organization_id, 'client_authorization.amended', 'client_authorizations',
    v_new_id,
    jsonb_build_object('authorization_id', v_old.id, 'version', v_old.version_number,
                       'monthly_authorized_minutes', v_old.monthly_authorized_minutes,
                       'period_start', v_old.period_start, 'period_end', v_old.period_end),
    jsonb_build_object('authorization_id', v_new_id, 'version', v_old.version_number + 1,
                       'monthly_authorized_minutes', p_monthly_authorized_minutes,
                       'period_start', p_period_start, 'period_end', p_period_end),
    btrim(p_reason));
  perform ogevia.idempotency_finish('amend_authorization', p_idempotency_key, v_old.organization_id,
    v_fingerprint, jsonb_build_object('new_authorization_id', v_new_id,
                                      'new_version_number', v_old.version_number + 1));

  -- Impact report (current main semantics): visits on any version of this
  -- lineage that a review may now need to revisit. Nothing is auto-rebilled.
  return query
  select v_new_id, v_old.version_number + 1, v.id, v.status, v.service_date, v.worked_minutes,
         v.billable_minutes,
         case
           when v_moved_up and v.authorization_status in ('exceeds_authorization', 'limit_reached')
             then 'increase_may_allow_more'
           when not v_moved_up and v.status in ('signed', 'administrator_review')
             then 'decrease_now_exceeds'
         end
  from ogevia.service_visits v
  join ogevia.client_authorizations a on a.id = v.service_authorization_id
  where a.lineage_id = v_old.lineage_id
    and v.status not in ('voided', 'corrected')
    and ((v_moved_up and v.authorization_status in ('exceeds_authorization', 'limit_reached'))
         or (not v_moved_up and v.status in ('signed', 'administrator_review')))
  union all
  select v_new_id, v_old.version_number + 1, null, null, null, null, null, null
  where not exists (
    select 1 from ogevia.service_visits v
    join ogevia.client_authorizations a on a.id = v.service_authorization_id
    where a.lineage_id = v_old.lineage_id and v.status not in ('voided', 'corrected')
      and ((v_moved_up and v.authorization_status in ('exceeds_authorization', 'limit_reached'))
           or (not v_moved_up and v.status in ('signed', 'administrator_review')))
  );
end;
$$;
