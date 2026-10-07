-- 0013 Link Service Verification visits to the scheduled shift they deliver.
--
-- Until now start_ad_hoc_service_visit (0006) always stored
-- scheduled_shift_id = null, so:
--   * a visit was never compared with the shift it delivered;
--   * the authorization reservation held by a Care Request shift (0011) was
--     never released, so once the visit was signed its time was counted
--     twice by the assignment cap (signed visit minutes + the reservation).
--
-- This migration:
--   1. ogevia.match_scheduled_shift_for_visit(): finds the caller's own still
--      'scheduled' shift for the same client and service that is in progress,
--      or starts within the early-arrival window, at the server's Time In.
--      Excluded: called-out shifts (ogevia.shift_is_called_out) and shifts
--      that already have a live visit (also enforced by the existing
--      service_visits_shift_unique index). A shift already in progress wins
--      over a later one; otherwise the nearest start time wins. The shift row
--      is locked for the rest of the transaction.
--   2. start_ad_hoc_service_visit: stores the matched shift and records it in
--      the start audit event. No match means the visit stays unlinked,
--      exactly as before; nothing new is refused.
--   3. end_service_visit: Time Out moves the linked shift from 'scheduled' to
--      'completed' (cancelled or already-completed shifts are untouched).
--   4. When a linked visit becomes 'signed' (client confirmation or a manager
--      correction), the shift's authorization reservation is released with
--      reason 'visit_signed': from then on the signed visit's billable minutes
--      count instead (authorization_month_usage). A visit in
--      administrator_review keeps the reservation held until it is resolved,
--      so time already delivered is never freed for re-scheduling early.
--
-- Not changed: existing visits (no backfill), void, billing review rules,
-- grants of the two ogevia_api functions (create or replace keeps them).
-- The client never supplies a shift id.

create function ogevia.match_scheduled_shift_for_visit(
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
revoke all on function ogevia.match_scheduled_shift_for_visit(uuid, uuid, uuid, uuid, uuid, timestamptz) from public;

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

create or replace function ogevia_api.end_service_visit(
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

  -- The linked shift has been delivered. Only a still-scheduled shift moves;
  -- a cancelled or already-completed shift is left as it is.
  if v_visit.scheduled_shift_id is not null then
    update ogevia.shifts sh
    set status = 'completed', updated_at = now()
    where sh.id = v_visit.scheduled_shift_id
      and sh.organization_id = v_visit.organization_id
      and sh.status = 'scheduled';
  end if;

  perform ogevia.write_audit(v_visit.organization_id, 'service_visit.ended', 'service_visits', v_visit.id,
    jsonb_build_object('status', 'draft'),
    jsonb_build_object('status', 'awaiting_signature', 'time_out', v_ended_at, 'worked_minutes', v_minutes));
  return query select v_visit.id, v_minutes, v_visit.time_in, v_ended_at;
end;
$$;

-- A linked visit that becomes 'signed' consumes its shift's reservation.
-- One trigger covers both writers of a signed row: confirm_service_visit
-- (update of status) and correct_service_visit (insert of the corrected row,
-- which copies scheduled_shift_id).
create function ogevia.release_reservation_for_signed_visit()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
declare
  v_reservation ogevia.authorization_reservations%rowtype;
begin
  if new.status <> 'signed' or new.scheduled_shift_id is null then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.status = 'signed' then
    return null;
  end if;

  update ogevia.authorization_reservations r
  set released_at = now(), release_reason = 'visit_signed'
  where r.shift_id = new.scheduled_shift_id
    and r.organization_id = new.organization_id
    and r.released_at is null
  returning r.* into v_reservation;

  if v_reservation.id is not null then
    perform ogevia.write_audit(new.organization_id, 'authorization_reservation.released',
      'authorization_reservations', v_reservation.id,
      jsonb_build_object('released_at', null),
      jsonb_build_object('release_reason', 'visit_signed', 'visit_id', new.id,
                         'shift_id', new.scheduled_shift_id,
                         'reserved_minutes', v_reservation.reserved_minutes));
  end if;
  return null;
end;
$$;
revoke all on function ogevia.release_reservation_for_signed_visit() from public;

create trigger service_visits_release_reservation
after insert or update of status on ogevia.service_visits
for each row
when (new.status = 'signed' and new.scheduled_shift_id is not null)
execute function ogevia.release_reservation_for_signed_visit();

-- Visit records also return the linked shift's id and scheduled window.
-- Return type changes, so the function is dropped, recreated and re-granted.
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
