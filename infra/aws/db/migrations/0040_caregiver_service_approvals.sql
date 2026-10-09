-- 0040 Caregiver service approvals (caregiver-readiness release).
--
-- Records, per agency, caregiver and service, whether an administrator has approved that
-- caregiver to deliver that service: status, effective dates, who approved and why, and every
-- revocation. It is deliberately SEPARATE from
--   * the client's service authorisation (client_authorizations: hours the payer allows),
--   * client assignment (caregiver_assignments: who may serve which client), and
--   * the caregiver's employment / delivery model.
-- Nothing here is inferred from assignments, shifts, visits or documents. Existing
-- caregiver/service pairs are only offered as a REVIEW LIST; approval happens only for pairs an
-- administrator explicitly selects and confirms.
--
--   * Approval is administrator-only (caregiver_services.approve, owner role). Managers can
--     read; caregivers read their own and cannot approve themselves (nobody can approve their own
--     caregiver record).
--   * Approval covers dates. A shift or visit is covered only when EVERY agency-local date it
--     touches is covered, so an overnight interval needs both days.
--   * Revocation never deletes: it records who/when/why and an effective date. Dates before that
--     date stay covered, so historical visits keep their evidence of authorisation. Future shifts
--     and standing assignments that lose coverage are FLAGGED for review, never changed.
--   * Historical visits and billing approvals are never touched by anything in this migration.
--   * Enforcement (blocking work without approval) is added separately in 0042 behind the
--     "Service checks" switch, off by default.

insert into ogevia.permissions (key, description) values
  ('caregiver_services.read', 'View which services caregivers are approved to deliver'),
  ('caregiver_services.read_own', 'View your own approved services'),
  ('caregiver_services.approve', 'Approve and revoke caregiver service approvals');
insert into ogevia.role_permissions (role, permission_key) values
  ('organization_owner', 'caregiver_services.read'),
  ('manager', 'caregiver_services.read'),
  ('scheduler', 'caregiver_services.read'),
  ('caregiver', 'caregiver_services.read_own'),
  ('organization_owner', 'caregiver_services.approve');

create table ogevia.caregiver_service_approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid not null,
  service_id uuid not null,
  effective_from date not null,
  effective_until date,
  approval_reason text not null check (length(btrim(approval_reason)) between 3 and 500),
  source text not null default 'administrator' check (source in ('administrator', 'bulk_review')),
  review_batch_id uuid,
  approved_by uuid not null references ogevia.app_users(id),
  approved_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references ogevia.app_users(id),
  revoked_effective_on date,
  revocation_reason text,
  unique (id, organization_id),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id),
  foreign key (service_id, organization_id) references ogevia.services (id, organization_id),
  constraint caregiver_service_approvals_range check (effective_until is null or effective_until >= effective_from),
  constraint caregiver_service_approvals_revocation check (
    (revoked_at is null and revoked_by is null and revoked_effective_on is null and revocation_reason is null)
    or (revoked_at is not null and revoked_by is not null and revoked_effective_on is not null
        and length(btrim(coalesce(revocation_reason, ''))) >= 3))
);
create index caregiver_service_approvals_pair_idx on ogevia.caregiver_service_approvals (organization_id, caregiver_record_id, service_id);
create index caregiver_service_approvals_batch_idx on ogevia.caregiver_service_approvals (review_batch_id) where review_batch_id is not null;

-- Standing assignments that lose approval (or, in 0041, a required document) are flagged here.
create table ogevia.assignment_readiness_flags (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  assignment_id uuid not null references ogevia.caregiver_assignments(id),
  caregiver_record_id uuid not null,
  kind text not null check (kind in ('service', 'document')),
  reason_code text not null,
  detail jsonb not null default '{}'::jsonb,
  cause_id uuid,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references ogevia.app_users(id),
  resolution text,
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id)
);
create unique index assignment_readiness_flags_one_open on ogevia.assignment_readiness_flags (assignment_id, kind) where resolved_at is null;
create index assignment_readiness_flags_org_open_idx on ogevia.assignment_readiness_flags (organization_id, kind) where resolved_at is null;

alter table ogevia.caregiver_service_approvals enable row level security;
alter table ogevia.assignment_readiness_flags enable row level security;

-- ---------------------------------------------------------------------------
-- Coverage (internal)
-- ---------------------------------------------------------------------------

-- The dates an approval grant covers: [effective_from, least(effective_until, revoked_effective_on - 1)].
create function ogevia.service_approval_dates(p_a ogevia.caregiver_service_approvals)
returns daterange
language sql
immutable
set search_path = ogevia, pg_temp
as $$
  select case
    when upper_day is not null and upper_day < p_a.effective_from then 'empty'::daterange
    else daterange(p_a.effective_from, upper_day, '[]')
  end
  from (select case
          when p_a.revoked_effective_on is not null and p_a.effective_until is not null then least(p_a.effective_until, p_a.revoked_effective_on - 1)
          when p_a.revoked_effective_on is not null then p_a.revoked_effective_on - 1
          else p_a.effective_until
        end as upper_day) u;
$$;

-- 'approved' | 'partial' | 'revoked' | 'expired' | 'not_approved' for one interval. The approval must
-- cover EVERY agency-local date the interval touches (overnight intervals touch two).
create function ogevia.service_approval_status(
  p_organization_id uuid, p_caregiver_record_id uuid, p_service_id uuid, p_starts timestamptz, p_ends timestamptz
)
returns text
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  v_tz text;
  v_first date;
  v_last date;
  v_need daterange;
  v_cover datemultirange;
  v_latest ogevia.caregiver_service_approvals%rowtype;
begin
  select o.timezone into v_tz from ogevia.organizations o where o.id = p_organization_id;
  v_first := (p_starts at time zone v_tz)::date;
  v_last := ((p_ends - interval '1 microsecond') at time zone v_tz)::date;
  v_need := daterange(v_first, v_last, '[]');
  select range_agg(ogevia.service_approval_dates(a)) into v_cover
  from ogevia.caregiver_service_approvals a
  where a.organization_id = p_organization_id and a.caregiver_record_id = p_caregiver_record_id and a.service_id = p_service_id
    and not isempty(ogevia.service_approval_dates(a));
  if v_cover is not null and v_cover @> v_need then return 'approved'; end if;
  if v_cover is not null and v_cover && datemultirange(v_need) then return 'partial'; end if;
  select * into v_latest from ogevia.caregiver_service_approvals a
  where a.organization_id = p_organization_id and a.caregiver_record_id = p_caregiver_record_id and a.service_id = p_service_id
  order by a.approved_at desc limit 1;
  if v_latest.id is null then return 'not_approved'; end if;
  if v_latest.revoked_at is not null then return 'revoked'; end if;
  if v_latest.effective_until is not null and v_latest.effective_until < v_first then return 'expired'; end if;
  return 'not_approved';
end;
$$;

-- Flags future shifts and active standing assignments of one caregiver/service that are not covered;
-- clears flags that are covered again. Advice only: nothing is moved, cancelled or blocked here.
create function ogevia.service_flag_impact(
  p_organization_id uuid, p_caregiver_record_id uuid, p_service_id uuid, p_cause uuid, p_actor uuid
)
returns jsonb
language plpgsql
volatile
set search_path = ogevia, pg_temp
as $$
declare
  s record;
  a record;
  v_shifts jsonb := '[]'::jsonb;
  v_assignments jsonb := '[]'::jsonb;
  v_status text;
  v_today date := ogevia.organization_local_date(p_organization_id, now());
begin
  for s in
    select sh.id, sh.starts_at, sh.ends_at from ogevia.shifts sh
    where sh.organization_id = p_organization_id and sh.caregiver_record_id = p_caregiver_record_id and sh.service_id = p_service_id
      and sh.status = 'scheduled' and sh.starts_at > now() and not ogevia.shift_is_called_out(sh.id)
  loop
    v_status := ogevia.service_approval_status(p_organization_id, p_caregiver_record_id, p_service_id, s.starts_at, s.ends_at);
    if v_status = 'approved' then
      update ogevia.shift_readiness_flags f set resolved_at = now(), resolved_by = p_actor, resolution = 'Service approval covers this shift again'
       where f.shift_id = s.id and f.kind = 'service' and f.resolved_at is null;
    else
      insert into ogevia.shift_readiness_flags (organization_id, shift_id, caregiver_record_id, kind, reason_code, detail, cause_id)
      values (p_organization_id, s.id, p_caregiver_record_id, 'service', 'service_' || v_status,
              jsonb_build_object('service_id', p_service_id, 'starts_at', s.starts_at, 'ends_at', s.ends_at), p_cause)
      on conflict (shift_id, kind) where resolved_at is null do nothing;
      v_shifts := v_shifts || jsonb_build_object('shiftId', s.id, 'startsAt', s.starts_at, 'endsAt', s.ends_at);
    end if;
  end loop;
  for a in
    select ca.id, ca.client_id, ca.effective_start, ca.effective_end
    from ogevia.caregiver_assignments ca
    where ca.organization_id = p_organization_id and ca.service_id = p_service_id and ca.is_active
      and (ca.effective_end is null or ca.effective_end >= v_today)
      and (ca.caregiver_record_id = p_caregiver_record_id
           or (ca.caregiver_record_id is null and ca.caregiver_user_id = (select r.linked_user_id from ogevia.caregiver_records r where r.id = p_caregiver_record_id)))
  loop
    -- A standing assignment is covered while the approval covers today onward through its end (or the next 7 days when open-ended).
    v_status := ogevia.service_approval_status(
      p_organization_id, p_caregiver_record_id, p_service_id,
      (greatest(a.effective_start, v_today))::timestamp at time zone (select o.timezone from ogevia.organizations o where o.id = p_organization_id),
      (coalesce(a.effective_end, greatest(a.effective_start, v_today) + 7) + 1)::timestamp at time zone (select o.timezone from ogevia.organizations o where o.id = p_organization_id));
    if v_status = 'approved' then
      update ogevia.assignment_readiness_flags f set resolved_at = now(), resolved_by = p_actor, resolution = 'Service approval covers this assignment again'
       where f.assignment_id = a.id and f.kind = 'service' and f.resolved_at is null;
    else
      insert into ogevia.assignment_readiness_flags (organization_id, assignment_id, caregiver_record_id, kind, reason_code, detail, cause_id)
      values (p_organization_id, a.id, p_caregiver_record_id, 'service', 'service_' || v_status,
              jsonb_build_object('service_id', p_service_id, 'client_id', a.client_id), p_cause)
      on conflict (assignment_id, kind) where resolved_at is null do nothing;
      v_assignments := v_assignments || jsonb_build_object('assignmentId', a.id);
    end if;
  end loop;
  return jsonb_build_object('affectedShifts', v_shifts, 'affectedAssignments', v_assignments);
end;
$$;

create function ogevia.service_approval_guard(p_organization_id uuid)
returns uuid
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare v_actor uuid := ogevia.require_actor();
begin
  if not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'caregiver_services.approve') then
    raise exception 'Only an administrator can approve or revoke caregiver services' using errcode = 'OGA03';
  end if;
  return v_actor;
end;
$$;

-- ---------------------------------------------------------------------------
-- API
-- ---------------------------------------------------------------------------

-- Staff read all (or one caregiver); a caregiver reads only their own. Newest first.
create function ogevia_api.list_caregiver_service_approvals(p_organization_id uuid, p_caregiver_record_id uuid default null)
returns table (
  approval_id uuid, caregiver_record_id uuid, caregiver_code text, caregiver_name text, service_id uuid, service_code text,
  service_name text, state text, effective_from date, effective_until date, approval_reason text, approved_by_name text,
  approved_at timestamp with time zone, revoked_at timestamp with time zone, revoked_effective_on date, revocation_reason text, source text
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_own uuid;
  v_staff boolean;
  v_today date := ogevia.organization_local_date(p_organization_id, now());
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  v_staff := ogevia.has_permission(p_organization_id, 'caregiver_services.read');
  if not v_staff then
    if not ogevia.has_permission(p_organization_id, 'caregiver_services.read_own') then raise exception 'Forbidden' using errcode = 'OGA03'; end if;
    select r.id into v_own from ogevia.caregiver_records r
    where r.organization_id = p_organization_id and r.linked_user_id = ogevia.require_actor() and r.deleted_at is null;
    if v_own is null or (p_caregiver_record_id is not null and p_caregiver_record_id <> v_own) then
      raise exception 'Forbidden' using errcode = 'OGA03';
    end if;
  end if;
  return query
  select a.id, a.caregiver_record_id, c.caregiver_code, concat_ws(' ', coalesce(c.preferred_name, c.first_name), c.last_name),
         a.service_id, sv.code, sv.name,
         case when a.revoked_at is not null then 'revoked'
              when a.effective_from > v_today then 'not_started'
              when a.effective_until is not null and a.effective_until < v_today then 'expired'
              else 'approved' end,
         a.effective_from, a.effective_until, a.approval_reason,
         case when v_staff then u.display_name end, a.approved_at, a.revoked_at, a.revoked_effective_on,
         case when v_staff then a.revocation_reason end, a.source
  from ogevia.caregiver_service_approvals a
  join ogevia.caregiver_records c on c.id = a.caregiver_record_id and c.organization_id = a.organization_id
  join ogevia.services sv on sv.id = a.service_id and sv.organization_id = a.organization_id
  join ogevia.app_users u on u.id = a.approved_by
  where a.organization_id = p_organization_id
    and (v_own is null or a.caregiver_record_id = v_own)
    and (p_caregiver_record_id is null or a.caregiver_record_id = p_caregiver_record_id)
  order by a.approved_at desc;
end;
$$;

create function ogevia_api.approve_caregiver_service(
  p_organization_id uuid, p_caregiver_record_id uuid, p_service_id uuid, p_effective_from date, p_effective_until date,
  p_reason text, p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.service_approval_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_caregiver_record_id, p_service_id, p_effective_from, p_effective_until, v_reason);
  v_prior jsonb;
  v_rec ogevia.caregiver_records%rowtype;
  v_id uuid := gen_random_uuid();
begin
  v_prior := ogevia.idempotency_begin('approve_caregiver_service', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return (v_prior ->> 'approval_id')::uuid; end if;
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null;
  if v_rec.id is null then raise exception 'Caregiver not found' using errcode = 'OGN04'; end if;
  if v_rec.linked_user_id is not null and v_rec.linked_user_id = v_actor then
    raise exception 'You cannot approve your own services. Ask another administrator.' using errcode = 'OGA03';
  end if;
  if not exists (select 1 from ogevia.services s where s.id = p_service_id and s.organization_id = p_organization_id and s.deleted_at is null and s.is_active) then
    raise exception 'Service not found or inactive' using errcode = 'OGN04';
  end if;
  if length(v_reason) < 3 then raise exception 'Enter a reason for the approval' using errcode = 'OGV22'; end if;
  if length(v_reason) > 500 then raise exception 'The reason is too long (500 characters at most)' using errcode = 'OGV22'; end if;
  if p_effective_from is null then raise exception 'Enter the date the approval starts' using errcode = 'OGV22'; end if;
  if p_effective_until is not null and p_effective_until < p_effective_from then
    raise exception 'The end date cannot be before the start date' using errcode = 'OGV22';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ogevia.service-approval:' || p_caregiver_record_id::text || ':' || p_service_id::text, 0));
  if exists (
    select 1 from ogevia.caregiver_service_approvals a
    where a.organization_id = p_organization_id and a.caregiver_record_id = p_caregiver_record_id and a.service_id = p_service_id
      and not isempty(ogevia.service_approval_dates(a))
      and ogevia.service_approval_dates(a) && daterange(p_effective_from, p_effective_until, '[]')) then
    raise exception 'This caregiver already has an approval for this service on those dates' using errcode = 'OGC09';
  end if;
  insert into ogevia.caregiver_service_approvals (id, organization_id, caregiver_record_id, service_id, effective_from, effective_until,
                                                  approval_reason, source, approved_by)
  values (v_id, p_organization_id, p_caregiver_record_id, p_service_id, p_effective_from, p_effective_until, v_reason, 'administrator', v_actor);
  perform ogevia.write_audit(p_organization_id, 'caregiver_service.approved', 'caregiver_service_approvals', v_id, null,
    jsonb_build_object('caregiver_record_id', p_caregiver_record_id, 'service_id', p_service_id,
                       'effective_from', p_effective_from, 'effective_until', p_effective_until), v_reason);
  perform ogevia.service_flag_impact(p_organization_id, p_caregiver_record_id, p_service_id, v_id, v_actor);
  perform ogevia.idempotency_finish('approve_caregiver_service', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('approval_id', v_id));
  return v_id;
end;
$$;

-- Revokes from p_effective_on (default: today, agency time). Earlier dates stay covered.
create function ogevia_api.revoke_caregiver_service(
  p_organization_id uuid, p_approval_id uuid, p_reason text, p_effective_on date default null, p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.service_approval_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_today date := ogevia.organization_local_date(p_organization_id, now());
  v_on date := coalesce(p_effective_on, ogevia.organization_local_date(p_organization_id, now()));
  v_fp text := concat_ws('|', p_organization_id, p_approval_id, v_reason, p_effective_on);
  v_prior jsonb;
  a ogevia.caregiver_service_approvals%rowtype;
  v_impact jsonb;
begin
  v_prior := ogevia.idempotency_begin('revoke_caregiver_service', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior; end if;
  if length(v_reason) < 3 then raise exception 'Enter a reason for the revocation' using errcode = 'OGV22'; end if;
  select * into a from ogevia.caregiver_service_approvals x where x.id = p_approval_id and x.organization_id = p_organization_id for update;
  if a.id is null then raise exception 'Approval not found' using errcode = 'OGN04'; end if;
  if a.revoked_at is not null then raise exception 'This approval was already revoked.' using errcode = 'OGC09'; end if;
  if v_on < v_today then raise exception 'A revocation cannot take effect in the past' using errcode = 'OGV22'; end if;
  if v_on < a.effective_from then v_on := a.effective_from; end if;
  perform pg_advisory_xact_lock(hashtextextended('ogevia.service-approval:' || a.caregiver_record_id::text || ':' || a.service_id::text, 0));
  update ogevia.caregiver_service_approvals
     set revoked_at = now(), revoked_by = v_actor, revoked_effective_on = v_on, revocation_reason = v_reason
   where id = a.id;
  perform ogevia.write_audit(p_organization_id, 'caregiver_service.revoked', 'caregiver_service_approvals', a.id,
    jsonb_build_object('effective_from', a.effective_from, 'effective_until', a.effective_until),
    jsonb_build_object('revoked_effective_on', v_on, 'caregiver_record_id', a.caregiver_record_id, 'service_id', a.service_id), v_reason);
  v_impact := ogevia.service_flag_impact(p_organization_id, a.caregiver_record_id, a.service_id, a.id, v_actor);
  v_impact := v_impact || jsonb_build_object('approvalId', a.id, 'revokedEffectiveOn', v_on,
    'note', 'Revoking an approval does not change past visits, booked shifts or billing approvals. Affected future work is flagged for review.');
  perform ogevia.idempotency_finish('revoke_caregiver_service', p_idempotency_key, p_organization_id, v_fp, v_impact);
  return v_impact;
end;
$$;

-- Pairs that already have a link to work (an active assignment, a future shift or an earlier visit) but no
-- current approval. This is a LIST TO REVIEW ONLY; it approves nothing.
create function ogevia_api.list_service_review_pairs(p_organization_id uuid)
returns table (
  caregiver_record_id uuid, caregiver_code text, caregiver_name text, caregiver_status text, service_id uuid, service_code text,
  service_name text, active_assignments integer, future_shifts integer, past_visits integer, last_visit_on date, approval_state text
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare v_today date := ogevia.organization_local_date(p_organization_id, now());
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'caregiver_services.read') then raise exception 'Forbidden' using errcode = 'OGA03'; end if;
  return query
  with pairs as (
    select ca.caregiver_record_id as rec, ca.service_id as svc from ogevia.caregiver_assignments ca
      where ca.organization_id = p_organization_id and ca.is_active and ca.caregiver_record_id is not null
        and (ca.effective_end is null or ca.effective_end >= v_today)
    union
    select sh.caregiver_record_id, sh.service_id from ogevia.shifts sh
      where sh.organization_id = p_organization_id and sh.caregiver_record_id is not null and sh.service_id is not null
        and sh.status = 'scheduled' and sh.starts_at > now()
    union
    select v.caregiver_record_id, v.service_id from ogevia.service_visits v
      where v.organization_id = p_organization_id and v.caregiver_record_id is not null and v.status not in ('voided')
  )
  select c.id, c.caregiver_code, concat_ws(' ', coalesce(c.preferred_name, c.first_name), c.last_name), c.status,
         sv.id, sv.code, sv.name,
         (select count(*)::int from ogevia.caregiver_assignments ca where ca.organization_id = p_organization_id and ca.is_active
            and ca.service_id = p.svc and (ca.caregiver_record_id = p.rec) and (ca.effective_end is null or ca.effective_end >= v_today)),
         (select count(*)::int from ogevia.shifts sh where sh.organization_id = p_organization_id and sh.caregiver_record_id = p.rec
            and sh.service_id = p.svc and sh.status = 'scheduled' and sh.starts_at > now()),
         (select count(*)::int from ogevia.service_visits v where v.organization_id = p_organization_id and v.caregiver_record_id = p.rec
            and v.service_id = p.svc and v.status not in ('voided')),
         (select max(v.service_date) from ogevia.service_visits v
            where v.organization_id = p_organization_id and v.caregiver_record_id = p.rec and v.service_id = p.svc and v.status not in ('voided')),
         ogevia.service_approval_status(p_organization_id, p.rec, p.svc,
           v_today::timestamp at time zone (select o.timezone from ogevia.organizations o where o.id = p_organization_id),
           (v_today + 1)::timestamp at time zone (select o.timezone from ogevia.organizations o where o.id = p_organization_id))
  from pairs p
  join ogevia.caregiver_records c on c.id = p.rec and c.organization_id = p_organization_id and c.deleted_at is null and c.status <> 'inactive'
  join ogevia.services sv on sv.id = p.svc and sv.organization_id = p_organization_id and sv.deleted_at is null
  where ogevia.service_approval_status(p_organization_id, p.rec, p.svc,
           v_today::timestamp at time zone (select o.timezone from ogevia.organizations o where o.id = p_organization_id),
           (v_today + 1)::timestamp at time zone (select o.timezone from ogevia.organizations o where o.id = p_organization_id)) <> 'approved'
  order by c.caregiver_code, sv.code;
end;
$$;

-- Administrator-confirmed approval of EXPLICITLY listed pairs. Nothing outside the list is approved; the
-- count must match so a truncated or widened list is refused.
create function ogevia_api.bulk_approve_reviewed_services(
  p_organization_id uuid, p_pairs jsonb, p_expected_count integer, p_effective_from date, p_reason text, p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.service_approval_guard(p_organization_id);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_fp text := concat_ws('|', p_organization_id, p_pairs::text, p_expected_count, p_effective_from, v_reason);
  v_prior jsonb;
  v_batch uuid := gen_random_uuid();
  v_n integer;
  r record;
  v_id uuid;
  v_created integer := 0;
  v_skipped integer := 0;
begin
  v_prior := ogevia.idempotency_begin('bulk_approve_reviewed_services', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior; end if;
  if p_pairs is null or jsonb_typeof(p_pairs) <> 'array' then raise exception 'Select the caregiver and service pairs to approve' using errcode = 'OGV22'; end if;
  v_n := jsonb_array_length(p_pairs);
  if v_n = 0 then raise exception 'Select at least one caregiver and service pair' using errcode = 'OGV22'; end if;
  if v_n > 200 then raise exception 'Approve at most 200 pairs at a time' using errcode = 'OGV22'; end if;
  if p_expected_count is distinct from v_n then
    raise exception 'The number of pairs does not match what you reviewed. Reload and review again.' using errcode = 'OGC09';
  end if;
  if length(v_reason) < 3 then raise exception 'Enter a reason for the approval' using errcode = 'OGV22'; end if;
  if p_effective_from is null then raise exception 'Enter the date the approvals start' using errcode = 'OGV22'; end if;
  for r in
    select (x ->> 'caregiverRecordId')::uuid as rec, (x ->> 'serviceId')::uuid as svc from jsonb_array_elements(p_pairs) x
  loop
    if r.rec is null or r.svc is null then raise exception 'Every pair needs a caregiver and a service' using errcode = 'OGV22'; end if;
    if not exists (select 1 from ogevia.caregiver_records c where c.id = r.rec and c.organization_id = p_organization_id and c.deleted_at is null and c.status <> 'inactive')
       or not exists (select 1 from ogevia.services s where s.id = r.svc and s.organization_id = p_organization_id and s.deleted_at is null and s.is_active) then
      raise exception 'A selected caregiver or service was not found' using errcode = 'OGN04';
    end if;
    if exists (select 1 from ogevia.caregiver_records c where c.id = r.rec and c.linked_user_id = v_actor) then
      raise exception 'You cannot approve your own services. Ask another administrator.' using errcode = 'OGA03';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('ogevia.service-approval:' || r.rec::text || ':' || r.svc::text, 0));
    if exists (select 1 from ogevia.caregiver_service_approvals a
               where a.organization_id = p_organization_id and a.caregiver_record_id = r.rec and a.service_id = r.svc
                 and not isempty(ogevia.service_approval_dates(a)) and ogevia.service_approval_dates(a) && daterange(p_effective_from, null, '[]')) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    v_id := gen_random_uuid();
    insert into ogevia.caregiver_service_approvals (id, organization_id, caregiver_record_id, service_id, effective_from, approval_reason, source, review_batch_id, approved_by)
    values (v_id, p_organization_id, r.rec, r.svc, p_effective_from, v_reason, 'bulk_review', v_batch, v_actor);
    perform ogevia.write_audit(p_organization_id, 'caregiver_service.approved', 'caregiver_service_approvals', v_id, null,
      jsonb_build_object('caregiver_record_id', r.rec, 'service_id', r.svc, 'effective_from', p_effective_from, 'review_batch_id', v_batch), v_reason);
    perform ogevia.service_flag_impact(p_organization_id, r.rec, r.svc, v_id, v_actor);
    v_created := v_created + 1;
  end loop;
  v_prior := jsonb_build_object('batchId', v_batch, 'approved', v_created, 'alreadyApproved', v_skipped);
  perform ogevia.idempotency_finish('bulk_approve_reviewed_services', p_idempotency_key, p_organization_id, v_fp, v_prior);
  return v_prior;
end;
$$;

-- Open flags (shifts and standing assignments) caused by service approval changes, for the review screens.
create function ogevia_api.list_service_flags(p_organization_id uuid)
returns table (
  flag_id uuid, subject text, subject_id uuid, caregiver_record_id uuid, caregiver_code text, reason_code text,
  starts_at timestamp with time zone, ends_at timestamp with time zone, created_at timestamp with time zone
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'caregiver_services.read') then raise exception 'Forbidden' using errcode = 'OGA03'; end if;
  return query
  select f.id, 'shift'::text, f.shift_id, f.caregiver_record_id, c.caregiver_code, f.reason_code, s.starts_at, s.ends_at, f.created_at
  from ogevia.shift_readiness_flags f
  join ogevia.shifts s on s.id = f.shift_id
  join ogevia.caregiver_records c on c.id = f.caregiver_record_id and c.organization_id = f.organization_id
  where f.organization_id = p_organization_id and f.kind = 'service' and f.resolved_at is null
  union all
  select f.id, 'assignment'::text, f.assignment_id, f.caregiver_record_id, c.caregiver_code, f.reason_code, null::timestamptz, null::timestamptz, f.created_at
  from ogevia.assignment_readiness_flags f
  join ogevia.caregiver_records c on c.id = f.caregiver_record_id and c.organization_id = f.organization_id
  where f.organization_id = p_organization_id and f.kind = 'service' and f.resolved_at is null
  order by 9 desc;
end;
$$;

revoke all on function ogevia.service_approval_dates(ogevia.caregiver_service_approvals) from public;
revoke all on function ogevia.service_approval_status(uuid, uuid, uuid, timestamptz, timestamptz) from public;
revoke all on function ogevia.service_flag_impact(uuid, uuid, uuid, uuid, uuid) from public;
revoke all on function ogevia.service_approval_guard(uuid) from public;
revoke all on function ogevia_api.list_caregiver_service_approvals(uuid, uuid) from public;
revoke all on function ogevia_api.approve_caregiver_service(uuid, uuid, uuid, date, date, text, uuid) from public;
revoke all on function ogevia_api.revoke_caregiver_service(uuid, uuid, text, date, uuid) from public;
revoke all on function ogevia_api.list_service_review_pairs(uuid) from public;
revoke all on function ogevia_api.bulk_approve_reviewed_services(uuid, jsonb, integer, date, text, uuid) from public;
revoke all on function ogevia_api.list_service_flags(uuid) from public;
grant execute on function ogevia_api.list_caregiver_service_approvals(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.approve_caregiver_service(uuid, uuid, uuid, date, date, text, uuid) to ogevia_app;
grant execute on function ogevia_api.revoke_caregiver_service(uuid, uuid, text, date, uuid) to ogevia_app;
grant execute on function ogevia_api.list_service_review_pairs(uuid) to ogevia_app;
grant execute on function ogevia_api.bulk_approve_reviewed_services(uuid, jsonb, integer, date, text, uuid) to ogevia_app;
grant execute on function ogevia_api.list_service_flags(uuid) to ogevia_app;
