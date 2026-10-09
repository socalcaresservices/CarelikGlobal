-- 0041 Required work documents: CPR and TB (caregiver-readiness release).
--
-- Reuses the existing documents module (0021/0033): document types, requests, uploads, administrator
-- review (verified / rejected) and expiry dates. This migration adds only what readiness needs:
--
--   * An agency designates WHICH of its document types is its "CPR" record and which is its "TB"
--     record (document_types.work_requirement). Nothing is guessed from a type's name.
--   * An agency states HOW LONG each record stays valid (document_requirement_policies):
--       - 'document_expiry'  the verified record's own expiry date is the end of validity;
--       - 'issue_plus_days'  validity ends N days after the record's issue date (N set by the
--                            administrator; for a TB result whose validity is a policy, not a
--                            certificate date).
--     Ogevia ships NO default period and invents no legal requirement. Until an agency has
--     designated a type AND set the rule, that requirement is reported as INCOMPLETE SETUP.
--   * A caregiver is "current" for a requirement only when a version was VERIFIED by staff (an upload
--     alone is never verified), validity has not ended, and validity covers the whole work interval.
--   * Document readiness is separate from service approval and availability. Neither can stand in for
--     the other. Enforcement is added in 0042; this migration only records rules and reports status.
--   * Flags for future shifts and standing assignments that a document change puts at risk use the
--     same advisory flag tables as 0039/0040. In-progress visits are never interrupted.
--
-- Verification keeps using documents.manage (administrator and manager) and the existing self-review
-- rule; see docs/releases/caregiver-readiness for the policy decision on who may verify.

insert into ogevia.permissions (key, description) values
  ('documents.requirements.manage', 'Choose which document types are the CPR and TB records and set how long they stay valid');
insert into ogevia.role_permissions (role, permission_key) values
  ('organization_owner', 'documents.requirements.manage');

alter table ogevia.document_types add column work_requirement text check (work_requirement in ('cpr', 'tb'));
create unique index document_types_one_work_requirement on ogevia.document_types (organization_id, work_requirement)
  where work_requirement is not null;

create table ogevia.document_requirement_policies (
  organization_id uuid not null references ogevia.organizations(id),
  requirement text not null check (requirement in ('cpr', 'tb')),
  validity_basis text not null check (validity_basis in ('document_expiry', 'issue_plus_days')),
  validity_days integer check (validity_days between 1 and 3650),
  reason text not null check (length(btrim(reason)) between 3 and 500),
  configured_by uuid not null references ogevia.app_users(id),
  configured_at timestamptz not null default now(),
  primary key (organization_id, requirement),
  constraint document_requirement_policies_days check ((validity_basis = 'issue_plus_days') = (validity_days is not null))
);
alter table ogevia.document_requirement_policies enable row level security;

-- Policy history is kept: every change is audited, and the previous row is archived here.
create table ogevia.document_requirement_policy_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  requirement text not null,
  validity_basis text not null,
  validity_days integer,
  reason text not null,
  configured_by uuid not null references ogevia.app_users(id),
  configured_at timestamptz not null,
  replaced_at timestamptz not null default now()
);
alter table ogevia.document_requirement_policy_history enable row level security;

-- The one lock that every commit-time check and every readiness change takes first, per caregiver.
-- (check_shift_caregiver already used this key for overlap protection; it is now shared.)
create function ogevia.lock_caregiver(p_caregiver_record_id uuid)
returns void
language sql
volatile
set search_path = ogevia, pg_temp
as $$
  select pg_advisory_xact_lock(hashtextextended('ogevia.caregiver-schedule:' || p_caregiver_record_id::text, 0));
$$;

-- ---------------------------------------------------------------------------
-- Status of one requirement for one caregiver (internal)
-- ---------------------------------------------------------------------------

-- status: ok | type_not_set | policy_not_set | missing | awaiting_review | rejected | expiry_missing | expired | expires_during
-- The interval is optional; without it the check is "current today".
create function ogevia.document_requirement_check(
  p_organization_id uuid, p_caregiver_record_id uuid, p_requirement text,
  p_starts timestamptz default null, p_ends timestamptz default null
)
returns table (status text, valid_until date, document_id uuid, version_id uuid)
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  v_type uuid;
  v_policy ogevia.document_requirement_policies%rowtype;
  v_doc uuid;
  v_ver ogevia.document_versions%rowtype;
  v_latest ogevia.document_versions%rowtype;
  v_tz text;
  v_first date;
  v_last date;
  v_until date;
begin
  select t.id into v_type from ogevia.document_types t
  where t.organization_id = p_organization_id and t.work_requirement = p_requirement and t.is_active;
  if v_type is null then return query select 'type_not_set'::text, null::date, null::uuid, null::uuid; return; end if;
  select * into v_policy from ogevia.document_requirement_policies p
  where p.organization_id = p_organization_id and p.requirement = p_requirement;
  if v_policy.requirement is null then return query select 'policy_not_set'::text, null::date, null::uuid, null::uuid; return; end if;
  select d.id into v_doc from ogevia.staff_documents d
  where d.organization_id = p_organization_id and d.caregiver_record_id = p_caregiver_record_id and d.document_type_id = v_type and d.closed_at is null;
  if v_doc is null then return query select 'missing'::text, null::date, null::uuid, null::uuid; return; end if;
  select * into v_ver from ogevia.document_versions v
  where v.document_id = v_doc and v.review_status = 'verified' order by v.version_number desc limit 1;
  if v_ver.id is null then
    select * into v_latest from ogevia.document_versions v where v.document_id = v_doc order by v.version_number desc limit 1;
    if v_latest.id is null then return query select 'missing'::text, null::date, v_doc, null::uuid; return; end if;
    return query select case v_latest.review_status when 'rejected' then 'rejected' else 'awaiting_review' end, null::date, v_doc, v_latest.id;
    return;
  end if;
  v_until := case v_policy.validity_basis
               when 'document_expiry' then v_ver.expires_on
               else v_ver.issued_on + v_policy.validity_days end;
  if v_until is null then return query select 'expiry_missing'::text, null::date, v_doc, v_ver.id; return; end if;
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  if p_starts is null then
    v_first := ogevia.organization_local_date(p_organization_id, now()); v_last := v_first;
  else
    v_first := (p_starts at time zone v_tz)::date; v_last := ((p_ends - interval '1 microsecond') at time zone v_tz)::date;
  end if;
  return query select case when v_until < v_first then 'expired' when v_until < v_last then 'expires_during' else 'ok' end,
                      v_until, v_doc, v_ver.id;
end;
$$;

-- CPR and TB together for one caregiver and interval: one row per requirement.
create function ogevia.document_readiness(
  p_organization_id uuid, p_caregiver_record_id uuid, p_starts timestamptz default null, p_ends timestamptz default null
)
returns table (requirement text, status text, valid_until date, document_id uuid, version_id uuid)
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select r.req, c.status, c.valid_until, c.document_id, c.version_id
  from unnest(array['cpr', 'tb']) as r(req)
  cross join lateral ogevia.document_requirement_check(p_organization_id, p_caregiver_record_id, r.req, p_starts, p_ends) c;
$$;

-- Flags future shifts and standing assignments whose dates fall after the caregiver's validity (or whose
-- requirement is not current), and clears flags that are current again. Advice only.
create function ogevia.document_flag_impact(p_organization_id uuid, p_caregiver_record_id uuid, p_cause uuid, p_actor uuid)
returns jsonb
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare
  s record;
  a record;
  v_bad text;
  v_shifts jsonb := '[]'::jsonb;
  v_assignments jsonb := '[]'::jsonb;
  v_today date := ogevia.organization_local_date(p_organization_id, now());
  v_tz text;
begin
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  for s in
    select sh.id, sh.starts_at, sh.ends_at from ogevia.shifts sh
    where sh.organization_id = p_organization_id and sh.caregiver_record_id = p_caregiver_record_id
      and sh.status = 'scheduled' and sh.starts_at > now() and not ogevia.shift_is_called_out(sh.id)
  loop
    select string_agg(d.requirement || '_' || d.status, ',' order by d.requirement) into v_bad
    from ogevia.document_readiness(p_organization_id, p_caregiver_record_id, s.starts_at, s.ends_at) d where d.status <> 'ok';
    if v_bad is null then
      update ogevia.shift_readiness_flags f set resolved_at = now(), resolved_by = p_actor, resolution = 'Required documents are current for this shift'
       where f.shift_id = s.id and f.kind = 'document' and f.resolved_at is null;
    else
      insert into ogevia.shift_readiness_flags (organization_id, shift_id, caregiver_record_id, kind, reason_code, detail, cause_id)
      values (p_organization_id, s.id, p_caregiver_record_id, 'document', 'documents_' || v_bad,
              jsonb_build_object('starts_at', s.starts_at, 'ends_at', s.ends_at), p_cause)
      on conflict (shift_id, kind) where resolved_at is null do update set reason_code = excluded.reason_code, cause_id = excluded.cause_id;
      v_shifts := v_shifts || jsonb_build_object('shiftId', s.id, 'startsAt', s.starts_at, 'endsAt', s.ends_at);
    end if;
  end loop;
  for a in
    select ca.id, ca.effective_start, ca.effective_end from ogevia.caregiver_assignments ca
    where ca.organization_id = p_organization_id and ca.is_active and (ca.effective_end is null or ca.effective_end >= v_today)
      and (ca.caregiver_record_id = p_caregiver_record_id
           or (ca.caregiver_record_id is null and ca.caregiver_user_id = (select r.linked_user_id from ogevia.caregiver_records r where r.id = p_caregiver_record_id)))
  loop
    -- Standing assignments are judged from today to their end date (or the next 7 days when open-ended).
    select string_agg(d.requirement || '_' || d.status, ',' order by d.requirement) into v_bad
    from ogevia.document_readiness(
           p_organization_id, p_caregiver_record_id,
           greatest(a.effective_start, v_today)::timestamp at time zone v_tz,
           (coalesce(a.effective_end, greatest(a.effective_start, v_today) + 7) + 1)::timestamp at time zone v_tz) d
    where d.status <> 'ok';
    if v_bad is null then
      update ogevia.assignment_readiness_flags f set resolved_at = now(), resolved_by = p_actor, resolution = 'Required documents are current'
       where f.assignment_id = a.id and f.kind = 'document' and f.resolved_at is null;
    else
      insert into ogevia.assignment_readiness_flags (organization_id, assignment_id, caregiver_record_id, kind, reason_code, detail, cause_id)
      values (p_organization_id, a.id, p_caregiver_record_id, 'document', 'documents_' || v_bad, '{}'::jsonb, p_cause)
      on conflict (assignment_id, kind) where resolved_at is null do update set reason_code = excluded.reason_code, cause_id = excluded.cause_id;
      v_assignments := v_assignments || jsonb_build_object('assignmentId', a.id);
    end if;
  end loop;
  return jsonb_build_object('affectedShifts', v_shifts, 'affectedAssignments', v_assignments);
end;
$$;

-- ---------------------------------------------------------------------------
-- API: setup
-- ---------------------------------------------------------------------------

create function ogevia.requirement_admin_guard(p_organization_id uuid)
returns uuid
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.require_actor();
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'documents.requirements.manage') then
    raise exception 'Only an administrator can set the required documents' using errcode = 'OGA03';
  end if;
  return v_actor;
end;
$$;

-- What the agency has set up. incomplete = at least one requirement has no document type or no validity rule.
create function ogevia_api.get_work_requirement_setup(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'documents.read') or ogevia.has_permission(p_organization_id, 'documents.requirements.manage')) then
    raise exception 'Forbidden' using errcode = 'OGA03';
  end if;
  return (
    select jsonb_build_object(
      'requirements', jsonb_agg(jsonb_build_object(
        'requirement', r.req,
        'documentTypeId', t.id, 'documentTypeName', t.name,
        'validityBasis', p.validity_basis, 'validityDays', p.validity_days,
        'complete', t.id is not null and p.requirement is not null,
        'gap', case when t.id is null then 'type_not_set' when p.requirement is null then 'policy_not_set' end) order by r.req),
      'incomplete', bool_or(t.id is null or p.requirement is null))
    from unnest(array['cpr', 'tb']) as r(req)
    left join ogevia.document_types t on t.organization_id = p_organization_id and t.work_requirement = r.req and t.is_active
    left join ogevia.document_requirement_policies p on p.organization_id = p_organization_id and p.requirement = r.req);
end;
$$;

create function ogevia_api.set_document_work_requirement(
  p_organization_id uuid, p_requirement text, p_document_type_id uuid, p_reason text, p_idempotency_key uuid default null
)
returns void
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.requirement_admin_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_requirement, p_document_type_id, v_reason);
  v_prior jsonb;
  v_old uuid;
  c record;
begin
  v_prior := ogevia.idempotency_begin('set_document_work_requirement', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return; end if;
  if p_requirement not in ('cpr', 'tb') then raise exception 'Choose CPR or TB' using errcode = 'OGV22'; end if;
  if length(v_reason) < 3 then raise exception 'Enter a reason for the change' using errcode = 'OGV22'; end if;
  if p_document_type_id is not null and not exists (
       select 1 from ogevia.document_types t where t.id = p_document_type_id and t.organization_id = p_organization_id and t.is_active) then
    raise exception 'Document type not found' using errcode = 'OGN04';
  end if;
  select t.id into v_old from ogevia.document_types t where t.organization_id = p_organization_id and t.work_requirement = p_requirement;
  update ogevia.document_types set work_requirement = null where organization_id = p_organization_id and work_requirement = p_requirement;
  if p_document_type_id is not null then
    update ogevia.document_types set work_requirement = p_requirement where id = p_document_type_id;
  end if;
  perform ogevia.write_audit(p_organization_id, 'document_requirement.type_set', 'document_types', coalesce(p_document_type_id, v_old),
    jsonb_build_object('requirement', p_requirement, 'previous_document_type_id', v_old),
    jsonb_build_object('requirement', p_requirement, 'document_type_id', p_document_type_id), v_reason);
  for c in select r.id from ogevia.caregiver_records r where r.organization_id = p_organization_id and r.deleted_at is null and r.status <> 'inactive' loop
    perform ogevia.lock_caregiver(c.id);
    perform ogevia.document_flag_impact(p_organization_id, c.id, p_document_type_id, v_actor);
  end loop;
  perform ogevia.idempotency_finish('set_document_work_requirement', p_idempotency_key, p_organization_id, v_fp, '{}'::jsonb);
end;
$$;

create function ogevia_api.set_requirement_policy(
  p_organization_id uuid, p_requirement text, p_validity_basis text, p_validity_days integer, p_reason text, p_idempotency_key uuid default null
)
returns void
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.requirement_admin_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_requirement, p_validity_basis, p_validity_days, v_reason);
  v_prior jsonb;
  v_old ogevia.document_requirement_policies%rowtype;
  c record;
begin
  v_prior := ogevia.idempotency_begin('set_requirement_policy', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return; end if;
  if p_requirement not in ('cpr', 'tb') then raise exception 'Choose CPR or TB' using errcode = 'OGV22'; end if;
  if p_validity_basis not in ('document_expiry', 'issue_plus_days') then raise exception 'Choose how validity is measured' using errcode = 'OGV22'; end if;
  if p_validity_basis = 'issue_plus_days' and (p_validity_days is null or p_validity_days not between 1 and 3650) then
    raise exception 'Enter the number of days the record stays valid after its issue date (1 to 3650)' using errcode = 'OGV22';
  end if;
  if p_validity_basis = 'document_expiry' and p_validity_days is not null then
    raise exception 'A number of days applies only when validity is counted from the issue date' using errcode = 'OGV22';
  end if;
  if length(v_reason) < 3 then raise exception 'Enter a reason for the rule' using errcode = 'OGV22'; end if;
  select * into v_old from ogevia.document_requirement_policies where organization_id = p_organization_id and requirement = p_requirement for update;
  if v_old.requirement is not null then
    insert into ogevia.document_requirement_policy_history (organization_id, requirement, validity_basis, validity_days, reason, configured_by, configured_at)
    values (v_old.organization_id, v_old.requirement, v_old.validity_basis, v_old.validity_days, v_old.reason, v_old.configured_by, v_old.configured_at);
  end if;
  insert into ogevia.document_requirement_policies (organization_id, requirement, validity_basis, validity_days, reason, configured_by)
  values (p_organization_id, p_requirement, p_validity_basis, p_validity_days, v_reason, v_actor)
  on conflict (organization_id, requirement) do update
    set validity_basis = excluded.validity_basis, validity_days = excluded.validity_days, reason = excluded.reason,
        configured_by = excluded.configured_by, configured_at = now();
  perform ogevia.write_audit(p_organization_id, 'document_requirement.policy_set', 'document_requirement_policies', null,
    case when v_old.requirement is null then null else jsonb_build_object('requirement', v_old.requirement, 'validity_basis', v_old.validity_basis, 'validity_days', v_old.validity_days) end,
    jsonb_build_object('requirement', p_requirement, 'validity_basis', p_validity_basis, 'validity_days', p_validity_days), v_reason);
  for c in select r.id from ogevia.caregiver_records r where r.organization_id = p_organization_id and r.deleted_at is null and r.status <> 'inactive' loop
    perform ogevia.lock_caregiver(c.id);
    perform ogevia.document_flag_impact(p_organization_id, c.id, null, v_actor);
  end loop;
  perform ogevia.idempotency_finish('set_requirement_policy', p_idempotency_key, p_organization_id, v_fp, '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- API: readiness views
-- ---------------------------------------------------------------------------

-- One caregiver's CPR and TB (optionally for an interval). Staff pass a record id; a caregiver sees their own.
create function ogevia_api.get_document_readiness(
  p_organization_id uuid, p_caregiver_record_id uuid default null, p_starts timestamptz default null, p_ends timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare v_rec uuid;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if (p_starts is null) <> (p_ends is null) or (p_starts is not null and p_ends <= p_starts) then
    raise exception 'Enter a start and an end for the work interval' using errcode = 'OGV22';
  end if;
  if p_caregiver_record_id is null then
    v_rec := ogevia.my_caregiver_record(p_organization_id);
    if v_rec is null or not ogevia.has_permission(p_organization_id, 'documents.manage_own') then raise exception 'Forbidden' using errcode = 'OGA03'; end if;
  else
    if not ogevia.has_permission(p_organization_id, 'documents.read') then raise exception 'Forbidden' using errcode = 'OGA03'; end if;
    select r.id into v_rec from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
    if v_rec is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  end if;
  return jsonb_build_object('caregiverRecordId', v_rec,
    'requirements', (select jsonb_agg(jsonb_build_object('requirement', d.requirement, 'status', d.status, 'validUntil', d.valid_until,
                                                         'documentId', d.document_id) order by d.requirement)
                     from ogevia.document_readiness(p_organization_id, v_rec, p_starts, p_ends) d));
end;
$$;

-- Everyone's CPR/TB status today, plus the number of future shifts that would not be covered. Staff only.
create function ogevia_api.list_document_readiness(p_organization_id uuid)
returns table (
  caregiver_record_id uuid, caregiver_code text, caregiver_name text, caregiver_status text,
  cpr_status text, cpr_valid_until date, tb_status text, tb_valid_until date, future_shifts_at_risk integer
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'documents.read') then raise exception 'Forbidden' using errcode = 'OGA03'; end if;
  return query
  select c.id, c.caregiver_code, concat_ws(' ', coalesce(c.preferred_name, c.first_name), c.last_name), c.status,
         (select d.status from ogevia.document_readiness(p_organization_id, c.id) d where d.requirement = 'cpr'),
         (select d.valid_until from ogevia.document_readiness(p_organization_id, c.id) d where d.requirement = 'cpr'),
         (select d.status from ogevia.document_readiness(p_organization_id, c.id) d where d.requirement = 'tb'),
         (select d.valid_until from ogevia.document_readiness(p_organization_id, c.id) d where d.requirement = 'tb'),
         (select count(*)::int from ogevia.shifts sh
           where sh.organization_id = p_organization_id and sh.caregiver_record_id = c.id and sh.status = 'scheduled' and sh.starts_at > now()
             and not ogevia.shift_is_called_out(sh.id)
             and exists (select 1 from ogevia.document_readiness(p_organization_id, c.id, sh.starts_at, sh.ends_at) d where d.status <> 'ok'))
  from ogevia.caregiver_records c
  where c.organization_id = p_organization_id and c.deleted_at is null and c.status <> 'inactive'
  order by c.caregiver_code;
end;
$$;

-- Review of a document version now also refreshes the readiness flags when the type is CPR or TB, under
-- the shared per-caregiver lock, so a verification (or rejection) cannot interleave with a commit-time check.
create or replace function ogevia_api.review_document_version(p_version_id uuid, p_decision text, p_reason text, p_idempotency_key uuid default null)
returns text
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v ogevia.document_versions%rowtype;
  v_fp text := concat_ws('|', p_version_id, p_decision, btrim(coalesce(p_reason, '')));
  v_prior jsonb;
  v_self boolean;
  v_rec uuid;
  v_requirement text;
begin
  select * into v from ogevia.document_versions where id = p_version_id;
  if v.id is null or not ogevia.is_active_member(v.organization_id) then
    raise exception 'Document not found' using errcode = 'OGN04';
  end if;
  select d.caregiver_record_id, t.work_requirement into v_rec, v_requirement
  from ogevia.staff_documents d join ogevia.document_types t on t.id = d.document_type_id where d.id = v.document_id;
  if v_requirement is not null then perform ogevia.lock_caregiver(v_rec); end if;
  select * into v from ogevia.document_versions where id = p_version_id for update;
  if not ogevia.has_permission(v.organization_id, 'documents.manage') then
    raise exception 'You do not have permission to review documents' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('review_document_version', p_idempotency_key, v.organization_id, v_fp);
  if v_prior is not null then return v_prior ->> 'decision'; end if;
  if p_decision not in ('verified', 'rejected') then
    raise exception 'Decision must be verified or rejected' using errcode = 'OGV22';
  end if;
  if p_decision = 'rejected' and length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required to reject a document' using errcode = 'OGV22';
  end if;
  v_self := v.uploaded_by = v_actor;
  if v_self and not ogevia.has_permission(v.organization_id, 'documents.review_own') then
    raise exception 'You cannot review a document you uploaded; ask the Administrator or another manager' using errcode = 'OGA03';
  end if;
  if v.review_status <> 'awaiting_review' then
    raise exception 'This document version has already been reviewed' using errcode = 'OGC09';
  end if;
  if exists (select 1 from ogevia.document_versions n where n.document_id = v.document_id and n.version_number > v.version_number) then
    raise exception 'A newer version was uploaded; review that one' using errcode = 'OGC09';
  end if;
  update ogevia.document_versions set review_status = p_decision::ogevia.document_review_status, reviewed_by = v_actor,
    reviewed_at = now(), rejection_reason = case when p_decision = 'rejected' then btrim(p_reason) end
   where id = v.id;
  perform ogevia.write_audit(v.organization_id, 'document.' || p_decision, 'document_versions', v.id,
    jsonb_build_object('review_status', 'awaiting_review'),
    jsonb_build_object('review_status', p_decision, 'self_review', v_self),
    case when v_self then 'Administrator self-review' || coalesce(': ' || nullif(btrim(coalesce(p_reason, '')), ''), '')
         else nullif(btrim(coalesce(p_reason, '')), '') end);
  if v_requirement is not null then
    perform ogevia.document_flag_impact(v.organization_id, v_rec, v.id, v_actor);
  end if;
  perform ogevia.idempotency_finish('review_document_version', p_idempotency_key, v.organization_id, v_fp,
    jsonb_build_object('decision', p_decision));
  return p_decision;
end;
$$;

revoke all on function ogevia.lock_caregiver(uuid) from public;
revoke all on function ogevia.document_requirement_check(uuid, uuid, text, timestamptz, timestamptz) from public;
revoke all on function ogevia.document_readiness(uuid, uuid, timestamptz, timestamptz) from public;
revoke all on function ogevia.document_flag_impact(uuid, uuid, uuid, uuid) from public;
revoke all on function ogevia.requirement_admin_guard(uuid) from public;
revoke all on function ogevia_api.get_work_requirement_setup(uuid) from public;
revoke all on function ogevia_api.set_document_work_requirement(uuid, text, uuid, text, uuid) from public;
revoke all on function ogevia_api.set_requirement_policy(uuid, text, text, integer, text, uuid) from public;
revoke all on function ogevia_api.get_document_readiness(uuid, uuid, timestamptz, timestamptz) from public;
revoke all on function ogevia_api.list_document_readiness(uuid) from public;
grant execute on function ogevia_api.get_work_requirement_setup(uuid) to ogevia_app;
grant execute on function ogevia_api.set_document_work_requirement(uuid, text, uuid, text, uuid) to ogevia_app;
grant execute on function ogevia_api.set_requirement_policy(uuid, text, text, integer, text, uuid) to ogevia_app;
grant execute on function ogevia_api.get_document_readiness(uuid, uuid, timestamptz, timestamptz) to ogevia_app;
grant execute on function ogevia_api.list_document_readiness(uuid) to ogevia_app;
