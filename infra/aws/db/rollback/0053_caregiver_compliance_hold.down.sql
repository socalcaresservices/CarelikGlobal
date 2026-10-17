-- ROLLBACK 0053_caregiver_compliance_hold | CLASS: BACKUP REQUIRED (drops tables that hold hire dates, background-check results and hold history)
-- Restores the 0047 gate (no background check, no 14-day period) and removes the compliance objects. Hire dates, verified
-- background-check results and hold history are DELETED with their tables: take a snapshot first and export them if they are needed.
-- Shifts, visits, assignments and documents are never touched. 'compliance' flags are deleted (they are advice only); audit
-- events written by this release stay.
drop trigger if exists document_versions_compliance on ogevia.document_versions;
drop trigger if exists staff_documents_compliance on ogevia.staff_documents;
drop trigger if exists shifts_compliance_commit on ogevia.shifts;
drop trigger if exists assignments_compliance_commit on ogevia.caregiver_assignments;
drop function ogevia_api.system_compliance_sweep_org(uuid);
drop function ogevia_api.system_compliance_orgs();
drop function ogevia_api.run_compliance_sweep(uuid);
drop function ogevia_api.get_compliance_summary(uuid);
drop function ogevia_api.get_compliance_attention(uuid);
drop function ogevia_api.list_compliance_holds(uuid);
drop function ogevia_api.verify_background_check(uuid, uuid, text, text, uuid);
drop function ogevia_api.set_background_check_status(uuid, uuid, text, text, uuid);
drop function ogevia_api.set_caregiver_hire_date(uuid, uuid, date, text, uuid);
drop function ogevia_api.get_caregiver_compliance(uuid, uuid);
drop function ogevia.compliance_snapshot(uuid, uuid);
drop function ogevia.compliance_read_guard(uuid);
drop function ogevia.compliance_document_trigger();
drop function ogevia.compliance_commit_guard();
drop function ogevia.assert_compliance_for_commit(uuid, uuid);
drop function ogevia.compliance_sweep(uuid, uuid, timestamptz);
drop function ogevia.compliance_evaluate(uuid, uuid, uuid, timestamptz);
drop function ogevia.compliance_flag_impact(uuid, uuid, uuid, jsonb, uuid);

-- The 0047 gate and its helpers, restored (the gate no longer references the functions dropped below).
create or replace function ogevia.readiness_message(p_check text, p_code text)
returns text
language sql
immutable
set search_path = ogevia, pg_temp
as $$
  select case
    when p_check in ('cpr', 'tb') then
      upper(p_check) || case p_code
        when 'missing' then ' missing.'
        when 'awaiting_review' then ' needs review.'
        when 'rejected' then ' rejected.'
        when 'expired' then ' expired.'
        when 'expires_during' then ' expires before this work ends.'
        when 'expiry_missing' then ' expiry date missing.'
        when 'policy_not_set' then ' rule not set (setup incomplete).'
        when 'type_not_set' then ' record not set up (setup incomplete).'
        else ' not current.' end
    when p_check = 'service' then
      case p_code
        when 'service_partial' then 'Not approved for this service for the whole shift.'
        when 'service_revoked' then 'Service approval revoked.'
        when 'service_expired' then 'Service approval expired.'
        else 'Not approved for this service.' end
    when p_check = 'availability' then
      case p_code
        when 'availability_not_provided' then 'Availability not provided.'
        when 'availability_override' then 'Availability overridden by an administrator.'
        else 'Outside approved hours.' end
    when p_check = 'conflict' then 'Already booked.'
    when p_check = 'caregiver' then 'Caregiver is not active.'
    when p_check = 'client' then 'A mandatory client requirement is not met.'
    else 'Not ready.' end;
$$;

create or replace function ogevia.readiness_enforced(p_organization_id uuid, p_check text, p_context text)
returns boolean
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare s ogevia.organization_readiness_settings%rowtype; v_active boolean;
begin
  select * into s from ogevia.organization_readiness_settings x where x.organization_id = p_organization_id;
  v_active := s.organization_id is not null and s.enforcement_active_from is not null and s.enforcement_active_from <= now();
  return case p_check
    when 'caregiver' then true
    when 'conflict' then true
    when 'cpr' then v_active
    when 'tb' then v_active
    when 'client' then true
    when 'availability' then v_active or p_context = 'care_request'
    when 'service' then v_active and coalesce(s.service_checks, false)
    else v_active end;
end;
$$;

create or replace function ogevia.readiness_checks(
  p_organization_id uuid, p_caregiver_record_id uuid, p_service_id uuid, p_starts timestamptz, p_ends timestamptz,
  p_context text default 'shift', p_exclude_shift uuid default null, p_client_id uuid default null, p_with_conflict boolean default false
)
returns table (check_name text, status text, code text, message text, enforced boolean)
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  v_rec ogevia.caregiver_records%rowtype;
  v_st text;
  d record;
  i record;
  v_ov boolean;
begin
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  if p_context = 'assignment' then
    -- A standing assignment may be prepared for a caregiver who is not Ready yet; it grants nothing until they are.
    null;
  elsif v_rec.id is null or v_rec.status not in ('ready', 'active') then
    return query select 'caregiver'::text, 'blocked'::text, 'caregiver_not_active'::text, ogevia.readiness_message('caregiver', null), true;
  else
    return query select 'caregiver'::text, 'ok'::text, null::text, null::text, true;
  end if;

  if p_service_id is null then
    return query select 'service'::text, 'not_checked'::text, null::text, null::text, false;
  else
    v_st := ogevia.service_approval_status(p_organization_id, p_caregiver_record_id, p_service_id, p_starts, p_ends);
    return query select 'service'::text, case when v_st = 'approved' then 'ok' else 'blocked' end,
                        case when v_st = 'approved' then null else 'service_' || v_st end,
                        case when v_st = 'approved' then null else ogevia.readiness_message('service', 'service_' || v_st) end,
                        ogevia.readiness_enforced(p_organization_id, 'service', p_context);
  end if;

  for d in select * from ogevia.document_readiness(p_organization_id, p_caregiver_record_id, p_starts, p_ends) loop
    return query select d.requirement, case when d.status = 'ok' then 'ok' else 'blocked' end,
                        case when d.status = 'ok' then null else d.status end,
                        case when d.status = 'ok' then null else ogevia.readiness_message(d.requirement, d.status) end,
                        ogevia.readiness_enforced(p_organization_id, d.requirement, p_context);
  end loop;

  if p_context in ('shift', 'care_request', 'reschedule', 'series', 'visit_start') then
    v_st := ogevia.availability_status(p_organization_id, p_caregiver_record_id, p_starts, p_ends);
    if v_st = 'covered' then
      return query select 'availability'::text, 'ok'::text, null::text, null::text, ogevia.readiness_enforced(p_organization_id, 'availability', p_context);
    else
      v_ov := ogevia.availability_override_for(p_organization_id, p_caregiver_record_id, p_starts, p_ends, p_context, p_client_id) is not null;
      if v_ov then
        return query select 'availability'::text, 'overridden'::text, 'availability_override'::text,
                            ogevia.readiness_message('availability', 'availability_override'), ogevia.readiness_enforced(p_organization_id, 'availability', p_context);
      else
        return query select 'availability'::text, 'blocked'::text, 'availability_' || v_st,
                            ogevia.readiness_message('availability', 'availability_' || v_st), ogevia.readiness_enforced(p_organization_id, 'availability', p_context);
      end if;
    end if;
  end if;

  if p_with_conflict then
    if exists (
      select 1 from ogevia.shifts s
      where s.organization_id = p_organization_id and s.id is distinct from p_exclude_shift
        and (s.caregiver_record_id = p_caregiver_record_id or (v_rec.linked_user_id is not null and s.caregiver_user_id = v_rec.linked_user_id))
        and s.status in ('scheduled', 'completed') and not ogevia.shift_is_called_out(s.id)
        and s.starts_at < p_ends and s.ends_at > p_starts) then
      return query select 'conflict'::text, 'blocked'::text, 'already_booked'::text, ogevia.readiness_message('conflict', null), true;
    else
      return query select 'conflict'::text, 'ok'::text, null::text, null::text, true;
    end if;
  end if;

  if p_client_id is not null then
    for i in select * from ogevia.client_requirement_issues(p_organization_id, p_client_id, p_caregiver_record_id) loop
      return query select 'client'::text, 'blocked'::text, i.code, coalesce(i.message, ogevia.readiness_message('client', null)),
                          ogevia.readiness_enforced(p_organization_id, 'client', p_context);
    end loop;
  end if;
end;
$$;

create or replace function ogevia.readiness_outcome(
  p_organization_id uuid, p_caregiver_record_id uuid, p_service_id uuid, p_starts timestamptz, p_ends timestamptz
)
returns text
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select case
    when bool_or(c.check_name in ('cpr', 'tb')) then 'documents_not_current'
    when bool_or(c.check_name = 'service') then 'service_not_approved'
    when bool_or(c.check_name = 'availability' and c.code = 'availability_not_provided') then 'availability_not_provided'
    when bool_or(c.check_name = 'availability') then 'availability_outside'
  end
  from ogevia.readiness_checks(p_organization_id, p_caregiver_record_id, p_service_id, p_starts, p_ends, 'series') c
  where c.status = 'blocked' and c.enforced and c.check_name <> 'caregiver';
$$;


drop function ogevia.compliance_blockers(uuid, uuid, timestamptz);
drop function ogevia.background_clearance_state(uuid, uuid);
drop function ogevia.compliance_grace(uuid, uuid, timestamptz);
drop function ogevia.compliance_grace_days();

delete from ogevia.shift_readiness_flags where kind = 'compliance';
delete from ogevia.assignment_readiness_flags where kind = 'compliance';
delete from ogevia.shift_series_skipped_dates where reason = 'compliance_hold';
alter table ogevia.shift_readiness_flags drop constraint shift_readiness_flags_kind_check;
alter table ogevia.shift_readiness_flags add constraint shift_readiness_flags_kind_check check (kind in ('availability', 'service', 'document'));
alter table ogevia.assignment_readiness_flags drop constraint assignment_readiness_flags_kind_check;
alter table ogevia.assignment_readiness_flags add constraint assignment_readiness_flags_kind_check check (kind in ('service', 'document'));
alter table ogevia.shift_series_skipped_dates drop constraint shift_series_skipped_dates_reason_check;
alter table ogevia.shift_series_skipped_dates add constraint shift_series_skipped_dates_reason_check check (
  reason in ('exceeds_authorization', 'no_authorization', 'caregiver_conflict', 'already_started',
             'time_does_not_exist', 'time_occurs_twice',
             'documents_not_current', 'service_not_approved', 'availability_outside', 'availability_not_provided'));

drop table ogevia.caregiver_compliance_holds;
drop table ogevia.caregiver_background_checks;
alter table ogevia.caregiver_records drop column hire_date;
delete from ogevia.role_permissions where permission_key = 'caregivers.compliance.manage';
delete from ogevia.permissions where key = 'caregivers.compliance.manage';
