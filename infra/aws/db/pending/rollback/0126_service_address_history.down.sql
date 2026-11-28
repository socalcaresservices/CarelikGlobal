-- 0126 rollback (PENDING). Restores the three 0124 functions exactly as they were, then removes what 0126 added.
-- DATA: the address history table and the inactive/historical columns are dropped with their contents. Addresses themselves are kept; any address that 0126 set inactive
-- stays inactive (the 0124 list hides inactive addresses). The one-current-home rule is removed with the index.
create or replace function ogevia_api.assign_home_label(p_organization_id uuid, p_label_code text, p_service_location_id uuid, p_confirmed_address boolean, p_reassign boolean default false)
returns uuid language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_label ogevia.home_labels%rowtype;
  v_loc ogevia.client_service_locations%rowtype;
  v_from uuid;
begin
  if not (ogevia.has_permission(p_organization_id, 'clients.manage') and ogevia.has_permission(p_organization_id, 'clients.names.manage')) then
    raise exception 'You do not have permission to assign labels' using errcode = 'OGA03';
  end if;
  if not coalesce(p_confirmed_address, false) then raise exception 'Confirm the address on file before assigning the label' using errcode = 'OGV22'; end if;
  select * into v_label from ogevia.home_labels h where upper(h.label_code) = upper(btrim(p_label_code)) and h.organization_id = p_organization_id for update;
  if v_label.id is null then raise exception 'Label not found for your agency' using errcode = 'OGN04'; end if;
  select * into v_loc from ogevia.client_service_locations l where l.id = p_service_location_id and l.organization_id = p_organization_id and l.is_active and l.kind = 'home';
  if v_loc.id is null then raise exception 'Service location not found' using errcode = 'OGN04'; end if;
  if v_label.status = 'active' then
    if v_label.service_location_id = p_service_location_id then return v_label.id; end if;      -- same assignment again: nothing to do
    if not coalesce(p_reassign, false) then raise exception 'This label is already active at another location. Choose reassign to move it.' using errcode = 'OGC09'; end if;
  elsif v_label.status <> 'unassigned' then
    raise exception 'This label is % and cannot be used again', v_label.status using errcode = 'OGC09';
  end if;
  if exists (select 1 from ogevia.home_labels h where h.service_location_id = p_service_location_id and h.status = 'active' and h.id <> v_label.id) then
    raise exception 'This location already has an active label. Replace it instead.' using errcode = 'OGC09';
  end if;
  v_from := v_label.service_location_id;
  update ogevia.home_labels h set status = 'active', service_location_id = p_service_location_id, client_id = v_loc.client_id, installed_at = now(), installed_by = v_actor, ended_at = null, ended_by = null
   where h.id = v_label.id;
  insert into ogevia.home_label_events (organization_id, label_id, action, actor_user_id, from_location_id, to_location_id)
  values (p_organization_id, v_label.id, case when v_from is null then 'assigned' else 'reassigned' end, v_actor, v_from, p_service_location_id);
  perform ogevia.write_audit(p_organization_id, case when v_from is null then 'home_label.assigned' else 'home_label.reassigned' end, 'home_labels', v_label.id, null,
    jsonb_build_object('service_location_id', p_service_location_id, 'client_id', v_loc.client_id), null);
  return v_label.id;
end;
$$;

create or replace function ogevia_api.preview_home_label(p_label_hash text)
returns jsonb language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_label ogevia.home_labels%rowtype;
  v_open ogevia.service_visits%rowtype;
  v_record uuid;
  v_shifts jsonb;
  v_n integer;
  v_code text;
  v_loc ogevia.client_service_locations%rowtype;
begin
  select * into v_label from ogevia.home_labels h where h.token_hash = p_label_hash;
  if v_label.id is null or v_label.status <> 'active' or not ogevia.is_active_caregiver(v_label.organization_id) then
    return jsonb_build_object('state', 'unavailable');
  end if;
  v_record := ogevia.my_caregiver_record(v_label.organization_id);
  select coalesce(nullif(btrim(c.caregiver_display_code), ''), c.client_code) into v_code from ogevia.clients c where c.id = v_label.client_id;
  select * into v_loc from ogevia.client_service_locations l where l.id = v_label.service_location_id;
  select * into v_open from ogevia.service_visits v where v.caregiver_user_id = v_actor and v.status in ('draft', 'awaiting_signature') limit 1;
  if v_open.id is not null then
    if v_open.client_id = v_label.client_id and v_open.status = 'draft' then
      return jsonb_build_object('state', 'ready', 'action', 'departure', 'organizationId', v_label.organization_id, 'clientCode', v_code, 'city', v_loc.city,
        'visit', jsonb_build_object('id', v_open.id, 'timeIn', v_open.time_in));
    end if;
    return jsonb_build_object('state', 'blocked', 'reason', case when v_open.client_id = v_label.client_id then 'previous_visit_not_finished' else 'open_visit_elsewhere' end,
      'organizationId', v_label.organization_id, 'clientCode', v_code);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'startsAt', s.starts_at, 'endsAt', s.ends_at) order by s.starts_at), '[]'::jsonb), count(*) into v_shifts, v_n
    from ogevia.shifts s
   where s.organization_id = v_label.organization_id and s.client_id = v_label.client_id and s.status = 'scheduled' and s.service_id is not null
     and (s.caregiver_user_id = v_actor or s.caregiver_record_id = v_record)
     and now() >= s.starts_at - ogevia.visit_shift_early_arrival() and now() < s.ends_at
     and not ogevia.shift_is_called_out(s.id)
     and not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id and v.status not in ('voided', 'corrected'))
     and (select expected_start from ogevia.vv_expected_kinds(s.organization_id, s.id, s.service_id)) = 'home';
  if v_n = 0 then
    return jsonb_build_object('state', 'ready', 'action', 'none', 'reason',
      case when exists (select 1 from ogevia.shifts s where s.organization_id = v_label.organization_id and s.client_id = v_label.client_id and s.status = 'scheduled' and (s.caregiver_user_id = v_actor or s.caregiver_record_id = v_record) and s.ends_at > now() - interval '12 hours')
           then 'no_visit_in_window' else 'not_assigned' end,
      'organizationId', v_label.organization_id, 'clientCode', v_code);
  end if;
  return jsonb_build_object('state', 'ready', 'action', case when v_n = 1 then 'arrival' else 'choose' end, 'organizationId', v_label.organization_id, 'clientCode', v_code, 'city', v_loc.city, 'shifts', v_shifts);
end;
$$;

create or replace function ogevia_api.record_punch(
  p_label_hash text, p_organization_id uuid, p_intent text, p_shift_id uuid, p_visit_id uuid,
  p_latitude numeric, p_longitude numeric, p_accuracy_m integer, p_idempotency_key uuid, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_prior jsonb;
  v_label ogevia.home_labels%rowtype;
  v_org uuid;
  v_source text := case when p_label_hash is null then 'app' else 'label' end;
  v_record uuid;
  v_open ogevia.service_visits%rowtype;
  v_shift ogevia.shifts%rowtype;
  v_cands uuid[];
  v_kinds record;
  v_loc_id uuid;
  v_loc record;
  v_visit uuid;
  v_client uuid;
  v_outcome text := 'not_saved';
  v_reason text;
  v_message text;
  v_resp jsonb;
  v_punch uuid := gen_random_uuid();
  v_time_out timestamptz;
  v_signing text;
  v_settings ogevia.visit_verification_settings;
  v_choices jsonb := '[]'::jsonb;
  v_expected text;
  v_row_shift uuid;
  v_want text := case when p_label_hash is null then 'community' else 'home' end;
begin
  if p_idempotency_key is null then raise exception 'A retry key is required' using errcode = 'OGV22'; end if;
  if p_intent not in ('arrival', 'departure') then raise exception 'Intent must be arrival or departure' using errcode = 'OGV22'; end if;
  if p_latitude is not null and (p_latitude not between -90 and 90) or p_longitude is not null and (p_longitude not between -180 and 180) then
    raise exception 'The phone location is not valid' using errcode = 'OGV22';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ogevia.punch:' || v_actor::text, 0));
  -- A retry, reload or second tap with the SAME key returns the first answer; it never writes a second punch.
  select p.response into v_prior from ogevia.visit_punches p where p.caregiver_user_id = v_actor and p.idempotency_key = p_idempotency_key;
  if v_prior is not null then return v_prior || jsonb_build_object('replayed', true); end if;

  if v_source = 'label' then
    select * into v_label from ogevia.home_labels h where h.token_hash = p_label_hash for update;
    if v_label.id is null or not ogevia.is_active_caregiver(v_label.organization_id) then
      return jsonb_build_object('outcome', 'not_saved', 'reason', 'label_unavailable', 'message', 'This label cannot be used. Ask the office.');   -- nothing recorded: no agency to attach it to
    end if;
    v_org := v_label.organization_id;
    if p_organization_id is not null and p_organization_id <> v_org then
      return jsonb_build_object('outcome', 'not_saved', 'reason', 'label_unavailable', 'message', 'This label cannot be used. Ask the office.');
    end if;
    v_client := v_label.client_id;
    v_loc_id := v_label.service_location_id;
  else
    v_org := p_organization_id;
    if v_org is null or not ogevia.is_active_caregiver(v_org) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  end if;
  v_settings := ogevia.vv_settings(v_org);
  v_record := ogevia.my_caregiver_record(v_org);

  if v_source = 'label' and v_label.status <> 'active' then
    v_reason := 'label_revoked'; v_message := 'This label was replaced or turned off. Ask the office.';
  elsif p_intent = 'arrival' then
    select * into v_open from ogevia.service_visits v where v.caregiver_user_id = v_actor and v.status in ('draft', 'awaiting_signature') limit 1;
    if v_open.id is not null then
      -- An arrival NEVER becomes a checkout. The caregiver is told, and the departure is a separate, explicit action.
      v_reason := case when v_open.client_id = v_client and v_open.status = 'draft' then 'already_clocked_in'
                       when v_open.status = 'awaiting_signature' then 'previous_visit_not_finished' else 'open_visit_elsewhere' end;
      v_visit := v_open.id;
      v_message := case v_reason when 'already_clocked_in' then 'You are already clocked in here.' when 'previous_visit_not_finished' then 'Finish the signature on your last visit first.' else 'You have another visit open. Finish it first.' end;
      if v_reason = 'open_visit_elsewhere' then
        perform ogevia.vv_open_exception(v_org, 'overlap', 'overlap:' || v_open.id::text, v_open.id, null, v_actor, v_client, null, jsonb_build_object('attempt', 'arrival'));
      end if;
    else
      select coalesce(array_agg(s.id order by s.starts_at), '{}') into v_cands
        from ogevia.shifts s
       where s.organization_id = v_org and s.status = 'scheduled' and s.service_id is not null
         and (v_client is null or s.client_id = v_client)
         and (p_shift_id is null or s.id = p_shift_id)
         and (s.caregiver_user_id = v_actor or s.caregiver_record_id = v_record)
         and now() >= s.starts_at - ogevia.visit_shift_early_arrival() and now() < s.ends_at
         and not ogevia.shift_is_called_out(s.id)
         and not exists (select 1 from ogevia.service_visits v where v.scheduled_shift_id = s.id and v.status not in ('voided', 'corrected'))
         and (select expected_start from ogevia.vv_expected_kinds(s.organization_id, s.id, s.service_id)) = case when v_source = 'label' then 'home' else 'community' end;
      -- the client of an app clock-in comes from the caregiver's OWN shift only; a shift that is not hers names nothing
      if p_shift_id is not null and v_source = 'app' then v_client := (select s.client_id from ogevia.shifts s where s.id = p_shift_id and s.organization_id = v_org and (s.caregiver_user_id = v_actor or s.caregiver_record_id = v_record)); end if;
      if coalesce(array_length(v_cands, 1), 0) = 0 then
        v_reason := case
          when exists (select 1 from ogevia.shifts s where s.organization_id = v_org and (v_client is null or s.client_id = v_client) and (s.caregiver_user_id = v_actor or s.caregiver_record_id = v_record) and s.status = 'scheduled'
                          and now() >= s.starts_at - ogevia.visit_shift_early_arrival() and now() < s.ends_at
                          and (select expected_start from ogevia.vv_expected_kinds(s.organization_id, s.id, s.service_id)) <> case when v_source = 'label' then 'home' else 'community' end)
            then 'wrong_clock_in_method'
          when exists (select 1 from ogevia.shifts s where s.organization_id = v_org and (v_client is null or s.client_id = v_client) and (s.caregiver_user_id = v_actor or s.caregiver_record_id = v_record) and s.status = 'scheduled' and s.ends_at > now() - interval '12 hours')
            then 'no_visit_in_window'
          when exists (select 1 from ogevia.shifts s where s.organization_id = v_org and (v_client is null or s.client_id = v_client) and (s.caregiver_user_id = v_actor or s.caregiver_record_id = v_record) and s.status <> 'scheduled' and s.ends_at > now() - interval '12 hours')
            then 'visit_cancelled'
          else 'not_assigned' end;
        v_message := case v_reason when 'wrong_clock_in_method' then 'This visit starts another way. Use the method shown on your schedule.' when 'no_visit_in_window' then 'No visit is scheduled for you at this time. Nothing was clocked.'
                      when 'visit_cancelled' then 'This visit was cancelled or reassigned. Nothing was clocked.' else 'You are not assigned to this client. Nothing was clocked.' end;
        if v_reason in ('no_visit_in_window', 'visit_cancelled') then
          perform ogevia.vv_open_exception(v_org, 'failed_punch', 'failed:' || v_actor::text || ':' || coalesce(v_client::text, '-') || ':' || to_char(now(), 'YYYYMMDDHH24'), null, null, v_actor, v_client, null, jsonb_build_object('reason', v_reason, 'intent', 'arrival'));
        end if;
      elsif array_length(v_cands, 1) > 1 and p_shift_id is null then
        v_outcome := 'needs_choice'; v_reason := 'choose_visit'; v_message := 'Choose which visit you are starting.';
        select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'startsAt', s.starts_at, 'endsAt', s.ends_at) order by s.starts_at), '[]'::jsonb) into v_choices from ogevia.shifts s where s.id = any (v_cands);
      else
        select * into v_shift from ogevia.shifts s where s.id = v_cands[1];
        v_client := v_shift.client_id;
        begin
          v_visit := ogevia.vv_start_for_shift(v_org, v_shift.client_id, v_shift.service_id, p_idempotency_key, v_shift.id);
          v_outcome := 'saved';
        exception when others then
          v_visit := null; v_outcome := 'not_saved'; v_reason := 'start_refused'; v_message := sqlerrm;
          perform ogevia.vv_open_exception(v_org, 'failed_punch', 'failed:' || v_actor::text || ':' || v_shift.id::text, null, v_shift.id, v_actor, v_shift.client_id, null, jsonb_build_object('reason', 'start_refused', 'intent', 'arrival'));
        end;
      end if;
    end if;
    v_expected := case when v_source = 'label' then 'home' else 'community' end;
  else
    -- departure: the caregiver's own running visit; it must be the one at this label.
    select * into v_open from ogevia.service_visits v
     where v.caregiver_user_id = v_actor and v.organization_id = v_org and v.status = 'draft' and (p_visit_id is null or v.id = p_visit_id) limit 1 for update;
    if v_open.id is null then
      v_reason := 'no_active_visit'; v_message := 'You have no running visit to end.';
      perform ogevia.vv_open_exception(v_org, 'failed_punch', 'failed:' || v_actor::text || ':nodep:' || to_char(now(), 'YYYYMMDDHH24'), null, null, v_actor, v_client, null, jsonb_build_object('reason', v_reason, 'intent', 'departure'));
    elsif v_source = 'label' and v_open.client_id <> v_client then
      v_reason := 'wrong_home'; v_message := 'This is not the home of your running visit. Nothing was saved.'; v_visit := v_open.id;
      perform ogevia.vv_open_exception(v_org, 'failed_punch', 'failed:' || v_open.id::text || ':wronghome', v_open.id, v_open.scheduled_shift_id, v_actor, v_open.client_id, null, jsonb_build_object('reason', v_reason, 'intent', 'departure'));
    else
      v_client := v_open.client_id; v_visit := v_open.id;
      select * into v_shift from ogevia.shifts s where s.id = v_open.scheduled_shift_id;
      select * into v_kinds from ogevia.vv_expected_kinds(v_org, v_open.scheduled_shift_id, v_open.service_id);
      v_expected := v_kinds.expected_end;
      if v_expected <> v_want then
        v_reason := 'wrong_clock_out_method'; v_message := 'This visit ends another way. Use the method shown on your visit.';
      elsif v_open.time_in > now() - interval '1 minute' then
        v_reason := 'too_soon'; v_message := 'The visit started less than a minute ago. Nothing was ended.';
      elsif v_shift.id is not null and now() < v_shift.ends_at - make_interval(mins => v_settings.early_checkout_minutes) and not coalesce(p_confirm, false) then
        v_outcome := 'needs_confirmation'; v_reason := 'early_checkout'; v_message := 'This is much earlier than the scheduled end. Confirm to end the visit now.';
      else
        begin
          perform ogevia_api.end_service_visit(v_open.id);
          select v.time_out into v_time_out from ogevia.service_visits v where v.id = v_open.id;
          v_outcome := 'saved';
        exception when others then
          v_outcome := 'not_saved'; v_reason := 'end_refused'; v_message := sqlerrm;
          perform ogevia.vv_open_exception(v_org, 'failed_punch', 'failed:' || v_open.id::text || ':end', v_open.id, v_open.scheduled_shift_id, v_actor, v_open.client_id, null, jsonb_build_object('reason', 'end_refused', 'intent', 'departure'));
        end;
      end if;
    end if;
  end if;

  -- Location: compared with the expected endpoint only for a saved or reviewable punch at a known place.
  declare v_res record; v_cm uuid;
  begin
    if v_expected = 'community' and v_client is not null then
      select l.id into v_cm from ogevia.client_service_locations l where l.organization_id = v_org and l.client_id = v_client and l.kind = 'community' and l.is_active
       order by (case when l.latitude is null or p_latitude is null then 0 else ogevia.vv_distance_m(p_latitude, p_longitude, l.latitude, l.longitude) end), l.created_at limit 1;
      v_loc_id := v_cm;
    elsif v_expected = 'home' and v_loc_id is null and v_client is not null then
      select l.id into v_loc_id from ogevia.client_service_locations l where l.organization_id = v_org and l.client_id = v_client and l.kind = 'home' and l.is_active order by l.created_at limit 1;
    end if;
    select * into v_res from ogevia.vv_location_result(v_org, p_latitude, p_longitude, p_accuracy_m, v_loc_id);
    v_loc := v_res;
  end;

  v_signing := null;
  if v_outcome = 'saved' then
    if v_loc.result is distinct from 'within_range' then
      perform ogevia.vv_open_exception(v_org, 'location_issue', 'loc:' || v_visit::text || ':' || p_intent, v_visit, (select scheduled_shift_id from ogevia.service_visits where id = v_visit), v_actor, v_client, v_punch,
        jsonb_build_object('result', v_loc.result, 'distance_m', v_loc.distance_m, 'intent', p_intent, 'expected', v_expected));
    end if;
    if p_intent = 'departure' then
      v_signing := 'sign_now';
      -- Unexpected off-site checkout of a home-only visit goes to direct client confirmation: the caregiver phone is not offered for the signature.
      if v_source = 'label' and v_kinds.expected_start = 'home' and v_kinds.expected_end = 'home' and v_loc.result = 'outside_range' then
        v_signing := 'direct_required';
        insert into ogevia.visit_signature_followups (organization_id, visit_id, reason_code, direct_signing_required, opened_by)
        values (v_org, v_visit, 'off_site_checkout', true, v_actor) on conflict do nothing;
        perform ogevia.vv_sig_event(v_org, v_visit, 'deferred', null, jsonb_build_object('reason', 'off_site_checkout'));
        -- The visit leaves the caregiver's open state (existing unable_to_confirm path) so the next visit is not blocked; the client confirms directly through the office.
        perform ogevia_api.confirm_service_visit(v_visit, 'client', 'unable_to_confirm', null, null, null, 'Client confirmation required directly after an off-site checkout', null, null);
      end if;
    end if;
    if v_source = 'label' then update ogevia.home_labels set last_used_at = now() where id = v_label.id; end if;
  end if;

  select s.id into v_row_shift from ogevia.shifts s where s.organization_id = v_org and s.id = coalesce(v_open.scheduled_shift_id, v_shift.id, p_shift_id);
  v_resp := jsonb_build_object('outcome', v_outcome, 'reason', v_reason, 'message', v_message, 'intent', p_intent, 'visitId', v_visit, 'savedAt', case when v_outcome = 'saved' then now() end,
    'locationResult', v_loc.result, 'distanceM', v_loc.distance_m, 'signing', v_signing, 'choices', v_choices, 'organizationId', v_org);
  insert into ogevia.visit_punches (id, organization_id, caregiver_user_id, source, intent, outcome, reason, label_id, client_id, shift_id, visit_id, expected_kind, location_result, distance_m,
    device_latitude, device_longitude, accuracy_m, idempotency_key, response)
  values (v_punch, v_org, v_actor, v_source, p_intent, v_outcome, v_reason, v_label.id, v_client, v_row_shift, v_visit, v_expected, v_loc.result, v_loc.distance_m,
    p_latitude, p_longitude, p_accuracy_m, p_idempotency_key, v_resp);
  return v_resp;
end;
$$;

drop function if exists ogevia_api.list_client_service_addresses(uuid, uuid);
drop function if exists ogevia_api.list_service_location_history(uuid, uuid);
drop function if exists ogevia_api.set_service_location_state(uuid, uuid, text, text);
drop function if exists ogevia_api.delete_service_location(uuid, uuid, text);
drop trigger if exists client_service_locations_after_change on ogevia.client_service_locations;
drop trigger if exists client_service_locations_before_insert on ogevia.client_service_locations;
drop function if exists ogevia.scl_after_change();
drop function if exists ogevia.scl_before_insert();
drop index if exists ogevia.client_service_locations_one_current_home;
drop table if exists ogevia.service_location_events cascade;
drop function if exists ogevia.sle_log(uuid, uuid, uuid, text, text, jsonb);
drop function if exists ogevia.vv_log_denial(uuid, uuid, uuid, text, text);
drop function if exists ogevia.sle_guard();
alter table ogevia.client_service_locations drop constraint if exists client_service_locations_state_shape;
alter table ogevia.client_service_locations drop column if exists inactive_reason, drop column if exists inactive_by, drop column if exists inactive_at, drop column if exists inactive_kind;
