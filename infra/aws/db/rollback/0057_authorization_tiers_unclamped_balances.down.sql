-- ROLLBACK 0057 | CLASS: SAFE AUTOMATED (no tables or records removed). Restores list_monthly_service_summary (0049), get_utilisation_overview (0020),
-- create_shift and reschedule_shift (0042) and confirm_service_visit (0050) to their previous definitions and removes the two helper functions.
-- Confirmations already recorded keep the real (possibly negative) balance in their snapshot: those rows are never rewritten.
drop function ogevia_api.get_utilisation_overview(uuid, date);
drop function ogevia_api.list_monthly_service_summary(uuid, date, uuid);

create function ogevia_api.list_monthly_service_summary(
  p_organization_id uuid,
  p_month_start date,
  p_client_id uuid default null
)
returns table (
  client_id uuid,
  client_code text,
  service_id uuid,
  service_code text,
  service_name text,
  authorization_lineage_id uuid,
  authorization_period_start date,
  authorization_period_end date,
  authorized_minutes integer,
  worked_minutes integer,
  verified_minutes integer,
  billable_minutes integer,
  remaining_minutes integer,
  review_minutes integer,
  visit_count integer,
  reserved_minutes integer
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with bounds as (
    select
      date_trunc('month', p_month_start::timestamp)::date as month_start,
      (date_trunc('month', p_month_start::timestamp) + interval '1 month')::date as month_end
  ),
  ranked_authorizations as (
    select
      a.*,
      row_number() over (
        partition by a.lineage_id
        order by a.version_number desc
      ) as version_rank
    from ogevia.client_authorizations a
    cross join bounds b
    where a.organization_id = p_organization_id
      and (p_client_id is null or a.client_id = p_client_id)
      and a.deleted_at is null
      and a.period_start < b.month_end
      and a.period_end >= b.month_start
  ),
  authorizations as (
    select *
    from ranked_authorizations
    where version_rank = 1
  ),
  usage as (
    select
      va.lineage_id,
      coalesce(sum(v.worked_minutes), 0)::integer as worked_minutes,
      coalesce(sum(v.verified_minutes), 0)::integer as verified_minutes,
      coalesce(sum(v.billable_minutes + (select coalesce(sum(d.accepted_minutes), 0) from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null and d.decision = 'accept_late_confirmation')), 0)::integer as billable_minutes,
      coalesce(sum(v.worked_minutes) filter (where v.status = 'administrator_review'), 0)::integer as review_minutes,
      count(*)::integer as visit_count
    from ogevia.service_visits v
    join ogevia.client_authorizations va on va.id = v.service_authorization_id
    cross join bounds b
    where v.organization_id = p_organization_id
      and (p_client_id is null or v.client_id = p_client_id)
      and v.service_date >= b.month_start
      and v.service_date < b.month_end
      and v.status in ('signed', 'administrator_review')
    group by va.lineage_id
  ),
  -- Time held by assigned Care Request shifts that no signed visit has
  -- consumed yet (released when the linked visit is signed, 0013). The
  -- assignment cap counts it, so "remaining" must too.
  -- Approved billing rounding adjustments (0029) consume (or return) authorized time.
  adjusted as (
    select r.authorization_lineage_id as lineage_id, coalesce(sum(r.adjustment_minutes), 0)::integer as adjustment_minutes
    from ogevia.billing_rounding_adjustments r
    cross join bounds b
    where r.organization_id = p_organization_id and r.voided_at is null
      and r.service_date >= b.month_start and r.service_date < b.month_end
    group by r.authorization_lineage_id
  ),
  reserved as (
    select r.authorization_lineage_id as lineage_id, coalesce(sum(r.reserved_minutes), 0)::integer as reserved_minutes
    from ogevia.authorization_reservations r
    cross join bounds b
    where r.organization_id = p_organization_id
      and r.released_at is null
      and r.service_date >= b.month_start
      and r.service_date < b.month_end
      and not ogevia.reservation_counted_as_used(r.shift_id)
    group by r.authorization_lineage_id
  )
  select
    c.id,
    coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code),
    sv.id,
    sv.code,
    sv.name,
    a.lineage_id,
    a.period_start,
    a.period_end,
    a.monthly_authorized_minutes,
    coalesce(u.worked_minutes, 0),
    coalesce(u.verified_minutes, 0),
    coalesce(u.billable_minutes, 0),
    greatest(a.monthly_authorized_minutes - coalesce(u.billable_minutes, 0) - coalesce(ad.adjustment_minutes, 0) - coalesce(rs.reserved_minutes, 0), 0),
    coalesce(u.review_minutes, 0),
    coalesce(u.visit_count, 0),
    coalesce(rs.reserved_minutes, 0)
  from authorizations a
  join ogevia.clients c
    on c.id = a.client_id
   and c.organization_id = a.organization_id
  join ogevia.services sv
    on sv.id = a.service_id
   and sv.organization_id = a.organization_id
  left join usage u on u.lineage_id = a.lineage_id
  left join reserved rs on rs.lineage_id = a.lineage_id
  left join adjusted ad on ad.lineage_id = a.lineage_id
  where ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and ogevia.has_permission(p_organization_id, 'visits.read')
  order by sv.name, sv.code, a.period_start;
$$;

create function ogevia_api.get_utilisation_overview(p_organization_id uuid, p_month_start date)
returns table (
  service_id uuid,
  service_code text,
  service_name text,
  client_count integer,
  authorized_minutes integer,
  scheduled_minutes integer,
  worked_minutes integer,
  billable_minutes integer,
  review_minutes integer,
  approved_minutes integer,
  remaining_minutes integer,
  lineages_without_rate integer,
  billable_value_cents bigint,
  approved_value_cents bigint,
  unused_value_cents bigint
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with ctx as (
    select ogevia.require_actor() as actor,
           ogevia.is_active_member(p_organization_id)
             and ogevia.has_permission(p_organization_id, 'visits.read') as can_read,
           ogevia.has_permission(p_organization_id, 'billing.read') as can_see_money,
           date_trunc('month', p_month_start::timestamp)::date as m0,
           (date_trunc('month', p_month_start::timestamp) + interval '1 month')::date as m1
  ),
  -- One row per client/service/lineage; the latest version only (0010).
  summary as (
    select s.* from ctx, ogevia_api.list_monthly_service_summary(p_organization_id, ctx.m0, null) s
    where ctx.can_read
  ),
  lineage_rate as (
    select distinct on (a.lineage_id) a.lineage_id, a.hourly_rate_cents
    from ogevia.client_authorizations a
    join summary su on su.authorization_lineage_id = a.lineage_id
    order by a.lineage_id, a.version_number desc
  ),
  visit_values as (
    select va.lineage_id,
           sum(v.billable_minutes::numeric / 60 * va.hourly_rate_cents) filter (where va.hourly_rate_cents is not null) as billable_value,
           coalesce(sum(b.approved_minutes), 0)::integer as approved_minutes,
           sum(b.amount_cents) as approved_value
    from ctx
    join ogevia.service_visits v on v.organization_id = p_organization_id
     and v.service_date >= ctx.m0 and v.service_date < ctx.m1
     and v.status in ('signed', 'administrator_review')
    join ogevia.client_authorizations va on va.id = v.service_authorization_id
    left join ogevia.billing_approvals b on b.visit_id = v.id and b.voided_at is null
    where ctx.can_read
    group by va.lineage_id
  ),
  scheduled as (
    select sh.service_id, sum(extract(epoch from (sh.ends_at - sh.starts_at)) / 60)::integer as minutes
    from ctx
    join ogevia.shifts sh on sh.organization_id = p_organization_id
     and sh.status = 'scheduled' and sh.starts_at >= now()
     and sh.starts_at >= ctx.m0::timestamp and sh.starts_at < ctx.m1::timestamp
    where ctx.can_read
      and not ogevia.shift_is_called_out(sh.id)
      and not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = sh.id and v.status not in ('voided', 'corrected'))
    group by sh.service_id
  ),
  per_service as (
    select su.service_id, su.service_code, su.service_name,
           count(distinct su.client_id)::integer as client_count,
           sum(su.authorized_minutes)::integer as authorized_minutes,
           sum(su.worked_minutes)::integer as worked_minutes,
           sum(su.billable_minutes)::integer as billable_minutes,
           sum(su.review_minutes)::integer as review_minutes,
           coalesce(sum(vv.approved_minutes), 0)::integer as approved_minutes,
           sum(su.remaining_minutes)::integer as remaining_minutes,
           count(*) filter (where lr.hourly_rate_cents is null)::integer as lineages_without_rate,
           round(sum(vv.billable_value))::bigint as billable_value,
           sum(vv.approved_value)::bigint as approved_value,
           round(sum(su.remaining_minutes::numeric / 60 * lr.hourly_rate_cents) filter (where lr.hourly_rate_cents is not null))::bigint as unused_value
    from summary su
    left join lineage_rate lr on lr.lineage_id = su.authorization_lineage_id
    left join visit_values vv on vv.lineage_id = su.authorization_lineage_id
    group by su.service_id, su.service_code, su.service_name
  )
  select ps.service_id, ps.service_code, ps.service_name, ps.client_count, ps.authorized_minutes,
         coalesce(sc.minutes, 0), ps.worked_minutes, ps.billable_minutes, ps.review_minutes,
         ps.approved_minutes, ps.remaining_minutes, ps.lineages_without_rate,
         case when ctx.can_see_money then ps.billable_value end,
         case when ctx.can_see_money then ps.approved_value end,
         case when ctx.can_see_money then ps.unused_value end
  from ctx
  join per_service ps on true
  left join scheduled sc on sc.service_id = ps.service_id
  where ctx.actor is not null and ctx.can_read
  order by ps.service_name, ps.service_code;
$$;

create or replace function ogevia_api.create_shift(
  p_organization_id uuid, p_client_id uuid, p_service_id uuid, p_local_date date, p_start time, p_end time,
  p_caregiver_record_id uuid default null, p_idempotency_key uuid default null
)
returns table (shift_id uuid, starts_at timestamptz, ends_at timestamptz, reserved_minutes integer, remaining_minutes bigint)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_fp text := concat_ws('|', p_organization_id, p_client_id, p_service_id, p_local_date, p_start, p_end, p_caregiver_record_id);
  v_prior jsonb;
  v_tz text;
  v_starts timestamptz;
  v_ends timestamptz;
  v_minutes integer;
  v_auth ogevia.client_authorizations%rowtype;
  v_used bigint;
  v_reserved bigint;
  v_rec ogevia.caregiver_records%rowtype;
  v_id uuid := gen_random_uuid();
begin
  v_prior := ogevia.idempotency_begin('create_shift', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'shift_id')::uuid, (v_prior ->> 'starts_at')::timestamptz, (v_prior ->> 'ends_at')::timestamptz,
                        (v_prior ->> 'reserved_minutes')::integer, (v_prior ->> 'remaining_minutes')::bigint;
    return;
  end if;
  if p_local_date is null or p_start is null or p_end is null then
    raise exception 'Enter the date, start time and end time' using errcode = 'OGV22';
  end if;
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  perform ogevia.require_clear_local_times(v_tz, p_local_date, p_start, p_end);
  v_starts := (p_local_date + p_start) at time zone v_tz;
  v_ends := (case when p_end <= p_start then p_local_date + 1 else p_local_date end + p_end) at time zone v_tz;
  v_minutes := floor(extract(epoch from (v_ends - v_starts)) / 60)::integer;
  if v_minutes < 15 or v_minutes > 1440 then
    raise exception 'A shift must be between 15 minutes and 24 hours' using errcode = 'OGV22';
  end if;
  if v_ends <= now() then
    raise exception 'This shift is already over; record past service as a visit instead' using errcode = 'OGV22';
  end if;
  if not exists (select 1 from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id
                 and c.deleted_at is null and c.status = 'active') then
    raise exception 'The client must be active in this agency' using errcode = 'OGV22';
  end if;
  if not exists (select 1 from ogevia.services s where s.id = p_service_id and s.organization_id = p_organization_id
                 and s.deleted_at is null and s.is_active) then
    raise exception 'The service must be active in this agency' using errcode = 'OGV22';
  end if;

  select * into v_auth from ogevia.client_authorizations a
  where a.organization_id = p_organization_id and a.client_id = p_client_id and a.service_id = p_service_id
    and a.is_current and a.deleted_at is null and p_local_date between a.period_start and a.period_end;
  if v_auth.id is null then
    raise exception 'No current authorization covers this client and service on that date' using errcode = 'OGV22';
  end if;
  perform ogevia.lock_authorization_lineage(v_auth.lineage_id);
  v_used := ogevia.authorization_month_usage(v_auth.lineage_id, p_local_date, null);
  v_reserved := ogevia.authorization_month_reserved(v_auth.lineage_id, p_local_date);
  if v_used + v_reserved + v_minutes > v_auth.monthly_authorized_minutes then
    -- 0032: hours and minutes, with what the shift needs (was "179 minutes left").
    raise exception 'Not enough authorized time remains this month for this shift: % available, this shift needs %',
      ogevia.format_duration(greatest(v_auth.monthly_authorized_minutes - v_used - v_reserved, 0)::integer),
      ogevia.format_duration(v_minutes::integer) using errcode = 'OGC09';
  end if;

  if p_caregiver_record_id is not null then
    v_rec := ogevia.check_shift_caregiver(p_organization_id, p_caregiver_record_id, v_starts, v_ends, null, p_service_id);
  end if;

  insert into ogevia.shifts (id, organization_id, client_id, service_id, caregiver_user_id, caregiver_record_id,
                             starts_at, ends_at, status, authorization_lineage_id, created_by)
  values (v_id, p_organization_id, p_client_id, p_service_id, v_rec.linked_user_id, v_rec.id,
          v_starts, v_ends, 'scheduled', v_auth.lineage_id, v_actor);
  insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
  values (p_organization_id, v_auth.lineage_id, null, v_id, p_local_date, v_minutes);
  perform ogevia.write_audit(p_organization_id, 'shift.created', 'shifts', v_id, null,
    jsonb_build_object('client_id', p_client_id, 'service_id', p_service_id, 'starts_at', v_starts, 'ends_at', v_ends,
                       'caregiver_record_id', v_rec.id, 'reserved_minutes', v_minutes, 'authorization_lineage_id', v_auth.lineage_id), null);
  perform ogevia.idempotency_finish('create_shift', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('shift_id', v_id, 'starts_at', v_starts, 'ends_at', v_ends, 'reserved_minutes', v_minutes,
                       'remaining_minutes', v_auth.monthly_authorized_minutes - v_used - v_reserved - v_minutes));
  return query select v_id, v_starts, v_ends, v_minutes, (v_auth.monthly_authorized_minutes - v_used - v_reserved - v_minutes)::bigint;
end;
$$;

create or replace function ogevia_api.reschedule_shift(
  p_organization_id uuid, p_shift_id uuid, p_local_date date, p_start time, p_end time, p_reason text, p_idempotency_key uuid default null
)
returns table (shift_id uuid, starts_at timestamptz, ends_at timestamptz, reserved_minutes integer, remaining_minutes bigint)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_shift_id, p_local_date, p_start, p_end);
  v_prior jsonb;
  v_s ogevia.shifts%rowtype;
  v_tz text;
  v_starts timestamptz;
  v_ends timestamptz;
  v_minutes integer;
  v_auth ogevia.client_authorizations%rowtype;
  v_res ogevia.authorization_reservations%rowtype;
  v_used bigint;
  v_reserved bigint;
begin
  v_prior := ogevia.idempotency_begin('reschedule_shift', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'shift_id')::uuid, (v_prior ->> 'starts_at')::timestamptz, (v_prior ->> 'ends_at')::timestamptz,
      (v_prior ->> 'reserved_minutes')::integer, (v_prior ->> 'remaining_minutes')::bigint;
    return;
  end if;
  if length(v_reason) not between 3 and 500 then raise exception 'Give the reason for the change' using errcode = 'OGV22'; end if;
  if p_local_date is null or p_start is null or p_end is null then
    raise exception 'Enter the date, start time and end time' using errcode = 'OGV22';
  end if;
  v_s := ogevia.lock_staff_shift(p_organization_id, p_shift_id);
  if v_s.starts_at <= now() then raise exception 'This shift has started; record the visit instead' using errcode = 'OGC09'; end if;
  if exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = v_s.id and v.status not in ('voided', 'corrected')) then
    raise exception 'A visit is linked to this shift; it cannot be moved' using errcode = 'OGC09';
  end if;
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  perform ogevia.require_clear_local_times(v_tz, p_local_date, p_start, p_end);
  v_starts := (p_local_date + p_start) at time zone v_tz;
  v_ends := (case when p_end <= p_start then p_local_date + 1 else p_local_date end + p_end) at time zone v_tz;
  v_minutes := floor(extract(epoch from (v_ends - v_starts)) / 60)::integer;
  if v_minutes < 15 or v_minutes > 1440 then
    raise exception 'A shift must be between 15 minutes and 24 hours' using errcode = 'OGV22';
  end if;
  if v_starts <= now() then raise exception 'The new time is in the past' using errcode = 'OGV22'; end if;
  select * into v_auth from ogevia.client_authorizations a
  where a.organization_id = p_organization_id and a.client_id = v_s.client_id and a.service_id = v_s.service_id
    and a.is_current and a.deleted_at is null and p_local_date between a.period_start and a.period_end;
  if v_auth.id is null then
    raise exception 'No current authorization covers this client and service on that date' using errcode = 'OGV22';
  end if;
  select * into v_res from ogevia.authorization_reservations r where r.shift_id = v_s.id and r.released_at is null for update;
  -- Lock both lineages in a fixed order.
  perform ogevia.lock_authorization_lineage(l) from (
    select distinct x as l from unnest(array[v_auth.lineage_id, v_res.authorization_lineage_id]) x where x is not null order by 1) q;
  v_used := ogevia.authorization_month_usage(v_auth.lineage_id, p_local_date, null);
  v_reserved := ogevia.authorization_month_reserved(v_auth.lineage_id, p_local_date)
    - case when v_res.id is not null and v_res.authorization_lineage_id = v_auth.lineage_id
                and date_trunc('month', v_res.service_date) = date_trunc('month', p_local_date)
           then v_res.reserved_minutes else 0 end;
  if v_used + v_reserved + v_minutes > v_auth.monthly_authorized_minutes then
    raise exception 'Not enough authorized time remains this month for this shift: % available, this shift needs %',
      ogevia.format_duration(greatest(v_auth.monthly_authorized_minutes - v_used - v_reserved, 0)::integer),
      ogevia.format_duration(v_minutes) using errcode = 'OGC09';
  end if;
  if v_s.caregiver_record_id is not null then
    perform ogevia.check_shift_caregiver(p_organization_id, v_s.caregiver_record_id, v_starts, v_ends, v_s.id, v_s.service_id);
  end if;
  update ogevia.shifts set starts_at = v_starts, ends_at = v_ends, authorization_lineage_id = v_auth.lineage_id, updated_at = now()
   where id = v_s.id;
  if v_res.id is not null then
    update ogevia.authorization_reservations set authorization_lineage_id = v_auth.lineage_id, service_date = p_local_date,
           reserved_minutes = v_minutes where id = v_res.id;
  else
    insert into ogevia.authorization_reservations (organization_id, authorization_lineage_id, care_request_id, shift_id, service_date, reserved_minutes)
    values (p_organization_id, v_auth.lineage_id, null, v_s.id, p_local_date, v_minutes);
  end if;
  perform ogevia.write_audit(p_organization_id, 'shift.rescheduled', 'shifts', v_s.id,
    jsonb_build_object('starts_at', v_s.starts_at, 'ends_at', v_s.ends_at, 'reserved_minutes', v_res.reserved_minutes,
      'service_date', v_res.service_date, 'series_id', v_s.series_id),
    jsonb_build_object('starts_at', v_starts, 'ends_at', v_ends, 'reserved_minutes', v_minutes, 'service_date', p_local_date), v_reason);
  perform ogevia.idempotency_finish('reschedule_shift', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('shift_id', v_s.id, 'starts_at', v_starts, 'ends_at', v_ends, 'reserved_minutes', v_minutes,
      'remaining_minutes', v_auth.monthly_authorized_minutes - v_used - v_reserved - v_minutes));
  return query select v_s.id, v_starts, v_ends, v_minutes, (v_auth.monthly_authorized_minutes - v_used - v_reserved - v_minutes)::bigint;
end;
$$;

create or replace function ogevia_api.confirm_service_visit(
  p_visit_id uuid,
  p_signer_role ogevia.visit_signer_role,
  p_confirmation_method text,
  p_evidence_id uuid default null,
  p_typed_signer_name text default null,
  p_signer_relationship text default null,
  p_confirmation_reason text default null,
  p_idempotency_key uuid default null,
  p_attestation_version text default null
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
  v_attest text := nullif(btrim(coalesce(p_attestation_version, '')), '');
  v_unsched boolean;
  v_shift ogevia.shifts%rowtype;
  v_rule record;
  v_sched_minutes integer;
  v_variance boolean := false;
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

  -- 0050 (D-U): a visit with no scheduled shift is provisional and goes to review, whoever the caregiver is.
  -- 0050 (D-S): a scheduled visit whose length differs from the shift by more than the agency's rule (versioned,
  -- effective-dated; a conservative system default applies when the agency has set none) goes to review.
  -- Billable minutes are kept in both cases (capped by the authorization as before); approval waits for a review decision.
  v_unsched := v_visit.scheduled_shift_id is null;
  select * into v_rule from ogevia.effective_visit_variance_rule(v_visit.organization_id, v_visit.service_date);
  if not v_unsched then
    select * into v_shift from ogevia.shifts sh where sh.id = v_visit.scheduled_shift_id;
    v_sched_minutes := floor(extract(epoch from (v_shift.ends_at - v_shift.starts_at)) / 60)::integer;
    v_variance := abs(v_visit.worked_minutes - v_sched_minutes) > v_rule.minutes;
  end if;

  if v_confirmed then
    v_allowed := v_potential;
    v_status := case when v_potential < v_visit.worked_minutes or v_unsched or v_variance
                     then 'administrator_review' else 'signed' end;
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
    confirmed_visit_snapshot, confirmation_version, confirmed_by, request_id, attestation_version
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
    4, v_actor, ogevia.current_request_id(), v_attest
  );

  insert into ogevia.visit_rule_evaluations (
    organization_id, visit_id, rule_key, rule_version, rule_minutes, rule_source, scheduled_minutes, worked_minutes, outcome
  ) values (
    v_visit.organization_id, v_visit.id, 'schedule_variance_minutes', v_rule.version, v_rule.minutes, v_rule.source,
    v_sched_minutes, v_visit.worked_minutes,
    case when v_unsched then 'not_applicable' when v_variance then 'over' else 'within' end
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
                       'billable_minutes', v_allowed, 'worked_minutes', v_visit.worked_minutes,
                       'unscheduled', v_unsched, 'schedule_variance', v_variance,
                       'rule_version', v_rule.version, 'attestation_version', v_attest));

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

revoke all on function ogevia_api.list_monthly_service_summary(uuid, date, uuid) from public;
revoke all on function ogevia_api.get_utilisation_overview(uuid, date) from public;
grant execute on function ogevia_api.list_monthly_service_summary(uuid, date, uuid) to ogevia_app;
grant execute on function ogevia_api.get_utilisation_overview(uuid, date) to ogevia_app;
drop function ogevia.authorization_shortfall_message(bigint, bigint);
drop function ogevia.authorization_tier(bigint, bigint);
