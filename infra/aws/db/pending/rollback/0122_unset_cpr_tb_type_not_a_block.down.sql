-- Rollback of 0122: restore the 0088 readiness_checks and compliance_blockers and the 0103 caregiver_readiness, then drop the helper.
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
  g record;
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
    -- 0088 (owner decision 2026-10-30): a MISSING or only-uploaded CPR/TB is a warning until its due date (hire date + the agency's days, or the
    -- administrator's extension). After that date it is blocked (a Warning while the agency is report-only). Rejected, expired, expiring before the
    -- work ends, or a rule that is not set up still block at once.
    if d.status in ('missing', 'awaiting_review') then
      select * into g from ogevia.compliance_grace_for(p_organization_id, p_caregiver_record_id, now(), d.requirement);
      if g.in_grace then
        return query select d.requirement, 'pending'::text, d.status,
                            ogevia.readiness_message(d.requirement, d.status) || ' Due ' || to_char(g.due_date, 'YYYY-MM-DD') || '.',
                            ogevia.readiness_enforced(p_organization_id, d.requirement, p_context);
        continue;
      end if;
    end if;
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
  v_days text := ogevia.compliance_grace_days(p_organization_id)::text || '-day';
begin
  v_bg := ogevia.background_clearance_state(p_organization_id, p_caregiver_record_id);
  if v_bg <> 'approved' then
    return query select 'background'::text, 'background_' || v_bg, ogevia.readiness_message('background', 'background_' || v_bg), true, null::date;
  end if;
  for r in select x from unnest(array['cpr', 'tb']) as x loop
    select * into c from ogevia.document_requirement_check(p_organization_id, p_caregiver_record_id, r, null, null);
    select * into g from ogevia.compliance_grace_for(p_organization_id, p_caregiver_record_id, p_as_of, r);
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

create or replace function ogevia.caregiver_readiness(p_organization_id uuid, p_caregiver_record_id uuid)
returns table (requirement text, label text, kind text, sort_order integer, state text, detail text, due_date date, met_on date,
               actor_name text, blocks_shifts boolean, next_action text, extra jsonb)
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  v_rec ogevia.caregiver_records%rowtype;
  v_tz text;
  b ogevia.caregiver_background_checks%rowtype;
  v_bg text;
  v_name text;
  t record;
  v_inv ogevia.caregiver_invitations%rowtype;
  d record;
  g record;
  r text;
  v_enf boolean;
  v_ovr ogevia.caregiver_signin_overrides%rowtype;
  v_ovr_name text;
begin
  select * into v_rec from ogevia.caregiver_records c
  where c.id = p_caregiver_record_id and c.organization_id = p_organization_id and c.deleted_at is null;
  if v_rec.id is null then return; end if;
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;

  -- 1. Background check: caregiver_background_checks is the ONE canonical record (0055).
  select * into b from ogevia.caregiver_background_checks x where x.caregiver_record_id = v_rec.id;
  v_bg := ogevia.background_clearance_state(p_organization_id, v_rec.id);
  if v_bg = 'approved' then
    select u.display_name into v_name from ogevia.app_users u where u.id = b.verified_by;
    return query select 'background'::text, 'Background check'::text, 'hard'::text, 10, 'met'::text, 'Verified'::text, null::date,
                        (b.verified_at at time zone coalesce(v_tz, 'UTC'))::date, v_name, false, 'view'::text, '{}'::jsonb;
  else
    return query select 'background'::text, 'Background check'::text, 'hard'::text, 10, 'unmet'::text,
                        (case v_bg when 'not_recorded' then 'Not started' when 'not_started' then 'Not started' when 'not_approved' then 'Not approved'
                                   when 'completed_not_approved' then 'Completed, but no approved result is verified yet'
                                   else 'In progress' end)::text,
                        null::date, null::date, null::text, false, 'verify'::text, '{}'::jsonb;
  end if;

  -- 2. Required training (0054 onboarding item), only while the agency still requires it.
  select * into t from ogevia.onboarding_checklist(p_organization_id, v_rec.id) c where c.requirement_key = 'training' and c.required;
  if t.requirement_key is not null then
    if t.state in ('done', 'waived') then
      return query select 'training'::text, 'Required training'::text, 'hard'::text, 20, 'met'::text, (case when t.state = 'waived' then 'Waived' else 'Done' end)::text,
                          null::date, t.completed_on, null::text, false, 'reopen'::text, jsonb_build_object('requirementId', t.requirement_id);
    else
      return query select 'training'::text, 'Required training'::text, 'hard'::text, 20, 'unmet'::text, (case when t.state = 'expired' then 'Expired' else 'Not recorded' end)::text,
                          null::date, null::date, null::text, false, 'record'::text, jsonb_build_object('requirementId', t.requirement_id);
    end if;
  end if;

  -- 3. App sign-in.
  select * into v_inv from ogevia.caregiver_invitations i where i.organization_id = p_organization_id and i.caregiver_record_id = v_rec.id;
  if ogevia.caregiver_has_signed_in(p_organization_id, v_rec.id) then
    return query select 'signin'::text, 'App sign-in'::text, 'hard'::text, 30, 'met'::text, 'Signed in'::text, null::date,
                        (v_inv.first_signed_in_at at time zone coalesce(v_tz, 'UTC'))::date, null::text, false, 'none'::text, '{}'::jsonb;
  elsif ogevia.caregiver_has_signin_override(p_organization_id, v_rec.id) then
    -- An administrator approved this caregiver for work before the first sign-in (reason, approver and time are on the override record). The row is met, not skipped:
    -- the badge "Approved by override: not signed in" stays until the first real sign-in turns the first branch on. The reason is NOT repeated here.
    select * into v_ovr from ogevia.caregiver_signin_overrides o where o.caregiver_record_id = v_rec.id;
    select u.display_name into v_ovr_name from ogevia.app_users u where u.id = v_ovr.approved_by;
    return query select 'signin'::text, 'App sign-in'::text, 'hard'::text, 30, 'met'::text, 'Approved by override: not signed in'::text, null::date,
                        (v_ovr.approved_at at time zone coalesce(v_tz, 'UTC'))::date, v_ovr_name, false, 'none'::text, jsonb_build_object('override', true);
  else
    return query select 'signin'::text, 'App sign-in'::text, 'hard'::text, 30, 'unmet'::text,
                        (case when not ogevia.caregiver_has_contact(p_organization_id, v_rec.id) then 'No email on file'
                              when v_inv.id is null then 'Not invited yet'
                              else 'Invited, has not signed in yet' end)::text,
                        null::date, null::date, null::text, false,
                        (case when not ogevia.caregiver_has_contact(p_organization_id, v_rec.id) then 'add_contact'
                              when v_inv.id is null then 'send_link' else 'resend_link' end)::text,
                        jsonb_build_object('lastSentAt', v_inv.last_sent_at, 'sendCount', v_inv.send_count);
  end if;

  -- 4 and 5. CPR and TB: flexible, due within the agency's days of the hire date, or the administrator's extension.
  foreach r in array array['cpr', 'tb'] loop
    select * into d from ogevia.document_requirement_check(p_organization_id, v_rec.id, r, null, null);
    select * into g from ogevia.compliance_grace_for(p_organization_id, v_rec.id, now(), r);
    v_enf := ogevia.readiness_enforced(p_organization_id, r, 'shift');
    if d.status = 'ok' then
      return query select r, (case r when 'cpr' then 'CPR certificate' else 'TB clearance' end)::text, 'flexible'::text, (case r when 'cpr' then 40 else 50 end), 'met'::text,
                          'Verified'::text, d.valid_until, null::date, null::text, false, 'none'::text, '{}'::jsonb;
    elsif d.status in ('missing', 'awaiting_review') then
      return query select r, (case r when 'cpr' then 'CPR certificate' else 'TB clearance' end)::text, 'flexible'::text, (case r when 'cpr' then 40 else 50 end),
                          (case when g.in_grace then 'pending' else 'overdue' end)::text,
                          (case d.status when 'missing' then 'Not uploaded' else 'Uploaded, waiting for review' end ||
                           case when g.hire_date is null then ' (hire date not recorded)' else '' end)::text,
                          g.due_date, null::date, null::text, (not g.in_grace) and v_enf, 'upload'::text, '{}'::jsonb;
    else
      return query select r, (case r when 'cpr' then 'CPR certificate' else 'TB clearance' end)::text, 'flexible'::text, (case r when 'cpr' then 40 else 50 end), 'problem'::text,
                          (case d.status when 'rejected' then 'Rejected' when 'expired' then 'Expired' when 'expiry_missing' then 'Expiry date missing'
                                         when 'policy_not_set' then 'Agency document rule not set up' when 'type_not_set' then 'Document type not set up'
                                         else 'Not current' end)::text,
                          g.due_date, null::date, null::text, v_enf, 'upload'::text, '{}'::jsonb;
    end if;
  end loop;
end;
$$;

drop function if exists ogevia.caregiver_has_work_approval(uuid, uuid);
