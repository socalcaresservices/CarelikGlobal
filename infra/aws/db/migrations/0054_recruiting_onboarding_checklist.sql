-- 0054 Recruiting and onboarding (owner request 2026-10-15, "Consolidated Application Correction", section FOURTH).
--
-- Reuses the Care Team record (caregiver_records) and the readiness gate; nothing is rebuilt.
--   * Stages (caregiver_records.status): applicant -> interview -> offer -> onboarding -> pending_documents -> ready (shown as
--     "Approved") -> active -> inactive. 'ready' and 'active' keep their meaning (the only statuses that can be scheduled);
--     the four new stages before them cannot be scheduled, as 'onboarding' never could.
--   * caregiver_records.onboarding_required (default false: nobody who exists today is changed). It becomes true when a record
--     is created as an applicant, is moved into any stage before Approved, or the administrator starts the checklist.
--   * onboarding_requirements: the agency's checklist (background check, required training, CPR and TB documents, compliance
--     clearance). Defaults are created for every agency; documents are evaluated from the real document records (0041).
--   * caregiver_onboarding_items: the recorded result for one caregiver and one requirement (completed with a date and
--     optional expiry, or waived with a reason). Absence = outstanding. Every change is in the audit log with old/new values.
--     Only the status and dates are stored: no background-check report, result detail or personal data (the note is capped).
--   * Gates (all server-side): a record that needs onboarding cannot become Approved or Active until every applicable
--     required item is satisfied; cannot receive an assignment (planned or active); and, if an item later expires,
--     readiness_checks blocks new shifts, series and care-request assignments ('onboarding' check, always enforced; it does not
--     stop a caregiver who is already on a visit from recording it). Document items stay under the existing CPR/TB checks.
-- No stored row is changed except new defaults; completed services and visits are never touched.

alter table ogevia.caregiver_records drop constraint caregiver_records_status_check;
alter table ogevia.caregiver_records add constraint caregiver_records_status_check check (status = any (array[
  'applicant', 'interview', 'offer', 'onboarding', 'pending_documents', 'ready', 'active', 'inactive']));
alter table ogevia.caregiver_records add column onboarding_required boolean not null default false;

alter table ogevia.shift_series_skipped_dates drop constraint shift_series_skipped_dates_reason_check;
alter table ogevia.shift_series_skipped_dates add constraint shift_series_skipped_dates_reason_check check (reason = any (array[
  'exceeds_authorization', 'no_authorization', 'caregiver_conflict', 'already_started', 'time_does_not_exist', 'time_occurs_twice',
  'documents_not_current', 'service_not_approved', 'availability_outside', 'availability_not_provided', 'over_hour_limit',
  'onboarding_incomplete']));

create table ogevia.onboarding_requirements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  requirement_key text not null check (requirement_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label text not null check (length(btrim(label)) between 3 and 80),
  category text not null check (category in ('background_check', 'training', 'document', 'clearance', 'other')),
  document_requirement text check (document_requirement in ('cpr', 'tb')),
  hire_type text check (hire_type in ('direct_hire', 'eor')),
  required boolean not null default true,
  validity_months integer check (validity_months between 1 and 120),
  sort_order integer not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, requirement_key),
  unique (id, organization_id),
  constraint onboarding_requirements_document check ((category = 'document') = (document_requirement is not null))
);
create table ogevia.caregiver_onboarding_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid not null,
  requirement_id uuid not null,
  status text not null check (status in ('completed', 'waived')),
  completed_on date not null,
  expires_on date,
  note text check (note is null or length(note) <= 200),
  recorded_by uuid not null references ogevia.app_users(id),
  recorded_at timestamptz not null default now(),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id),
  foreign key (requirement_id, organization_id) references ogevia.onboarding_requirements (id, organization_id),
  unique (caregiver_record_id, requirement_id),
  constraint caregiver_onboarding_items_dates check (expires_on is null or expires_on >= completed_on)
);
create index caregiver_onboarding_items_org_idx on ogevia.caregiver_onboarding_items (organization_id, caregiver_record_id);
alter table ogevia.onboarding_requirements enable row level security;
alter table ogevia.caregiver_onboarding_items enable row level security;
create policy readonly_select on ogevia.onboarding_requirements for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.caregiver_onboarding_items for select to ogevia_readonly using (true);
grant select on ogevia.onboarding_requirements, ogevia.caregiver_onboarding_items to ogevia_readonly;

create function ogevia.ensure_onboarding_defaults(p_organization_id uuid)
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
create function ogevia.seed_onboarding_defaults()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.ensure_onboarding_defaults(new.id);
  return new;
end;
$$;
create trigger organizations_seed_onboarding after insert on ogevia.organizations
for each row execute function ogevia.seed_onboarding_defaults();
select ogevia.ensure_onboarding_defaults(o.id) from ogevia.organizations o;

-- One row per applicable requirement. state: done | waived | outstanding | expired. `expiring_soon` is true while a satisfied
-- item expires within 30 days. A document requirement is evaluated from the document records themselves.
create function ogevia.onboarding_checklist(p_organization_id uuid, p_caregiver_record_id uuid)
returns table (
  requirement_id uuid, requirement_key text, label text, category text, required boolean, sort_order integer,
  state text, detail text, completed_on date, expires_on date, note text, expiring_soon boolean
)
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  v_rec ogevia.caregiver_records%rowtype;
  v_today date := ogevia.organization_local_date(p_organization_id, now());
  r record;
  i ogevia.caregiver_onboarding_items%rowtype;
  d record;
  v_state text;
  v_detail text;
  v_until date;
begin
  select * into v_rec from ogevia.caregiver_records c
  where c.id = p_caregiver_record_id and c.organization_id = p_organization_id and c.deleted_at is null;
  if v_rec.id is null then return; end if;
  for r in select * from ogevia.onboarding_requirements q
           where q.organization_id = p_organization_id and q.is_active and (q.hire_type is null or q.hire_type = v_rec.hire_type)
           order by q.sort_order, q.label loop
    v_state := 'outstanding'; v_detail := null; v_until := null; i := null;
    if r.category = 'document' then
      select * into d from ogevia.document_requirement_check(p_organization_id, v_rec.id, r.document_requirement, null, null);
      v_until := d.valid_until;
      if d.status = 'ok' then v_state := 'done';
      else
        v_detail := case d.status when 'missing' then 'No document uploaded' when 'awaiting_review' then 'Waiting for review' when 'rejected' then 'Rejected'
                                  when 'expired' then 'Expired' when 'expiry_missing' then 'Expiry date missing'
                                  when 'policy_not_set' then 'Agency document rule not set up' when 'type_not_set' then 'Document type not set up'
                                  else 'Not current' end;
        if d.status = 'expired' then v_state := 'expired'; end if;
      end if;
    else
      select * into i from ogevia.caregiver_onboarding_items x where x.caregiver_record_id = v_rec.id and x.requirement_id = r.id;
      if i.id is not null then
        v_until := i.expires_on;
        if i.expires_on is not null and i.expires_on < v_today then v_state := 'expired'; v_detail := 'Expired';
        else v_state := case i.status when 'waived' then 'waived' else 'done' end; end if;
      end if;
    end if;
    return query select r.id, r.requirement_key, r.label, r.category, r.required, r.sort_order, v_state, v_detail,
      i.completed_on, v_until, i.note, (v_state in ('done', 'waived') and v_until is not null and v_until <= v_today + 30);
  end loop;
end;
$$;

-- Labels of the required items not yet satisfied (empty = complete). Documents are left out when the caller already checks them.
create function ogevia.onboarding_outstanding(p_organization_id uuid, p_caregiver_record_id uuid, p_include_documents boolean default true)
returns text[]
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select coalesce(array_agg(c.label order by c.sort_order, c.label), '{}'::text[])
  from ogevia.onboarding_checklist(p_organization_id, p_caregiver_record_id) c
  where c.required and c.state in ('outstanding', 'expired') and (p_include_documents or c.category <> 'document');
$$;

-- No assignment (planned or active) for a record that needs onboarding until it is complete.
create function ogevia.assignment_onboarding_gate()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
declare v_rec ogevia.caregiver_records%rowtype; v_labels text[];
begin
  if new.is_active and new.caregiver_record_id is not null then
    select * into v_rec from ogevia.caregiver_records r where r.id = new.caregiver_record_id and r.organization_id = new.organization_id;
    if v_rec.id is not null and v_rec.onboarding_required then
      v_labels := ogevia.onboarding_outstanding(new.organization_id, v_rec.id, true);
      if cardinality(v_labels) > 0 then
        raise exception 'Onboarding is not complete: %', array_to_string(v_labels, ', ') using errcode = 'OGR30';
      end if;
    end if;
  end if;
  return new;
end;
$$;
create trigger caregiver_assignments_onboarding_gate before insert on ogevia.caregiver_assignments
for each row execute function ogevia.assignment_onboarding_gate();


-- readiness_checks: adds the 'onboarding' check (non-document items; always enforced).
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
    when bool_or(c.check_name = 'onboarding') then 'onboarding_incomplete'
  end
  from ogevia.readiness_checks(p_organization_id, p_caregiver_record_id, p_service_id, p_starts, p_ends, 'series') c
  where c.status = 'blocked' and c.enforced and c.check_name <> 'caregiver';
$$;



-- set_caregiver_status: the new stages, and the approval gate.
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
  if p_status is null or p_status not in ('applicant', 'onboarding', 'ready', 'active') then
    raise exception 'A new caregiver starts as an applicant, onboarding, ready or active' using errcode = 'OGV22';
  end if;
  loop
    v_code := 'CG-' || upper(left(replace(gen_random_uuid()::text, '-', ''), 8));
    exit when not exists (select 1 from ogevia.caregiver_records r where r.organization_id = p_organization_id and r.caregiver_code = v_code);
  end loop;
  insert into ogevia.caregiver_records (id, organization_id, caregiver_code, first_name, last_name, preferred_name, status, onboarding_required)
  values (v_id, p_organization_id, v_code, v_first, v_last, v_pref, p_status, p_status = 'applicant');
  perform ogevia.write_audit(p_organization_id, 'caregiver.created', 'caregiver_records', v_id, null,
    jsonb_build_object('caregiver_code', v_code, 'first_name', v_first, 'last_name', v_last, 'preferred_name', v_pref, 'status', p_status), null);
  perform ogevia.idempotency_finish('create_caregiver', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('caregiver_record_id', v_id, 'caregiver_code', v_code));
  return query select v_id, v_code;
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



-- ---------------------------------------------------------------------------
-- API
-- ---------------------------------------------------------------------------
create function ogevia.onboarding_read_guard(p_organization_id uuid)
returns uuid
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.require_actor();
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'caregivers.manage') or ogevia.has_permission(p_organization_id, 'readiness.read')) then
    raise exception 'You do not have permission to see onboarding' using errcode = 'OGA03';
  end if;
  return v_actor;
end;
$$;

create function ogevia.onboarding_summary(p_organization_id uuid, p_caregiver_record_id uuid)
returns jsonb
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select jsonb_build_object(
    'caregiverRecordId', cr.id, 'status', cr.status, 'hireType', cr.hire_type, 'onboardingRequired', cr.onboarding_required,
    'done', coalesce((select count(*) from ogevia.onboarding_checklist(cr.organization_id, cr.id) k where k.required and k.state in ('done', 'waived')), 0),
    'total', coalesce((select count(*) from ogevia.onboarding_checklist(cr.organization_id, cr.id) k where k.required), 0),
    'complete', cardinality(ogevia.onboarding_outstanding(cr.organization_id, cr.id, true)) = 0,
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'requirementId', k.requirement_id, 'key', k.requirement_key, 'label', k.label, 'category', k.category, 'required', k.required,
        'state', k.state, 'detail', k.detail, 'completedOn', k.completed_on, 'expiresOn', k.expires_on, 'note', k.note, 'expiringSoon', k.expiring_soon)
        order by k.sort_order, k.label) from ogevia.onboarding_checklist(cr.organization_id, cr.id) k), '[]'::jsonb))
  from ogevia.caregiver_records cr
  where cr.id = p_caregiver_record_id and cr.organization_id = p_organization_id and cr.deleted_at is null;
$$;

create function ogevia_api.get_onboarding(p_organization_id uuid, p_caregiver_record_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare v_out jsonb;
begin
  perform ogevia.onboarding_read_guard(p_organization_id);
  v_out := ogevia.onboarding_summary(p_organization_id, p_caregiver_record_id);
  if v_out is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  return v_out;
end;
$$;

-- Pipeline: every record that needs onboarding or is in a stage before Approved, with what is still outstanding.
create function ogevia_api.list_onboarding_overview(p_organization_id uuid)
returns table (
  caregiver_record_id uuid, caregiver_code text, caregiver_name text, status text, hire_type text, onboarding_required boolean,
  done integer, total integer, outstanding jsonb, next_expiry date, updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.onboarding_read_guard(p_organization_id);
  return query
  select cr.id, cr.caregiver_code, coalesce(nullif(btrim(cr.preferred_name), ''), cr.first_name) || ' ' || cr.last_name, cr.status, cr.hire_type, cr.onboarding_required,
         (select count(*)::integer from ogevia.onboarding_checklist(cr.organization_id, cr.id) k where k.required and k.state in ('done', 'waived')),
         (select count(*)::integer from ogevia.onboarding_checklist(cr.organization_id, cr.id) k where k.required),
         coalesce((select jsonb_agg(jsonb_build_object('label', k.label, 'state', k.state, 'detail', k.detail, 'category', k.category) order by k.sort_order, k.label)
                   from ogevia.onboarding_checklist(cr.organization_id, cr.id) k where k.required and k.state in ('outstanding', 'expired')), '[]'::jsonb),
         (select min(k.expires_on) from ogevia.onboarding_checklist(cr.organization_id, cr.id) k where k.required and k.expires_on is not null and k.state in ('done', 'waived')),
         cr.updated_at
  from ogevia.caregiver_records cr
  where cr.organization_id = p_organization_id and cr.deleted_at is null and cr.status <> 'inactive'
    and (cr.onboarding_required or cr.status in ('applicant', 'interview', 'offer', 'onboarding', 'pending_documents'))
  order by case cr.status when 'pending_documents' then 0 when 'onboarding' then 1 when 'offer' then 2 when 'interview' then 3 when 'applicant' then 4 else 5 end,
           lower(cr.last_name), lower(cr.first_name);
end;
$$;

-- Turns the checklist on for a record that exists today (nobody is switched on automatically).
create function ogevia_api.start_onboarding(p_organization_id uuid, p_caregiver_record_id uuid)
returns void
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.caregiver_admin_guard(p_organization_id); v_rec ogevia.caregiver_records%rowtype;
begin
  select * into v_rec from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null for update;
  if v_rec.id is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  if v_rec.onboarding_required then return; end if;
  update ogevia.caregiver_records set onboarding_required = true, updated_at = now() where id = v_rec.id;
  perform ogevia.write_audit(p_organization_id, 'caregiver.onboarding_started', 'caregiver_records', v_rec.id,
    jsonb_build_object('onboarding_required', false), jsonb_build_object('onboarding_required', true), null);
end;
$$;

-- action: complete | waive | reopen. A document requirement is recorded by uploading and approving the document, not here.
-- Compliance clearance is the final sign-off: it needs every other required item satisfied and cannot be waived.
create function ogevia_api.record_onboarding_item(
  p_organization_id uuid, p_caregiver_record_id uuid, p_requirement_key text, p_action text,
  p_completed_on date default null, p_expires_on date default null, p_note text default null, p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.caregiver_admin_guard(p_organization_id);
  v_today date := ogevia.organization_local_date(p_organization_id, now());
  v_rec ogevia.caregiver_records%rowtype;
  v_req ogevia.onboarding_requirements%rowtype;
  v_old ogevia.caregiver_onboarding_items%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_reason text := btrim(coalesce(p_reason, ''));
  v_on date := coalesce(p_completed_on, v_today);
  v_exp date := p_expires_on;
  v_open text[];
begin
  if p_action is null or p_action not in ('complete', 'waive', 'reopen') then raise exception 'Choose complete, waive or reopen' using errcode = 'OGV22'; end if;
  select * into v_rec from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null for update;
  if v_rec.id is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  select * into v_req from ogevia.onboarding_requirements q where q.organization_id = p_organization_id and q.requirement_key = p_requirement_key and q.is_active;
  if v_req.id is null then raise exception 'Requirement not found' using errcode = 'OGN04'; end if;
  if v_req.category = 'document' then
    raise exception 'Documents are recorded by uploading and approving them on the caregiver''s Documents page' using errcode = 'OGV22';
  end if;
  if v_note is not null and length(v_note) > 200 then raise exception 'The note is limited to 200 characters. Do not enter results or personal details.' using errcode = 'OGV22'; end if;
  if p_action in ('waive', 'reopen') and length(v_reason) not between 3 and 500 then raise exception 'Give the reason' using errcode = 'OGV22'; end if;
  if p_action = 'waive' and v_req.category = 'clearance' then raise exception 'Compliance clearance cannot be waived' using errcode = 'OGV22'; end if;
  select * into v_old from ogevia.caregiver_onboarding_items x where x.caregiver_record_id = v_rec.id and x.requirement_id = v_req.id for update;

  if p_action = 'reopen' then
    if v_old.id is null then return ogevia.onboarding_summary(p_organization_id, v_rec.id); end if;
    delete from ogevia.caregiver_onboarding_items where id = v_old.id;
    perform ogevia.write_audit(p_organization_id, 'caregiver.onboarding_item_reopened', 'caregiver_records', v_rec.id,
      jsonb_build_object('requirement', v_req.requirement_key, 'status', v_old.status, 'completed_on', v_old.completed_on, 'expires_on', v_old.expires_on), null, v_reason);
    return ogevia.onboarding_summary(p_organization_id, v_rec.id);
  end if;

  if v_on > v_today then raise exception 'The completion date cannot be in the future' using errcode = 'OGV22'; end if;
  if v_exp is null and v_req.validity_months is not null then v_exp := (v_on + make_interval(months => v_req.validity_months))::date; end if;
  if v_exp is not null and v_exp < v_on then raise exception 'The expiry date cannot be before the completion date' using errcode = 'OGV22'; end if;
  if v_req.category = 'clearance' then
    select array_agg(c.label) into v_open from ogevia.onboarding_checklist(p_organization_id, v_rec.id) c
    where c.required and c.state in ('outstanding', 'expired') and c.category <> 'clearance';
    if v_open is not null then
      raise exception 'Compliance clearance comes last. Still outstanding: %', array_to_string(v_open, ', ') using errcode = 'OGC09';
    end if;
  end if;
  insert into ogevia.caregiver_onboarding_items (organization_id, caregiver_record_id, requirement_id, status, completed_on, expires_on, note, recorded_by)
  values (p_organization_id, v_rec.id, v_req.id, case p_action when 'waive' then 'waived' else 'completed' end, v_on, v_exp, v_note, v_actor)
  on conflict (caregiver_record_id, requirement_id) do update
    set status = excluded.status, completed_on = excluded.completed_on, expires_on = excluded.expires_on, note = excluded.note,
        recorded_by = excluded.recorded_by, recorded_at = now();
  perform ogevia.write_audit(p_organization_id, 'caregiver.onboarding_item_' || case p_action when 'waive' then 'waived' else 'completed' end, 'caregiver_records', v_rec.id,
    case when v_old.id is null then null else jsonb_build_object('requirement', v_req.requirement_key, 'status', v_old.status, 'completed_on', v_old.completed_on, 'expires_on', v_old.expires_on) end,
    jsonb_build_object('requirement', v_req.requirement_key, 'status', case p_action when 'waive' then 'waived' else 'completed' end, 'completed_on', v_on, 'expires_on', v_exp),
    nullif(v_reason, ''));
  return ogevia.onboarding_summary(p_organization_id, v_rec.id);
end;
$$;

create function ogevia_api.list_onboarding_requirements(p_organization_id uuid)
returns table (requirement_key text, label text, category text, document_requirement text, hire_type text, required boolean, validity_months integer, sort_order integer, is_active boolean)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.onboarding_read_guard(p_organization_id);
  return query select q.requirement_key, q.label, q.category, q.document_requirement, q.hire_type, q.required, q.validity_months, q.sort_order, q.is_active
  from ogevia.onboarding_requirements q where q.organization_id = p_organization_id order by q.sort_order, q.label;
end;
$$;

-- Adds or changes an agency requirement. The five built-in keys keep their category; documents can only be switched on or off.
create function ogevia_api.set_onboarding_requirement(
  p_organization_id uuid, p_requirement_key text, p_label text, p_category text, p_required boolean,
  p_validity_months integer, p_hire_type text, p_is_active boolean, p_reason text
)
returns void
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.caregiver_admin_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_old ogevia.onboarding_requirements%rowtype;
  v_new uuid;
begin
  if length(v_reason) not between 3 and 500 then raise exception 'Give the reason for the change' using errcode = 'OGV22'; end if;
  if p_requirement_key is null or p_requirement_key !~ '^[a-z][a-z0-9_]{1,40}$' then raise exception 'The key is lower-case letters, digits and underscores' using errcode = 'OGV22'; end if;
  select * into v_old from ogevia.onboarding_requirements q where q.organization_id = p_organization_id and q.requirement_key = p_requirement_key for update;
  if v_old.id is null then
    if p_category is null or p_category not in ('background_check', 'training', 'clearance', 'other') then raise exception 'Choose a category' using errcode = 'OGV22'; end if;
    insert into ogevia.onboarding_requirements (organization_id, requirement_key, label, category, hire_type, required, validity_months, sort_order, is_active)
    values (p_organization_id, p_requirement_key, btrim(p_label), p_category, p_hire_type, coalesce(p_required, true), p_validity_months, 50, coalesce(p_is_active, true))
    returning id into v_new;
    perform ogevia.write_audit(p_organization_id, 'onboarding_requirement.created', 'onboarding_requirements', v_new, null,
      jsonb_build_object('key', p_requirement_key, 'label', btrim(p_label), 'category', p_category, 'required', coalesce(p_required, true)), v_reason);
  else
    update ogevia.onboarding_requirements set
      label = case when v_old.category = 'document' then v_old.label else coalesce(nullif(btrim(p_label), ''), v_old.label) end,
      required = coalesce(p_required, v_old.required), validity_months = case when v_old.category = 'document' then null else p_validity_months end,
      hire_type = p_hire_type, is_active = coalesce(p_is_active, v_old.is_active), updated_at = now()
    where id = v_old.id;
    perform ogevia.write_audit(p_organization_id, 'onboarding_requirement.changed', 'onboarding_requirements', v_old.id,
      jsonb_build_object('label', v_old.label, 'required', v_old.required, 'validity_months', v_old.validity_months, 'hire_type', v_old.hire_type, 'is_active', v_old.is_active),
      jsonb_build_object('label', p_label, 'required', p_required, 'validity_months', p_validity_months, 'hire_type', p_hire_type, 'is_active', p_is_active), v_reason);
  end if;
end;
$$;

revoke all on function ogevia.ensure_onboarding_defaults(uuid) from public;
revoke all on function ogevia.seed_onboarding_defaults() from public;
revoke all on function ogevia.onboarding_checklist(uuid, uuid) from public;
revoke all on function ogevia.onboarding_outstanding(uuid, uuid, boolean) from public;
revoke all on function ogevia.assignment_onboarding_gate() from public;
revoke all on function ogevia.onboarding_read_guard(uuid) from public;
revoke all on function ogevia.onboarding_summary(uuid, uuid) from public;
revoke all on function ogevia_api.list_caregivers(uuid) from public;
revoke all on function ogevia_api.get_onboarding(uuid, uuid) from public;
revoke all on function ogevia_api.list_onboarding_overview(uuid) from public;
revoke all on function ogevia_api.start_onboarding(uuid, uuid) from public;
revoke all on function ogevia_api.record_onboarding_item(uuid, uuid, text, text, date, date, text, text) from public;
revoke all on function ogevia_api.list_onboarding_requirements(uuid) from public;
revoke all on function ogevia_api.set_onboarding_requirement(uuid, text, text, text, boolean, integer, text, boolean, text) from public;
grant execute on function ogevia_api.list_caregivers(uuid) to ogevia_app;
grant execute on function ogevia_api.get_onboarding(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.list_onboarding_overview(uuid) to ogevia_app;
grant execute on function ogevia_api.start_onboarding(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.record_onboarding_item(uuid, uuid, text, text, date, date, text, text) to ogevia_app;
grant execute on function ogevia_api.list_onboarding_requirements(uuid) to ogevia_app;
grant execute on function ogevia_api.set_onboarding_requirement(uuid, text, text, text, boolean, integer, text, boolean, text) to ogevia_app;
