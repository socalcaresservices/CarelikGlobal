begin;

-- Manager close-out for a missed clock-out.
--
-- A visit left open (Time In, no Time Out) could not be finished by anyone
-- but its caregiver, and after 24 hours not even by them
-- (end_service_visit: "contact a manager to resolve it") - but no manager
-- path existed. The Report Center now lists these as "Missing Time Out"
-- (Exceptions); this adds the action that resolves them.
--
-- close_missed_service_visit(visit, actual Time Out, reason):
--   * visits.manage only; the visit must be open (draft, no Time Out);
--   * the Time Out is after Time In, not in the future, at most 24 hours
--     after Time In, and must not overlap another visit of the caregiver;
--   * the visit moves to awaiting_signature exactly like a normal Time Out,
--     so the caregiver's app reopens it at the client-confirmation step and
--     the existing confirm_service_visit decides verified/billable minutes.
--     A manager never supplies the client confirmation;
--   * caregiver_attested_at stays empty (the caregiver did not attest to this
--     end time); time_out_entered_by / time_out_reason record who entered it
--     and why; an audit entry records the change;
--   * a linked scheduled shift is completed, as at a normal Time Out.
-- get_active_service_visit_v3() and list_service_visits() also return
-- time_out_entered_by_manager so the caregiver and the client see that the
-- Time Out was entered by the agency before confirming (return types change,
-- so both are dropped and recreated with their grants).

alter table public.service_visits
  add column if not exists time_out_entered_by uuid,
  add column if not exists time_out_reason text;

create or replace function public.close_missed_service_visit(
  target_visit_id uuid,
  actual_time_out timestamptz,
  reason text
)
returns table (
  visit_id uuid,
  worked_minutes integer,
  time_in timestamptz,
  time_out timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  target_visit public.service_visits%rowtype;
  minutes integer;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;

  select * into target_visit from public.service_visits v where v.id = target_visit_id for update;
  if target_visit.id is null then raise exception 'Visit not found'; end if;
  if not public.organization_is_active(target_visit.organization_id)
     or not public.has_permission(target_visit.organization_id, 'visits.manage') then
    raise exception 'Only a visit manager can close a missed visit';
  end if;
  if target_visit.status <> 'draft' or target_visit.time_out is not null then
    raise exception 'Only an open visit (no Time Out) can be closed this way';
  end if;
  if length(btrim(coalesce(reason, ''))) = 0 then
    raise exception 'A reason is required to close a missed visit';
  end if;
  if actual_time_out is null or actual_time_out > now() then
    raise exception 'The Time Out cannot be in the future';
  end if;

  minutes := floor(extract(epoch from (actual_time_out - target_visit.time_in)) / 60)::integer;
  if minutes < 1 then raise exception 'The Time Out must be after the Time In'; end if;
  if minutes > 1440 then raise exception 'A visit cannot be longer than 24 hours'; end if;

  if exists (
    select 1 from public.service_visits o
    where o.organization_id = target_visit.organization_id
      and o.id <> target_visit.id
      and o.status not in ('voided', 'corrected')
      and (
        (target_visit.caregiver_record_id is not null and o.caregiver_record_id = target_visit.caregiver_record_id)
        or (target_visit.caregiver_user_id is not null and o.caregiver_user_id = target_visit.caregiver_user_id)
      )
      and o.time_in < actual_time_out
      and coalesce(o.time_out, now()) > target_visit.time_in
  ) then
    raise exception 'The Time Out overlaps another visit for this caregiver';
  end if;

  update public.service_visits v
  set time_out = actual_time_out,
      worked_minutes = minutes,
      status = 'awaiting_signature',
      time_out_entered_by = auth.uid(),
      time_out_reason = btrim(reason)
  where v.id = target_visit.id;

  if target_visit.scheduled_shift_id is not null then
    update public.shifts s
    set status = 'completed',
        updated_by = auth.uid()
    where s.id = target_visit.scheduled_shift_id
      and s.organization_id = target_visit.organization_id
      and s.status = 'scheduled';
  end if;

  insert into public.audit_logs (organization_id, actor_user_id, action, entity_type, entity_id, source, reason, metadata)
  values (
    target_visit.organization_id,
    auth.uid(),
    'service_visit.closed_by_manager',
    'service_visits',
    target_visit.id,
    'application',
    btrim(reason),
    jsonb_build_object('time_out', actual_time_out, 'worked_minutes', minutes,
                       'scheduled_shift_id', target_visit.scheduled_shift_id)
  );

  return query select target_visit.id, minutes, target_visit.time_in, actual_time_out;
end;
$$;

revoke all on function public.close_missed_service_visit(uuid, timestamptz, text) from public, anon;
grant execute on function public.close_missed_service_visit(uuid, timestamptz, text) to authenticated;

-- Return types change: drop and recreate with their grants.
drop function if exists public.get_active_service_visit_v3(uuid);

create function public.get_active_service_visit_v3(target_organization_id uuid)
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
  visit_status public.service_visit_status,
  max_monthly_hours numeric,
  confirmed_minutes_this_month bigint,
  time_out_entered_by_manager boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    v.id,
    v.visit_number_snapshot,
    v.client_code_snapshot,
    sv.code,
    sv.name,
    s.starts_at,
    s.ends_at,
    v.time_in,
    v.time_out,
    v.worked_minutes,
    v.status,
    a.max_monthly_hours,
    coalesce((
      select sum(v2.billable_minutes)::bigint
      from public.service_visits v2
      where v2.service_authorization_id = a.id
        and v2.id <> v.id
        and v2.service_date >= date_trunc('month', v.service_date::timestamp)::date
        and v2.service_date < (date_trunc('month', v.service_date::timestamp) + interval '1 month')::date
        and v2.status in ('signed', 'administrator_review')
    ), 0),
    v.time_out_entered_by is not null
  from public.service_visits v
  join public.services sv on sv.id = v.service_id
  join public.client_authorizations a on a.id = v.service_authorization_id
  left join public.shifts s on s.id = v.scheduled_shift_id
  where v.organization_id = target_organization_id
    and v.caregiver_user_id = auth.uid()
    and public.organization_is_active(target_organization_id)
    and public.is_organization_member(target_organization_id)
    and v.status in ('draft', 'awaiting_signature')
  order by v.time_in desc
  limit 1;
$$;

revoke all on function public.get_active_service_visit_v3(uuid) from public, anon;
grant execute on function public.get_active_service_visit_v3(uuid) to authenticated;

drop function if exists public.list_service_visits(uuid, uuid, uuid, uuid, date, date, public.service_visit_status);

create function public.list_service_visits(
  target_organization_id uuid,
  filter_client_id uuid default null,
  filter_caregiver_user_id uuid default null,
  filter_service_id uuid default null,
  filter_date_from date default null,
  filter_date_to date default null,
  filter_status public.service_visit_status default null
)
returns table (
  id uuid,
  visit_number text,
  client_id uuid,
  client_code text,
  client_legal_name text,
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
  status public.service_visit_status,
  authorization_status public.visit_authorization_status,
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
set search_path = public
as $$
  select
    v.id,
    v.visit_number_snapshot,
    v.client_id,
    v.client_code_snapshot,
    case when public.has_permission(target_organization_id, 'visits.read')
      then c.first_name || ' ' || c.last_name
      else null
    end,
    v.caregiver_user_id,
    v.caregiver_name_snapshot,
    v.service_id,
    sv.name,
    v.service_date,
    v.time_in,
    v.time_out,
    v.worked_minutes,
    v.verified_minutes,
    v.billable_minutes,
    v.status,
    v.authorization_status,
    v.signed_at,
    v.original_visit_id,
    (v.status = 'corrected' or v.original_visit_id is not null),
    (vs.signed_visit_snapshot->>'monthToDateBeforeMinutes')::bigint,
    (vs.signed_visit_snapshot->>'monthToDateAfterMinutes')::bigint,
    (vs.signed_visit_snapshot->>'remainingMinutes')::bigint,
    v.scheduled_shift_id,
    sh.starts_at,
    sh.ends_at,
    v.time_out_entered_by is not null
  from public.service_visits v
  join public.services sv on sv.id = v.service_id
  left join public.clients c on c.id = v.client_id
  left join public.visit_signatures vs on vs.visit_id = v.id
  left join public.shifts sh on sh.id = v.scheduled_shift_id
  where v.organization_id = target_organization_id
    and auth.uid() is not null
    and (public.has_permission(target_organization_id, 'visits.read') or v.caregiver_user_id = auth.uid())
    and (filter_client_id is null or v.client_id = filter_client_id)
    and (filter_caregiver_user_id is null or v.caregiver_user_id = filter_caregiver_user_id)
    and (filter_service_id is null or v.service_id = filter_service_id)
    and (filter_date_from is null or v.service_date >= filter_date_from)
    and (filter_date_to is null or v.service_date <= filter_date_to)
    and (filter_status is null or v.status = filter_status)
  order by v.service_date desc, v.time_in desc;
$$;

revoke all on function public.list_service_visits(uuid, uuid, uuid, uuid, date, date, public.service_visit_status) from public, anon;
grant execute on function public.list_service_visits(uuid, uuid, uuid, uuid, date, date, public.service_visit_status) to authenticated;

commit;
