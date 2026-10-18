-- 0063 Open-shift pickup needs an administrator's confirmation (owner directive 2026-10-17, requirement 9).
--
-- BEFORE (0051): pickup_open_shift wrote the caregiver onto the shift in the caregiver's own transaction. The caregiver self-assigned; the office was told
-- nothing and nothing could be declined.
-- NOW:
--   * pickup_open_shift (same name and arguments) only RECORDS A REQUEST (shift_pickup_requests, status 'pending') and returns 'requested'. The shift's caregiver,
--     its coverage state and its reservation are untouched, so the shift stays open and nothing the caregiver does can make them assigned. Cheap, fail-fast
--     checks still run at request time (the shift is open and not a Care Request shift, the client and service are assigned to the caregiver, the caregiver did
--     not call out of it, and the readiness gate), so a caregiver on a compliance hold cannot even ask. Several caregivers may have a pending request on one shift.
--   * confirm_shift_pickup (shifts.manage) makes the assignment effective. In ONE transaction, taking the shift row lock first, it re-checks everything at that
--     moment: the shift is still scheduled, not over, has no visit, is still open; the request is still pending; the caregiver is still assigned to the client and
--     service and did not call out; and the full readiness gate with the client (compliance hold, background clearance, CPR/TB, documents, availability, overlap
--     with other shifts, work-hour limits including the SoCal 8 h / 40 h policy, onboarding, service approval); then that the authorization still covers the
--     reservation. Only then does it write the coverage event, set the caregiver, mark the request confirmed with a snapshot, and close every other pending request
--     on that shift. Two administrators confirming two requests at once serialise on the shift row: the second sees the shift filled and changes nothing.
--   * decline_shift_pickup (shifts.manage, reason required) and withdraw_my_shift_pickup (the caregiver) end a request without touching the shift.
--   * A trigger closes the pending requests of a shift that is filled by any other path (office assignment, care request), cancelled, or moved off 'scheduled'.
--   * list_shift_pickup_requests (shifts.manage) is the administrator's queue, with what would block each confirmation right now; list_open_shifts tells a caregiver
--     which shifts they have already requested; the attention overview counts waiting requests under 'pickups' (routine, never added to the urgent total).
-- The reservation is NOT moved or created: it belongs to the shift (0051 decision Q-R). The authorization re-check now lives in one internal function.
-- Not changed: assign_shift_caregiver (the office's own direct assignment) still does not re-check authorization capacity (see README).
-- Rollback restores the 0051 pickup (self-assign) and the 0062 overview; the request table and its history are dropped (BACKUP REQUIRED).

create table ogevia.shift_pickup_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  shift_id uuid not null references ogevia.shifts(id),
  caregiver_record_id uuid not null,
  requested_by uuid not null references ogevia.app_users(id),
  requested_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'declined', 'withdrawn', 'superseded')),
  decided_at timestamptz,
  decided_by uuid references ogevia.app_users(id),
  decision_reason text,
  confirmation_snapshot jsonb,
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id),
  constraint shift_pickup_requests_decided_shape check (
    (status = 'pending' and decided_at is null and decided_by is null)
    or (status <> 'pending' and decided_at is not null)),
  constraint shift_pickup_requests_reason_shape check (
    status not in ('declined') or length(btrim(coalesce(decision_reason, ''))) between 3 and 500)
);
create unique index shift_pickup_requests_one_pending on ogevia.shift_pickup_requests (shift_id, caregiver_record_id) where status = 'pending';
create index shift_pickup_requests_org_pending on ogevia.shift_pickup_requests (organization_id, requested_at) where status = 'pending';
create trigger shift_pickup_requests_no_delete before delete on ogevia.shift_pickup_requests for each row execute function ogevia.forbid_delete();
alter table ogevia.shift_pickup_requests enable row level security;
create policy readonly_select on ogevia.shift_pickup_requests for select to ogevia_readonly using (true);
grant select on ogevia.shift_pickup_requests to ogevia_readonly;

-- Once decided, a request never changes again; only pending -> one final status.
create function ogevia.shift_pickup_requests_guard()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  if old.status <> 'pending' then raise exception 'A decided pickup request cannot change' using errcode = 'OGC09'; end if;
  if new.id <> old.id or new.shift_id <> old.shift_id or new.caregiver_record_id <> old.caregiver_record_id or new.organization_id <> old.organization_id
     or new.requested_at <> old.requested_at or new.requested_by <> old.requested_by then
    raise exception 'A pickup request keeps its shift, caregiver and time' using errcode = 'OGC09';
  end if;
  return new;
end;
$$;
revoke all on function ogevia.shift_pickup_requests_guard() from public;
create trigger shift_pickup_requests_guard_update before update on ogevia.shift_pickup_requests for each row execute function ogevia.shift_pickup_requests_guard();

-- Whatever fills, cancels or ends a shift closes the requests still waiting on it.
create function ogevia.shifts_close_pickups()
returns trigger
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if (new.status <> 'scheduled' or (new.caregiver_record_id is not null and not ogevia.shift_is_called_out(new.id)))
     and exists (select 1 from ogevia.shift_pickup_requests r where r.shift_id = new.id and r.status = 'pending') then
    update ogevia.shift_pickup_requests r
       set status = 'superseded', decided_at = now(),
           decision_reason = case when new.status <> 'scheduled' then 'The shift is no longer scheduled' else 'The shift was filled' end
     where r.shift_id = new.id and r.status = 'pending';
  end if;
  return null;
end;
$$;
revoke all on function ogevia.shifts_close_pickups() from public;
create trigger shifts_close_pickups after update of status, caregiver_record_id on ogevia.shifts
for each row execute function ogevia.shifts_close_pickups();

-- The authorization re-check shared by confirmation (was inline in the 0051 pickup): the reservation made at scheduling still exists and the month's
-- authorization still covers used + reserved. Caller holds the shift lock; this takes the reservation row and the lineage lock.
create function ogevia.assert_shift_authorization_covered(p_shift_id uuid)
returns void
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare
  v_res ogevia.authorization_reservations%rowtype;
  v_cap ogevia.client_authorizations%rowtype;
  v_used bigint;
  v_reserved bigint;
begin
  select * into v_res from ogevia.authorization_reservations r where r.shift_id = p_shift_id and r.released_at is null for update;
  if v_res.id is null then
    raise exception 'This shift has no authorization reserved. Ask the office.' using errcode = 'OGC09';
  end if;
  perform ogevia.lock_authorization_lineage(v_res.authorization_lineage_id);
  select * into v_cap from ogevia.client_authorizations a
  where a.lineage_id = v_res.authorization_lineage_id and a.is_current and a.deleted_at is null
    and v_res.service_date between a.period_start and a.period_end;
  if v_cap.id is null then
    raise exception 'Authorization no longer covers this shift. Ask the office.' using errcode = 'OGC09';
  end if;
  v_used := ogevia.authorization_month_usage(v_res.authorization_lineage_id, v_res.service_date, null);
  v_reserved := ogevia.authorization_month_reserved(v_res.authorization_lineage_id, v_res.service_date);
  if v_used + v_reserved > v_cap.monthly_authorized_minutes then
    raise exception 'Authorization no longer covers this shift (% over). Ask the office.',
      ogevia.format_duration((v_used + v_reserved - v_cap.monthly_authorized_minutes)::integer) using errcode = 'OGC09';
  end if;
end;
$$;
revoke all on function ogevia.assert_shift_authorization_covered(uuid) from public;

drop function ogevia_api.list_open_shifts(uuid);
create function ogevia_api.list_open_shifts(p_organization_id uuid)
returns table (
  shift_id uuid, starts_at timestamptz, ends_at timestamptz, minutes integer,
  client_code text, service_name text, coverage_state text, my_request_status text
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select s.id, s.starts_at, s.ends_at, floor(extract(epoch from (s.ends_at - s.starts_at)) / 60)::integer,
         coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code), sv.name,
         ogevia.shift_coverage_state(s),
         (select 'requested' from ogevia.shift_pickup_requests r join ogevia.caregiver_records cr on cr.id = r.caregiver_record_id
           where r.shift_id = s.id and r.status = 'pending' and cr.linked_user_id = ogevia.require_actor() limit 1)
  from ogevia.shifts s
  join ogevia.clients c on c.id = s.client_id
  left join ogevia.services sv on sv.id = s.service_id
  where s.organization_id = p_organization_id
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and ogevia.is_active_caregiver(p_organization_id)
    and s.status = 'scheduled' and s.ends_at > now() and s.starts_at < now() + interval '14 days'
    and ogevia.shift_coverage_state(s) = 'needs_coverage'
    and not ogevia.shift_is_care_request(s.id)
    and ogevia.caregiver_has_active_assignment(p_organization_id, s.client_id, s.service_id)
    and not exists (
      select 1 from ogevia.shift_coverage_events e
      join ogevia.caregiver_records cr on cr.id = e.original_caregiver_record_id
      where e.shift_id = s.id and e.event_type = 'called_out' and cr.linked_user_id = ogevia.require_actor()
    )
    and not exists (
      select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id and v.status not in ('voided', 'corrected')
    )
  order by s.starts_at;
$$;

create or replace function ogevia_api.pickup_open_shift(
  p_organization_id uuid, p_shift_id uuid, p_idempotency_key uuid default null
)
returns text
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_fp text := concat_ws('|', p_organization_id, p_shift_id);
  v_prior jsonb;
  v_rec ogevia.caregiver_records%rowtype;
  v_s ogevia.shifts%rowtype;
  v_id uuid;
begin
  if not ogevia.is_active_member(p_organization_id) or not ogevia.is_active_caregiver(p_organization_id) then
    raise exception 'Only an active caregiver can ask for a shift' using errcode = 'OGA03';
  end if;
  select cr.* into v_rec
  from ogevia.caregiver_records cr
  where cr.organization_id = p_organization_id and cr.linked_user_id = v_actor and cr.deleted_at is null
  order by case when cr.status in ('active', 'ready') then 0 else 1 end, cr.updated_at desc
  limit 1;
  if v_rec.id is null or v_rec.status not in ('active', 'ready') then
    raise exception 'Your Care Team profile is not active. Contact your agency manager before asking for a shift.' using errcode = 'OGA03';
  end if;

  v_prior := ogevia.idempotency_begin('pickup_open_shift', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior ->> 'state'; end if;

  -- Row lock on the shift: a confirmation in progress finishes first, and then this sees the shift filled.
  select * into v_s from ogevia.shifts s where s.id = p_shift_id and s.organization_id = p_organization_id for update;
  if v_s.id is null then raise exception 'Shift not found' using errcode = 'OGN04'; end if;
  if ogevia.shift_is_care_request(v_s.id) then
    raise exception 'This shift came from a Care Request and is handled by the office' using errcode = 'OGC09';
  end if;
  if v_s.status <> 'scheduled' then raise exception 'This shift is no longer scheduled' using errcode = 'OGC09'; end if;
  if v_s.ends_at <= now() then raise exception 'This shift is already over' using errcode = 'OGC09'; end if;
  if ogevia.shift_coverage_state(v_s) <> 'needs_coverage' then
    raise exception 'This shift was just filled' using errcode = 'OGC09';
  end if;
  if exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = v_s.id and v.status not in ('voided', 'corrected')) then
    raise exception 'A visit has already started for this shift' using errcode = 'OGC09';
  end if;
  -- O-1: the caregiver who called out of a shift does not take it back; the office reassigns it.
  if exists (select 1 from ogevia.shift_coverage_events e
             where e.shift_id = v_s.id and e.event_type = 'called_out' and e.original_caregiver_record_id = v_rec.id) then
    raise exception 'You called out of this shift. Ask the office to reassign it.' using errcode = 'OGC09';
  end if;
  if not ogevia.caregiver_has_active_assignment(p_organization_id, v_s.client_id, v_s.service_id) then
    raise exception 'This client and service are not assigned to you' using errcode = 'OGA03';
  end if;
  -- Fail fast: free and ready now (overlaps, Care Team status, the readiness gate). The office re-checks all of it at confirmation.
  perform ogevia.check_shift_caregiver(p_organization_id, v_rec.id, v_s.starts_at, v_s.ends_at, v_s.id, v_s.service_id);

  insert into ogevia.shift_pickup_requests (organization_id, shift_id, caregiver_record_id, requested_by)
  values (p_organization_id, v_s.id, v_rec.id, v_actor)
  on conflict (shift_id, caregiver_record_id) where status = 'pending' do nothing
  returning id into v_id;
  if v_id is not null then
    perform ogevia.write_audit(p_organization_id, 'shift.pickup_requested', 'shifts', v_s.id, null,
      jsonb_build_object('request_id', v_id, 'caregiver_record_id', v_rec.id), 'Open shift requested by caregiver');
  end if;
  perform ogevia.idempotency_finish('pickup_open_shift', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('state', 'requested'));
  return 'requested';
end;
$$;

create function ogevia_api.withdraw_my_shift_pickup(p_organization_id uuid, p_shift_id uuid)
returns text
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_id uuid;
begin
  if not ogevia.is_active_member(p_organization_id) or not ogevia.is_active_caregiver(p_organization_id) then
    raise exception 'Only an active caregiver can withdraw a request' using errcode = 'OGA03';
  end if;
  update ogevia.shift_pickup_requests r
     set status = 'withdrawn', decided_at = now(), decided_by = v_actor, decision_reason = 'Withdrawn by the caregiver'
   where r.organization_id = p_organization_id and r.shift_id = p_shift_id and r.status = 'pending'
     and exists (select 1 from ogevia.caregiver_records cr where cr.id = r.caregiver_record_id and cr.linked_user_id = v_actor)
  returning r.id into v_id;
  if v_id is null then raise exception 'You have no waiting request for this shift' using errcode = 'OGN04'; end if;
  perform ogevia.write_audit(p_organization_id, 'shift.pickup_withdrawn', 'shifts', p_shift_id, null, jsonb_build_object('request_id', v_id), 'Withdrawn by the caregiver');
  return 'withdrawn';
end;
$$;

create function ogevia_api.list_shift_pickup_requests(p_organization_id uuid)
returns table (
  request_id uuid, shift_id uuid, requested_at timestamptz, starts_at timestamptz, ends_at timestamptz, minutes integer,
  client_code text, service_name text, caregiver_record_id uuid, caregiver_code text, caregiver_name text, blockers text[]
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select r.id, r.shift_id, r.requested_at, s.starts_at, s.ends_at, floor(extract(epoch from (s.ends_at - s.starts_at)) / 60)::integer,
         coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code), sv.name,
         cr.id, cr.caregiver_code, nullif(btrim(coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name), ''),
         coalesce((select array_agg(x.message order by x.check_name) from ogevia.readiness_checks(r.organization_id, cr.id, s.service_id, s.starts_at, s.ends_at,
                    'reschedule', s.id, s.client_id, true) x where x.status = 'blocked' and x.enforced), array[]::text[])
  from ogevia.shift_pickup_requests r
  join ogevia.shifts s on s.id = r.shift_id
  join ogevia.clients c on c.id = s.client_id
  join ogevia.caregiver_records cr on cr.id = r.caregiver_record_id
  left join ogevia.services sv on sv.id = s.service_id
  where r.organization_id = p_organization_id and r.status = 'pending' and s.status = 'scheduled' and s.ends_at > now()
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and ogevia.has_permission(p_organization_id, 'shifts.manage')
  order by s.starts_at, r.requested_at;
$$;

create function ogevia_api.confirm_shift_pickup(p_organization_id uuid, p_request_id uuid, p_idempotency_key uuid default null)
returns text
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_fp text := concat_ws('|', p_organization_id, p_request_id);
  v_prior jsonb;
  v_req ogevia.shift_pickup_requests%rowtype;
  v_s ogevia.shifts%rowtype;
  v_rec ogevia.caregiver_records%rowtype;
  v_res ogevia.authorization_reservations%rowtype;
  v_kind text;
begin
  v_prior := ogevia.idempotency_begin('confirm_shift_pickup', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior ->> 'state'; end if;
  select * into v_req from ogevia.shift_pickup_requests r where r.id = p_request_id and r.organization_id = p_organization_id;
  if v_req.id is null then raise exception 'Pickup request not found' using errcode = 'OGN04'; end if;

  -- The shift row first (as every other assignment path does), so competing confirmations serialise here.
  v_s := ogevia.lock_staff_shift(p_organization_id, v_req.shift_id);
  select * into v_req from ogevia.shift_pickup_requests r where r.id = p_request_id for update;
  if v_req.status <> 'pending' then
    raise exception 'This request was already %. Refresh the list.', case v_req.status when 'confirmed' then 'confirmed' when 'superseded' then 'closed (the shift was filled)' else v_req.status end
      using errcode = 'OGC09';
  end if;
  if v_s.ends_at <= now() then raise exception 'This shift is already over' using errcode = 'OGC09'; end if;
  if ogevia.shift_coverage_state(v_s) <> 'needs_coverage' then raise exception 'This shift was just filled' using errcode = 'OGC09'; end if;
  if exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = v_s.id and v.status not in ('voided', 'corrected')) then
    raise exception 'A visit has already started for this shift' using errcode = 'OGC09';
  end if;
  if exists (select 1 from ogevia.shift_coverage_events e
             where e.shift_id = v_s.id and e.event_type = 'called_out' and e.original_caregiver_record_id = v_req.caregiver_record_id) then
    raise exception 'This caregiver called out of this shift. Choose someone else.' using errcode = 'OGC09';
  end if;
  select * into v_rec from ogevia.caregiver_records r where r.id = v_req.caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  if v_rec.id is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  if v_rec.status not in ('ready', 'active') then
    raise exception 'Only caregivers who are Ready to work or Active can be scheduled' using errcode = 'OGV22';
  end if;
  if v_rec.linked_user_id is null or not exists (
       select 1 from ogevia.caregiver_assignments ca
       where ca.organization_id = p_organization_id and ca.caregiver_user_id = v_rec.linked_user_id
         and ca.client_id = v_s.client_id and ca.service_id = v_s.service_id and ca.is_active
         and ogevia.organization_local_date(p_organization_id, now()) >= ca.effective_start
         and (ca.effective_end is null or ogevia.organization_local_date(p_organization_id, now()) <= ca.effective_end)) then
    raise exception 'This client and service are no longer assigned to this caregiver' using errcode = 'OGC09';
  end if;

  -- The caregiver lock, then overlap and the whole readiness gate with the client: compliance hold, background, CPR/TB, documents, availability,
  -- work-hour limits (the agency policy included), onboarding, service approval, client requirements.
  perform ogevia.lock_caregiver(v_rec.id);
  if exists (
    select 1 from ogevia.shifts s
    where s.organization_id = p_organization_id and s.id is distinct from v_s.id
      and (s.caregiver_record_id = v_rec.id or (v_rec.linked_user_id is not null and s.caregiver_user_id = v_rec.linked_user_id))
      and s.status in ('scheduled', 'completed') and not ogevia.shift_is_called_out(s.id)
      and s.starts_at < v_s.ends_at and s.ends_at > v_s.starts_at) then
    raise exception 'This caregiver already has a shift at that time' using errcode = 'OGC09';
  end if;
  perform ogevia.assert_ready_for_work(p_organization_id, v_rec.id, v_s.service_id, v_s.starts_at, v_s.ends_at, 'reschedule', v_s.client_id, v_s.id);

  -- The authorization still covers the shift's reservation.
  perform ogevia.assert_shift_authorization_covered(v_s.id);
  select * into v_res from ogevia.authorization_reservations r where r.shift_id = v_s.id and r.released_at is null;

  v_kind := case when v_s.caregiver_record_id is null then 'Open shift filled: request confirmed by the office'
                 else 'Replacement after call-out: request confirmed by the office' end;
  update ogevia.shift_pickup_requests
     set status = 'confirmed', decided_at = now(), decided_by = v_actor,
         confirmation_snapshot = jsonb_build_object('reservation_id', v_res.id, 'reserved_minutes', v_res.reserved_minutes,
           'checks', array['shift_open', 'caregiver_assigned_to_client', 'readiness_gate', 'overlap', 'work_hours', 'authorization_capacity'])
   where id = v_req.id;
  insert into ogevia.shift_coverage_events (organization_id, shift_id, event_type, actor_user_id, original_caregiver_record_id,
                                            replacement_caregiver_record_id, reason, before_snapshot, after_snapshot)
  values (p_organization_id, v_s.id, 'reassigned', v_actor, v_s.caregiver_record_id, v_rec.id, v_kind,
          jsonb_build_object('caregiver_record_id', v_s.caregiver_record_id),
          jsonb_build_object('caregiver_record_id', v_rec.id, 'pickup_request_id', v_req.id, 'reservation_id', v_res.id, 'reserved_minutes', v_res.reserved_minutes,
                             'authorization_checked', true));
  update ogevia.shifts set caregiver_record_id = v_rec.id, caregiver_user_id = v_rec.linked_user_id, updated_at = now() where id = v_s.id;
  perform ogevia.write_audit(p_organization_id, 'shift.pickup_confirmed', 'shifts', v_s.id,
    jsonb_build_object('caregiver_record_id', v_s.caregiver_record_id),
    jsonb_build_object('caregiver_record_id', v_rec.id, 'request_id', v_req.id, 'reservation_id', v_res.id, 'reserved_minutes', v_res.reserved_minutes), v_kind);
  perform ogevia.idempotency_finish('confirm_shift_pickup', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('state', 'covered'));
  return 'covered';
end;
$$;

create function ogevia_api.decline_shift_pickup(p_organization_id uuid, p_request_id uuid, p_reason text, p_idempotency_key uuid default null)
returns text
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.shift_admin_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_request_id, v_reason);
  v_prior jsonb;
  v_req ogevia.shift_pickup_requests%rowtype;
begin
  if length(v_reason) not between 3 and 500 then raise exception 'Give the reason for declining' using errcode = 'OGV22'; end if;
  v_prior := ogevia.idempotency_begin('decline_shift_pickup', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior ->> 'state'; end if;
  select * into v_req from ogevia.shift_pickup_requests r where r.id = p_request_id and r.organization_id = p_organization_id for update;
  if v_req.id is null then raise exception 'Pickup request not found' using errcode = 'OGN04'; end if;
  if v_req.status <> 'pending' then raise exception 'This request was already %. Refresh the list.', v_req.status using errcode = 'OGC09'; end if;
  update ogevia.shift_pickup_requests set status = 'declined', decided_at = now(), decided_by = v_actor, decision_reason = v_reason where id = v_req.id;
  perform ogevia.write_audit(p_organization_id, 'shift.pickup_declined', 'shifts', v_req.shift_id, null, jsonb_build_object('request_id', v_req.id), v_reason);
  perform ogevia.idempotency_finish('decline_shift_pickup', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('state', 'declined'));
  return 'declined';
end;
$$;

create or replace function ogevia_api.get_attention_overview(p_organization_id uuid, p_urgent_hours integer default 48)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_win interval;
  v_can_visits boolean;
  v_can_cover boolean;
  v_can_docs boolean;
  v_can_comp boolean;
  v_can_bill boolean;
  v_urgent jsonb := null;
  v_upcoming jsonb := null;
  v_docs jsonb := null;
  v_review jsonb := null;
  v_pick jsonb := null;
  v_holds integer;
  v_pending integer;
begin
  if p_urgent_hours is null or p_urgent_hours < 1 or p_urgent_hours > 168 then
    raise exception 'The urgent window must be 1 to 168 hours' using errcode = 'OGV22';
  end if;
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  v_win := make_interval(hours => p_urgent_hours);
  v_can_visits := ogevia.has_permission(p_organization_id, 'visits.read');
  v_can_cover := ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'visits.manage');
  v_can_docs := ogevia.has_permission(p_organization_id, 'documents.read');
  v_can_comp := ogevia.has_permission(p_organization_id, 'readiness.read');
  v_can_bill := ogevia.has_permission(p_organization_id, 'billing.visits.read');
  if not (v_can_visits or v_can_cover or v_can_docs or v_can_comp) then
    raise exception 'You do not have permission to see attention items' using errcode = 'OGA03';
  end if;

  -- NEEDS ATTENTION NOW -------------------------------------------------------------------------------------------
  if v_can_cover or v_can_visits or v_can_comp then
    with reasons as (
      -- an uncovered shift that starts inside the window or is already running
      select 'shift'::text as kind, sh.id as id, sh.starts_at as at, sh.ends_at as ends_at,
             case when ogevia.shift_is_called_out(sh.id) then 'uncovered_called_out' else 'uncovered_open' end as reason,
             ogevia.attention_shift_tier(sh.starts_at, now()) as severity, null::uuid as caregiver_id, sh.client_id as client_id, sh.service_id as service_id
      from ogevia.shifts sh
      where v_can_cover and sh.organization_id = p_organization_id and sh.status = 'scheduled' and sh.ends_at > now() and sh.starts_at <= now() + v_win
        and ogevia.shift_coverage_state(sh) = 'needs_coverage'
      union all
      -- a shift inside the window whose caregiver is blocked (0055 hold, or a required-document problem flagged by 0041)
      select 'shift', sh.id, sh.starts_at, sh.ends_at,
             case f.kind when 'compliance' then 'compliance_hold' else 'documents_not_current' end, ogevia.attention_shift_tier(sh.starts_at, now()), f.caregiver_record_id, sh.client_id, sh.service_id
      from ogevia.shift_readiness_flags f
      join ogevia.shifts sh on sh.id = f.shift_id
      where (v_can_comp or v_can_cover) and f.organization_id = p_organization_id and f.kind in ('compliance', 'document') and f.resolved_at is null
        and sh.status = 'scheduled' and sh.ends_at > now() and sh.starts_at <= now() + v_win and not ogevia.shift_is_called_out(sh.id)
      union all
      -- a visit still open past its shift end (or 12 h without a schedule): the worked time is unknown
      select 'visit', v.id, v.time_in, null::timestamptz, 'missing_clock_out', 'urgent', v.caregiver_record_id, v.client_id, v.service_id
      from ogevia.service_visits v
      left join ogevia.shifts s on s.id = v.scheduled_shift_id
      where v_can_visits and v.organization_id = p_organization_id and v.status = 'draft' and v.time_out is null
        and ((s.id is not null and s.ends_at < now()) or (s.id is null and v.time_in <= now() - interval '12 hours'))
      union all
      -- a visit in progress for a caregiver who is on a compliance hold: the office must arrange safe coverage
      select 'visit', v.id, v.time_in, null::timestamptz, 'in_progress_on_hold', 'critical', v.caregiver_record_id, v.client_id, v.service_id
      from ogevia.service_visits v
      join ogevia.caregiver_compliance_holds h on h.organization_id = v.organization_id and h.released_at is null
       and (h.caregiver_record_id = v.caregiver_record_id
            or (v.caregiver_record_id is null and v.caregiver_user_id = (select r.linked_user_id from ogevia.caregiver_records r where r.id = h.caregiver_record_id)))
      where (v_can_comp or v_can_visits) and v.organization_id = p_organization_id and v.status = 'draft' and v.time_out is null
    ), items as (
      select r.kind, r.id, min(r.at) as at, max(r.ends_at) as ends_at,
             (array_agg(distinct r.reason order by r.reason)) as reasons,
             case when bool_or(r.severity = 'critical') then 'critical' else 'urgent' end as tier,
             max(r.caregiver_id::text)::uuid as caregiver_id, max(r.client_id::text)::uuid as client_id, max(r.service_id::text)::uuid as service_id
      from reasons r group by r.kind, r.id
    )
    select jsonb_build_object(
             'items', coalesce(jsonb_agg(jsonb_build_object(
                'kind', i.kind, 'id', i.id, 'startsAt', i.at, 'endsAt', i.ends_at, 'reasons', to_jsonb(i.reasons), 'tier', i.tier, 'severity', case when i.tier = 'critical' then 'red' else 'amber' end,
                'inProgress', i.at <= now() and (i.ends_at is null or i.ends_at > now()),
                'caregiverRecordId', i.caregiver_id, 'caregiverCode', (select r2.caregiver_code from ogevia.caregiver_records r2 where r2.id = i.caregiver_id),
                'clientCode', (select c.client_code from ogevia.clients c where c.id = i.client_id),
                'serviceCode', (select s2.code from ogevia.services s2 where s2.id = i.service_id)) order by (i.tier = 'critical') desc, i.at), '[]'::jsonb),
             'itemCount', count(*),
             'issueCount', coalesce(sum(cardinality(i.reasons)), 0),
             'shifts', count(*) filter (where i.kind = 'shift'),
             'visits', count(*) filter (where i.kind = 'visit'),
             'critical', count(*) filter (where i.tier = 'critical'),
             'urgent', count(*) filter (where i.tier = 'urgent'))
      into v_urgent
    from items i;
  end if;

  -- UPCOMING STAFFING: shifts that start after the window and still need a person's attention: uncovered, or whose caregiver is blocked
  -- (0055 hold, required document). Same timing rule as Needs attention now: Upcoming beyond the window (more than 48 h), Urgent inside it, Critical at/after start.
  -- A hold is enforced immediately whatever the display tier; this only decides where the shift is listed.
  if v_can_cover or v_can_comp then
    select jsonb_build_object(
             'count', count(*),
             'nextStartsAt', min(x.starts_at),
             'shifts', coalesce(jsonb_agg(jsonb_build_object(
                'shiftId', x.id, 'startsAt', x.starts_at, 'endsAt', x.ends_at, 'reason', x.reason,
                'clientCode', (select c.client_code from ogevia.clients c where c.id = x.client_id),
                'serviceCode', (select s2.code from ogevia.services s2 where s2.id = x.service_id),
                'serviceName', (select s2.name from ogevia.services s2 where s2.id = x.service_id)) order by x.starts_at, x.id) filter (where x.rn <= 200), '[]'::jsonb))
      into v_upcoming
    from (
      select y.*, row_number() over (order by y.starts_at, y.id) as rn
      from (
        select distinct on (u.id) u.* from (
          select sh.id, sh.starts_at, sh.ends_at, sh.client_id, sh.service_id,
                 case when ogevia.shift_is_called_out(sh.id) then 'called_out' else 'open' end as reason
          from ogevia.shifts sh
          where v_can_cover and sh.organization_id = p_organization_id and sh.status = 'scheduled' and sh.starts_at > now() + v_win
            and ogevia.shift_coverage_state(sh) = 'needs_coverage'
          union all
          select sh.id, sh.starts_at, sh.ends_at, sh.client_id, sh.service_id,
                 case f.kind when 'compliance' then 'compliance_hold' else 'documents_not_current' end
          from ogevia.shift_readiness_flags f
          join ogevia.shifts sh on sh.id = f.shift_id
          where (v_can_comp or v_can_cover) and f.organization_id = p_organization_id and f.kind in ('compliance', 'document') and f.resolved_at is null
            and sh.status = 'scheduled' and sh.starts_at > now() + v_win and not ogevia.shift_is_called_out(sh.id)
        ) u order by u.id, u.reason
      ) y
    ) x;
  end if;

  -- DOCUMENTS & COMPLIANCE -----------------------------------------------------------------------------------------------
  if v_can_docs then
    -- Routine review (awaiting a person, inside the deadline) is reported apart from review that has escalated: more than 48 hours since
    -- the upload, OR the document is expired, OR its caregiver has an upcoming shift flagged for documents (it blocks care).
    with d as (
      select x.display_status,
             (x.display_status = 'awaiting_review'
              and (x.latest_uploaded_at <= now() - make_interval(hours => ogevia.attention_rule_hours('document_review_overdue'))
                   or x.currency_status = 'expired'
                   or exists (select 1 from ogevia.shift_readiness_flags f join ogevia.shifts sh on sh.id = f.shift_id
                               where f.organization_id = p_organization_id and f.caregiver_record_id = x.caregiver_record_id
                                 and f.kind = 'document' and f.resolved_at is null and sh.status = 'scheduled' and sh.ends_at > now()
                                 and not ogevia.shift_is_called_out(sh.id)))) as escalated
      from ogevia_api.list_staff_documents(p_organization_id, null) x
    )
    select jsonb_build_object(
             'overdue', count(*) filter (where d.display_status in ('expired', 'overdue')),
             'dueSoon', count(*) filter (where d.display_status = 'expiring'),
             'awaitingReview', count(*) filter (where d.display_status = 'awaiting_review'),
             'reviewOverdue', count(*) filter (where d.escalated),
             'reviewRoutine', count(*) filter (where d.display_status = 'awaiting_review' and not d.escalated),
             'rejected', count(*) filter (where d.display_status = 'rejected'))
      into v_docs
    from d;
  end if;
  if v_can_comp then
    select count(*)::int into v_holds from ogevia.caregiver_compliance_holds h where h.organization_id = p_organization_id and h.released_at is null;
    select count(*)::int into v_pending from ogevia.caregiver_records r
    where r.organization_id = p_organization_id and r.deleted_at is null and r.status in ('ready', 'active')
      and exists (select 1 from ogevia.compliance_blockers(p_organization_id, r.id) b where not b.blocking);
    v_docs := coalesce(v_docs, '{}'::jsonb) || jsonb_build_object('caregiversOnHold', v_holds, 'caregiversWithPendingRequirements', v_pending);
  end if;

  -- VISIT REVIEW: unique visits. What needs a person (administrator review from the moment it starts, a late answer, a confirmation more than 48 h
  -- overdue) is counted in visitsNeedingAttention. Pending Confirmation (inside 48 h of the visit end) and Ready for Approval are counted apart and
  -- never added to it. Administrator review is Urgent after 24 h in the queue (reviewOverdue).
  if v_can_visits then
    with u as (
      select v.id, 'pending_confirmation'::text as kind, v.time_out as at from ogevia.service_visits v
       where v.organization_id = p_organization_id and v.status = 'awaiting_signature' and v.time_out is not null
         and v.time_out > now() - make_interval(hours => ogevia.attention_rule_hours('confirmation_overdue'))
      union all
      select v.id, 'confirmation_overdue', v.time_out from ogevia.service_visits v
       where v.organization_id = p_organization_id and v.status = 'awaiting_signature' and v.time_out is not null
         and v.time_out <= now() - make_interval(hours => ogevia.attention_rule_hours('confirmation_overdue'))
      union all
      select v.id, 'needs_review', ogevia.visit_review_entered_at(v.id) from ogevia.service_visits v
       where v.organization_id = p_organization_id and v.status = 'administrator_review'
         and not exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null)
         and ogevia.visit_recovery_state(v.id) is null
      union all
      select v.id, 'late_response', ogevia.visit_late_response_at(v.id) from ogevia.service_visits v
       where v.organization_id = p_organization_id and v.status = 'administrator_review' and ogevia.visit_recovery_state(v.id) = 'response_to_review'
      union all
      select v.id, 'ready_for_approval', v.signed_at from ogevia.service_visits v
       where v_can_bill and v.organization_id = p_organization_id and v.status in ('signed', 'administrator_review')
         and ogevia.visit_billing_state(v.id) in ('ready_for_review', 'voided')
    )
    select jsonb_build_object(
             'visitsNeedingAttention', count(distinct u.id) filter (where u.kind in ('needs_review', 'late_response', 'confirmation_overdue')),
             'pendingConfirmation', count(distinct u.id) filter (where u.kind = 'pending_confirmation'),
             'confirmationOverdue', count(distinct u.id) filter (where u.kind = 'confirmation_overdue'),
             'awaitingConfirmation', count(distinct u.id) filter (where u.kind in ('pending_confirmation', 'confirmation_overdue')),
             'needsReview', count(distinct u.id) filter (where u.kind = 'needs_review'),
             'reviewOverdue', count(distinct u.id) filter (where u.kind in ('needs_review', 'late_response') and u.at <= now() - make_interval(hours => ogevia.attention_rule_hours('review_overdue'))),
             'lateResponses', count(distinct u.id) filter (where u.kind = 'late_response'),
             'readyForApproval', case when v_can_bill then count(distinct u.id) filter (where u.kind = 'ready_for_approval') end,
             'reviewIssues', coalesce(sum(cardinality(coalesce(ogevia.visit_review_reasons(u.id), array[]::text[]))) filter (where u.kind = 'needs_review'), 0),
             'awaitingResponse', (select count(*) from ogevia.service_visits v where v.organization_id = p_organization_id and v.status = 'administrator_review'
                                   and not exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null)
                                   and ogevia.visit_recovery_state(v.id) = 'awaiting_response'))
      into v_review
    from u;
  end if;

  -- PICKUP REQUESTS (0063): a caregiver asked for an open shift and no one has confirmed it yet. Routine: counted here, never added to the urgent total.
  if ogevia.has_permission(p_organization_id, 'shifts.manage') then
    select jsonb_build_object('count', count(*), 'oldestRequestedAt', min(r.requested_at)) into v_pick
    from ogevia.shift_pickup_requests r join ogevia.shifts sh on sh.id = r.shift_id
    where r.organization_id = p_organization_id and r.status = 'pending' and sh.status = 'scheduled' and sh.ends_at > now();
  end if;

  return jsonb_build_object(
    'asOf', now(), 'urgentWindowHours', p_urgent_hours, 'pickups', v_pick,
    'urgent', v_urgent, 'upcoming', v_upcoming, 'documents', v_docs, 'visitReview', v_review);
end;
$$;

revoke all on function ogevia_api.list_open_shifts(uuid) from public;
revoke all on function ogevia_api.pickup_open_shift(uuid, uuid, uuid) from public;
revoke all on function ogevia_api.withdraw_my_shift_pickup(uuid, uuid) from public;
revoke all on function ogevia_api.list_shift_pickup_requests(uuid) from public;
revoke all on function ogevia_api.confirm_shift_pickup(uuid, uuid, uuid) from public;
revoke all on function ogevia_api.decline_shift_pickup(uuid, uuid, text, uuid) from public;
grant execute on function ogevia_api.list_open_shifts(uuid) to ogevia_app;
grant execute on function ogevia_api.pickup_open_shift(uuid, uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.withdraw_my_shift_pickup(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.list_shift_pickup_requests(uuid) to ogevia_app;
grant execute on function ogevia_api.confirm_shift_pickup(uuid, uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.decline_shift_pickup(uuid, uuid, text, uuid) to ogevia_app;
