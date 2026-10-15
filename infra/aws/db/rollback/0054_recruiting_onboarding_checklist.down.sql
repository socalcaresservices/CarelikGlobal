-- ROLLBACK 0054_recruiting_onboarding_checklist | CLASS: SAFE AUTOMATED (refuses when records would be lost)
-- Refuses while any caregiver is in one of the four new stages (applicant, interview, offer, pending_documents), any record needs
-- onboarding, any onboarding item is recorded, any requirement differs from the five defaults, or dates were skipped for an
-- incomplete onboarding (export them first: they would be lost). Otherwise restores the pre-0054 functions exactly and removes 0054.
do $$ begin
  if exists (select 1 from ogevia.caregiver_records where status in ('applicant', 'interview', 'offer', 'pending_documents')) then
    raise exception 'ROLLBACK REFUSED: caregivers are in applicant, interview, offer or pending-documents stages; move them first (the stages would be lost)';
  end if;
  if exists (select 1 from ogevia.caregiver_records where onboarding_required) then
    raise exception 'ROLLBACK REFUSED: caregivers are on the onboarding checklist; export it first (it would be lost)';
  end if;
  if exists (select 1 from ogevia.caregiver_onboarding_items) then
    raise exception 'ROLLBACK REFUSED: onboarding items are recorded; export them first (they would be lost)';
  end if;
  if exists (select 1 from ogevia.onboarding_requirements where requirement_key not in ('background_check', 'training', 'cpr', 'tb', 'clearance')
             or not is_active or not required or validity_months is not null or hire_type is not null) then
    raise exception 'ROLLBACK REFUSED: the agency changed its onboarding requirements; export them first (they would be lost)';
  end if;
  if exists (select 1 from ogevia.shift_series_skipped_dates where reason = 'onboarding_incomplete') then
    raise exception 'ROLLBACK REFUSED: dates skipped for incomplete onboarding exist; export them first';
  end if;
end $$;

drop trigger caregiver_assignments_onboarding_gate on ogevia.caregiver_assignments;
drop function ogevia.assignment_onboarding_gate();
drop function ogevia_api.set_onboarding_requirement(uuid, text, text, text, boolean, integer, text, boolean, text);
drop function ogevia_api.list_onboarding_requirements(uuid);
drop function ogevia_api.record_onboarding_item(uuid, uuid, text, text, date, date, text, text);
drop function ogevia_api.start_onboarding(uuid, uuid);
drop function ogevia_api.list_onboarding_overview(uuid);
drop function ogevia_api.get_onboarding(uuid, uuid);
drop function ogevia.onboarding_summary(uuid, uuid);
drop function ogevia.onboarding_read_guard(uuid);
drop function ogevia_api.list_caregivers(uuid);
create function ogevia_api.list_caregivers(p_organization_id uuid)
 RETURNS TABLE(caregiver_record_id uuid, caregiver_code text, first_name text, last_name text, preferred_name text, status text, has_sign_in boolean, sign_in_status text, active_assignments integer, open_visits integer, updated_at timestamp with time zone, invitation_email text, invited_at timestamp with time zone, invitation_last_sent_at timestamp with time zone, invitation_send_count integer, first_signed_in_at timestamp with time zone, planned_assignments integer, hire_type text, scheduling_mode text)
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
         cr.hire_type, cr.scheduling_mode
  from ogevia.caregiver_records cr
  left join ogevia.organization_memberships m on m.organization_id = cr.organization_id and m.user_id = cr.linked_user_id and m.role = 'caregiver'
  left join ogevia.caregiver_invitations i on i.organization_id = cr.organization_id and i.caregiver_record_id = cr.id
  where ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and ogevia.has_permission(p_organization_id, 'visits.read')
    and cr.organization_id = p_organization_id and cr.deleted_at is null
  order by case cr.status when 'active' then 0 when 'ready' then 1 when 'onboarding' then 2 else 3 end, lower(cr.last_name), lower(cr.first_name);
$$;

create or replace function ogevia_api.create_caregiver(p_organization_id uuid, p_first_name text, p_last_name text, p_preferred_name text DEFAULT NULL::text, p_status text DEFAULT 'onboarding'::text, p_idempotency_key uuid DEFAULT NULL::uuid)
 RETURNS TABLE(caregiver_record_id uuid, caregiver_code text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 set search_path = ogevia, pg_temp
AS $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.caregiver_admin_guard(p_organization_id);
  v_first text := btrim(coalesce(p_first_name, ''));
  v_last text := btrim(coalesce(p_last_name, ''));
  v_pref text := nullif(btrim(coalesce(p_preferred_name, '')), '');
  v_fp text := concat_ws('|', p_organization_id, v_first, v_last, v_pref, p_status);
  v_prior jsonb;
  v_id uuid := gen_random_uuid();
  v_code text;
begin
  v_prior := ogevia.idempotency_begin('create_caregiver', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'caregiver_record_id')::uuid, v_prior ->> 'caregiver_code';
    return;
  end if;
  perform ogevia.check_caregiver_names(v_first, v_last, v_pref);
  if p_status is null or p_status not in ('onboarding', 'ready', 'active') then
    raise exception 'A new caregiver starts as onboarding, ready or active' using errcode = 'OGV22';
  end if;
  loop
    v_code := 'CG-' || upper(left(replace(gen_random_uuid()::text, '-', ''), 8));
    exit when not exists (select 1 from ogevia.caregiver_records r where r.organization_id = p_organization_id and r.caregiver_code = v_code);
  end loop;
  insert into ogevia.caregiver_records (id, organization_id, caregiver_code, first_name, last_name, preferred_name, status)
  values (v_id, p_organization_id, v_code, v_first, v_last, v_pref, p_status);
  perform ogevia.write_audit(p_organization_id, 'caregiver.created', 'caregiver_records', v_id, null,
    jsonb_build_object('caregiver_code', v_code, 'first_name', v_first, 'last_name', v_last, 'preferred_name', v_pref, 'status', p_status), null);
  perform ogevia.idempotency_finish('create_caregiver', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('caregiver_record_id', v_id, 'caregiver_code', v_code));
  return query select v_id, v_code;
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
begin
  v_prior := ogevia.idempotency_begin('set_caregiver_status', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'ended_assignments')::integer, v_prior ->> 'sign_in_status';
    return;
  end if;
  if p_status is null or p_status not in ('onboarding', 'ready', 'active', 'inactive') then
    raise exception 'Choose a status' using errcode = 'OGV22';
  end if;
  if length(v_reason) not between 3 and 500 then
    raise exception 'Give a reason for the status change' using errcode = 'OGV22';
  end if;
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null for update;
  if v_rec.id is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  if v_rec.status = p_status then raise exception 'The caregiver already has this status' using errcode = 'OGC09'; end if;

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
  update ogevia.caregiver_records set status = p_status, updated_at = now() where id = v_rec.id;
  select m.status::text into v_sign_in from ogevia.organization_memberships m
   where m.organization_id = p_organization_id and m.user_id = v_rec.linked_user_id and m.role = 'caregiver';
  perform ogevia.write_audit(p_organization_id, 'caregiver.status_changed', 'caregiver_records', v_rec.id,
    jsonb_build_object('status', v_rec.status),
    jsonb_build_object('status', p_status, 'ended_assignments', v_ended, 'sign_in_status', v_sign_in), v_reason);
  perform ogevia.idempotency_finish('set_caregiver_status', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('ended_assignments', v_ended, 'sign_in_status', v_sign_in));
  return query select v_ended, v_sign_in;
end;
$$;

create or replace function ogevia.readiness_outcome(p_organization_id uuid, p_caregiver_record_id uuid, p_service_id uuid, p_starts timestamp with time zone, p_ends timestamp with time zone)
 RETURNS text
 LANGUAGE sql
 STABLE
 set search_path = ogevia, pg_temp
AS $$
  select case
    when bool_or(c.check_name in ('cpr', 'tb')) then 'documents_not_current'
    when bool_or(c.check_name = 'service') then 'service_not_approved'
    when bool_or(c.check_name = 'availability' and c.code = 'availability_not_provided') then 'availability_not_provided'
    when bool_or(c.check_name = 'availability') then 'availability_outside'
    when bool_or(c.check_name = 'hours') then 'over_hour_limit'
  end
  from ogevia.readiness_checks(p_organization_id, p_caregiver_record_id, p_service_id, p_starts, p_ends, 'series') c
  where c.status = 'blocked' and c.enforced and c.check_name <> 'caregiver';
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

  if p_context in ('shift', 'care_request', 'reschedule', 'series') and v_rec.id is not null then
    declare
      v_lim ogevia.caregiver_hour_limits%rowtype;
      v_issue text;
      v_tz text;
      v_date date;
      v_min integer;
    begin
      v_lim := ogevia.effective_hour_limit(p_organization_id, p_caregiver_record_id);
      if v_lim.id is not null then
        select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
        v_date := (p_starts at time zone v_tz)::date;
        v_min := floor(extract(epoch from (p_ends - p_starts)) / 60)::integer;
        v_issue := ogevia.hour_limit_issue(p_organization_id, p_caregiver_record_id, v_date, v_min, p_exclude_shift);
        if v_issue is null then
          return query select 'hours'::text, 'ok'::text, null::text, null::text, v_lim.mode = 'block';
        else
          return query select 'hours'::text, 'blocked'::text, v_issue || '_hour_limit', ogevia.readiness_message('hours', v_issue || '_hour_limit'), v_lim.mode = 'block';
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


drop function ogevia.onboarding_outstanding(uuid, uuid, boolean);
drop function ogevia.onboarding_checklist(uuid, uuid);
drop trigger organizations_seed_onboarding on ogevia.organizations;
drop function ogevia.seed_onboarding_defaults();
drop function ogevia.ensure_onboarding_defaults(uuid);
drop table ogevia.caregiver_onboarding_items;
drop table ogevia.onboarding_requirements;

alter table ogevia.shift_series_skipped_dates drop constraint shift_series_skipped_dates_reason_check;
alter table ogevia.shift_series_skipped_dates add constraint shift_series_skipped_dates_reason_check check (reason = any (array[
  'exceeds_authorization', 'no_authorization', 'caregiver_conflict', 'already_started', 'time_does_not_exist', 'time_occurs_twice',
  'documents_not_current', 'service_not_approved', 'availability_outside', 'availability_not_provided', 'over_hour_limit']));
alter table ogevia.caregiver_records drop column onboarding_required;
alter table ogevia.caregiver_records drop constraint caregiver_records_status_check;
alter table ogevia.caregiver_records add constraint caregiver_records_status_check check (status = any (array['onboarding', 'ready', 'active', 'inactive']));

revoke all on function ogevia_api.list_caregivers(uuid) from public;
grant execute on function ogevia_api.list_caregivers(uuid) to ogevia_app;
