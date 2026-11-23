-- ROLLBACK 0088 | CLASS: BACKUP REQUIRED (drops tables, with their rows: CPR/TB extensions, work approvals, caregiver contacts, the due-days setting).
-- Restores the 0087/0081/0066/0064/0055/0054/0048/0025 function definitions (list_accounts as 0087 left it, with the staff-invitation account_status order) and the 14-day rule, and re-activates the onboarding requirements 0086 retired
-- (only those whose category is background_check, document or clearance). Status and onboarding items are untouched. Run only after a verified backup.

drop function if exists ogevia_api.get_caregiver_readiness(uuid, uuid);
drop function if exists ogevia_api.approve_caregiver_for_work(uuid, uuid, uuid);
drop function if exists ogevia_api.extend_cpr_tb_due_date(uuid, uuid, text, date, text, uuid);
drop function if exists ogevia_api.list_cpr_tb_extensions(uuid, uuid);
drop function if exists ogevia_api.get_compliance_settings(uuid);
drop function if exists ogevia_api.set_cpr_tb_due_days(uuid, integer, text, uuid);
drop function if exists ogevia_api.set_caregiver_contact(uuid, uuid, text, text, uuid);
drop function if exists ogevia_api.get_signin_contact(uuid, uuid);

create or replace function ogevia.compliance_blockers(p_organization_id uuid, p_caregiver_record_id uuid, p_as_of timestamptz default now())
returns table (requirement text, code text, message text, blocking boolean, due_date date)
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  g record;
  c record;
  r text;
  v_bg text;
  v_base text;
  v_days text := ogevia.compliance_grace_days()::text || '-day';
begin
  select * into g from ogevia.compliance_grace(p_organization_id, p_caregiver_record_id, p_as_of);
  v_bg := ogevia.background_clearance_state(p_organization_id, p_caregiver_record_id);
  if v_bg <> 'approved' then
    return query select 'background'::text, 'background_' || v_bg, ogevia.readiness_message('background', 'background_' || v_bg), true, null::date;
  end if;
  for r in select x from unnest(array['cpr', 'tb']) as x loop
    select * into c from ogevia.document_requirement_check(p_organization_id, p_caregiver_record_id, r, null, null);
    if c.status = 'ok' then continue; end if;
    if c.status in ('missing', 'awaiting_review') then
      v_base := ogevia.readiness_message(r, c.status);
      if g.in_grace then
        return query select r, c.status || '_pending', v_base || ' Due ' || to_char(g.due_date, 'YYYY-MM-DD') || '.', false, g.due_date;
      elsif g.hire_date is null then
        return query select r, c.status || '_no_hire_date',
          v_base || ' Hire date is not recorded, so the ' || v_days || ' period cannot be applied.', true, null::date;
      elsif g.sticky then
        return query select r, c.status || '_after_deadline',
          v_base || ' A compliance hold is open for this caregiver. It is released only when this requirement is verified; entering or changing the hire date does not release it.', true, g.due_date;
      else
        return query select r, c.status || '_after_deadline',
          v_base || ' The ' || v_days || ' period ended ' || to_char(g.due_date, 'YYYY-MM-DD') || '.', true, g.due_date;
      end if;
    else
      -- rejected, expired, expires_during, expiry_missing, type_not_set, policy_not_set: unchanged strict behaviour
      return query select r, c.status, ogevia.readiness_message(r, c.status), true, null::date;
    end if;
  end loop;
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
    'shiftRisks', coalesce((select jsonb_agg(jsonb_build_object('shiftId', x.shift_id, 'startsAt', x.starts_at, 'endsAt', x.ends_at, 'requirement', x.requirement,
                                                                   'documentStatus', x.document_status, 'validUntil', x.valid_until, 'inProgress', x.in_progress,
                                                                   'visitId', x.visit_id) order by x.starts_at, x.requirement)
                            from ogevia.shift_document_risks(p_organization_id, p_caregiver_record_id) x), '[]'::jsonb),
    'eligible', not exists (select 1 from ogevia.compliance_blockers(p_organization_id, p_caregiver_record_id) k where k.blocking),
    'hireDateRequired', g.hire_date is null and exists (select 1 from jsonb_array_elements(v_req) e where (e ->> 'current')::boolean is not true));
end;
$$;
create or replace function ogevia_api.get_compliance_summary(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  c record;
  n integer := 0; n_bg integer := 0; n_pending integer := 0; n_deadline integer := 0; n_nohire integer := 0; n_strict integer := 0; n_hold integer := 0; n_wouldhold integer := 0;
  v_block boolean; v_pending boolean; v_bg boolean; v_dead boolean; v_nohire boolean; v_strict boolean;
begin
  perform ogevia.compliance_read_guard(p_organization_id);
  for c in select r.id from ogevia.caregiver_records r
           where r.organization_id = p_organization_id and r.deleted_at is null and r.status in ('ready', 'active') loop
    n := n + 1;
    select coalesce(bool_or(k.blocking), false), coalesce(bool_or(not k.blocking), false),
           coalesce(bool_or(k.requirement = 'background' and k.blocking), false),
           coalesce(bool_or(k.code like '%\_after\_deadline'), false), coalesce(bool_or(k.code like '%\_no\_hire\_date'), false),
           coalesce(bool_or(k.requirement in ('cpr', 'tb') and k.blocking and k.code not like '%\_after\_deadline' and k.code not like '%\_no\_hire\_date'), false)
      into v_block, v_pending, v_bg, v_dead, v_nohire, v_strict
    from ogevia.compliance_blockers(p_organization_id, c.id) k;
    if v_block then n_wouldhold := n_wouldhold + 1; end if;
    if v_bg then n_bg := n_bg + 1; end if;
    if v_pending and not v_block then n_pending := n_pending + 1; end if;
    if v_dead then n_deadline := n_deadline + 1; end if;
    if v_nohire then n_nohire := n_nohire + 1; end if;
    if v_strict then n_strict := n_strict + 1; end if;
  end loop;
  select count(*)::int into n_hold from ogevia.caregiver_compliance_holds h where h.organization_id = p_organization_id and h.released_at is null;
  return jsonb_build_object(
    'enforcementActive', ogevia.readiness_enforced(p_organization_id, 'background', 'visit_start'),
    'graceDays', ogevia.compliance_grace_days(),
    'readyOrActive', n, 'wouldBeHeld', n_wouldhold, 'withoutApprovedBackground', n_bg, 'insideGracePending', n_pending,
    'pastDeadline', n_deadline, 'hireDateMissing', n_nohire, 'strictDocumentProblem', n_strict, 'openHolds', n_hold);
end;
$$;
create or replace function ogevia.readiness_checks(p_organization_id uuid, p_caregiver_record_id uuid, p_service_id uuid, p_starts timestamp with time zone, p_ends timestamp with time zone, p_context text DEFAULT 'shift'::text, p_exclude_shift uuid DEFAULT NULL::uuid, p_client_id uuid DEFAULT NULL::uuid, p_with_conflict boolean DEFAULT false)
 RETURNS TABLE(check_name text, status text, code text, message text, enforced boolean)
 LANGUAGE plpgsql
 STABLE
 set search_path = ogevia, pg_temp
AS $$
declare
  v_rec ogevia.caregiver_records%rowtype;
  v_st text;
  d record;
  i record;
  v_ov boolean;
  v_bg text;
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

  if p_context <> 'visit_start' and v_rec.id is not null and v_rec.onboarding_required then
    declare v_open text[];
    begin
      v_open := ogevia.onboarding_outstanding(p_organization_id, v_rec.id, false);
      if cardinality(v_open) > 0 then
        return query select 'onboarding'::text, 'blocked'::text, 'onboarding_incomplete'::text,
          ('Onboarding incomplete: ' || array_to_string(v_open, ', ') || '.')::text, true;
      else
        return query select 'onboarding'::text, 'ok'::text, null::text, null::text, true;
      end if;
    end;
  end if;

  -- Background-check clearance (0055): only a VERIFIED APPROVED result qualifies. "Completed" alone never does.
  v_bg := ogevia.background_clearance_state(p_organization_id, p_caregiver_record_id);
  if v_bg = 'approved' then
    return query select 'background'::text, 'ok'::text, null::text, null::text, ogevia.readiness_enforced(p_organization_id, 'background', p_context);
  else
    return query select 'background'::text, 'blocked'::text, 'background_' || v_bg, ogevia.readiness_message('background', 'background_' || v_bg),
                        ogevia.readiness_enforced(p_organization_id, 'background', p_context);
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

  -- CPR / TB (0081, owner correction): ONLY a VERIFIED, CURRENT document qualifies. A document that is missing, uploaded but still awaiting review, rejected, expired,
  -- expiring before the work ends, without an expiry date, or whose agency rule/type is not set up all produce the same result: status 'blocked' (Blocked when
  -- enforcement is active, a Warning while the agency is report-only). The 14-day period from the hire date (0055) no longer lets work go ahead; it still governs only
  -- when an automatic compliance HOLD is opened (ogevia.compliance_blockers, unchanged). The period is no longer read here.
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

  if p_context in ('shift', 'care_request', 'reschedule', 'series') and v_rec.id is not null then
    declare
      v_lim ogevia.caregiver_hour_limits%rowtype;
      v_issue text;
      h record;
      v_tz text;
      v_date date;
      v_min integer;
    begin
      v_lim := ogevia.effective_hour_limit(p_organization_id, p_caregiver_record_id);
      if v_lim.id is not null then
        select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
        v_date := (p_starts at time zone v_tz)::date;
        v_min := floor(extract(epoch from (p_ends - p_starts)) / 60)::integer;
        select * into h from ogevia.hour_limit_detail(p_organization_id, p_caregiver_record_id, p_starts, p_ends, p_exclude_shift);
        v_issue := h.issue;
        if v_issue is null then
          return query select 'hours'::text, 'ok'::text, null::text, null::text, v_lim.mode = 'block';
        else
          return query select 'hours'::text, 'blocked'::text, v_issue || '_hour_limit', ogevia.hour_limit_message(h.issue, h.actual_minutes, h.allowed_minutes), v_lim.mode = 'block';
        end if;
      end if;
    end;
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
create or replace function ogevia_api.set_caregiver_status(p_organization_id uuid, p_caregiver_record_id uuid, p_status text, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS TABLE(ended_assignments integer, sign_in_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = ogevia, pg_temp
AS $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.caregiver_admin_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_caregiver_record_id, p_status);
  v_prior jsonb;
  v_rec ogevia.caregiver_records%rowtype;
  v_today date := ogevia.organization_local_date(p_organization_id, now());
  v_ended integer := 0;
  v_sign_in text;
  v_open text[];
  v_pre boolean := p_status in ('applicant', 'interview', 'offer', 'onboarding', 'pending_documents');
begin
  v_prior := ogevia.idempotency_begin('set_caregiver_status', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'ended_assignments')::integer, v_prior ->> 'sign_in_status';
    return;
  end if;
  if p_status is null or p_status not in ('applicant', 'interview', 'offer', 'onboarding', 'pending_documents', 'ready', 'active', 'inactive') then
    raise exception 'Choose a status' using errcode = 'OGV22';
  end if;
  if length(v_reason) not between 3 and 500 then
    raise exception 'Give a reason for the status change' using errcode = 'OGV22';
  end if;
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null for update;
  if v_rec.id is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  if v_rec.status = p_status then raise exception 'The caregiver already has this status' using errcode = 'OGC09'; end if;

  -- Moving a person who is already Approved or Active back a stage (paperwork, a pause) does not put them on the checklist;
  -- every other move into a stage before Approved does (a new applicant, or someone returning from Inactive).
  -- Approval gate: a record that needs onboarding cannot become Approved ('ready') or Active until every required item is satisfied.
  if p_status in ('ready', 'active') and v_rec.onboarding_required then
    v_open := ogevia.onboarding_outstanding(p_organization_id, v_rec.id, true);
    if cardinality(v_open) > 0 then
      raise exception 'Onboarding is not complete: %', array_to_string(v_open, ', ') using errcode = 'OGC09';
    end if;
  end if;
  if p_status = 'inactive' then
    if exists (select 1 from ogevia.service_visits v where v.organization_id = p_organization_id and v.status = 'draft'
               and (v.caregiver_record_id = v_rec.id or (v_rec.linked_user_id is not null and v.caregiver_user_id = v_rec.linked_user_id))) then
      raise exception 'This caregiver has a visit in progress; end or close it first' using errcode = 'OGC09';
    end if;
    update ogevia.caregiver_assignments a
       set is_active = false, effective_end = greatest(a.effective_start, v_today), updated_at = now()
     where a.organization_id = p_organization_id and a.is_active
       and (a.caregiver_record_id = v_rec.id or (v_rec.linked_user_id is not null and a.caregiver_user_id = v_rec.linked_user_id));
    get diagnostics v_ended = row_count;
    if v_rec.linked_user_id is not null then
      update ogevia.organization_memberships m set status = 'suspended', updated_at = now()
       where m.organization_id = p_organization_id and m.user_id = v_rec.linked_user_id and m.role = 'caregiver' and m.status = 'active';
    end if;
  elsif v_rec.status = 'inactive' and v_rec.linked_user_id is not null then
    update ogevia.organization_memberships m set status = 'active', updated_at = now()
     where m.organization_id = p_organization_id and m.user_id = v_rec.linked_user_id and m.role = 'caregiver' and m.status = 'suspended';
  end if;
  update ogevia.caregiver_records set status = p_status, onboarding_required = onboarding_required or (v_pre and v_rec.status not in ('ready', 'active')), updated_at = now() where id = v_rec.id;
  select m.status::text into v_sign_in from ogevia.organization_memberships m
   where m.organization_id = p_organization_id and m.user_id = v_rec.linked_user_id and m.role = 'caregiver';
  perform ogevia.write_audit(p_organization_id, 'caregiver.status_changed', 'caregiver_records', v_rec.id,
    jsonb_build_object('status', v_rec.status, 'onboarding_required', v_rec.onboarding_required),
    jsonb_build_object('status', p_status, 'onboarding_required', v_rec.onboarding_required or (v_pre and v_rec.status not in ('ready', 'active')), 'ended_assignments', v_ended, 'sign_in_status', v_sign_in), v_reason);
  perform ogevia.idempotency_finish('set_caregiver_status', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('ended_assignments', v_ended, 'sign_in_status', v_sign_in));
  return query select v_ended, v_sign_in;
end;
$$;
create or replace function ogevia_api.begin_invitation_resend(p_organization_id uuid, p_caregiver_record_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.caregiver_admin_guard(p_organization_id);
  v_inv ogevia.caregiver_invitations%rowtype;
begin
  select i.* into v_inv from ogevia.caregiver_invitations i
  join ogevia.caregiver_records r on r.id = i.caregiver_record_id and r.organization_id = i.organization_id
   and r.deleted_at is null and r.linked_user_id = i.user_id
  where i.organization_id = p_organization_id and i.caregiver_record_id = p_caregiver_record_id;
  if v_inv.id is null then raise exception 'This caregiver has not been invited' using errcode = 'OGN04'; end if;
  if v_inv.first_signed_in_at is not null then
    raise exception 'This caregiver has already signed in; if they are locked out they can reset their sign-in from the sign-in page' using errcode = 'OGC09';
  end if;
  if v_inv.existing_account then
    raise exception 'This caregiver already had a sign-in; ask them to sign in with it, or reset it from the sign-in page' using errcode = 'OGC09';
  end if;
  return v_inv.email;
end;
$$;
drop function ogevia_api.list_caregivers(uuid);
create function ogevia_api.list_caregivers(p_organization_id uuid)
 RETURNS TABLE(caregiver_record_id uuid, caregiver_code text, first_name text, last_name text, preferred_name text, status text, has_sign_in boolean, sign_in_status text, active_assignments integer, open_visits integer, updated_at timestamp with time zone, invitation_email text, invited_at timestamp with time zone, invitation_last_sent_at timestamp with time zone, invitation_send_count integer, first_signed_in_at timestamp with time zone, planned_assignments integer, hire_type text, scheduling_mode text, onboarding_required boolean, onboarding_done integer, onboarding_total integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 set search_path = ogevia, pg_temp
AS $$
  select cr.id, cr.caregiver_code, cr.first_name, cr.last_name, cr.preferred_name, cr.status,
         cr.linked_user_id is not null,
         m.status::text,
         (select count(*)::integer from ogevia.caregiver_assignments a
           where a.organization_id = cr.organization_id and a.is_active
             and (a.caregiver_record_id = cr.id or (a.caregiver_record_id is null and a.caregiver_user_id = cr.linked_user_id))
             and (a.effective_end is null or a.effective_end >= ogevia.organization_local_date(cr.organization_id, now()))),
         (select count(*)::integer from ogevia.service_visits v
           where v.organization_id = cr.organization_id and v.status = 'draft'
             and (v.caregiver_record_id = cr.id or (cr.linked_user_id is not null and v.caregiver_user_id = cr.linked_user_id))),
         cr.updated_at,
         i.email, i.invited_at, i.last_sent_at, i.send_count, i.first_signed_in_at,
         (select count(*)::integer from ogevia.caregiver_assignments a
           where a.organization_id = cr.organization_id and a.is_active and a.caregiver_record_id = cr.id
             and a.caregiver_user_id is null
             and (a.effective_end is null or a.effective_end >= ogevia.organization_local_date(cr.organization_id, now()))),
         cr.hire_type, cr.scheduling_mode, cr.onboarding_required,
         (select count(*)::integer from ogevia.onboarding_checklist(cr.organization_id, cr.id) k where k.required and k.state in ('done', 'waived')),
         (select count(*)::integer from ogevia.onboarding_checklist(cr.organization_id, cr.id) k where k.required)
  from ogevia.caregiver_records cr
  left join ogevia.organization_memberships m on m.organization_id = cr.organization_id and m.user_id = cr.linked_user_id and m.role = 'caregiver'
  left join ogevia.caregiver_invitations i on i.organization_id = cr.organization_id and i.caregiver_record_id = cr.id
  where ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and ogevia.has_permission(p_organization_id, 'visits.read')
    and cr.organization_id = p_organization_id and cr.deleted_at is null
  order by case cr.status when 'active' then 0 when 'ready' then 1 when 'pending_documents' then 2 when 'onboarding' then 3 when 'offer' then 4 when 'interview' then 5 when 'applicant' then 6 else 7 end, lower(cr.last_name), lower(cr.first_name);
$$;
drop function ogevia_api.list_accounts(uuid);
create function ogevia_api.list_accounts(p_organization_id uuid)
returns table (
  user_id uuid, display_name text, role text, membership_status text, account_status text,
  caregiver_record_id uuid, caregiver_code text, caregiver_name text,
  invited_at timestamptz, first_signed_in_at timestamptz, is_self boolean
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.accounts_manage_guard(p_organization_id);
begin
  return query
  select x.* from (
    select u.id as user_id,
           coalesce(nullif(btrim(u.display_name), ''), case when cr.id is not null then coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name end) as display_name,
           m.role::text as role, m.status::text as membership_status,
           case when m.status = 'invited' then 'invitation_pending'
                when m.status = 'suspended' or u.status = 'disabled' then 'disabled'
                when i.id is not null and i.first_signed_in_at is null then 'invitation_pending'
                else 'active' end as account_status,
           cr.id as caregiver_record_id, cr.caregiver_code as caregiver_code,
           case when cr.id is not null then coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name end as caregiver_name,
           i.invited_at as invited_at, i.first_signed_in_at as first_signed_in_at, (u.id = v_actor) as is_self
    from ogevia.organization_memberships m
    join ogevia.app_users u on u.id = m.user_id
    left join ogevia.caregiver_records cr on cr.organization_id = m.organization_id and cr.linked_user_id = u.id and cr.deleted_at is null
    left join ogevia.caregiver_invitations i on i.organization_id = m.organization_id and i.user_id = u.id
    where m.organization_id = p_organization_id and m.status <> 'revoked'
    union all
    select null::uuid, coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name, 'caregiver', 'none', 'setup_required',
           cr.id, cr.caregiver_code, coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name, null::timestamptz, null::timestamptz, false
    from ogevia.caregiver_records cr
    where cr.organization_id = p_organization_id and cr.linked_user_id is null and cr.deleted_at is null and cr.status <> 'inactive'
  ) x
  order by (x.account_status = 'disabled'), lower(coalesce(x.display_name, '')), x.caregiver_code;
end;
$$;

drop function ogevia.caregiver_readiness_summary(uuid, uuid);
drop function ogevia.caregiver_work_status(uuid, uuid);
drop function ogevia.caregiver_readiness(uuid, uuid);
drop function ogevia.caregiver_has_contact(uuid, uuid);
drop function ogevia.caregiver_has_signed_in(uuid, uuid);

create or replace function ogevia.compliance_grace_days()
returns integer language sql immutable set search_path = ogevia, pg_temp as $$ select 14; $$;

drop function ogevia.compliance_grace_days(uuid);

create or replace function ogevia.compliance_grace(p_organization_id uuid, p_caregiver_record_id uuid, p_as_of timestamptz default now())
returns table (hire_date date, due_date date, grace_ends_at timestamptz, in_grace boolean, sticky boolean)
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  v_hire date;
  v_tz text;
  v_ends timestamptz;
  v_sticky boolean;
begin
  select r.hire_date into v_hire from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id;
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  v_sticky := exists (select 1 from ogevia.caregiver_compliance_holds h
                      where h.caregiver_record_id = p_caregiver_record_id and h.released_at is null and h.grace_closed);
  if v_hire is not null and v_tz is not null then
    v_ends := (v_hire + ogevia.compliance_grace_days() + 1)::timestamp at time zone v_tz;
  end if;
  return query select v_hire,
                      case when v_hire is null then null::date else v_hire + ogevia.compliance_grace_days() end,
                      v_ends,
                      coalesce(v_ends is not null and p_as_of < v_ends and not v_sticky, false),
                      v_sticky;
end;
$$;

drop function ogevia.compliance_grace_for(uuid, uuid, timestamptz, text);

create or replace function ogevia.ensure_onboarding_defaults(p_organization_id uuid)
returns void
language sql
set search_path = ogevia, pg_temp
as $$
  insert into ogevia.onboarding_requirements (organization_id, requirement_key, label, category, document_requirement, sort_order)
  select p_organization_id, v.k, v.l, v.c, v.d, v.s
  from (values
    ('background_check', 'Background check cleared', 'background_check', null::text, 10),
    ('training', 'Required training completed', 'training', null::text, 20),
    ('cpr', 'CPR certificate current', 'document', 'cpr', 30),
    ('tb', 'TB clearance current', 'document', 'tb', 40),
    ('clearance', 'Compliance clearance', 'clearance', null::text, 90)) v (k, l, c, d, s)
  where not exists (select 1 from ogevia.onboarding_requirements r where r.organization_id = p_organization_id)
  on conflict do nothing;
$$;

update ogevia.onboarding_requirements set is_active = true, updated_at = now() where not is_active and category in ('background_check', 'document', 'clearance');

revoke all on function ogevia_api.list_caregivers(uuid) from public;
revoke all on function ogevia_api.list_accounts(uuid) from public;
grant execute on function ogevia_api.list_caregivers(uuid) to ogevia_app;
grant execute on function ogevia_api.list_accounts(uuid) to ogevia_app;
drop table ogevia.caregiver_contacts;
drop table ogevia.caregiver_work_approvals;
drop table ogevia.caregiver_cpr_tb_extensions;
drop table ogevia.organization_compliance_settings;
drop function ogevia.append_only_guard();
