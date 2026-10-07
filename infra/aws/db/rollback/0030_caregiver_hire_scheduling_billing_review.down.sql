-- ROLLBACK 0030_caregiver_hire_scheduling_billing_review | CLASS: SAFE AUTOMATED (refuses when records would be lost)
-- Refuses while any hire type, flexible scheduling or family relationship is
-- recorded (those facts would be lost). Otherwise restores the four list
-- functions exactly as before 0030 and drops the new functions (including the
-- read-only list_monthly_approval_summary) and columns.
do $$ begin
  if exists (select 1 from ogevia.caregiver_records where hire_type is not null or scheduling_mode <> 'fixed')
     or exists (select 1 from ogevia.caregiver_assignments where family_relationship is not null) then
    raise exception 'ROLLBACK REFUSED: hire types, flexible scheduling or family relationships are recorded; export them first (they would be lost)';
  end if;
end $$;
drop function if exists ogevia_api.set_assignment_family_relationship(uuid, uuid, text, uuid);
drop function if exists ogevia_api.set_caregiver_employment(uuid, uuid, text, text, text, uuid);
drop function if exists ogevia_api.list_monthly_approval_summary(uuid, date, uuid);
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
  time_out_entered_by_manager boolean
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
    v.scheduled_shift_id, sh.starts_at, sh.ends_at, v.time_out_entered_by is not null
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
  first_signed_in_at timestamptz, planned_assignments integer
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
             and (a.effective_end is null or a.effective_end >= ogevia.organization_local_date(cr.organization_id, now())))
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
  grants_access boolean
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
         a.caregiver_user_id is not null
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
  latest_audit_event_id bigint
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
    (select max(ae.id) from ogevia.audit_events ae where ae.entity_id = v.id)
  from ogevia.service_visits v
  join ogevia.services sv on sv.id = v.service_id
  join ogevia.client_authorizations a on a.id = v.service_authorization_id
  left join ogevia.visit_confirmations root_conf
    on root_conf.visit_id = coalesce(v.original_visit_id, v.id)
  where ogevia.require_actor() is not null
    and v.organization_id = p_organization_id
    and ogevia.has_permission(p_organization_id, 'billing.visits.read')
    and v.status in ('signed', 'administrator_review')
    and v.service_date between p_date_from and p_date_to
  order by v.service_date, v.time_in;
$$;

revoke all on function ogevia_api.list_service_visits(uuid, uuid, uuid, uuid, date, date, ogevia.service_visit_status) from public;
revoke all on function ogevia_api.list_caregivers(uuid) from public;
revoke all on function ogevia_api.list_assignments(uuid, uuid, uuid) from public;
revoke all on function ogevia_api.list_billing_review_visits(uuid, date, date) from public;
grant execute on function ogevia_api.list_service_visits(uuid, uuid, uuid, uuid, date, date, ogevia.service_visit_status) to ogevia_app;
grant execute on function ogevia_api.list_caregivers(uuid) to ogevia_app;
grant execute on function ogevia_api.list_assignments(uuid, uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.list_billing_review_visits(uuid, date, date) to ogevia_app;
alter table ogevia.caregiver_assignments drop column family_relationship;
alter table ogevia.caregiver_records drop column scheduling_mode, drop column hire_type;
