-- ROLLBACK 0066 | CLASS: SAFE AUTOMATED (no table or row is touched). Restores the 0055 list/snapshot and the 0064 attention functions, then drops the new function.
create or replace function ogevia_api.get_compliance_attention(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) or not ogevia.has_permission(p_organization_id, 'readiness.read') then
    return null;
  end if;
  return jsonb_build_object(
    'holds', (select count(*) from ogevia.caregiver_compliance_holds h where h.organization_id = p_organization_id and h.released_at is null),
    'affectedShifts', (select count(*) from ogevia.shift_readiness_flags f
                       where f.organization_id = p_organization_id and f.kind = 'compliance' and f.resolved_at is null),
    -- live (0064): a visit in progress for a caregiver who is blocked NOW is counted without waiting for the next sweep to open the hold row
    'inProgressVisits', (select count(*) from ogevia.service_visits v
                         join ogevia.caregiver_records cr on cr.organization_id = v.organization_id
                          and (cr.id = v.caregiver_record_id or (v.caregiver_record_id is null and cr.linked_user_id = v.caregiver_user_id))
                         where v.organization_id = p_organization_id and v.status = 'draft' and v.time_out is null
                           and ogevia.caregiver_blocked_now(p_organization_id, cr.id)));
end;
$$;
create or replace function ogevia_api.list_compliance_holds(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare v_holds jsonb; v_tot jsonb;
begin
  perform ogevia.compliance_read_guard(p_organization_id);
  select coalesce(jsonb_agg(x.j order by x.opened_at), '[]'::jsonb) into v_holds
  from (
    select h.opened_at,
      jsonb_build_object(
        'holdId', h.id, 'caregiverRecordId', h.caregiver_record_id, 'caregiverCode', r.caregiver_code,
        'caregiverName', concat_ws(' ', coalesce(r.preferred_name, r.first_name), r.last_name),
        'openedAt', h.opened_at, 'automatic', h.opened_by is null, 'reasons', h.reasons,
        'affectedShifts', coalesce((
          select jsonb_agg(jsonb_build_object('flagId', f.id, 'shiftId', s.id, 'startsAt', s.starts_at, 'endsAt', s.ends_at,
                                               'clientCode', c.client_code, 'seriesId', s.series_id) order by s.starts_at)
          from ogevia.shift_readiness_flags f
          join ogevia.shifts s on s.id = f.shift_id
          left join ogevia.clients c on c.id = s.client_id
          where f.caregiver_record_id = h.caregiver_record_id and f.kind = 'compliance' and f.resolved_at is null), '[]'::jsonb),
        'affectedAssignments', coalesce((
          select jsonb_agg(jsonb_build_object('flagId', f.id, 'assignmentId', ca.id, 'clientCode', c.client_code,
                                               'effectiveStart', ca.effective_start, 'effectiveEnd', ca.effective_end) order by ca.effective_start)
          from ogevia.assignment_readiness_flags f
          join ogevia.caregiver_assignments ca on ca.id = f.assignment_id
          left join ogevia.clients c on c.id = ca.client_id
          where f.caregiver_record_id = h.caregiver_record_id and f.kind = 'compliance' and f.resolved_at is null), '[]'::jsonb),
        'inProgressVisits', coalesce((
          select jsonb_agg(jsonb_build_object('visitId', v.id, 'timeIn', v.time_in, 'clientCode', c.client_code, 'shiftId', v.scheduled_shift_id) order by v.time_in)
          from ogevia.service_visits v
          left join ogevia.clients c on c.id = v.client_id
          where v.organization_id = p_organization_id and v.status = 'draft' and v.time_out is null
            and (v.caregiver_record_id = h.caregiver_record_id or (v.caregiver_record_id is null and r.linked_user_id is not null and v.caregiver_user_id = r.linked_user_id))), '[]'::jsonb)
      ) as j
    from ogevia.caregiver_compliance_holds h
    join ogevia.caregiver_records r on r.id = h.caregiver_record_id and r.organization_id = h.organization_id
    where h.organization_id = p_organization_id and h.released_at is null
  ) x;
  select jsonb_build_object(
           'holds', jsonb_array_length(v_holds),
           'affectedShifts', coalesce(sum(jsonb_array_length(e -> 'affectedShifts')), 0),
           'affectedAssignments', coalesce(sum(jsonb_array_length(e -> 'affectedAssignments')), 0),
           'inProgressVisits', coalesce(sum(jsonb_array_length(e -> 'inProgressVisits')), 0))
    into v_tot from jsonb_array_elements(v_holds) e;
  return jsonb_build_object('holds', v_holds, 'totals', v_tot);
end;
$$;
create or replace function ogevia.compliance_snapshot(p_organization_id uuid, p_caregiver_record_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  v_rec ogevia.caregiver_records%rowtype;
  g record;
  b ogevia.caregiver_background_checks%rowtype;
  h ogevia.caregiver_compliance_holds%rowtype;
  v_tz text;
  v_req jsonb;
  v_hold jsonb := null;
  v_bg jsonb;
  v_name text;
begin
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  if v_rec.id is null then raise exception 'Care Team member not found' using errcode = 'OGN04'; end if;
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  select * into g from ogevia.compliance_grace(p_organization_id, p_caregiver_record_id);
  select * into b from ogevia.caregiver_background_checks x where x.caregiver_record_id = p_caregiver_record_id;
  select u.display_name into v_name from ogevia.app_users u where u.id = b.verified_by;
  v_bg := jsonb_build_object(
    'state', ogevia.background_clearance_state(p_organization_id, p_caregiver_record_id),
    'qualifies', ogevia.background_clearance_state(p_organization_id, p_caregiver_record_id) = 'approved',
    'status', coalesce(b.status, 'not_started'), 'result', b.result, 'evidenceNote', b.evidence_note,
    'verifiedAt', b.verified_at, 'verifiedByName', v_name);
  select coalesce(jsonb_agg(jsonb_build_object(
           'requirement', d.requirement, 'documentStatus', d.status, 'validUntil', d.valid_until, 'documentId', d.document_id,
           'blocking', coalesce(k.blocking, false), 'pending', k.blocking is false, 'current', d.status = 'ok',
           'code', k.code, 'message', k.message, 'dueDate', k.due_date) order by d.requirement), '[]'::jsonb)
    into v_req
  from ogevia.document_readiness(p_organization_id, p_caregiver_record_id) d
  left join ogevia.compliance_blockers(p_organization_id, p_caregiver_record_id) k on k.requirement = d.requirement;
  select * into h from ogevia.caregiver_compliance_holds x where x.caregiver_record_id = p_caregiver_record_id and x.released_at is null;
  if h.id is not null then
    v_hold := jsonb_build_object('id', h.id, 'openedAt', h.opened_at, 'automatic', h.opened_by is null, 'reasons', h.reasons, 'graceClosed', h.grace_closed);
  end if;
  return jsonb_build_object(
    'caregiverRecordId', v_rec.id, 'caregiverStatus', v_rec.status,
    'enforcementActive', ogevia.readiness_enforced(p_organization_id, 'background', 'visit_start'),
    'timezone', v_tz, 'graceDays', ogevia.compliance_grace_days(),
    'hireDate', g.hire_date, 'dueDate', g.due_date, 'graceEndsAt', g.grace_ends_at, 'inGrace', g.in_grace,
    'deadlineRule', 'Hire date is day 0. The last day is the hire date plus ' || ogevia.compliance_grace_days() || ' calendar days in the agency time zone ('
                    || coalesce(v_tz, 'not set') || '). A hold starts at 00:00 the next day.',
    'background', v_bg, 'requirements', v_req, 'hold', v_hold,
    'eligible', not exists (select 1 from ogevia.compliance_blockers(p_organization_id, p_caregiver_record_id) k where k.blocking),
    'hireDateRequired', g.hire_date is null and exists (select 1 from jsonb_array_elements(v_req) e where (e ->> 'current')::boolean is not true));
end;
$$;
drop function ogevia.shift_document_risks(uuid, uuid);
