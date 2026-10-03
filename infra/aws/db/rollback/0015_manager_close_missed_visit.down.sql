-- ROLLBACK 0015_manager_close_missed_visit | CLASS: BACKUP REQUIRED
-- Restores the previous read functions, drops the close-out function and the
-- two columns. Dropping time_out_entered_by / time_out_reason discards who
-- entered a manager Time Out and why: take a backup first if any visit was
-- closed this way. The visits' times and statuses themselves are kept.
drop function if exists ogevia_api.close_missed_service_visit(uuid, timestamptz, text, uuid);
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
  scheduled_ends_at timestamptz
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
    v.scheduled_shift_id, sh.starts_at, sh.ends_at
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

alter table ogevia.service_visits
  drop column if exists time_out_entered_by,
  drop column if exists time_out_reason;
