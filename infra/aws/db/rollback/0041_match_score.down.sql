-- ROLLBACK 0041_match_score | CLASS: SAFE AUTOMATED (refuses while any experience, support need, location, decision or non-default match setting exists)
-- Restores the 0039 readiness check (no client-requirement check, no "availability not provided" label) and drops
-- the matching functions and tables. Refuses while any record exists: experience entries and their verification,
-- client support needs, stored ZIP codes, the ZIP reference table, assignment decisions (the audit of who chose whom)
-- or a changed match setting. Matching is read-only, so to stop USING it, simply stop calling it.
do $$ begin
  if exists (select 1 from ogevia.experience_tags) or exists (select 1 from ogevia.caregiver_experience)
     or exists (select 1 from ogevia.caregiver_experience_reviews) or exists (select 1 from ogevia.client_support_preferences)
     or exists (select 1 from ogevia.client_locations) or exists (select 1 from ogevia.caregiver_locations)
     or exists (select 1 from ogevia.zip_centroids) or exists (select 1 from ogevia.assignment_decisions)
     or exists (select 1 from ogevia.agency_readiness_settings where match_radius_miles <> 15 or not match_location_enabled) then
    raise exception 'ROLLBACK REFUSED: experience, support needs, locations, ZIP reference data, assignment decisions or match settings exist; they are kept';
  end if;
end $$;

drop function ogevia_api.get_client_location(uuid, uuid);
drop function ogevia_api.get_caregiver_location(uuid, uuid);
drop function ogevia_api.set_caregiver_location(uuid, uuid, text, integer);
drop function ogevia_api.set_client_location(uuid, uuid, text);
drop function ogevia_api.list_client_support_preferences(uuid, uuid);
drop function ogevia_api.remove_client_support_preference(uuid, text);
drop function ogevia_api.set_client_support_preference(uuid, uuid, uuid, integer, boolean, text);
drop function ogevia_api.list_caregiver_experience(uuid, uuid);
drop function ogevia_api.mark_experience_reviewed(uuid, uuid);
drop function ogevia_api.review_experience(uuid, text, text);
drop function ogevia_api.record_experience(uuid, uuid, uuid, text, boolean);
drop function ogevia_api.list_experience_tags(uuid);
drop function ogevia_api.set_experience_tag_active(uuid, uuid, boolean, text);
drop function ogevia_api.create_experience_tag(uuid, text);
drop function ogevia_api.set_match_settings(uuid, numeric, boolean, text);
drop function ogevia_api.get_match_settings(uuid);
drop function ogevia_api.list_assignment_decisions(uuid, uuid);
drop function ogevia_api.record_decision_for_series(uuid, uuid, text, text);
drop function ogevia_api.record_decision_for_care_request(uuid, uuid, text, text);
drop function ogevia_api.record_decision_for_shift(uuid, uuid, text, text);
drop function ogevia_api.record_assignment_decision(uuid, uuid, uuid, uuid, jsonb, text, uuid, text, text, uuid, boolean);
drop function ogevia_api.list_match_candidates(uuid, uuid, uuid, jsonb, uuid);
drop function ogevia.match_candidate(uuid, uuid, uuid, uuid, jsonb, uuid, boolean);

create or replace function ogevia.assignment_readiness(
  p_organization_id uuid,
  p_caregiver_record_id uuid,
  p_client_id uuid,
  p_service_id uuid,
  p_starts timestamptz,
  p_ends timestamptz default null,
  p_exclude_shift uuid default null,
  p_availability text default 'setting',
  p_check_conflicts boolean default true,
  p_check_authorization boolean default true
)
returns jsonb
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  v_set record;
  v_tz text;
  v_end timestamptz;
  v_first date;
  v_last date;
  v_rec ogevia.caregiver_records%rowtype;
  v_checks jsonb := '[]'::jsonb;
  v_reasons jsonb := '[]'::jsonb;
  v_blocked boolean := false;
  v_override boolean := false;
  v_unchecked jsonb := '[]'::jsonb;
  v_items jsonb := '[]'::jsonb;
  v_state text;
  v_dt record;
  v_avail_on boolean;
  v_ok boolean;
begin
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  if v_tz is null then
    return jsonb_build_object('ready', false, 'blocked', true, 'needs_override', false,
      'reasons', jsonb_build_array(jsonb_build_object('code', 'NO_AGENCY', 'label', 'Agency not found')), 'checks', '[]'::jsonb);
  end if;
  v_end := coalesce(p_ends, p_starts + interval '1 minute');
  v_first := (p_starts at time zone v_tz)::date;
  v_last := ((v_end - interval '1 microsecond') at time zone v_tz)::date;
  select * into v_set from ogevia.readiness_settings(p_organization_id);

  -- 1. Caregiver status
  select * into v_rec from ogevia.caregiver_records r
   where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  v_ok := v_rec.id is not null and v_rec.status in ('ready', 'active');
  v_checks := v_checks || jsonb_build_object('key', 'status', 'status', case when v_ok then 'pass' else 'fail' end,
    'code', case when v_ok then null else 'CAREGIVER_STATUS' end, 'label', case when v_ok then 'Active' else 'Not ready to work' end);
  if not v_ok then
    v_blocked := true;
    v_reasons := v_reasons || jsonb_build_object('code', 'CAREGIVER_STATUS', 'label', 'Not ready to work');
  end if;

  -- 2. Required documents, over the whole interval in agency local dates
  for v_dt in
    select dt.id, dt.name from ogevia.document_types dt
     where dt.organization_id = p_organization_id and dt.is_active and dt.required_for_work
     order by lower(dt.name)
  loop
    v_state := ogevia.document_requirement_state(p_organization_id, p_caregiver_record_id, v_dt.id, v_first, v_last);
    if v_state <> 'ok' then
      v_items := v_items || jsonb_build_object('document_type_id', v_dt.id, 'name', v_dt.name,
        'code', 'DOC_' || upper(v_state), 'label', ogevia.document_state_label(v_dt.name, v_state),
        'pending_replacement', v_state <> 'pending' and ogevia.document_has_pending(p_organization_id, p_caregiver_record_id, v_dt.id));
      v_reasons := v_reasons || jsonb_build_object('code', 'DOC_' || upper(v_state), 'label', ogevia.document_state_label(v_dt.name, v_state));
      v_blocked := true;
    end if;
  end loop;
  v_checks := v_checks || jsonb_build_object('key', 'documents',
    'status', case when jsonb_array_length(v_items) > 0 then 'fail'
                   when exists (select 1 from ogevia.document_types dt where dt.organization_id = p_organization_id and dt.is_active and dt.required_for_work) then 'pass'
                   else 'not_required' end,
    'label', case when jsonb_array_length(v_items) > 0 then 'Documents blocked'
                  when exists (select 1 from ogevia.document_types dt where dt.organization_id = p_organization_id and dt.is_active and dt.required_for_work) then 'Documents current'
                  else 'No documents required' end,
    'items', v_items);

  -- 3. Service approval (separate from the client's authorization)
  if v_set.service_checks_enabled then
    v_ok := exists (
      select 1 from ogevia.caregiver_service_approvals a
       where a.organization_id = p_organization_id and a.caregiver_record_id = p_caregiver_record_id
         and a.service_id = p_service_id and a.revoked_at is null
         and a.effective_from <= v_first and (a.effective_to is null or a.effective_to >= v_last));
    v_checks := v_checks || jsonb_build_object('key', 'service', 'status', case when v_ok then 'pass' else 'fail' end,
      'code', case when v_ok then null else 'SERVICE_NOT_APPROVED' end, 'label', case when v_ok then 'Service approved' else 'Service not approved' end);
    if not v_ok then
      v_blocked := true;
      v_reasons := v_reasons || jsonb_build_object('code', 'SERVICE_NOT_APPROVED', 'label', 'Service not approved');
    end if;
  else
    v_checks := v_checks || jsonb_build_object('key', 'service', 'status', 'unchecked', 'label', 'Approval unchecked');
    v_unchecked := v_unchecked || to_jsonb('service'::text);
  end if;

  -- 4. Approved availability (current approved windows and exceptions only)
  v_avail_on := p_availability = 'force' or (p_availability = 'setting' and v_set.availability_required);
  if p_availability = 'skip' then
    v_checks := v_checks || jsonb_build_object('key', 'availability', 'status', 'not_applicable', 'label', 'Not checked here');
  elsif v_avail_on then
    v_ok := ogevia.availability_covers(p_organization_id, p_caregiver_record_id, v_tz, p_starts, v_end, v_first, v_last)
      and not exists (select 1 from ogevia.caregiver_unavailable_dates u
                       where u.organization_id = p_organization_id and u.caregiver_record_id = p_caregiver_record_id
                         and u.unavailable_date between v_first and v_last);
    v_checks := v_checks || jsonb_build_object('key', 'availability', 'status', case when v_ok then 'pass' else 'fail' end,
      'code', case when v_ok then null else 'AVAILABILITY' end, 'label', case when v_ok then 'Available' else 'Outside availability' end,
      'overridable', not v_ok);
    if not v_ok then
      v_override := true;
      v_reasons := v_reasons || jsonb_build_object('code', 'AVAILABILITY', 'label', 'Outside availability');
    end if;
  else
    v_checks := v_checks || jsonb_build_object('key', 'availability', 'status', 'unchecked', 'label', 'Availability unchecked');
    v_unchecked := v_unchecked || to_jsonb('availability'::text);
  end if;

  -- 5. Client authorization exists on the service dates (hours stay with the booking rules)
  if p_check_authorization then
    v_ok := exists (select 1 from ogevia.resolve_current_authorization(p_organization_id, p_client_id, p_service_id, v_first) a where a.id is not null)
        and exists (select 1 from ogevia.resolve_current_authorization(p_organization_id, p_client_id, p_service_id, v_last) a where a.id is not null);
    v_checks := v_checks || jsonb_build_object('key', 'authorization', 'status', case when v_ok then 'pass' else 'fail' end,
      'code', case when v_ok then null else 'AUTH_MISSING' end, 'label', case when v_ok then 'Authorized' else 'No authorization' end);
    if not v_ok then
      v_blocked := true;
      v_reasons := v_reasons || jsonb_build_object('code', 'AUTH_MISSING', 'label', 'No authorization');
    end if;
  else
    v_checks := v_checks || jsonb_build_object('key', 'authorization', 'status', 'not_applicable', 'label', 'Not checked here');
  end if;

  -- 6. Conflicts with the caregiver's other shifts
  if p_check_conflicts then
    v_ok := not exists (
      select 1 from ogevia.shifts s
       where s.organization_id = p_organization_id and s.id is distinct from p_exclude_shift
         and (s.caregiver_record_id = p_caregiver_record_id
              or (v_rec.linked_user_id is not null and s.caregiver_user_id = v_rec.linked_user_id))
         and s.status in ('scheduled', 'completed') and not ogevia.shift_is_called_out(s.id)
         and s.starts_at < v_end and s.ends_at > p_starts);
    v_checks := v_checks || jsonb_build_object('key', 'conflicts', 'status', case when v_ok then 'pass' else 'fail' end,
      'code', case when v_ok then null else 'TIME_CONFLICT' end, 'label', case when v_ok then 'No conflict' else 'Already booked' end);
    if not v_ok then
      v_blocked := true;
      v_reasons := v_reasons || jsonb_build_object('code', 'TIME_CONFLICT', 'label', 'Already booked');
    end if;
  else
    v_checks := v_checks || jsonb_build_object('key', 'conflicts', 'status', 'not_applicable', 'label', 'Not checked here');
  end if;

  return jsonb_build_object(
    'ready', not v_blocked and not v_override,
    'blocked', v_blocked,
    'needs_override', v_override and not v_blocked,
    'service_checks', case when v_set.service_checks_enabled then 'on' else 'off' end,
    'availability_checks', case when v_avail_on then 'on' else 'off' end,
    'unchecked', v_unchecked,
    'interval', jsonb_build_object('starts_at', p_starts, 'ends_at', v_end, 'first_date', v_first, 'last_date', v_last, 'timezone', v_tz),
    'checks', v_checks,
    'reasons', v_reasons);
end;
$$;

drop function ogevia.caregiver_verified_tags(uuid, uuid);
drop function ogevia.availability_covered_minutes(uuid, uuid, text, timestamptz, timestamptz, date, date);
drop function ogevia.approx_distance_miles(text, text);

drop table ogevia.assignment_decisions;
drop table ogevia.caregiver_locations;
drop table ogevia.client_locations;
drop table ogevia.zip_centroids;
drop table ogevia.client_support_preferences;
drop function ogevia.client_support_guard_update();
drop table ogevia.caregiver_experience_reviews;
drop table ogevia.caregiver_experience;
drop function ogevia.caregiver_experience_guard_update();
drop table ogevia.experience_tags;
drop function ogevia.match_settings(uuid);
alter table ogevia.agency_readiness_settings drop column match_location_enabled, drop column match_radius_miles;
