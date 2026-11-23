-- ROLLBACK 0086 | CLASS: BACKUP REQUIRED (the board's tables are dropped: coverage rounds, notification jobs, SMS consent, office contacts, coverage cities,
-- agency settings and usage; shifts lose public_ref / service_city / service_state; pickup requests lose round_id and the two new statuses). No shift,
-- assignment, visit, reservation or authorization is touched. Requests closed as 'invalidated' or 'closed' return to 'superseded'. Texts already sent
-- cannot be recalled. Restores the 0063 confirmation and the 0063 close-pickups trigger.
drop trigger shift_coverage_events_open_round on ogevia.shift_coverage_events;
drop trigger shifts_close_pickups on ogevia.shifts;
drop trigger organizations_default_open_shift_settings on ogevia.organizations;
drop function ogevia_api.post_shift_for_coverage(uuid, uuid);
drop function ogevia_api.unpost_shift(uuid, uuid, text);
drop function ogevia_api.set_shift_service_city(uuid, uuid, text, text);
drop function ogevia_api.list_open_shift_board(uuid, integer, integer);
drop function ogevia_api.get_open_shift(uuid, uuid);
drop function ogevia_api.request_open_shift(uuid, uuid, uuid);
drop function ogevia_api.withdraw_open_shift_request(uuid, uuid);
drop function ogevia_api.list_my_open_shift_requests(uuid);
drop function ogevia_api.list_coverage_queue(uuid);
drop function ogevia_api.list_coverage_requests(uuid, uuid);
drop function ogevia_api.confirm_coverage_request(uuid, uuid, text, uuid);
drop function ogevia_api.get_shift_coverage_status(uuid, uuid);
drop function ogevia_api.get_open_shift_settings(uuid);
drop function ogevia_api.update_open_shift_settings(uuid, jsonb);
drop function ogevia_api.list_office_contacts(uuid);
drop function ogevia_api.upsert_office_contact(uuid, uuid, text, text, text, boolean, boolean, boolean, boolean);
drop function ogevia_api.list_caregiver_coverage_cities(uuid, uuid);
drop function ogevia_api.set_caregiver_coverage_cities(uuid, uuid, jsonb);
drop function ogevia_api.set_my_sms_consent(uuid, text, boolean, text);
drop function ogevia_api.get_my_sms_consent(uuid);
drop function ogevia_api.system_sms_claim(integer);
drop function ogevia_api.system_sms_record(uuid, uuid, text, text, integer, bigint, text);
drop function ogevia_api.system_sms_receipt(text, text, boolean, text);
drop function ogevia_api.system_sms_stop(text, text);
drop function ogevia_api.system_coverage_sweep();
drop function ogevia.sms_evaluate_job(uuid);
drop function ogevia.coverage_on_coverage_event();
drop function ogevia.coverage_escalate_if_due(uuid);
drop function ogevia.coverage_plan_round(uuid);
drop function ogevia.enqueue_office_notice(uuid, text, uuid, uuid, text);
drop function ogevia.coverage_close_round(uuid, text);
drop function ogevia.coverage_open_round(uuid, text, uuid, uuid, text);
drop function ogevia.coverage_blockers(uuid, uuid, uuid);
drop function ogevia.organizations_default_open_shift_settings();
drop function ogevia.mask_phone(text);
drop function ogevia.actor_caregiver_record(uuid);
drop function ogevia.fmt_sms_when(timestamptz, timestamptz, text);
drop function ogevia.sms_available(uuid);
drop function ogevia.shift_city(uuid);
drop function ogevia.city_key(text, text);

create or replace function ogevia_api.confirm_shift_pickup(p_organization_id uuid, p_request_id uuid, p_idempotency_key uuid default null)
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

create or replace function ogevia.shifts_close_pickups()
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

create trigger shifts_close_pickups after update of status, caregiver_record_id on ogevia.shifts
for each row execute function ogevia.shifts_close_pickups();
update ogevia.shift_pickup_requests set status = 'superseded' where status in ('invalidated', 'closed');
alter table ogevia.shift_pickup_requests drop constraint shift_pickup_requests_status_check;
alter table ogevia.shift_pickup_requests add constraint shift_pickup_requests_status_check check (status in ('pending', 'confirmed', 'declined', 'withdrawn', 'superseded'));
alter table ogevia.shift_pickup_requests drop column round_id, drop column request_seq, drop column approved_order_position, drop column skipped_earlier_reason;
drop table ogevia.notification_jobs;
drop table ogevia.shift_coverage_rounds;
drop table ogevia.office_notification_contacts;
drop table ogevia.caregiver_sms_consent_events;
drop table ogevia.caregiver_sms_consent;
drop table ogevia.agency_sms_usage;
drop table ogevia.agency_open_shift_settings;
drop table ogevia.caregiver_coverage_cities;
alter table ogevia.shifts drop column public_ref, drop column service_city, drop column service_state;
