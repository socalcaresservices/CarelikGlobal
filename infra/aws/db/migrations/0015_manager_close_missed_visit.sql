-- 0015 Manager close-out for a missed clock-out.
--
-- A visit left open (Time In, no Time Out) could only be ended by its
-- caregiver, and after 24 hours not even by them, with no manager path. The
-- Report Center lists these as "Missing Time Out"; this adds the action.
--
-- ogevia_api.close_missed_service_visit(visit, actual Time Out, reason, key):
--   * visits.manage only; the visit must be open (draft, no Time Out);
--   * the Time Out is after Time In, not in the future, at most 24 hours
--     after Time In, and must not overlap another visit of the caregiver;
--   * the visit moves to awaiting_signature exactly like a normal Time Out,
--     so the caregiver's app reopens it at client confirmation and the
--     existing confirm_service_visit decides verified/billable minutes. A
--     manager never supplies the client confirmation;
--   * caregiver_attested_at stays empty; time_out_entered_by /
--     time_out_reason record who entered it and why; an audit event records
--     it; a linked scheduled shift is completed; idempotent with a key.
-- get_active_service_visit and list_service_visits also return
-- time_out_entered_by_manager (dropped, recreated and re-granted).

alter table ogevia.service_visits
  add column time_out_entered_by uuid references ogevia.app_users(id),
  add column time_out_reason text;

create function ogevia_api.close_missed_service_visit(
  p_visit_id uuid,
  p_time_out timestamptz,
  p_reason text,
  p_idempotency_key uuid default null
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
  v_fingerprint text := concat_ws('|', p_visit_id, p_time_out, btrim(coalesce(p_reason, '')));
  v_prior jsonb;
  v_minutes integer;
begin
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required to close a missed visit' using errcode = 'OGV22';
  end if;
  if p_time_out is null or p_time_out > now() then
    raise exception 'The Time Out cannot be in the future' using errcode = 'OGV22';
  end if;

  select * into v_visit from ogevia.service_visits sv where sv.id = p_visit_id for update;
  if v_visit.id is null or not ogevia.is_active_member(v_visit.organization_id) then
    raise exception 'Visit not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v_visit.organization_id, 'visits.manage') then
    raise exception 'Only a visit manager can close a missed visit' using errcode = 'OGA03';
  end if;

  v_prior := ogevia.idempotency_begin('close_missed_visit', p_idempotency_key, v_visit.organization_id, v_fingerprint);
  if v_prior is not null then
    return query select (v_prior ->> 'visit_id')::uuid, (v_prior ->> 'worked_minutes')::integer,
      (v_prior ->> 'time_in')::timestamptz, (v_prior ->> 'time_out')::timestamptz;
    return;
  end if;

  if v_visit.status <> 'draft' or v_visit.time_out is not null then
    raise exception 'Only an open visit (no Time Out) can be closed this way' using errcode = 'OGC09';
  end if;
  v_minutes := floor(extract(epoch from (p_time_out - v_visit.time_in)) / 60)::integer;
  if v_minutes < 1 then
    raise exception 'The Time Out must be after the Time In' using errcode = 'OGV22';
  end if;
  if v_minutes > 1440 then
    raise exception 'A visit cannot be longer than 24 hours' using errcode = 'OGV22';
  end if;
  if exists (
    select 1 from ogevia.service_visits o
    where o.organization_id = v_visit.organization_id
      and o.id <> v_visit.id
      and o.status not in ('voided', 'corrected')
      and (
        (v_visit.caregiver_record_id is not null and o.caregiver_record_id = v_visit.caregiver_record_id)
        or (v_visit.caregiver_user_id is not null and o.caregiver_user_id = v_visit.caregiver_user_id)
      )
      and o.time_in < p_time_out
      and coalesce(o.time_out, now()) > v_visit.time_in
  ) then
    raise exception 'The Time Out overlaps another visit for this caregiver' using errcode = 'OGC09';
  end if;

  update ogevia.service_visits sv
  set time_out = p_time_out,
      worked_minutes = v_minutes,
      status = 'awaiting_signature',
      time_out_entered_by = v_actor,
      time_out_reason = btrim(p_reason)
  where sv.id = v_visit.id;

  if v_visit.scheduled_shift_id is not null then
    update ogevia.shifts sh
    set status = 'completed', updated_at = now()
    where sh.id = v_visit.scheduled_shift_id
      and sh.organization_id = v_visit.organization_id
      and sh.status = 'scheduled';
  end if;

  perform ogevia.write_audit(v_visit.organization_id, 'service_visit.closed_by_manager', 'service_visits', v_visit.id,
    jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'awaiting_signature', 'time_out', p_time_out, 'worked_minutes', v_minutes,
                       'time_out_entered_by', v_actor, 'scheduled_shift_id', v_visit.scheduled_shift_id),
    btrim(p_reason));
  perform ogevia.idempotency_finish('close_missed_visit', p_idempotency_key, v_visit.organization_id, v_fingerprint,
    jsonb_build_object('visit_id', v_visit.id, 'worked_minutes', v_minutes, 'time_in', v_visit.time_in, 'time_out', p_time_out));
  return query select v_visit.id, v_minutes, v_visit.time_in, p_time_out;
end;
$$;
revoke all on function ogevia_api.close_missed_service_visit(uuid, timestamptz, text, uuid) from public;
grant execute on function ogevia_api.close_missed_service_visit(uuid, timestamptz, text, uuid) to ogevia_app;

-- Return types change: drop, recreate, re-grant.
drop function if exists ogevia_api.get_active_service_visit(uuid);
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
  confirmed_minutes_this_month bigint,
  time_out_entered_by_manager boolean
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
    ogevia.authorization_month_usage(bound.lineage_id, v.service_date, v.id),
    v.time_out_entered_by is not null
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
revoke all on function ogevia_api.get_active_service_visit(uuid) from public;
grant execute on function ogevia_api.get_active_service_visit(uuid) to ogevia_app;

drop function if exists ogevia_api.list_service_visits(uuid, uuid, uuid, uuid, date, date, ogevia.service_visit_status);
create function ogevia_api.list_service_visits(
  p_organization_id uuid,
  p_client_id uuid default null,
  p_caregiver_user_id uuid default null,
  p_service_id uuid default null,
  p_date_from date default null,
  p_date_to date default null,
  p_status ogevia.service_visit_status default null
)
returns table (
  id uuid,
  visit_number text,
  client_id uuid,
  client_code text,
  caregiver_user_id uuid,
  caregiver_name text,
  service_id uuid,
  service_name text,
  service_date date,
  time_in timestamptz,
  time_out timestamptz,
  worked_minutes integer,
  verified_minutes integer,
  billable_minutes integer,
  status ogevia.service_visit_status,
  authorization_status ogevia.visit_authorization_status,
  signed_at timestamptz,
  original_visit_id uuid,
  is_corrected boolean,
  month_to_date_before_minutes bigint,
  month_to_date_after_minutes bigint,
  remaining_minutes bigint,
  scheduled_shift_id uuid,
  scheduled_starts_at timestamptz,
  scheduled_ends_at timestamptz,
  time_out_entered_by_manager boolean
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select
    v.id, v.visit_number_snapshot, v.client_id, v.client_code_snapshot, v.caregiver_user_id,
    v.caregiver_name_snapshot, v.service_id, sv.name, v.service_date, v.time_in, v.time_out,
    v.worked_minutes, v.verified_minutes, v.billable_minutes, v.status, v.authorization_status,
    v.signed_at, v.original_visit_id,
    (v.status = 'corrected' or v.original_visit_id is not null),
    (vc.confirmed_visit_snapshot ->> 'monthToDateBeforeMinutes')::bigint,
    (vc.confirmed_visit_snapshot ->> 'monthToDateAfterMinutes')::bigint,
    (vc.confirmed_visit_snapshot ->> 'remainingMinutes')::bigint,
    v.scheduled_shift_id, sh.starts_at, sh.ends_at, v.time_out_entered_by is not null
  from ogevia.service_visits v
  join ogevia.services sv on sv.id = v.service_id
  left join ogevia.visit_confirmations vc on vc.visit_id = v.id
  left join ogevia.shifts sh on sh.id = v.scheduled_shift_id
  where ogevia.require_actor() is not null
    and v.organization_id = p_organization_id
    and ogevia.is_active_member(p_organization_id)
    and (ogevia.has_permission(p_organization_id, 'visits.read')
         or v.caregiver_user_id = ogevia.current_user_id())
    and (p_client_id is null or v.client_id = p_client_id)
    and (p_caregiver_user_id is null or v.caregiver_user_id = p_caregiver_user_id)
    and (p_service_id is null or v.service_id = p_service_id)
    and (p_date_from is null or v.service_date >= p_date_from)
    and (p_date_to is null or v.service_date <= p_date_to)
    and (p_status is null or v.status = p_status)
  order by v.service_date desc, v.time_in desc;
$$;
revoke all on function ogevia_api.list_service_visits(uuid, uuid, uuid, uuid, date, date, ogevia.service_visit_status) from public;
grant execute on function ogevia_api.list_service_visits(uuid, uuid, uuid, uuid, date, date, ogevia.service_visit_status) to ogevia_app;
