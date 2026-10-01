-- 0007 - Manager reporting and the billing-review data contract.

-- current main: list_service_visits (20260809150000). client_legal_name is
-- intentionally absent: legal names are not part of the Phase 2 schema.
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
  remaining_minutes bigint
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
    (vc.confirmed_visit_snapshot ->> 'remainingMinutes')::bigint
  from ogevia.service_visits v
  join ogevia.services sv on sv.id = v.service_id
  left join ogevia.visit_confirmations vc on vc.visit_id = v.id
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

-- current main: list_visit_corrections (20260809150000).
create function ogevia_api.list_visit_corrections(p_visit_id uuid)
returns table (
  id uuid,
  corrected_by uuid,
  corrected_by_name text,
  reason text,
  before_snapshot jsonb,
  after_snapshot jsonb,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select vc.id, vc.corrected_by, coalesce(u.display_name, 'Administrator'), vc.reason,
         vc.before_snapshot, vc.after_snapshot, vc.created_at
  from ogevia.visit_corrections vc
  left join ogevia.app_users u on u.id = vc.corrected_by
  where ogevia.require_actor() is not null
    and (vc.original_visit_id = p_visit_id or vc.corrected_visit_id = p_visit_id)
    and ogevia.has_permission(vc.organization_id, 'visits.read')
  order by vc.created_at desc;
$$;

-- Billing-review contract (no billing decision is made here). Exposes the
-- authoritative fields a human reviewer needs. review_state:
--   ready         signed, not superseded by a correction
--   needs_review  administrator_review (unconfirmed, over cap, or uncovered)
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
