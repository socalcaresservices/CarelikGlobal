-- 0030 Caregiver hire type, scheduling mode and family relationship; readable
-- billing review rows.
--
-- Inventory before this migration (2026-10-05, from the repository):
--   * Carelik (Supabase) never had a Direct Hire / EOR field. caregiver_records
--     had employment_type (full_time, part_time, per_diem, contractor), which
--     was not migrated to AWS. Neither system records a caregiver's family
--     relationship to a client, or fixed vs flexible scheduling.
--   * AWS already lets an assigned caregiver start a visit without a scheduled
--     shift (start_ad_hoc_service_visit: active sign-in and Care Team profile,
--     active client/service assignment, current authorization; confirmation and
--     the monthly authorization cap apply as usual). Such a signed visit is
--     Billing Ready like any other; the screens only label it "Unscheduled".
--
-- This migration adds three SEPARATE facts (EOR never implies family):
--   * caregiver_records.hire_type: direct_hire | eor | NULL (not recorded).
--   * caregiver_records.scheduling_mode: fixed (default: scheduled shifts, as
--     today) | flexible (authorized visits without a scheduled shift are the
--     normal pattern, not an exception).
--   * caregiver_assignments.family_relationship: the caregiver's relationship
--     to THAT client: none | parent | spouse_partner | child | sibling |
--     grandparent | grandchild | other_relative | NULL (not recorded).
-- Set by set_caregiver_employment (caregivers.manage) and
-- set_assignment_family_relationship (assignments.manage); audited and
-- idempotent. Existing records keep every value; new columns start NULL
-- (hire type, relationship) or 'fixed' (current behaviour).
-- Visit rules do not change: no field here relaxes sign-in, assignment,
-- authorization, confirmation or hour limits.
--
-- list_billing_review_visits also returns client code, client legal name (ONLY
-- with clients.names.read), caregiver and service names, the caregiver's
-- scheduling mode and the linked shift. Rates and dollar amounts are not part
-- of it (they stay owner-only in billing approvals).
--
-- list_monthly_approval_summary (NEW, read-only, visits.read): per authorization
-- lineage and month, the human-approved minutes, how many visits are approved,
-- and approved billing-rounding adjustments, so the monthly reconciliation can
-- show Approved separately from Billable (eligible). Minutes only, never money.
-- A separate function, because list_monthly_service_summary is used by three
-- other functions (0020, 0022, 0027) and must keep its return type.

alter table ogevia.caregiver_records
  add column hire_type text check (hire_type is null or hire_type in ('direct_hire', 'eor')),
  add column scheduling_mode text not null default 'fixed' check (scheduling_mode in ('fixed', 'flexible'));
alter table ogevia.caregiver_assignments
  add column family_relationship text check (family_relationship is null or family_relationship in
    ('none', 'parent', 'spouse_partner', 'child', 'sibling', 'grandparent', 'grandchild', 'other_relative'));

create function ogevia_api.set_caregiver_employment(
  p_organization_id uuid, p_caregiver_record_id uuid, p_hire_type text, p_scheduling_mode text, p_reason text default null, p_idempotency_key uuid default null
)
returns table (caregiver_record_id uuid, hire_type text, scheduling_mode text)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.require_actor();
  v_fp text := concat_ws('|', p_organization_id, p_caregiver_record_id, p_hire_type, p_scheduling_mode, btrim(coalesce(p_reason, '')));
  v_prior jsonb;
  v_rec ogevia.caregiver_records%rowtype;
begin
  if not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'caregivers.manage') then
    raise exception 'You do not have permission to manage the Care Team' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('set_caregiver_employment', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'caregiver_record_id')::uuid, v_prior ->> 'hire_type', v_prior ->> 'scheduling_mode';
    return;
  end if;
  if p_hire_type is not null and p_hire_type not in ('direct_hire', 'eor') then
    raise exception 'Hire type must be Direct Hire, EOR or not recorded' using errcode = 'OGV22';
  end if;
  if coalesce(p_scheduling_mode, '') not in ('fixed', 'flexible') then
    raise exception 'Scheduling must be fixed (scheduled shifts) or flexible (authorized visits without a shift)' using errcode = 'OGV22';
  end if;
  select * into v_rec from ogevia.caregiver_records r
  where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null for update;
  if v_rec.id is null then
    raise exception 'Care Team member not found' using errcode = 'OGN04';
  end if;
  update ogevia.caregiver_records r set hire_type = p_hire_type, scheduling_mode = p_scheduling_mode, updated_at = now() where r.id = v_rec.id;
  perform ogevia.write_audit(p_organization_id, 'caregiver.employment_set', 'caregiver_records', v_rec.id,
    jsonb_build_object('hire_type', v_rec.hire_type, 'scheduling_mode', v_rec.scheduling_mode),
    jsonb_build_object('hire_type', p_hire_type, 'scheduling_mode', p_scheduling_mode), nullif(btrim(coalesce(p_reason, '')), ''));
  perform ogevia.idempotency_finish('set_caregiver_employment', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('caregiver_record_id', v_rec.id, 'hire_type', p_hire_type, 'scheduling_mode', p_scheduling_mode));
  return query select v_rec.id, p_hire_type, p_scheduling_mode;
end;
$$;

create function ogevia_api.set_assignment_family_relationship(
  p_organization_id uuid, p_assignment_id uuid, p_relationship text, p_idempotency_key uuid default null
)
returns table (assignment_id uuid, family_relationship text)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
declare
  v_actor uuid := ogevia.require_actor();
  v_fp text := concat_ws('|', p_organization_id, p_assignment_id, p_relationship);
  v_prior jsonb;
  v_a ogevia.caregiver_assignments%rowtype;
begin
  if not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'assignments.manage') then
    raise exception 'You do not have permission to manage assignments' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('set_assignment_family_relationship', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'assignment_id')::uuid, v_prior ->> 'family_relationship';
    return;
  end if;
  if p_relationship is not null and p_relationship not in ('none', 'parent', 'spouse_partner', 'child', 'sibling', 'grandparent', 'grandchild', 'other_relative') then
    raise exception 'Choose a relationship from the list, or leave it not recorded' using errcode = 'OGV22';
  end if;
  select * into v_a from ogevia.caregiver_assignments a where a.id = p_assignment_id and a.organization_id = p_organization_id for update;
  if v_a.id is null then
    raise exception 'Assignment not found' using errcode = 'OGN04';
  end if;
  update ogevia.caregiver_assignments a set family_relationship = p_relationship, updated_at = now() where a.id = v_a.id;
  perform ogevia.write_audit(p_organization_id, 'assignment.family_relationship_set', 'caregiver_assignments', v_a.id,
    jsonb_build_object('family_relationship', v_a.family_relationship), jsonb_build_object('family_relationship', p_relationship), null);
  perform ogevia.idempotency_finish('set_assignment_family_relationship', p_idempotency_key, p_organization_id, v_fp,
    jsonb_build_object('assignment_id', v_a.id, 'family_relationship', p_relationship));
  return query select v_a.id, p_relationship;
end;
$$;

-- Return types grow: drop, recreate, re-grant (same arguments).
drop function ogevia_api.list_service_visits(uuid, uuid, uuid, uuid, date, date, ogevia.service_visit_status);
create function ogevia_api.list_service_visits(
  p_organization_id uuid,
  p_client_id uuid default null,
  p_caregiver_user_id uuid default null,
  p_service_id uuid default null,
  p_date_from date default null,
  p_date_to date default null,
  p_status ogevia.service_visit_status default null
)
returns table (
  id uuid,
  visit_number text,
  client_id uuid,
  client_code text,
  caregiver_user_id uuid,
  caregiver_name text,
  service_id uuid,
  service_name text,
  service_date date,
  time_in timestamptz,
  time_out timestamptz,
  worked_minutes integer,
  verified_minutes integer,
  billable_minutes integer,
  status ogevia.service_visit_status,
  authorization_status ogevia.visit_authorization_status,
  signed_at timestamptz,
  original_visit_id uuid,
  is_corrected boolean,
  month_to_date_before_minutes bigint,
  month_to_date_after_minutes bigint,
  remaining_minutes bigint,
  scheduled_shift_id uuid,
  scheduled_starts_at timestamptz,
  scheduled_ends_at timestamptz,
  time_out_entered_by_manager boolean,
  caregiver_scheduling_mode text
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select
    v.id, v.visit_number_snapshot, v.client_id, v.client_code_snapshot, v.caregiver_user_id,
    v.caregiver_name_snapshot, v.service_id, sv.name, v.service_date, v.time_in, v.time_out,
    v.worked_minutes, v.verified_minutes, v.billable_minutes, v.status, v.authorization_status,
    v.signed_at, v.original_visit_id,
    (v.status = 'corrected' or v.original_visit_id is not null),
    (vc.confirmed_visit_snapshot ->> 'monthToDateBeforeMinutes')::bigint,
    (vc.confirmed_visit_snapshot ->> 'monthToDateAfterMinutes')::bigint,
    (vc.confirmed_visit_snapshot ->> 'remainingMinutes')::bigint,
    v.scheduled_shift_id, sh.starts_at, sh.ends_at, v.time_out_entered_by is not null,
    (select cr.scheduling_mode from ogevia.caregiver_records cr where cr.organization_id = v.organization_id and cr.deleted_at is null
       and (cr.id = v.caregiver_record_id or (v.caregiver_record_id is null and cr.linked_user_id = v.caregiver_user_id)) limit 1)
  from ogevia.service_visits v
  join ogevia.services sv on sv.id = v.service_id
  left join ogevia.visit_confirmations vc on vc.visit_id = v.id
  left join ogevia.shifts sh on sh.id = v.scheduled_shift_id
  where ogevia.require_actor() is not null
    and v.organization_id = p_organization_id
    and ogevia.is_active_member(p_organization_id)
    and (ogevia.has_permission(p_organization_id, 'visits.read')
         or v.caregiver_user_id = ogevia.current_user_id())
    and (p_client_id is null or v.client_id = p_client_id)
    and (p_caregiver_user_id is null or v.caregiver_user_id = p_caregiver_user_id)
    and (p_service_id is null or v.service_id = p_service_id)
    and (p_date_from is null or v.service_date >= p_date_from)
    and (p_date_to is null or v.service_date <= p_date_to)
    and (p_status is null or v.status = p_status)
  order by v.service_date desc, v.time_in desc;
$$;

drop function ogevia_api.list_caregivers(uuid);
create function ogevia_api.list_caregivers(p_organization_id uuid)
returns table (
  caregiver_record_id uuid, caregiver_code text, first_name text, last_name text, preferred_name text, status text,
  has_sign_in boolean, sign_in_status text, active_assignments integer, open_visits integer, updated_at timestamptz,
  invitation_email text, invited_at timestamptz, invitation_last_sent_at timestamptz, invitation_send_count integer,
  first_signed_in_at timestamptz, planned_assignments integer, hire_type text, scheduling_mode text
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
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

drop function ogevia_api.list_assignments(uuid, uuid, uuid);
create function ogevia_api.list_assignments(p_organization_id uuid, p_client_id uuid default null, p_caregiver_record_id uuid default null)
returns table (
  assignment_id uuid, caregiver_record_id uuid, caregiver_code text, caregiver_name text,
  client_id uuid, client_code text, client_name text, service_id uuid, service_code text, service_name text,
  effective_start date, effective_end date, state text, has_authorization boolean, created_at timestamptz,
  grants_access boolean, family_relationship text
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with ctx as (
    select ogevia.require_actor() as actor,
           ogevia.is_active_member(p_organization_id) and ogevia.has_permission(p_organization_id, 'visits.read') as can_list,
           ogevia.has_permission(p_organization_id, 'clients.names.read') as can_names,
           ogevia.organization_local_date(p_organization_id, now()) as today
  )
  select a.id, cr.id, cr.caregiver_code,
         coalesce(cr.preferred_name, cr.first_name) || ' ' || cr.last_name,
         c.id, c.client_code,
         case when ctx.can_names then nullif(btrim(coalesce(n.legal_first_name, '') || ' ' || coalesce(n.legal_last_name, '')), '') end,
         s.id, s.code, s.name, a.effective_start, a.effective_end,
         case when not a.is_active or (a.effective_end is not null and a.effective_end < ctx.today) then 'ended'
              when a.effective_start > ctx.today then 'upcoming'
              else 'current' end,
         ogevia.authorization_covers(p_organization_id, c.id, s.id, greatest(a.effective_start, ctx.today), a.effective_end),
         a.created_at,
         a.caregiver_user_id is not null,
         a.family_relationship
  from ctx
  join ogevia.caregiver_assignments a on a.organization_id = p_organization_id
  join ogevia.clients c on c.id = a.client_id
  join ogevia.services s on s.id = a.service_id
  left join ogevia.caregiver_records cr on cr.organization_id = a.organization_id and cr.deleted_at is null
    and (cr.id = a.caregiver_record_id or (a.caregiver_record_id is null and cr.linked_user_id = a.caregiver_user_id))
  left join ogevia.client_private_names n on n.client_id = c.id
  where ctx.actor is not null and ctx.can_list
    and (p_client_id is null or a.client_id = p_client_id)
    and (p_caregiver_record_id is null or cr.id = p_caregiver_record_id)
  order by case when not a.is_active or (a.effective_end is not null and a.effective_end < ctx.today) then 2
                when a.effective_start > ctx.today then 1 else 0 end,
           a.effective_start desc, c.client_code, s.code;
$$;

drop function ogevia_api.list_billing_review_visits(uuid, date, date);
create function ogevia_api.list_billing_review_visits(
  p_organization_id uuid,
  p_date_from date,
  p_date_to date
)
returns table (
  visit_id uuid,
  visit_number text,
  client_id uuid,
  service_id uuid,
  service_code text,
  authorization_id uuid,
  authorization_lineage_id uuid,
  authorization_version integer,
  service_date date,
  time_in timestamptz,
  time_out timestamptz,
  worked_minutes integer,
  verified_minutes integer,
  billable_minutes integer,
  visit_status ogevia.service_visit_status,
  authorization_status ogevia.visit_authorization_status,
  has_administrator_override boolean,
  confirmation_method text,
  has_signature_evidence boolean,
  is_correction boolean,
  original_visit_id uuid,
  review_state text,
  latest_audit_event_id bigint,
  client_code text,
  client_name text,
  caregiver_name text,
  service_name text,
  caregiver_scheduling_mode text,
  scheduled_shift_id uuid
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select
    v.id, v.visit_number_snapshot, v.client_id, v.service_id, sv.code,
    a.id, a.lineage_id, a.version_number,
    v.service_date, v.time_in, v.time_out, v.worked_minutes, v.verified_minutes, v.billable_minutes,
    v.status, v.authorization_status,
    v.authorization_status = 'administrator_override',
    root_conf.confirmation_method,
    root_conf.evidence_id is not null,
    v.original_visit_id is not null,
    v.original_visit_id,
    case v.status when 'signed' then 'ready' else 'needs_review' end,
    (select max(ae.id) from ogevia.audit_events ae where ae.entity_id = v.id),
    v.client_code_snapshot,
    -- Legal names only for clients.names.read (Administrator, manager); null otherwise.
    case when ogevia.has_permission(p_organization_id, 'clients.names.read')
         then nullif(btrim(coalesce(n.legal_first_name, '') || ' ' || coalesce(n.legal_last_name, '')), '') end,
    v.caregiver_name_snapshot,
    sv.name,
    (select cr.scheduling_mode from ogevia.caregiver_records cr where cr.organization_id = v.organization_id and cr.deleted_at is null
       and (cr.id = v.caregiver_record_id or (v.caregiver_record_id is null and cr.linked_user_id = v.caregiver_user_id)) limit 1),
    v.scheduled_shift_id
  from ogevia.service_visits v
  join ogevia.services sv on sv.id = v.service_id
  join ogevia.client_authorizations a on a.id = v.service_authorization_id
  left join ogevia.visit_confirmations root_conf
    on root_conf.visit_id = coalesce(v.original_visit_id, v.id)
  left join ogevia.client_private_names n on n.client_id = v.client_id
  where ogevia.require_actor() is not null
    and v.organization_id = p_organization_id
    and ogevia.has_permission(p_organization_id, 'billing.visits.read')
    and v.status in ('signed', 'administrator_review')
    and v.service_date between p_date_from and p_date_to
  order by v.service_date, v.time_in;
$$;

revoke all on function ogevia_api.set_caregiver_employment(uuid, uuid, text, text, text, uuid) from public;
revoke all on function ogevia_api.set_assignment_family_relationship(uuid, uuid, text, uuid) from public;
revoke all on function ogevia_api.list_service_visits(uuid, uuid, uuid, uuid, date, date, ogevia.service_visit_status) from public;
revoke all on function ogevia_api.list_caregivers(uuid) from public;
revoke all on function ogevia_api.list_assignments(uuid, uuid, uuid) from public;
revoke all on function ogevia_api.list_billing_review_visits(uuid, date, date) from public;
grant execute on function ogevia_api.set_caregiver_employment(uuid, uuid, text, text, text, uuid) to ogevia_app;
grant execute on function ogevia_api.set_assignment_family_relationship(uuid, uuid, text, uuid) to ogevia_app;
grant execute on function ogevia_api.list_service_visits(uuid, uuid, uuid, uuid, date, date, ogevia.service_visit_status) to ogevia_app;
grant execute on function ogevia_api.list_caregivers(uuid) to ogevia_app;
grant execute on function ogevia_api.list_assignments(uuid, uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.list_billing_review_visits(uuid, date, date) to ogevia_app;

create function ogevia_api.list_monthly_approval_summary(
  p_organization_id uuid,
  p_month_start date,
  p_client_id uuid default null
)
returns table (
  authorization_lineage_id uuid,
  approved_minutes integer,
  approved_visit_count integer,
  rounding_adjustment_minutes integer
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with ctx as (
    select date_trunc('month', p_month_start::timestamp)::date as m0,
           (date_trunc('month', p_month_start::timestamp) + interval '1 month')::date as m1
    where ogevia.require_actor() is not null
      and ogevia.is_active_member(p_organization_id)
      and ogevia.has_permission(p_organization_id, 'visits.read')
  ),
  approvals as (
    select va.lineage_id, coalesce(sum(b.approved_minutes), 0)::integer as minutes, count(*)::integer as visits
    from ctx
    join ogevia.service_visits v on v.organization_id = p_organization_id
     and v.service_date >= ctx.m0 and v.service_date < ctx.m1
     and v.status in ('signed', 'administrator_review')
     and (p_client_id is null or v.client_id = p_client_id)
    join ogevia.client_authorizations va on va.id = v.service_authorization_id
    join ogevia.billing_approvals b on b.visit_id = v.id and b.organization_id = p_organization_id and b.voided_at is null
    group by va.lineage_id
  ),
  adjustments as (
    select r.authorization_lineage_id as lineage_id, coalesce(sum(r.adjustment_minutes), 0)::integer as minutes
    from ctx
    join ogevia.billing_rounding_adjustments r on r.organization_id = p_organization_id and r.voided_at is null
     and r.service_date >= ctx.m0 and r.service_date < ctx.m1
     and (p_client_id is null or r.client_id = p_client_id)
    group by r.authorization_lineage_id
  )
  select coalesce(a.lineage_id, j.lineage_id), coalesce(a.minutes, 0), coalesce(a.visits, 0), coalesce(j.minutes, 0)
  from approvals a
  full join adjustments j on j.lineage_id = a.lineage_id;
$$;

revoke all on function ogevia_api.list_monthly_approval_summary(uuid, date, uuid) from public;
grant execute on function ogevia_api.list_monthly_approval_summary(uuid, date, uuid) to ogevia_app;
