-- 0055 Caregiver compliance hold: approved background-check clearance and the 14-day CPR/TB period (owner-defined rules).
--
-- OWNER-DEFINED PRODUCT RULES (2026-10-17). These are the agency's own rules. They are NOT stated or verified as legal requirements.
--   1. A caregiver may be created before clearance. Assignment is blocked until authorised office staff VERIFY an APPROVED
--      background-check result. A check that is merely "completed" never qualifies; the result must be approved and verified.
--   2. CPR and TB must be verified within 14 calendar days of the caregiver's hire date. When that period ends, a caregiver without
--      current VERIFIED CPR or TB is put on a compliance hold automatically. A missing hire date never bypasses this (see below).
--   3. Existing stricter controls stay: a REJECTED, EXPIRED or expiring-before-the-work-ends record, an expiry-date gap, or an agency
--      whose CPR/TB type or rule is not set up, is blocked at once; the 14-day period never relaxes those.
--
-- EXTENDS, DOES NOT DUPLICATE (what already existed, verified in the repository at d82fefc):
--   * ogevia.readiness_checks / assert_ready_for_work (0042, last redefined 0047) is the one commit-time gate. Manual assignment,
--     reassignment, care-request assignment, open-shift pick-up (check_shift_caregiver), recurring series (readiness_outcome),
--     standing assignments, ad-hoc starts and every new live visit (the 0044 service_visits trigger) already call it. This migration
--     adds a 'background' check and the grace rule INSIDE that gate, so all of those paths enforce the new rules with no new call sites.
--   * 0039/0040/0041 shift_readiness_flags and assignment_readiness_flags hold advice flags; they get a 'compliance' kind.
--   * 0041 document_requirement_check decides whether a CPR/TB record is verified and current; it is reused unchanged.
--   * Enforcement is still switched on by the owner (organization_readiness_settings.enforcement_active_from, 0042). Until then the
--     new checks REPORT but do not block, exactly like CPR/TB today, so applying this migration cannot strand live caregivers. The
--     readiness report (get_compliance_summary) lists who would be held before activation.
--
-- DEADLINE CALCULATION (exact):
--   hire_date      = a calendar date in the agency's own time zone (organizations.timezone), day 0.
--   due_date       = hire_date + 14 calendar days. The due date is the LAST day to complete both requirements (inclusive).
--   grace_ends_at  = (hire_date + 15 days) at 00:00 agency-local, converted with AT TIME ZONE. This is the first instant of the day
--                    after the due date. A daylight-saving day is therefore 23 or 25 hours long and the boundary stays at local
--                    midnight. The caregiver is in grace while  now < grace_ends_at.
--   MISSING hire date  -> there is no period to apply: a caregiver without current verified CPR and TB is blocked and held with the
--                         reason "hire date not recorded". Nothing is assumed.
--   The 14 lives in ogevia.compliance_grace_days() (one place). A hold opened because the period ENDED is STICKY: editing the hire date
--   to a later day does not reopen the period while that hold is open. A hold that exists only because the hire date was missing is
--   cleared by entering the real date (the period is then judged from it).
--
-- HOLD (ogevia.caregiver_compliance_holds): one open row per caregiver while any blocking requirement is unmet. Opening a hold flags every
-- affected scheduled shift (including each occurrence of a recurring series) and every active standing assignment (kind 'compliance'),
-- and counts visits in progress. NOTHING is cancelled, moved, ended or reassigned: assignment history and completed visits are untouched,
-- an in-progress visit is never ended (the office is alerted instead), and releasing a hold NEVER resumes a shift that was cancelled or
-- reassigned meanwhile. A hold is released only by the same evaluation, when every blocking requirement is resolved.
-- Blocking itself is computed live from the source records at every commit point, so it does not depend on the sweep running;
-- the sweep (ogevia.compliance_sweep, run on a schedule and on demand) only materialises the hold, the flags and the audit entries.
--
-- WHO: caregivers.compliance.manage (organization owner = administrator, as for CPR/TB verification in 0044) verifies background clearance
-- and may change a hire date that is already recorded. caregivers.manage may set a hire date that is not yet recorded and update the
-- check's process status, never the result. Nobody may verify their own background check. Every change is audited with actor and time.

insert into ogevia.permissions (key, description) values
  ('caregivers.compliance.manage', 'Verify background-check clearance and change a caregiver hire date that is already recorded');
insert into ogevia.role_permissions (role, permission_key) values
  ('organization_owner', 'caregivers.compliance.manage');

alter table ogevia.caregiver_records
  add column hire_date date check (hire_date is null or hire_date between date '2000-01-01' and date '2100-12-31');

create table ogevia.caregiver_background_checks (
  caregiver_record_id uuid primary key,
  organization_id uuid not null references ogevia.organizations(id),
  -- Process status (the agency's own tracking). "completed" is NOT clearance.
  status text not null default 'not_started'
    check (status in ('not_started', 'requested', 'submitted', 'pending', 'completed', 'needs_attention')),
  -- The result, recorded only by verification. Only 'approved' qualifies.
  result text check (result in ('approved', 'not_approved')),
  evidence_note text check (evidence_note is null or length(btrim(evidence_note)) between 3 and 500),
  verified_by uuid references ogevia.app_users(id),
  verified_at timestamptz,
  updated_by uuid references ogevia.app_users(id),
  updated_at timestamptz not null default now(),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id),
  constraint caregiver_background_verification_pair check ((verified_by is null) = (verified_at is null)),
  constraint caregiver_background_verified_needs_result check (verified_at is null or result is not null)
);
alter table ogevia.caregiver_background_checks enable row level security;

create table ogevia.caregiver_compliance_holds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid not null,
  -- [{requirement, code, message, dueDate}] for every blocking requirement at the last evaluation
  reasons jsonb not null check (jsonb_typeof(reasons) = 'array' and jsonb_array_length(reasons) > 0),
  -- true once the 14-day period (or a missing hire date) was the cause: a later hire-date edit does not reopen the period
  grace_closed boolean not null default false,
  opened_at timestamptz not null default now(),
  opened_by uuid references ogevia.app_users(id),
  updated_at timestamptz not null default now(),
  released_at timestamptz,
  released_by uuid references ogevia.app_users(id),
  release_note text,
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id),
  constraint caregiver_compliance_holds_release check (released_at is null or release_note is not null)
);
create unique index caregiver_compliance_holds_one_open on ogevia.caregiver_compliance_holds (caregiver_record_id) where released_at is null;
create index caregiver_compliance_holds_org_open_idx on ogevia.caregiver_compliance_holds (organization_id) where released_at is null;
alter table ogevia.caregiver_compliance_holds enable row level security;

-- Flags: a 'compliance' kind on the existing advice tables (same unique-open-flag index, same resolve columns).
alter table ogevia.shift_readiness_flags drop constraint shift_readiness_flags_kind_check;
alter table ogevia.shift_readiness_flags add constraint shift_readiness_flags_kind_check
  check (kind in ('availability', 'service', 'document', 'compliance'));
alter table ogevia.assignment_readiness_flags drop constraint assignment_readiness_flags_kind_check;
alter table ogevia.assignment_readiness_flags add constraint assignment_readiness_flags_kind_check
  check (kind in ('service', 'document', 'compliance'));

-- A recurring-series occurrence skipped because the caregiver is on hold.
alter table ogevia.shift_series_skipped_dates drop constraint shift_series_skipped_dates_reason_check;
alter table ogevia.shift_series_skipped_dates add constraint shift_series_skipped_dates_reason_check check (
  reason in ('exceeds_authorization', 'no_authorization', 'caregiver_conflict', 'already_started',
             'time_does_not_exist', 'time_occurs_twice',
             'documents_not_current', 'service_not_approved', 'availability_outside', 'availability_not_provided',
             'over_hour_limit', 'onboarding_incomplete',
             'compliance_hold'));

-- ---------------------------------------------------------------------------
-- Rules (internal, read-only)
-- ---------------------------------------------------------------------------

create function ogevia.compliance_grace_days()
returns integer
language sql
immutable
set search_path = ogevia, pg_temp
as $$ select 14; $$;

-- The 14-day period for one caregiver at one instant. in_grace is false whenever the hire date is missing, the agency time zone
-- is unusable, or a hold opened because the period ended is still open (sticky).
create function ogevia.compliance_grace(p_organization_id uuid, p_caregiver_record_id uuid, p_as_of timestamptz default now())
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

-- 'approved' (verified approved result) or the reason it does not qualify.
create function ogevia.background_clearance_state(p_organization_id uuid, p_caregiver_record_id uuid)
returns text
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select coalesce((
    select case
             when b.result = 'approved' and b.verified_by is not null and b.verified_at is not null then 'approved'
             when b.result = 'not_approved' then 'not_approved'
             when b.status = 'completed' then 'completed_not_approved'
             else b.status end
    from ogevia.caregiver_background_checks b
    where b.caregiver_record_id = p_caregiver_record_id and b.organization_id = p_organization_id), 'not_recorded');
$$;

create or replace function ogevia.readiness_message(p_check text, p_code text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 set search_path = ogevia, pg_temp
AS $$
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
    when p_check = 'background' then
      case p_code
        when 'background_not_approved' then 'Background check result is not approved.'
        when 'background_completed_not_approved' then 'Background check is completed but clearance is not verified as approved.'
        when 'background_not_recorded' then 'Background check clearance has not been verified.'
        else 'Background check clearance has not been verified as approved.' end
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
    when p_check = 'hours' then
      case p_code when 'daily_hour_limit' then 'Over the daily hour limit.' else 'Over the weekly hour limit.' end
    when p_check = 'conflict' then 'Already booked.'
    when p_check = 'caregiver' then 'Caregiver is not active.'
    when p_check = 'client' then 'A mandatory client requirement is not met.'
    else 'Not ready.' end;
$$;

-- 'background' is enforced exactly when CPR/TB are (after the owner activates enforcement).
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
    when 'background' then v_active
    when 'client' then true
    when 'availability' then v_active or p_context = 'care_request'
    when 'service' then v_active and coalesce(s.service_checks, false)
    else v_active end;
end;
$$;

-- Every requirement for one caregiver, with the 14-day period applied. blocking=false rows are PENDING (inside the period).
create function ogevia.compliance_blockers(p_organization_id uuid, p_caregiver_record_id uuid, p_as_of timestamptz default now())
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
      elsif g.sticky and p_as_of < g.grace_ends_at then
        return query select r, c.status || '_after_deadline',
          v_base || ' The ' || v_days || ' period already ended and a hold is open; changing the hire date does not reopen it.', true, g.due_date;
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

-- The gate: the 0047 definition with two additions (the background check, and the 14-day period for a missing or only-uploaded CPR/TB).
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
  g record;
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

  -- CPR / TB (0055): inside the 14-day period from the hire date, a record that is MISSING or only uploaded (awaiting review) is PENDING,
  -- not blocking. Everything else keeps its existing behaviour: rejected, expired, expiring before the work ends, expiry date missing,
  -- and an agency whose CPR/TB type or rule is not set up still block at once. The period is judged at the moment of the check.
  select * into g from ogevia.compliance_grace(p_organization_id, p_caregiver_record_id);
  for d in select * from ogevia.document_readiness(p_organization_id, p_caregiver_record_id, p_starts, p_ends) loop
    if g.in_grace and d.status in ('missing', 'awaiting_review') then
      return query select d.requirement, 'pending'::text, d.status,
                          ogevia.readiness_message(d.requirement, d.status) || ' Due ' || to_char(g.due_date, 'YYYY-MM-DD') || '.',
                          ogevia.readiness_enforced(p_organization_id, d.requirement, p_context);
      continue;
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

-- The series outcome for one occurrence: a caregiver whose background clearance is missing is skipped as 'compliance_hold'.
create or replace function ogevia.readiness_outcome(p_organization_id uuid, p_caregiver_record_id uuid, p_service_id uuid, p_starts timestamp with time zone, p_ends timestamp with time zone)
 RETURNS text
 LANGUAGE sql
 STABLE
 set search_path = ogevia, pg_temp
AS $$
  select case
    when bool_or(c.check_name = 'background') then 'compliance_hold'
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

-- ---------------------------------------------------------------------------
-- Hold evaluation (internal). Idempotent: running it twice changes nothing the second time.
-- ---------------------------------------------------------------------------

-- Flags the shifts (every occurrence of a recurring series is a shift row) and standing assignments a hold affects, resolves the
-- flags of work that is no longer assigned to the caregiver, and counts visits in progress. Never edits a shift, assignment or visit.
create function ogevia.compliance_flag_impact(p_organization_id uuid, p_caregiver_record_id uuid, p_hold uuid, p_reasons jsonb, p_actor uuid)
returns jsonb
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare
  s record;
  a record;
  v_user uuid;
  v_today date := ogevia.organization_local_date(p_organization_id, now());
  v_shifts integer := 0;
  v_assignments integer := 0;
  v_in_progress integer;
begin
  select r.linked_user_id into v_user from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id;
  for s in
    select sh.id, sh.starts_at, sh.ends_at from ogevia.shifts sh
    where sh.organization_id = p_organization_id and sh.status = 'scheduled' and sh.ends_at > now()
      and (sh.caregiver_record_id = p_caregiver_record_id or (v_user is not null and sh.caregiver_user_id = v_user))
      and not ogevia.shift_is_called_out(sh.id)
  loop
    insert into ogevia.shift_readiness_flags (organization_id, shift_id, caregiver_record_id, kind, reason_code, detail, cause_id)
    values (p_organization_id, s.id, p_caregiver_record_id, 'compliance', 'compliance_hold',
            jsonb_build_object('starts_at', s.starts_at, 'ends_at', s.ends_at, 'reasons', p_reasons), p_hold)
    on conflict (shift_id, kind) where resolved_at is null do update set detail = excluded.detail, cause_id = excluded.cause_id;
    v_shifts := v_shifts + 1;
  end loop;
  update ogevia.shift_readiness_flags f
     set resolved_at = now(), resolved_by = p_actor,
         resolution = 'No longer assigned to this caregiver (reassigned, cancelled or called out). The hold did not change this shift.'
   where f.organization_id = p_organization_id and f.caregiver_record_id = p_caregiver_record_id and f.kind = 'compliance' and f.resolved_at is null
     and not exists (select 1 from ogevia.shifts sh
                     where sh.id = f.shift_id and sh.status = 'scheduled' and sh.ends_at > now()
                       and (sh.caregiver_record_id = p_caregiver_record_id or (v_user is not null and sh.caregiver_user_id = v_user))
                       and not ogevia.shift_is_called_out(sh.id));
  for a in
    select ca.id from ogevia.caregiver_assignments ca
    where ca.organization_id = p_organization_id and ca.is_active and (ca.effective_end is null or ca.effective_end >= v_today)
      and (ca.caregiver_record_id = p_caregiver_record_id or (ca.caregiver_record_id is null and v_user is not null and ca.caregiver_user_id = v_user))
  loop
    insert into ogevia.assignment_readiness_flags (organization_id, assignment_id, caregiver_record_id, kind, reason_code, detail, cause_id)
    values (p_organization_id, a.id, p_caregiver_record_id, 'compliance', 'compliance_hold', jsonb_build_object('reasons', p_reasons), p_hold)
    on conflict (assignment_id, kind) where resolved_at is null do update set detail = excluded.detail, cause_id = excluded.cause_id;
    v_assignments := v_assignments + 1;
  end loop;
  update ogevia.assignment_readiness_flags f
     set resolved_at = now(), resolved_by = p_actor,
         resolution = 'No longer an active assignment for this caregiver. The hold did not change it.'
   where f.organization_id = p_organization_id and f.caregiver_record_id = p_caregiver_record_id and f.kind = 'compliance' and f.resolved_at is null
     and not exists (select 1 from ogevia.caregiver_assignments ca
                     where ca.id = f.assignment_id and ca.is_active and (ca.effective_end is null or ca.effective_end >= v_today));
  select count(*)::int into v_in_progress from ogevia.service_visits v
  where v.organization_id = p_organization_id and v.status = 'draft' and v.time_out is null
    and (v.caregiver_record_id = p_caregiver_record_id or (v.caregiver_record_id is null and v_user is not null and v.caregiver_user_id = v_user));
  return jsonb_build_object('flaggedShifts', v_shifts, 'flaggedAssignments', v_assignments, 'inProgressVisits', v_in_progress);
end;
$$;

-- Re-evaluates one caregiver: opens, updates or releases the hold and keeps the flags in step. Returns what happened.
-- Enforcement must be active for the agency (the owner's switch, 0042); otherwise nothing is materialised (the report still shows who
-- would be held). Only Ready/Active caregivers can be held: nobody else can work.
create function ogevia.compliance_evaluate(p_organization_id uuid, p_caregiver_record_id uuid, p_actor uuid default null, p_now timestamptz default now())
returns text
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare
  v_rec ogevia.caregiver_records%rowtype;
  v_hold ogevia.caregiver_compliance_holds%rowtype;
  v_reasons jsonb;
  v_closed boolean;
  v_impact jsonb;
begin
  if not ogevia.readiness_enforced(p_organization_id, 'background', 'visit_start') then return 'not_enforced'; end if;
  perform ogevia.lock_caregiver(p_caregiver_record_id);
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  if v_rec.id is null or v_rec.status not in ('ready', 'active') then return 'not_applicable'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('requirement', b.requirement, 'code', b.code, 'message', b.message, 'dueDate', b.due_date)
                            order by b.requirement), '[]'::jsonb),
         coalesce(bool_or(b.code like '%\_after\_deadline'), false)
    into v_reasons, v_closed
  from ogevia.compliance_blockers(p_organization_id, p_caregiver_record_id, p_now) b where b.blocking;

  select * into v_hold from ogevia.caregiver_compliance_holds h where h.caregiver_record_id = p_caregiver_record_id and h.released_at is null for update;

  if jsonb_array_length(v_reasons) > 0 then
    if v_hold.id is null then
      insert into ogevia.caregiver_compliance_holds (organization_id, caregiver_record_id, reasons, grace_closed, opened_at, opened_by)
      values (p_organization_id, p_caregiver_record_id, v_reasons, v_closed, p_now, p_actor)
      returning * into v_hold;
      v_impact := ogevia.compliance_flag_impact(p_organization_id, p_caregiver_record_id, v_hold.id, v_reasons, p_actor);
      perform ogevia.write_audit(p_organization_id, 'caregiver.compliance_hold_opened', 'caregiver_compliance_holds', v_hold.id, null,
        jsonb_build_object('caregiver_record_id', p_caregiver_record_id, 'reasons', v_reasons, 'automatic', p_actor is null) || v_impact, null);
      return 'opened';
    end if;
    -- A hold that was opened because the period ended stays that way even if a later hire date would put the caregiver back in it.
    update ogevia.caregiver_compliance_holds h
       set reasons = v_reasons, grace_closed = h.grace_closed or v_closed, updated_at = now()
     where h.id = v_hold.id and (h.reasons is distinct from v_reasons or (v_closed and not h.grace_closed));
    if found then
      perform ogevia.write_audit(p_organization_id, 'caregiver.compliance_hold_updated', 'caregiver_compliance_holds', v_hold.id,
        jsonb_build_object('reasons', v_hold.reasons), jsonb_build_object('reasons', v_reasons), null);
    end if;
    perform ogevia.compliance_flag_impact(p_organization_id, p_caregiver_record_id, v_hold.id, v_reasons, p_actor);
    return 'updated';
  end if;

  if v_hold.id is not null then
    update ogevia.caregiver_compliance_holds h
       set released_at = p_now, released_by = p_actor, updated_at = now(),
           release_note = 'Every blocking requirement is resolved. Shifts that were cancelled or reassigned while the hold was open were not restored.'
     where h.id = v_hold.id;
    update ogevia.shift_readiness_flags f
       set resolved_at = now(), resolved_by = p_actor,
           resolution = 'Compliance hold released: every blocking requirement is resolved. This shift was not changed.'
     where f.caregiver_record_id = p_caregiver_record_id and f.kind = 'compliance' and f.resolved_at is null;
    update ogevia.assignment_readiness_flags f
       set resolved_at = now(), resolved_by = p_actor,
           resolution = 'Compliance hold released: every blocking requirement is resolved.'
     where f.caregiver_record_id = p_caregiver_record_id and f.kind = 'compliance' and f.resolved_at is null;
    perform ogevia.write_audit(p_organization_id, 'caregiver.compliance_hold_released', 'caregiver_compliance_holds', v_hold.id,
      jsonb_build_object('reasons', v_hold.reasons), jsonb_build_object('caregiver_record_id', p_caregiver_record_id, 'automatic', p_actor is null), null);
    return 'released';
  end if;
  return 'none';
end;
$$;

-- Every Ready/Active caregiver of one agency (or of every agency with enforcement active when null). Safe to run any number of times.
create function ogevia.compliance_sweep(p_organization_id uuid default null, p_actor uuid default null, p_now timestamptz default now())
returns jsonb
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare
  c record;
  v_out text;
  n_eval integer := 0;
  n_opened integer := 0;
  n_released integer := 0;
begin
  for c in
    select r.organization_id, r.id from ogevia.caregiver_records r
    join ogevia.organizations o on o.id = r.organization_id and o.status = 'active'
    where r.deleted_at is null and r.status in ('ready', 'active') and (p_organization_id is null or r.organization_id = p_organization_id)
    order by r.organization_id, r.id
  loop
    v_out := ogevia.compliance_evaluate(c.organization_id, c.id, p_actor, p_now);
    if v_out in ('opened', 'updated', 'released', 'none') then n_eval := n_eval + 1; end if;
    if v_out = 'opened' then n_opened := n_opened + 1; end if;
    if v_out = 'released' then n_released := n_released + 1; end if;
  end loop;
  return jsonb_build_object('evaluated', n_eval, 'holdsOpened', n_opened, 'holdsReleased', n_released);
end;
$$;

-- Defence in depth: any write that commits a Ready/Active caregiver to dated work is checked here too, so a path that forgot the
-- gate cannot place a held caregiver (the same shape as the 0044 client-requirement guard). Pending items inside the period pass.
create function ogevia.assert_compliance_for_commit(p_organization_id uuid, p_caregiver_record_id uuid)
returns void
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare v_msgs text;
begin
  if not ogevia.readiness_enforced(p_organization_id, 'background', 'shift') then return; end if;
  perform ogevia.lock_caregiver(p_caregiver_record_id);
  select string_agg(b.message, ' ' order by b.requirement) into v_msgs
  from ogevia.compliance_blockers(p_organization_id, p_caregiver_record_id) b where b.blocking;
  if v_msgs is not null then raise exception 'Compliance hold. %', v_msgs using errcode = 'OGR30'; end if;
end;
$$;

create function ogevia.compliance_commit_guard()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
declare v_rec uuid; v_status text;
begin
  if tg_table_name = 'shifts' then
    if new.status <> 'scheduled' or new.ends_at <= now() then return new; end if;
    if tg_op = 'UPDATE' then
      if (new.caregiver_record_id, new.caregiver_user_id, new.starts_at, new.ends_at, new.status)
        is not distinct from (old.caregiver_record_id, old.caregiver_user_id, old.starts_at, old.ends_at, old.status) then return new; end if;
    end if;
  else
    if not new.is_active or new.effective_end < ogevia.organization_local_date(new.organization_id, now()) then return new; end if;
    if tg_op = 'UPDATE' then
      if (new.caregiver_record_id, new.caregiver_user_id, new.effective_start, new.effective_end, new.is_active)
        is not distinct from (old.caregiver_record_id, old.caregiver_user_id, old.effective_start, old.effective_end, old.is_active) then return new; end if;
    end if;
  end if;
  select r.id, r.status into v_rec, v_status from ogevia.caregiver_records r
    where r.organization_id = new.organization_id and r.deleted_at is null
      and (r.id = new.caregiver_record_id or (new.caregiver_record_id is null and r.linked_user_id = new.caregiver_user_id))
    order by r.id limit 1;
  -- Planned relationships do not grant access. Dated work is still gated.
  if v_rec is not null and (tg_table_name = 'shifts' or v_status in ('ready', 'active')) then
    perform ogevia.assert_compliance_for_commit(new.organization_id, v_rec);
  end if;
  return new;
end;
$$;
create trigger shifts_compliance_commit before insert or update on ogevia.shifts
  for each row execute function ogevia.compliance_commit_guard();
create trigger assignments_compliance_commit before insert or update on ogevia.caregiver_assignments
  for each row execute function ogevia.compliance_commit_guard();

-- A document verified, rejected, replaced or closed re-evaluates the caregiver at once (so a hold is released the moment the last
-- blocking record is verified, and opened the moment one is rejected).
create function ogevia.compliance_document_trigger()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
declare v_org uuid; v_cg uuid;
begin
  if tg_table_name = 'document_versions' then
    select d.organization_id, d.caregiver_record_id into v_org, v_cg from ogevia.staff_documents d where d.id = new.document_id;
  else
    v_org := new.organization_id; v_cg := new.caregiver_record_id;
  end if;
  if v_cg is not null then
    perform ogevia.compliance_evaluate(v_org, v_cg, ogevia.current_user_id());
  end if;
  return null;
end;
$$;
create trigger document_versions_compliance after insert or update of review_status, expires_on, issued_on on ogevia.document_versions
  for each row execute function ogevia.compliance_document_trigger();
create trigger staff_documents_compliance after update of closed_at on ogevia.staff_documents
  for each row execute function ogevia.compliance_document_trigger();

-- ---------------------------------------------------------------------------
-- API
-- ---------------------------------------------------------------------------

create function ogevia.compliance_read_guard(p_organization_id uuid)
returns void
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'readiness.read') or ogevia.has_permission(p_organization_id, 'caregivers.manage')
          or ogevia.has_permission(p_organization_id, 'caregivers.compliance.manage')) then
    raise exception 'You do not have permission to view caregiver compliance' using errcode = 'OGA03';
  end if;
end;
$$;

-- One caregiver's compliance, ready for the profile: eligibility, hire date and the exact deadline, background clearance, CPR/TB
-- (pending vs blocking, with due date), and the open hold with its reasons. Reads only.
create function ogevia.compliance_snapshot(p_organization_id uuid, p_caregiver_record_id uuid)
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

create function ogevia_api.get_caregiver_compliance(p_organization_id uuid, p_caregiver_record_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.compliance_read_guard(p_organization_id);
  return ogevia.compliance_snapshot(p_organization_id, p_caregiver_record_id);
end;
$$;

create function ogevia_api.set_caregiver_hire_date(
  p_organization_id uuid, p_caregiver_record_id uuid, p_hire_date date, p_reason text, p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_caregiver_record_id, p_hire_date, v_reason);
  v_prior jsonb;
  v_rec ogevia.caregiver_records%rowtype;
  v_out jsonb;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'caregivers.manage') or ogevia.has_permission(p_organization_id, 'caregivers.compliance.manage')) then
    raise exception 'You do not have permission to manage the Care Team' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('set_caregiver_hire_date', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior; end if;
  if p_hire_date is null or p_hire_date < date '2000-01-01' or p_hire_date > date '2100-12-31' then
    raise exception 'Enter the hire date' using errcode = 'OGV22';
  end if;
  if length(v_reason) < 3 then raise exception 'Enter a reason for the hire date' using errcode = 'OGV22'; end if;
  perform ogevia.lock_caregiver(p_caregiver_record_id);
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null for update;
  if v_rec.id is null then raise exception 'Care Team member not found' using errcode = 'OGN04'; end if;
  -- A hire date moves the CPR/TB deadline. Entering one that is not recorded yet is a normal office task (it is what clears a hold
  -- that exists only because the date was missing); changing one that is already recorded is an administrator action. Either way it
  -- is audited with the old and new value, the actor and the reason, and it never reopens a period that already ended (sticky hold).
  if v_rec.hire_date is not null and not ogevia.has_permission(p_organization_id, 'caregivers.compliance.manage') then
    raise exception 'Only an administrator can change a hire date that is already recorded' using errcode = 'OGA03';
  end if;
  update ogevia.caregiver_records r set hire_date = p_hire_date, updated_at = now() where r.id = v_rec.id;
  perform ogevia.write_audit(p_organization_id, 'caregiver.hire_date_set', 'caregiver_records', v_rec.id,
    jsonb_build_object('hire_date', v_rec.hire_date), jsonb_build_object('hire_date', p_hire_date), v_reason);
  perform ogevia.compliance_evaluate(p_organization_id, v_rec.id, v_actor);
  v_out := ogevia.compliance_snapshot(p_organization_id, v_rec.id);
  perform ogevia.idempotency_finish('set_caregiver_hire_date', p_idempotency_key, p_organization_id, v_fp, v_out);
  return v_out;
end;
$$;

-- Process status of the check. It can never record a result. Reopening a check that was approved withdraws the approval.
create function ogevia_api.set_background_check_status(
  p_organization_id uuid, p_caregiver_record_id uuid, p_status text, p_note text default null, p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_fp text := concat_ws('|', p_organization_id, p_caregiver_record_id, p_status, v_note);
  v_prior jsonb;
  v_rec ogevia.caregiver_records%rowtype;
  v_old ogevia.caregiver_background_checks%rowtype;
  v_withdrawn boolean := false;
  v_out jsonb;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'caregivers.manage') or ogevia.has_permission(p_organization_id, 'caregivers.compliance.manage')) then
    raise exception 'You do not have permission to manage the Care Team' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('set_background_check_status', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior; end if;
  if p_status is null or p_status not in ('not_started', 'requested', 'submitted', 'pending', 'completed', 'needs_attention') then
    raise exception 'Choose a background-check status' using errcode = 'OGV22';
  end if;
  perform ogevia.lock_caregiver(p_caregiver_record_id);
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null for update;
  if v_rec.id is null then raise exception 'Care Team member not found' using errcode = 'OGN04'; end if;
  select * into v_old from ogevia.caregiver_background_checks b where b.caregiver_record_id = v_rec.id for update;
  if v_old.caregiver_record_id is null then
    insert into ogevia.caregiver_background_checks (caregiver_record_id, organization_id, status, updated_by)
    values (v_rec.id, p_organization_id, p_status, v_actor);
  else
    v_withdrawn := v_old.result = 'approved' and p_status <> 'completed';
    update ogevia.caregiver_background_checks b
       set status = p_status, updated_by = v_actor, updated_at = now(),
           result = case when v_withdrawn then null else b.result end,
           evidence_note = case when v_withdrawn then null else b.evidence_note end,
           verified_by = case when v_withdrawn then null else b.verified_by end,
           verified_at = case when v_withdrawn then null else b.verified_at end
     where b.caregiver_record_id = v_rec.id;
  end if;
  perform ogevia.write_audit(p_organization_id, 'caregiver.background_status_set', 'caregiver_background_checks', v_rec.id,
    jsonb_build_object('status', v_old.status, 'result', v_old.result, 'verified_at', v_old.verified_at),
    jsonb_build_object('status', p_status, 'approval_withdrawn', v_withdrawn), v_note);
  perform ogevia.compliance_evaluate(p_organization_id, v_rec.id, v_actor);
  v_out := ogevia.compliance_snapshot(p_organization_id, v_rec.id);
  perform ogevia.idempotency_finish('set_background_check_status', p_idempotency_key, p_organization_id, v_fp, v_out);
  return v_out;
end;
$$;

-- Verification: the ONLY way a result is recorded. Administrator only; never your own record; evidence note required.
create function ogevia_api.verify_background_check(
  p_organization_id uuid, p_caregiver_record_id uuid, p_result text, p_evidence_note text, p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_note text := btrim(coalesce(p_evidence_note, ''));
  v_fp text := concat_ws('|', p_organization_id, p_caregiver_record_id, p_result, v_note);
  v_prior jsonb;
  v_rec ogevia.caregiver_records%rowtype;
  v_old ogevia.caregiver_background_checks%rowtype;
  v_out jsonb;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'caregivers.compliance.manage') then
    raise exception 'Only an administrator can verify background-check clearance' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('verify_background_check', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior; end if;
  if p_result is null or p_result not in ('approved', 'not_approved') then
    raise exception 'Choose Approved or Not approved' using errcode = 'OGV22';
  end if;
  if length(v_note) < 3 or length(v_note) > 500 then
    raise exception 'Enter where the clearance was confirmed (3 to 500 characters, no details of the report)' using errcode = 'OGV22';
  end if;
  perform ogevia.lock_caregiver(p_caregiver_record_id);
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null for update;
  if v_rec.id is null then raise exception 'Care Team member not found' using errcode = 'OGN04'; end if;
  if v_rec.linked_user_id is not null and v_rec.linked_user_id = v_actor then
    raise exception 'You cannot verify your own background check' using errcode = 'OGA03';
  end if;
  select * into v_old from ogevia.caregiver_background_checks b where b.caregiver_record_id = v_rec.id for update;
  insert into ogevia.caregiver_background_checks (caregiver_record_id, organization_id, status, result, evidence_note, verified_by, verified_at, updated_by)
  values (v_rec.id, p_organization_id, 'completed', p_result, v_note, v_actor, now(), v_actor)
  on conflict (caregiver_record_id) do update
    set status = 'completed', result = excluded.result, evidence_note = excluded.evidence_note,
        verified_by = excluded.verified_by, verified_at = excluded.verified_at, updated_by = excluded.updated_by, updated_at = now();
  perform ogevia.write_audit(p_organization_id, 'caregiver.background_verified', 'caregiver_background_checks', v_rec.id,
    jsonb_build_object('status', v_old.status, 'result', v_old.result, 'verified_at', v_old.verified_at, 'verified_by', v_old.verified_by),
    jsonb_build_object('status', 'completed', 'result', p_result), v_note);
  perform ogevia.compliance_evaluate(p_organization_id, v_rec.id, v_actor);
  v_out := ogevia.compliance_snapshot(p_organization_id, v_rec.id);
  perform ogevia.idempotency_finish('verify_background_check', p_idempotency_key, p_organization_id, v_fp, v_out);
  return v_out;
end;
$$;

-- Action Needed for holds: every open hold with its affected shifts (the office arranges coverage), standing assignments, and any visit
-- in progress (never ended by the hold). Reads only.
create function ogevia_api.list_compliance_holds(p_organization_id uuid)
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

-- The Action Needed count: shifts to cover plus visits in progress that need safe coverage, for caregivers on hold.
-- NULL (not zero) when the viewer may not see compliance, like the other Action Needed categories: a missing number is never a false zero.
create function ogevia_api.get_compliance_attention(p_organization_id uuid)
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
    'inProgressVisits', (select count(*) from ogevia.service_visits v
                         join ogevia.caregiver_compliance_holds h on h.organization_id = v.organization_id and h.released_at is null
                          and (h.caregiver_record_id = v.caregiver_record_id
                               or (v.caregiver_record_id is null
                                   and v.caregiver_user_id = (select r.linked_user_id from ogevia.caregiver_records r where r.id = h.caregiver_record_id)))
                         where v.organization_id = p_organization_id and v.status = 'draft' and v.time_out is null));
end;
$$;

-- The readiness report for owners before they switch enforcement on: how many Ready/Active caregivers would be held and why.
-- Computed for everyone, whether or not enforcement is active.
create function ogevia_api.get_compliance_summary(p_organization_id uuid)
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

-- On demand ("Check now"): re-evaluates this agency once. The scheduled run does the same for every agency.
create function ogevia_api.run_compliance_sweep(p_organization_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.require_actor();
begin
  perform ogevia.compliance_read_guard(p_organization_id);
  return ogevia.compliance_sweep(p_organization_id, v_actor);
end;
$$;

-- The scheduled run (no signed-in person). Two small statements, so one slow agency cannot exceed the API database timeout:
-- the agencies whose enforcement is active, then one agency at a time. Counts only; no names or identifiers leave the database.
create function ogevia_api.system_compliance_orgs()
returns setof uuid
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select o.id from ogevia.organizations o
  join ogevia.organization_readiness_settings s on s.organization_id = o.id
  where o.status = 'active' and s.enforcement_active_from is not null and s.enforcement_active_from <= now()
  order by o.id;
$$;

create function ogevia_api.system_compliance_sweep_org(p_organization_id uuid)
returns jsonb
language sql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
  select ogevia.compliance_sweep(p_organization_id, null);
$$;

-- ---------------------------------------------------------------------------
-- Grants (same shape as 0041/0042)
-- ---------------------------------------------------------------------------

revoke all on function ogevia.compliance_grace_days() from public;
revoke all on function ogevia.compliance_grace(uuid, uuid, timestamptz) from public;
revoke all on function ogevia.background_clearance_state(uuid, uuid) from public;
revoke all on function ogevia.compliance_blockers(uuid, uuid, timestamptz) from public;
revoke all on function ogevia.compliance_flag_impact(uuid, uuid, uuid, jsonb, uuid) from public;
revoke all on function ogevia.compliance_evaluate(uuid, uuid, uuid, timestamptz) from public;
revoke all on function ogevia.compliance_sweep(uuid, uuid, timestamptz) from public;
revoke all on function ogevia.assert_compliance_for_commit(uuid, uuid) from public;
revoke all on function ogevia.compliance_commit_guard() from public;
revoke all on function ogevia.compliance_document_trigger() from public;
revoke all on function ogevia.compliance_read_guard(uuid) from public;
revoke all on function ogevia.compliance_snapshot(uuid, uuid) from public;
revoke all on function ogevia_api.get_caregiver_compliance(uuid, uuid) from public;
revoke all on function ogevia_api.set_caregiver_hire_date(uuid, uuid, date, text, uuid) from public;
revoke all on function ogevia_api.set_background_check_status(uuid, uuid, text, text, uuid) from public;
revoke all on function ogevia_api.verify_background_check(uuid, uuid, text, text, uuid) from public;
revoke all on function ogevia_api.list_compliance_holds(uuid) from public;
revoke all on function ogevia_api.get_compliance_attention(uuid) from public;
revoke all on function ogevia_api.get_compliance_summary(uuid) from public;
revoke all on function ogevia_api.run_compliance_sweep(uuid) from public;
revoke all on function ogevia_api.system_compliance_orgs() from public;
revoke all on function ogevia_api.system_compliance_sweep_org(uuid) from public;
grant execute on function ogevia_api.get_caregiver_compliance(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.set_caregiver_hire_date(uuid, uuid, date, text, uuid) to ogevia_app;
grant execute on function ogevia_api.set_background_check_status(uuid, uuid, text, text, uuid) to ogevia_app;
grant execute on function ogevia_api.verify_background_check(uuid, uuid, text, text, uuid) to ogevia_app;
grant execute on function ogevia_api.list_compliance_holds(uuid) to ogevia_app;
grant execute on function ogevia_api.get_compliance_attention(uuid) to ogevia_app;
grant execute on function ogevia_api.get_compliance_summary(uuid) to ogevia_app;
grant execute on function ogevia_api.run_compliance_sweep(uuid) to ogevia_app;
grant execute on function ogevia_api.system_compliance_orgs() to ogevia_app;
grant execute on function ogevia_api.system_compliance_sweep_org(uuid) to ogevia_app;

grant select on table ogevia.caregiver_background_checks, ogevia.caregiver_compliance_holds to ogevia_readonly;
create policy readonly_select on ogevia.caregiver_background_checks for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.caregiver_compliance_holds for select to ogevia_readonly using (true);
