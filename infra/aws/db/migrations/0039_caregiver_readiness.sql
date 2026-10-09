-- 0039 Caregiver readiness: required documents, explicit service approvals, one server-owned
-- readiness check, and the gates that make every assignment path and every new visit start use it.
--
-- Owner requirements (docs: caregiver readiness brief):
--   * No new assignment or visit start unless the required documents are verified and cover the
--     work, the service is approved (once service checks are switched on), and there is no
--     time conflict. CPR and TB are required for this agency: the agency lists the document
--     types it requires (ogevia.document_types.required_for_work); nothing is assumed or seeded.
--   * A file upload alone proves nothing. A document counts only after an administrator VERIFIES
--     it and records the validity dates the agency's policy gives it (valid from, and valid
--     through and/or review due). A verified record with no such dates is "needs review".
--     No universal CPR/TB interval is invented anywhere in this file.
--   * A replacement that is still pending never erases a verified record that still covers the
--     work. A verification can be revoked (append-only record, audited).
--   * Service approval is a separate, explicit, administrator-controlled record per caregiver and
--     service (dates, reason, approver, revocation). A client assignment never grants it.
--     Enforcement is OFF until an administrator switches it on (audited); while off the check
--     reports "unchecked", never "approved".
--   * Availability is required for new assignments only when the agency switches that on
--     (audited); the Care Request candidate list keeps requiring it as it always has.
--     Only an authorised administrator may override availability, with a recorded reason. There
--     is NO override for documents, service approval, caregiver status or time conflicts.
--
-- Where the checks run (one function, ogevia.assignment_readiness):
--   * A BEFORE trigger on ogevia.shifts runs them whenever a shift is created or its caregiver,
--     times, client or service change. Every existing and future path writes shifts: create_shift,
--     assign_shift_caregiver, reschedule_shift, recurring series, Care Request assignment and
--     coverage reassignment. Nothing is duplicated per path.
--   * A BEFORE trigger on ogevia.caregiver_assignments checks a NEW standing assignment that
--     grants access at once (a planned assignment for someone with no sign-in grants nothing and
--     is not gated; it shows as not ready in the review list).
--   * A BEFORE trigger on ogevia.service_visits checks a NEW live visit (draft, no time out). The
--     visit's planned end is the matched shift's end; an unscheduled visit is checked at the
--     start instant only. Manager-entered records (outage records, corrections) are not live
--     starts and are never blocked. A visit already in progress is never interrupted, and sign-out,
--     signature, correction and recording of work already done are not gated.
--
-- Locking: every one of those paths takes the same per-caregiver transaction advisory lock
-- (key 'ogevia.caregiver-schedule:' || caregiver_record_id, the key check_shift_caregiver already
-- uses) BEFORE it reads the facts, and every approval, document and availability change takes the
-- same lock before it writes. Two assignments for one caregiver therefore queue (this also closes
-- the double-booking race in assign_care_request), and a revocation either commits before an
-- assignment reads (the assignment is refused) or after it (the new shift is then flagged).
-- Limits: it needs READ COMMITTED (the default); it protects only code that takes the lock; a
-- visit already started is not stopped by a later revocation.

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
insert into ogevia.permissions (key, description) values
  ('readiness.manage', 'Choose which documents are required and switch readiness enforcement on or off'),
  ('readiness.override_availability', 'Assign outside approved availability, with a recorded reason'),
  ('service_approvals.manage', 'Approve, change and revoke the services a caregiver may provide');
insert into ogevia.role_permissions (role, permission_key) values
  ('organization_owner', 'readiness.manage'),
  ('organization_owner', 'readiness.override_availability'),
  ('manager', 'readiness.override_availability'),
  ('organization_owner', 'service_approvals.manage'),
  ('manager', 'service_approvals.manage');

-- ---------------------------------------------------------------------------
-- Agency settings (defaults: everything off; nothing is enabled by this migration)
-- ---------------------------------------------------------------------------
create table ogevia.agency_readiness_settings (
  organization_id uuid primary key references ogevia.organizations(id),
  service_checks_enabled boolean not null default false,
  availability_required boolean not null default false,
  expiry_warning_days integer not null default 30 check (expiry_warning_days between 1 and 365),
  updated_by uuid references ogevia.app_users(id),
  updated_at timestamptz not null default now()
);

create function ogevia.readiness_settings(p_organization_id uuid)
returns table (service_checks_enabled boolean, availability_required boolean, expiry_warning_days integer)
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select coalesce(s.service_checks_enabled, false), coalesce(s.availability_required, false), coalesce(s.expiry_warning_days, 30)
  from (select 1) x
  left join ogevia.agency_readiness_settings s on s.organization_id = p_organization_id;
$$;

-- ---------------------------------------------------------------------------
-- Required documents: the agency's list, administrator-approved validity, revocation
-- ---------------------------------------------------------------------------
alter table ogevia.document_types add column required_for_work boolean not null default false;

alter table ogevia.document_versions
  add column approved_valid_from date,
  add column approved_valid_through date,
  add column approved_review_due_on date,
  add constraint document_versions_approved_shape check (
    review_status = 'verified'
    or (approved_valid_from is null and approved_valid_through is null and approved_review_due_on is null)),
  add constraint document_versions_approved_dates check (
    (approved_valid_through is null or approved_valid_from is null or approved_valid_through >= approved_valid_from)
    and (approved_review_due_on is null or approved_valid_from is null or approved_review_due_on >= approved_valid_from));

-- The one-time review may now also record the approved validity dates; everything else stays append-only.
create or replace function ogevia.document_versions_guard_update()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  if old.review_status <> 'awaiting_review' then
    raise exception 'This document version has already been reviewed' using errcode = 'OGC09';
  end if;
  if (to_jsonb(new) - array['review_status', 'reviewed_by', 'reviewed_at', 'rejection_reason',
                            'approved_valid_from', 'approved_valid_through', 'approved_review_due_on'])
     is distinct from (to_jsonb(old) - array['review_status', 'reviewed_by', 'reviewed_at', 'rejection_reason',
                            'approved_valid_from', 'approved_valid_through', 'approved_review_due_on']) then
    raise exception 'Document versions are append-only; upload a new version instead' using errcode = 'OGC09';
  end if;
  return new;
end;
$$;

create table ogevia.document_version_revocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  version_id uuid not null unique references ogevia.document_versions(id),
  revoked_by uuid not null references ogevia.app_users(id),
  revoked_at timestamptz not null default now(),
  reason text not null check (length(btrim(reason)) between 3 and 500)
);
create trigger document_version_revocations_no_update before update on ogevia.document_version_revocations
for each row execute function ogevia.forbid_update();
create trigger document_version_revocations_no_delete before delete on ogevia.document_version_revocations
for each row execute function ogevia.forbid_delete();

-- ---------------------------------------------------------------------------
-- Explicit caregiver service approvals
-- ---------------------------------------------------------------------------
create table ogevia.caregiver_service_approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid not null,
  service_id uuid not null,
  effective_from date not null,
  effective_to date,
  reason text not null check (length(btrim(reason)) between 3 and 500),
  approved_by uuid not null references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references ogevia.app_users(id),
  revoked_reason text,
  unique (id, organization_id),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id),
  foreign key (service_id, organization_id) references ogevia.services (id, organization_id),
  constraint service_approval_period check (effective_to is null or effective_to >= effective_from),
  constraint service_approval_revocation_shape check (
    (revoked_at is null and revoked_by is null and revoked_reason is null)
    or (revoked_at is not null and revoked_by is not null and length(btrim(coalesce(revoked_reason, ''))) between 3 and 500)),
  constraint service_approval_no_overlap exclude using gist (
    caregiver_record_id with =,
    service_id with =,
    daterange(effective_from, effective_to, '[]') with &&
  ) where (revoked_at is null)
);
create index caregiver_service_approvals_lookup_idx on ogevia.caregiver_service_approvals (organization_id, caregiver_record_id, service_id);

-- Approvals are never edited or deleted: the only change is the one-time revocation.
create function ogevia.service_approvals_guard_update()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  if old.revoked_at is not null then
    raise exception 'This approval was already revoked' using errcode = 'OGC09';
  end if;
  if (to_jsonb(new) - array['revoked_at', 'revoked_by', 'revoked_reason'])
     is distinct from (to_jsonb(old) - array['revoked_at', 'revoked_by', 'revoked_reason']) then
    raise exception 'Service approvals cannot be edited; revoke and approve again' using errcode = 'OGC09';
  end if;
  return new;
end;
$$;
create trigger caregiver_service_approvals_guard before update on ogevia.caregiver_service_approvals
for each row execute function ogevia.service_approvals_guard_update();
create trigger caregiver_service_approvals_no_delete before delete on ogevia.caregiver_service_approvals
for each row execute function ogevia.forbid_delete();

-- Same least-privilege / RLS contract as every other table.
revoke all on table ogevia.agency_readiness_settings, ogevia.document_version_revocations, ogevia.caregiver_service_approvals
  from public, ogevia_app;
alter table ogevia.agency_readiness_settings enable row level security;
alter table ogevia.document_version_revocations enable row level security;
alter table ogevia.caregiver_service_approvals enable row level security;
create policy readonly_select on ogevia.agency_readiness_settings for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.document_version_revocations for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.caregiver_service_approvals for select to ogevia_readonly using (true);
grant select on ogevia.agency_readiness_settings, ogevia.document_version_revocations, ogevia.caregiver_service_approvals to ogevia_readonly;

-- ---------------------------------------------------------------------------
-- Locking
-- ---------------------------------------------------------------------------
create function ogevia.lock_caregiver_schedule(p_caregiver_record_id uuid)
returns void
language sql
volatile
set search_path = ogevia, pg_temp
as $$
  select pg_advisory_xact_lock(hashtextextended('ogevia.caregiver-schedule:' || p_caregiver_record_id::text, 0));
$$;

-- ---------------------------------------------------------------------------
-- Document requirement state for one required type over [first date, last date] (agency local dates)
-- ---------------------------------------------------------------------------
create function ogevia.document_requirement_state(
  p_organization_id uuid, p_caregiver_record_id uuid, p_document_type_id uuid, p_first date, p_last date
)
returns text
language sql
stable
set search_path = ogevia, pg_temp
as $$
  with v as (
    select dv.review_status, dv.uploaded_at,
           dv.approved_valid_from as vf,
           case when dv.approved_valid_through is null and dv.approved_review_due_on is null then null
                else least(coalesce(dv.approved_valid_through, 'infinity'::date), coalesce(dv.approved_review_due_on, 'infinity'::date)) end as eff_end,
           (r.id is not null) as revoked
    from ogevia.staff_documents sd
    join ogevia.document_versions dv on dv.document_id = sd.id and dv.organization_id = sd.organization_id
    left join ogevia.document_version_revocations r on r.version_id = dv.id
    where sd.organization_id = p_organization_id and sd.caregiver_record_id = p_caregiver_record_id
      and sd.document_type_id = p_document_type_id
  )
  select case
    when exists (select 1 from v where review_status = 'verified' and not revoked and vf is not null and eff_end is not null
                   and vf <= p_first and eff_end >= p_last) then 'ok'
    when exists (select 1 from v where review_status = 'verified' and not revoked and vf is not null and eff_end is not null
                   and vf <= p_first and eff_end >= p_first) then 'ends_before_end'
    when exists (select 1 from v where review_status = 'verified' and not revoked and vf is not null and eff_end is not null
                   and vf > p_first) then 'not_yet_valid'
    when exists (select 1 from v where review_status = 'verified' and not revoked and vf is not null and eff_end is not null) then 'expired'
    when exists (select 1 from v where review_status = 'verified' and not revoked) then 'needs_review'
    when exists (select 1 from v where review_status = 'awaiting_review') then 'pending'
    when exists (select 1 from v where review_status = 'verified' and revoked)
         and not exists (select 1 from v v2 where v2.review_status = 'rejected'
                           and v2.uploaded_at > coalesce((select max(v3.uploaded_at) from v v3 where v3.review_status = 'verified' and v3.revoked), '-infinity')) then 'revoked'
    when exists (select 1 from v where review_status = 'rejected') then 'rejected'
    else 'missing'
  end;
$$;

create function ogevia.document_has_pending(p_organization_id uuid, p_caregiver_record_id uuid, p_document_type_id uuid)
returns boolean
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select exists (
    select 1 from ogevia.staff_documents sd
    join ogevia.document_versions dv on dv.document_id = sd.id and dv.organization_id = sd.organization_id
    where sd.organization_id = p_organization_id and sd.caregiver_record_id = p_caregiver_record_id
      and sd.document_type_id = p_document_type_id and dv.review_status = 'awaiting_review');
$$;

create function ogevia.document_state_label(p_name text, p_state text)
returns text
language sql
immutable
set search_path = ogevia, pg_temp
as $$
  select p_name || case p_state
    when 'ends_before_end' then ' expires before end'
    when 'not_yet_valid' then ' not yet valid'
    when 'needs_review' then ' needs review'
    when 'expired' then ' expired'
    when 'pending' then ' pending'
    when 'revoked' then ' revoked'
    when 'rejected' then ' rejected'
    else ' missing' end;
$$;

-- ---------------------------------------------------------------------------
-- The one readiness check. Pure read. Returns separate checks with reason codes.
--   p_availability: 'setting' (agency switch), 'force' (always, as Care Requests always did), 'skip'.
--   Documents show only the document TYPE and a short state: never dates, files or medical detail.
-- ---------------------------------------------------------------------------
create function ogevia.assignment_readiness(
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

-- ---------------------------------------------------------------------------
-- The gate: take the caregiver lock, read the facts, refuse or allow (audited override only for availability)
-- ---------------------------------------------------------------------------
create function ogevia.assert_assignment_ready(
  p_organization_id uuid, p_caregiver_record_id uuid, p_client_id uuid, p_service_id uuid,
  p_starts timestamptz, p_ends timestamptz, p_exclude_shift uuid,
  p_availability text, p_check_conflicts boolean, p_check_authorization boolean, p_context text
)
returns jsonb
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare
  v_r jsonb;
  v_labels text;
  v_ov jsonb;
  v_conflict_only boolean;
begin
  perform ogevia.lock_caregiver_schedule(p_caregiver_record_id);
  v_r := ogevia.assignment_readiness(p_organization_id, p_caregiver_record_id, p_client_id, p_service_id,
    p_starts, p_ends, p_exclude_shift, p_availability, p_check_conflicts, p_check_authorization);
  if (v_r ->> 'blocked')::boolean then
    select string_agg(x ->> 'label', '; ') into v_labels from jsonb_array_elements(v_r -> 'reasons') x where x ->> 'code' <> 'AVAILABILITY';
    v_conflict_only := not exists (select 1 from jsonb_array_elements(v_r -> 'reasons') x where x ->> 'code' not in ('TIME_CONFLICT', 'AVAILABILITY'));
    raise exception 'Blocked: %', coalesce(v_labels, 'not ready')
      using errcode = case when v_conflict_only then 'OGC09' else 'OGV22' end;
  end if;
  if (v_r ->> 'needs_override')::boolean then
    v_ov := nullif(current_setting('ogevia.availability_override', true), '')::jsonb;
    if v_ov is null or (v_ov ->> 'org') is distinct from p_organization_id::text
       or not ogevia.has_permission(p_organization_id, 'readiness.override_availability') then
      raise exception 'Needs override: outside approved availability' using errcode = 'OGV22';
    end if;
    perform ogevia.write_audit(p_organization_id, 'assignment.availability_override', 'caregiver_records', p_caregiver_record_id,
      null, jsonb_build_object('context', p_context, 'starts_at', p_starts, 'ends_at', p_ends, 'service_id', p_service_id),
      v_ov ->> 'reason');
  end if;
  return v_r;
end;
$$;

-- ---------------------------------------------------------------------------
-- Gates (triggers): one set of checks for every path
-- ---------------------------------------------------------------------------
create function ogevia.shifts_readiness_gate()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  if new.caregiver_record_id is null or new.service_id is null or new.status <> 'scheduled' then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.status = 'scheduled'
     and old.caregiver_record_id is not distinct from new.caregiver_record_id
     and old.starts_at = new.starts_at and old.ends_at = new.ends_at
     and old.service_id is not distinct from new.service_id and old.client_id = new.client_id then
    return new;
  end if;
  -- Authorization hours stay with the booking functions that reserve them; here: status, documents,
  -- service approval, availability (when required) and conflicts.
  perform ogevia.assert_assignment_ready(new.organization_id, new.caregiver_record_id, new.client_id, new.service_id,
    new.starts_at, new.ends_at, new.id, 'setting', true, false, 'shift');
  return new;
end;
$$;
create trigger shifts_readiness_gate before insert or update on ogevia.shifts
for each row execute function ogevia.shifts_readiness_gate();

create function ogevia.assignments_readiness_gate()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
declare
  v_tz text;
  v_from date;
  v_start timestamptz;
begin
  -- Only a NEW standing assignment that grants access at once. A planned assignment (no sign-in yet) grants nothing.
  if new.is_active is not true or new.caregiver_user_id is null or new.caregiver_record_id is null then
    return new;
  end if;
  select o.timezone into v_tz from ogevia.organizations o where o.id = new.organization_id;
  v_from := greatest(new.effective_start, ogevia.organization_local_date(new.organization_id, now()));
  v_start := v_from::timestamp at time zone v_tz;
  perform ogevia.assert_assignment_ready(new.organization_id, new.caregiver_record_id, new.client_id, new.service_id,
    v_start, null, null, 'skip', false, false, 'standing_assignment');
  return new;
end;
$$;
create trigger assignments_readiness_gate before insert on ogevia.caregiver_assignments
for each row execute function ogevia.assignments_readiness_gate();

create function ogevia.visits_start_gate()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
declare
  v_end timestamptz;
begin
  -- Only a NEW live visit. Outage records, corrections and other manager-entered records have a time out.
  if new.status <> 'draft' or new.time_out is not null or new.caregiver_record_id is null then
    return new;
  end if;
  if new.scheduled_shift_id is not null then
    select s.ends_at into v_end from ogevia.shifts s where s.id = new.scheduled_shift_id;
  end if;
  -- Unscheduled (no planned end): checked at the start instant only; a later expiry never interrupts the visit.
  begin
    perform ogevia.assert_assignment_ready(new.organization_id, new.caregiver_record_id, new.client_id, new.service_id,
      new.time_in, greatest(v_end, new.time_in + interval '1 minute'), new.scheduled_shift_id, 'skip', false, false, 'visit_start');
  exception when sqlstate 'OGV22' then
    raise exception '% Contact your agency manager before starting this visit.', sqlerrm using errcode = 'OGV22';
  end;
  return new;
end;
$$;
create trigger visits_start_gate before insert on ogevia.service_visits
for each row execute function ogevia.visits_start_gate();

-- ---------------------------------------------------------------------------
-- API: readiness for one candidate (what the assignment screens show) and the override hook
-- ---------------------------------------------------------------------------
create function ogevia_api.get_assignment_readiness(
  p_organization_id uuid, p_caregiver_record_id uuid, p_client_id uuid, p_service_id uuid,
  p_starts_at timestamptz, p_ends_at timestamptz, p_exclude_shift_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not (ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'care_requests.manage')
          or ogevia.has_permission(p_organization_id, 'caregivers.manage')) then
    raise exception 'You do not have permission to check assignments' using errcode = 'OGA03';
  end if;
  if p_starts_at >= p_ends_at then
    raise exception 'The end must be after the start' using errcode = 'OGV22';
  end if;
  return ogevia.assignment_readiness(p_organization_id, p_caregiver_record_id, p_client_id, p_service_id,
    p_starts_at, p_ends_at, p_exclude_shift_id, 'setting', true, true);
end;
$$;

-- Call in the SAME transaction, just before an assignment, to allow an availability exception. The
-- gate re-checks the permission and records the reason in the audit trail when it uses the exception.
create function ogevia_api.begin_availability_override(p_organization_id uuid, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'readiness.override_availability') then
    raise exception 'You do not have permission to assign outside availability' using errcode = 'OGA03';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason is required to assign outside availability' using errcode = 'OGV22';
  end if;
  perform set_config('ogevia.availability_override',
    jsonb_build_object('org', p_organization_id, 'reason', btrim(p_reason))::text, true);
end;
$$;

-- ---------------------------------------------------------------------------
-- API: agency settings and the required-document list (owner only)
-- ---------------------------------------------------------------------------
create function ogevia_api.get_readiness_settings(p_organization_id uuid)
returns table (service_checks_enabled boolean, availability_required boolean, expiry_warning_days integer)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  return query select s.service_checks_enabled, s.availability_required, s.expiry_warning_days from ogevia.readiness_settings(p_organization_id) s;
end;
$$;

create function ogevia_api.set_readiness_settings(
  p_organization_id uuid, p_service_checks_enabled boolean, p_availability_required boolean, p_expiry_warning_days integer, p_reason text
)
returns void
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_before record;
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'readiness.manage') then
    raise exception 'Only the Administrator can change readiness settings' using errcode = 'OGA03';
  end if;
  if p_expiry_warning_days is null or p_expiry_warning_days not between 1 and 365 then
    raise exception 'Warning days must be between 1 and 365' using errcode = 'OGV22';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason is required' using errcode = 'OGV22';
  end if;
  select * into v_before from ogevia.readiness_settings(p_organization_id);
  insert into ogevia.agency_readiness_settings (organization_id, service_checks_enabled, availability_required, expiry_warning_days, updated_by, updated_at)
  values (p_organization_id, coalesce(p_service_checks_enabled, false), coalesce(p_availability_required, false), p_expiry_warning_days, ogevia.require_actor(), now())
  on conflict (organization_id) do update
    set service_checks_enabled = excluded.service_checks_enabled, availability_required = excluded.availability_required,
        expiry_warning_days = excluded.expiry_warning_days, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform ogevia.write_audit(p_organization_id, 'readiness.settings_changed', 'agency_readiness_settings', p_organization_id,
    to_jsonb(v_before),
    jsonb_build_object('service_checks_enabled', coalesce(p_service_checks_enabled, false),
                       'availability_required', coalesce(p_availability_required, false), 'expiry_warning_days', p_expiry_warning_days),
    btrim(p_reason));
end;
$$;

create function ogevia_api.set_document_type_required(p_organization_id uuid, p_document_type_id uuid, p_required boolean, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_before boolean;
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'readiness.manage') then
    raise exception 'Only the Administrator can change which documents are required' using errcode = 'OGA03';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason is required' using errcode = 'OGV22';
  end if;
  select dt.required_for_work into v_before from ogevia.document_types dt
   where dt.id = p_document_type_id and dt.organization_id = p_organization_id for update;
  if v_before is null then
    raise exception 'Document type not found' using errcode = 'OGN04';
  end if;
  update ogevia.document_types set required_for_work = coalesce(p_required, false) where id = p_document_type_id;
  perform ogevia.write_audit(p_organization_id, 'document_type.required_changed', 'document_types', p_document_type_id,
    jsonb_build_object('required_for_work', v_before), jsonb_build_object('required_for_work', coalesce(p_required, false)), btrim(p_reason));
end;
$$;

-- Which document types the agency has marked required (for the document-type screen).
create function ogevia_api.list_required_document_types(p_organization_id uuid)
returns table (document_type_id uuid, required boolean)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'caregivers.manage') then
    raise exception 'You do not have permission to see document requirements' using errcode = 'OGA03';
  end if;
  return query select dt.id, dt.required_for_work from ogevia.document_types dt
   where dt.organization_id = p_organization_id and dt.is_active order by lower(dt.name);
end;
$$;

-- ---------------------------------------------------------------------------
-- API: verify (with the agency-approved validity dates) and revoke a document
-- ---------------------------------------------------------------------------
create function ogevia_api.verify_document_version(
  p_version_id uuid, p_valid_from date, p_valid_through date, p_review_due_on date, p_reason text default null, p_idempotency_key uuid default null
)
returns text
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v ogevia.document_versions%rowtype;
  v_cr uuid;
  v_owner_user uuid;
  v_fp text := concat_ws('|', p_version_id, p_valid_from, p_valid_through, p_review_due_on);
  v_prior jsonb;
  v_self boolean;
begin
  select * into v from ogevia.document_versions where id = p_version_id for update;
  if v.id is null or not ogevia.is_active_member(v.organization_id) then
    raise exception 'Document not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v.organization_id, 'documents.manage') then
    raise exception 'You do not have permission to verify documents' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('verify_document_version', p_idempotency_key, v.organization_id, v_fp);
  if v_prior is not null then return 'verified'; end if;
  select sd.caregiver_record_id into v_cr from ogevia.staff_documents sd where sd.id = v.document_id;
  perform ogevia.lock_caregiver_schedule(v_cr);
  select r.linked_user_id into v_owner_user from ogevia.caregiver_records r where r.id = v_cr;
  v_self := v.uploaded_by = v_actor or v_owner_user = v_actor;
  if v_self and not ogevia.has_permission(v.organization_id, 'documents.review_own') then
    raise exception 'You cannot verify your own document; ask the Administrator or another manager' using errcode = 'OGA03';
  end if;
  if p_valid_from is null or (p_valid_through is null and p_review_due_on is null) then
    raise exception 'Enter the date it is valid from and the date it is valid through or due for review' using errcode = 'OGV22';
  end if;
  if (p_valid_through is not null and p_valid_through < p_valid_from) or (p_review_due_on is not null and p_review_due_on < p_valid_from) then
    raise exception 'The end or review date cannot be before the valid-from date' using errcode = 'OGV22';
  end if;
  if v.review_status <> 'awaiting_review' then
    raise exception 'This document version has already been reviewed' using errcode = 'OGC09';
  end if;
  if exists (select 1 from ogevia.document_versions n where n.document_id = v.document_id and n.version_number > v.version_number) then
    raise exception 'A newer version was uploaded; review that one' using errcode = 'OGC09';
  end if;
  update ogevia.document_versions
     set review_status = 'verified', reviewed_by = v_actor, reviewed_at = now(),
         approved_valid_from = p_valid_from, approved_valid_through = p_valid_through, approved_review_due_on = p_review_due_on
   where id = v.id;
  perform ogevia.write_audit(v.organization_id, 'document.verified', 'document_versions', v.id,
    jsonb_build_object('review_status', 'awaiting_review'),
    jsonb_build_object('review_status', 'verified', 'valid_from', p_valid_from, 'valid_through', p_valid_through,
                       'review_due_on', p_review_due_on, 'self_review', v_self),
    case when v_self then 'Administrator self-review' || coalesce(': ' || nullif(btrim(coalesce(p_reason, '')), ''), '')
         else nullif(btrim(coalesce(p_reason, '')), '') end);
  perform ogevia.idempotency_finish('verify_document_version', p_idempotency_key, v.organization_id, v_fp, jsonb_build_object('decision', 'verified'));
  return 'verified';
end;
$$;

create function ogevia_api.revoke_document_verification(p_version_id uuid, p_reason text, p_idempotency_key uuid default null)
returns void
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v ogevia.document_versions%rowtype;
  v_cr uuid;
  v_fp text := concat_ws('|', p_version_id, btrim(coalesce(p_reason, '')));
  v_prior jsonb;
begin
  select * into v from ogevia.document_versions where id = p_version_id for update;
  if v.id is null or not ogevia.is_active_member(v.organization_id) then
    raise exception 'Document not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v.organization_id, 'documents.manage') then
    raise exception 'You do not have permission to revoke a verification' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('revoke_document_verification', p_idempotency_key, v.organization_id, v_fp);
  if v_prior is not null then return; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason is required to revoke a verification' using errcode = 'OGV22';
  end if;
  if v.review_status <> 'verified' then
    raise exception 'Only a verified document can be revoked' using errcode = 'OGC09';
  end if;
  select sd.caregiver_record_id into v_cr from ogevia.staff_documents sd where sd.id = v.document_id;
  perform ogevia.lock_caregiver_schedule(v_cr);
  if exists (select 1 from ogevia.document_version_revocations r where r.version_id = v.id) then
    raise exception 'This verification was already revoked' using errcode = 'OGC09';
  end if;
  insert into ogevia.document_version_revocations (organization_id, version_id, revoked_by, reason)
  values (v.organization_id, v.id, ogevia.require_actor(), btrim(p_reason));
  perform ogevia.write_audit(v.organization_id, 'document.verification_revoked', 'document_versions', v.id,
    jsonb_build_object('review_status', 'verified'), jsonb_build_object('revoked', true), btrim(p_reason));
  perform ogevia.idempotency_finish('revoke_document_verification', p_idempotency_key, v.organization_id, v_fp, jsonb_build_object('revoked', true));
end;
$$;

-- ---------------------------------------------------------------------------
-- API: service approvals (administrator writes; the caregiver reads only their own)
-- ---------------------------------------------------------------------------
create function ogevia_api.set_caregiver_service_approval(
  p_organization_id uuid, p_caregiver_record_id uuid, p_service_id uuid,
  p_effective_from date, p_effective_to date, p_reason text, p_idempotency_key uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_fp text := concat_ws('|', p_organization_id, p_caregiver_record_id, p_service_id, p_effective_from, p_effective_to, btrim(coalesce(p_reason, '')));
  v_prior jsonb;
  v_id uuid;
begin
  if v_actor is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'service_approvals.manage') then
    raise exception 'You do not have permission to approve services' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('set_caregiver_service_approval', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return (v_prior ->> 'id')::uuid; end if;
  if p_effective_from is null then
    raise exception 'Enter the date the approval starts' using errcode = 'OGV22';
  end if;
  if p_effective_to is not null and p_effective_to < p_effective_from then
    raise exception 'The end date cannot be before the start date' using errcode = 'OGV22';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason is required' using errcode = 'OGV22';
  end if;
  if not exists (select 1 from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null) then
    raise exception 'Care Team member not found' using errcode = 'OGN04';
  end if;
  if not exists (select 1 from ogevia.services s where s.id = p_service_id and s.organization_id = p_organization_id and s.deleted_at is null and s.is_active) then
    raise exception 'Service not found or inactive' using errcode = 'OGN04';
  end if;
  perform ogevia.lock_caregiver_schedule(p_caregiver_record_id);
  if exists (select 1 from ogevia.caregiver_service_approvals a
              where a.caregiver_record_id = p_caregiver_record_id and a.service_id = p_service_id and a.revoked_at is null
                and daterange(a.effective_from, a.effective_to, '[]') && daterange(p_effective_from, p_effective_to, '[]')) then
    raise exception 'An approval already covers some of these dates; revoke or change it first' using errcode = 'OGC09';
  end if;
  insert into ogevia.caregiver_service_approvals (organization_id, caregiver_record_id, service_id, effective_from, effective_to, reason, approved_by)
  values (p_organization_id, p_caregiver_record_id, p_service_id, p_effective_from, p_effective_to, btrim(p_reason), v_actor)
  returning id into v_id;
  perform ogevia.write_audit(p_organization_id, 'service_approval.approved', 'caregiver_service_approvals', v_id, null,
    jsonb_build_object('caregiver_record_id', p_caregiver_record_id, 'service_id', p_service_id,
                       'effective_from', p_effective_from, 'effective_to', p_effective_to), btrim(p_reason));
  perform ogevia.idempotency_finish('set_caregiver_service_approval', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('id', v_id));
  return v_id;
end;
$$;

create function ogevia_api.revoke_caregiver_service_approval(p_approval_id uuid, p_reason text, p_idempotency_key uuid default null)
returns void
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  a ogevia.caregiver_service_approvals%rowtype;
  v_fp text := concat_ws('|', p_approval_id, btrim(coalesce(p_reason, '')));
  v_prior jsonb;
begin
  select * into a from ogevia.caregiver_service_approvals where id = p_approval_id for update;
  if a.id is null or not ogevia.is_active_member(a.organization_id) then
    raise exception 'Approval not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(a.organization_id, 'service_approvals.manage') then
    raise exception 'You do not have permission to revoke approvals' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('revoke_caregiver_service_approval', p_idempotency_key, a.organization_id, v_fp);
  if v_prior is not null then return; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason is required to revoke an approval' using errcode = 'OGV22';
  end if;
  perform ogevia.lock_caregiver_schedule(a.caregiver_record_id);
  if a.revoked_at is not null then
    raise exception 'This approval was already revoked' using errcode = 'OGC09';
  end if;
  update ogevia.caregiver_service_approvals set revoked_at = now(), revoked_by = ogevia.require_actor(), revoked_reason = btrim(p_reason) where id = a.id;
  perform ogevia.write_audit(a.organization_id, 'service_approval.revoked', 'caregiver_service_approvals', a.id,
    jsonb_build_object('effective_from', a.effective_from, 'effective_to', a.effective_to), jsonb_build_object('revoked', true), btrim(p_reason));
  perform ogevia.idempotency_finish('revoke_caregiver_service_approval', p_idempotency_key, a.organization_id, v_fp, jsonb_build_object('revoked', true));
end;
$$;

-- Change = revoke the old record and approve again with the new dates, in one transaction (history kept).
create function ogevia_api.change_caregiver_service_approval(
  p_approval_id uuid, p_effective_from date, p_effective_to date, p_reason text, p_idempotency_key uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  a ogevia.caregiver_service_approvals%rowtype;
  v_id uuid;
begin
  select * into a from ogevia.caregiver_service_approvals where id = p_approval_id;
  if a.id is null or not ogevia.is_active_member(a.organization_id) then
    raise exception 'Approval not found' using errcode = 'OGN04';
  end if;
  perform ogevia_api.revoke_caregiver_service_approval(p_approval_id, 'Changed: ' || btrim(coalesce(p_reason, '')), null);
  v_id := ogevia_api.set_caregiver_service_approval(a.organization_id, a.caregiver_record_id, a.service_id,
    p_effective_from, p_effective_to, p_reason, null);
  return v_id;
end;
$$;

create function ogevia_api.list_caregiver_service_approvals(p_organization_id uuid, p_caregiver_record_id uuid)
returns table (
  approval_id uuid, service_id uuid, service_code text, service_name text, effective_from date, effective_to date,
  state text, reason text, approved_by_name text, created_at timestamptz,
  revoked_at timestamptz, revoked_reason text, revoked_by_name text
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not (ogevia.has_permission(p_organization_id, 'service_approvals.manage') or ogevia.has_permission(p_organization_id, 'caregivers.manage')) then
    raise exception 'You do not have permission to see service approvals' using errcode = 'OGA03';
  end if;
  return query
    select a.id, a.service_id, s.code, s.name, a.effective_from, a.effective_to,
           case when a.revoked_at is not null then 'revoked'
                when a.effective_from > ogevia.organization_local_date(p_organization_id, now()) then 'future'
                when a.effective_to is not null and a.effective_to < ogevia.organization_local_date(p_organization_id, now()) then 'expired'
                else 'current' end,
           a.reason, ab.display_name, a.created_at, a.revoked_at, a.revoked_reason, rb.display_name
      from ogevia.caregiver_service_approvals a
      join ogevia.services s on s.id = a.service_id and s.organization_id = a.organization_id
      left join ogevia.app_users ab on ab.id = a.approved_by
      left join ogevia.app_users rb on rb.id = a.revoked_by
     where a.organization_id = p_organization_id and a.caregiver_record_id = p_caregiver_record_id
     order by s.name, a.effective_from desc;
end;
$$;

-- The caregiver's own approvals: read-only, no reason text.
create function ogevia_api.list_my_service_approvals(p_organization_id uuid)
returns table (service_id uuid, service_code text, service_name text, effective_from date, effective_to date, state text)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_cr uuid;
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  v_cr := ogevia.my_caregiver_record(p_organization_id);
  if v_cr is null then
    return;
  end if;
  return query
    select a.service_id, s.code, s.name, a.effective_from, a.effective_to,
           case when a.revoked_at is not null then 'revoked'
                when a.effective_from > ogevia.organization_local_date(p_organization_id, now()) then 'future'
                when a.effective_to is not null and a.effective_to < ogevia.organization_local_date(p_organization_id, now()) then 'expired'
                else 'current' end
      from ogevia.caregiver_service_approvals a
      join ogevia.services s on s.id = a.service_id and s.organization_id = a.organization_id
     where a.organization_id = p_organization_id and a.caregiver_record_id = v_cr
     order by s.name, a.effective_from desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- API: what needs attention (no automatic grandfathering: a review list; flags, never silent changes)
-- ---------------------------------------------------------------------------
-- One row per active/ready caregiver and required document type, with the short state today and the
-- warning window from the agency settings. Shows type and state only.
create function ogevia_api.list_document_compliance(p_organization_id uuid)
returns table (
  caregiver_record_id uuid, caregiver_code text, caregiver_name text, document_type_id uuid, document_type_name text,
  state text, valid_through date, review_due_on date, days_left integer, pending_replacement boolean
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_today date := ogevia.organization_local_date(p_organization_id, now());
  v_warn integer;
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not (ogevia.has_permission(p_organization_id, 'documents.read') or ogevia.has_permission(p_organization_id, 'caregivers.manage')) then
    raise exception 'You do not have permission to see document status' using errcode = 'OGA03';
  end if;
  select s.expiry_warning_days into v_warn from ogevia.readiness_settings(p_organization_id) s;
  return query
    select r.id, r.caregiver_code, coalesce(r.preferred_name, r.first_name) || ' ' || r.last_name, dt.id, dt.name,
           case
             when base.state = 'ok' and base.eff_end is not null and base.eff_end <= v_today + v_warn then 'expiring'
             else base.state end,
           base.vthrough, base.vreview,
           case when base.eff_end is null then null else (base.eff_end - v_today)::integer end,
           ogevia.document_has_pending(p_organization_id, r.id, dt.id)
      from ogevia.caregiver_records r
      join ogevia.document_types dt on dt.organization_id = r.organization_id and dt.is_active and dt.required_for_work
      cross join lateral (
        select ogevia.document_requirement_state(p_organization_id, r.id, dt.id, v_today, v_today) as state,
               (select max(least(coalesce(dv.approved_valid_through, 'infinity'::date), coalesce(dv.approved_review_due_on, 'infinity'::date)))
                  from ogevia.staff_documents sd
                  join ogevia.document_versions dv on dv.document_id = sd.id and dv.organization_id = sd.organization_id
                  left join ogevia.document_version_revocations rv on rv.version_id = dv.id
                 where sd.organization_id = r.organization_id and sd.caregiver_record_id = r.id and sd.document_type_id = dt.id
                   and dv.review_status = 'verified' and rv.id is null
                   and (dv.approved_valid_through is not null or dv.approved_review_due_on is not null)) as eff_end,
               (select max(dv.approved_valid_through) from ogevia.staff_documents sd
                  join ogevia.document_versions dv on dv.document_id = sd.id and dv.organization_id = sd.organization_id
                 where sd.organization_id = r.organization_id and sd.caregiver_record_id = r.id and sd.document_type_id = dt.id and dv.review_status = 'verified') as vthrough,
               (select max(dv.approved_review_due_on) from ogevia.staff_documents sd
                  join ogevia.document_versions dv on dv.document_id = sd.id and dv.organization_id = sd.organization_id
                 where sd.organization_id = r.organization_id and sd.caregiver_record_id = r.id and sd.document_type_id = dt.id and dv.review_status = 'verified') as vreview
      ) base
     where r.organization_id = p_organization_id and r.deleted_at is null and r.status in ('onboarding', 'ready', 'active')
     order by (case base.state when 'ok' then 1 else 0 end), r.last_name, r.first_name, dt.name;
end;
$$;

-- Future shifts, and new-access standing assignments, whose caregiver no longer passes a requirement.
-- Flag only: nothing is cancelled, moved or unassigned, and past visits and approvals are untouched.
create function ogevia_api.list_readiness_flags(p_organization_id uuid, p_horizon_days integer default 90)
returns table (
  kind text, shift_id uuid, assignment_id uuid, caregiver_record_id uuid, caregiver_name text, client_code text,
  service_name text, starts_at timestamptz, reason_codes text[], reasons text[]
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_horizon integer := least(greatest(coalesce(p_horizon_days, 90), 1), 365);
begin
  if ogevia.require_actor() is null or not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not (ogevia.has_permission(p_organization_id, 'caregivers.manage') or ogevia.has_permission(p_organization_id, 'shifts.manage')) then
    raise exception 'You do not have permission to see readiness flags' using errcode = 'OGA03';
  end if;
  return query
    select 'shift'::text, s.id, null::uuid, s.caregiver_record_id,
           coalesce(r.preferred_name, r.first_name) || ' ' || r.last_name, c.client_code, sv.name, s.starts_at,
           array(select x ->> 'code' from jsonb_array_elements(rd -> 'reasons') x where x ->> 'code' <> 'TIME_CONFLICT'),
           array(select x ->> 'label' from jsonb_array_elements(rd -> 'reasons') x where x ->> 'code' <> 'TIME_CONFLICT')
      from ogevia.shifts s
      join ogevia.caregiver_records r on r.id = s.caregiver_record_id and r.organization_id = s.organization_id
      join ogevia.clients c on c.id = s.client_id and c.organization_id = s.organization_id
      join ogevia.services sv on sv.id = s.service_id and sv.organization_id = s.organization_id
      cross join lateral ogevia.assignment_readiness(s.organization_id, s.caregiver_record_id, s.client_id, s.service_id,
                                                      s.starts_at, s.ends_at, s.id, 'setting', false, false) rd
     where s.organization_id = p_organization_id and s.status = 'scheduled' and s.caregiver_record_id is not null
       and s.starts_at > now() and s.starts_at < now() + make_interval(days => v_horizon)
       and not ogevia.shift_is_called_out(s.id)
       and exists (select 1 from jsonb_array_elements(rd -> 'reasons') x where x ->> 'code' not in ('TIME_CONFLICT', 'AVAILABILITY'))
    union all
    select 'assignment'::text, null::uuid, a.id, a.caregiver_record_id,
           coalesce(r.preferred_name, r.first_name) || ' ' || r.last_name, c.client_code, sv.name, null::timestamptz,
           array(select x ->> 'code' from jsonb_array_elements(rd -> 'reasons') x),
           array(select x ->> 'label' from jsonb_array_elements(rd -> 'reasons') x)
      from ogevia.caregiver_assignments a
      join ogevia.caregiver_records r on r.id = a.caregiver_record_id and r.organization_id = a.organization_id
      join ogevia.clients c on c.id = a.client_id and c.organization_id = a.organization_id
      join ogevia.services sv on sv.id = a.service_id and sv.organization_id = a.organization_id
      cross join lateral ogevia.assignment_readiness(a.organization_id, a.caregiver_record_id, a.client_id, a.service_id,
                                                      (ogevia.organization_local_date(a.organization_id, now()))::timestamp at time zone
                                                        (select o.timezone from ogevia.organizations o where o.id = a.organization_id),
                                                      null, null, 'skip', false, false) rd
     where a.organization_id = p_organization_id and a.is_active and a.caregiver_user_id is not null
       and (a.effective_end is null or a.effective_end >= ogevia.organization_local_date(a.organization_id, now()))
       and (rd ->> 'blocked')::boolean
     order by 8 nulls last, 5;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke all on function ogevia.readiness_settings(uuid) from public;
revoke all on function ogevia.lock_caregiver_schedule(uuid) from public;
revoke all on function ogevia.document_requirement_state(uuid, uuid, uuid, date, date) from public;
revoke all on function ogevia.document_has_pending(uuid, uuid, uuid) from public;
revoke all on function ogevia.document_state_label(text, text) from public;
revoke all on function ogevia.assignment_readiness(uuid, uuid, uuid, uuid, timestamptz, timestamptz, uuid, text, boolean, boolean) from public;
revoke all on function ogevia.assert_assignment_ready(uuid, uuid, uuid, uuid, timestamptz, timestamptz, uuid, text, boolean, boolean, text) from public;
revoke all on function ogevia.service_approvals_guard_update() from public;
revoke all on function ogevia.shifts_readiness_gate() from public;
revoke all on function ogevia.assignments_readiness_gate() from public;
revoke all on function ogevia.visits_start_gate() from public;

revoke all on function ogevia_api.get_assignment_readiness(uuid, uuid, uuid, uuid, timestamptz, timestamptz, uuid) from public;
revoke all on function ogevia_api.begin_availability_override(uuid, text) from public;
revoke all on function ogevia_api.get_readiness_settings(uuid) from public;
revoke all on function ogevia_api.set_readiness_settings(uuid, boolean, boolean, integer, text) from public;
revoke all on function ogevia_api.set_document_type_required(uuid, uuid, boolean, text) from public;
revoke all on function ogevia_api.list_required_document_types(uuid) from public;
revoke all on function ogevia_api.verify_document_version(uuid, date, date, date, text, uuid) from public;
revoke all on function ogevia_api.revoke_document_verification(uuid, text, uuid) from public;
revoke all on function ogevia_api.set_caregiver_service_approval(uuid, uuid, uuid, date, date, text, uuid) from public;
revoke all on function ogevia_api.revoke_caregiver_service_approval(uuid, text, uuid) from public;
revoke all on function ogevia_api.change_caregiver_service_approval(uuid, date, date, text, uuid) from public;
revoke all on function ogevia_api.list_caregiver_service_approvals(uuid, uuid) from public;
revoke all on function ogevia_api.list_my_service_approvals(uuid) from public;
revoke all on function ogevia_api.list_document_compliance(uuid) from public;
revoke all on function ogevia_api.list_readiness_flags(uuid, integer) from public;

grant execute on function ogevia_api.get_assignment_readiness(uuid, uuid, uuid, uuid, timestamptz, timestamptz, uuid) to ogevia_app;
grant execute on function ogevia_api.begin_availability_override(uuid, text) to ogevia_app;
grant execute on function ogevia_api.get_readiness_settings(uuid) to ogevia_app;
grant execute on function ogevia_api.set_readiness_settings(uuid, boolean, boolean, integer, text) to ogevia_app;
grant execute on function ogevia_api.set_document_type_required(uuid, uuid, boolean, text) to ogevia_app;
grant execute on function ogevia_api.list_required_document_types(uuid) to ogevia_app;
grant execute on function ogevia_api.verify_document_version(uuid, date, date, date, text, uuid) to ogevia_app;
grant execute on function ogevia_api.revoke_document_verification(uuid, text, uuid) to ogevia_app;
grant execute on function ogevia_api.set_caregiver_service_approval(uuid, uuid, uuid, date, date, text, uuid) to ogevia_app;
grant execute on function ogevia_api.revoke_caregiver_service_approval(uuid, text, uuid) to ogevia_app;
grant execute on function ogevia_api.change_caregiver_service_approval(uuid, date, date, text, uuid) to ogevia_app;
grant execute on function ogevia_api.list_caregiver_service_approvals(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.list_my_service_approvals(uuid) to ogevia_app;
grant execute on function ogevia_api.list_document_compliance(uuid) to ogevia_app;
grant execute on function ogevia_api.list_readiness_flags(uuid, integer) to ogevia_app;
