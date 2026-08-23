begin;

-- 20260812193010 granted 'billing.read'/'billing.approve'/'billing.submit'
-- to organization_admin/manager/coordinator/read_only for the visit-billing
-- approval pipeline. 20260817054716 (five days later) redefined
-- 'billing.read' to mean something unrelated - "view subscription prices
-- and financial billing details" - and, in the same migration, deleted
-- every role_permissions row for organization_admin/manager/coordinator/
-- read_only/etc and rebuilt them from an explicit allow-list that never
-- mentions 'billing.approve'/'billing.submit'/'billing.read' at all. Net
-- effect: since 20260817054716, only organization_owner (who gets every
-- permission key unconditionally) can approve or submit anything for
-- billing - the whole point of building a Biller workflow the owner
-- doesn't have to run personally was lost to a naming collision.
--
-- Fixed by giving the visit-billing pipeline its own non-colliding read
-- key, 'billing.visits.read', and granting the pipeline's three keys to
-- 'manager' (organization_admin's replacement per 20260817054716) as well
-- as organization_owner.
insert into public.permissions (key, description) values
  ('billing.visits.read', 'View billing-ready visits, billing approvals, and submission history for care visits')
on conflict (key) do nothing;

update public.role_permissions set permission_key = 'billing.visits.read'
where permission_key = 'billing.read'
  and role <> 'organization_owner';

delete from public.role_permissions
where permission_key = 'billing.read' and role <> 'organization_owner';

insert into public.role_permissions (role, permission_key)
select 'manager'::public.system_role, key
from unnest(array['billing.visits.read', 'billing.approve', 'billing.submit']) as key
on conflict do nothing;

create or replace function public.list_billing_ready_visits(target_organization_id uuid)
returns table (
  visit_id uuid,
  client_id uuid,
  client_name text,
  service_name text,
  caregiver_name text,
  service_date date,
  worked_minutes integer,
  billable_minutes integer,
  signed_at timestamptz,
  rate_cents integer,
  estimated_amount_cents integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    v.id, v.client_id, c.first_name || ' ' || c.last_name,
    sv.name, v.caregiver_name_snapshot, v.service_date,
    v.worked_minutes, v.billable_minutes, v.signed_at,
    a.hourly_rate_cents,
    case
      when a.hourly_rate_cents is not null
        then round(v.billable_minutes / 60.0 * a.hourly_rate_cents)::integer
      else null
    end
  from public.service_visits v
  join public.services sv on sv.id = v.service_id
  join public.clients c on c.id = v.client_id
  left join public.client_authorizations a on a.id = v.service_authorization_id
  where v.organization_id = target_organization_id
    and v.status = 'signed'
    and public.has_permission(target_organization_id, 'billing.visits.read')
    and not exists (
      select 1 from public.billing_approvals ba
      where ba.visit_id = v.id and ba.voided_at is null
    )
  order by v.service_date desc;
$$;

create or replace function public.list_billing_approvals(
  target_organization_id uuid,
  only_unsubmitted boolean default false
)
returns table (
  approval_id uuid,
  visit_id uuid,
  client_name text,
  service_name text,
  service_date date,
  approved_minutes integer,
  rate_cents integer,
  amount_cents integer,
  approved_by_name text,
  approved_at timestamptz,
  is_voided boolean,
  is_submitted boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    a.id, a.visit_id,
    a.source_snapshot->>'clientName', a.source_snapshot->>'serviceName',
    v.service_date, a.approved_minutes,
    a.rate_cents, a.amount_cents,
    coalesce(p.display_name, 'Administrator'), a.approved_at,
    a.voided_at is not null,
    exists (select 1 from public.billing_submission_items i where i.billing_approval_id = a.id and i.voided_at is null)
  from public.billing_approvals a
  join public.service_visits v on v.id = a.visit_id
  left join public.user_profiles p on p.id = a.approved_by
  where a.organization_id = target_organization_id
    and public.has_permission(target_organization_id, 'billing.visits.read')
    and a.voided_at is null
    and (
      not only_unsubmitted
      or not exists (
        select 1 from public.billing_submission_items i
        where i.billing_approval_id = a.id and i.voided_at is null
      )
    )
  order by a.approved_at desc;
$$;

create or replace function public.list_billing_submissions(target_organization_id uuid)
returns table (
  submission_id uuid,
  submitted_by_name text,
  submitted_at timestamptz,
  period_start date,
  period_end date,
  notes text,
  item_count bigint,
  active_item_count bigint,
  total_submitted_minutes bigint,
  total_amount_cents bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.id, coalesce(p.display_name, 'Administrator'), s.submitted_at,
    s.period_start, s.period_end, s.notes,
    count(i.id),
    count(i.id) filter (where i.voided_at is null),
    coalesce(sum(i.submitted_minutes) filter (where i.voided_at is null), 0),
    coalesce(sum(i.submitted_amount_cents) filter (where i.voided_at is null), 0)
  from public.billing_submissions s
  left join public.user_profiles p on p.id = s.submitted_by
  left join public.billing_submission_items i on i.submission_id = s.id
  where s.organization_id = target_organization_id
    and public.has_permission(target_organization_id, 'billing.visits.read')
  group by s.id, p.display_name, s.submitted_at, s.period_start, s.period_end, s.notes
  order by s.submitted_at desc;
$$;

create or replace function public.list_billing_submission_items(target_submission_id uuid)
returns table (
  item_id uuid,
  visit_id uuid,
  client_name text,
  service_name text,
  service_date date,
  submitted_minutes integer,
  rate_cents integer,
  submitted_amount_cents integer,
  is_voided boolean,
  void_reason text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    i.id, i.visit_id,
    a.source_snapshot->>'clientName', a.source_snapshot->>'serviceName',
    v.service_date, i.submitted_minutes,
    a.rate_cents, i.submitted_amount_cents,
    i.voided_at is not null, i.void_reason
  from public.billing_submission_items i
  join public.billing_submissions s on s.id = i.submission_id
  join public.billing_approvals a on a.id = i.billing_approval_id
  join public.service_visits v on v.id = i.visit_id
  where i.submission_id = target_submission_id
    and public.has_permission(s.organization_id, 'billing.visits.read')
  order by v.service_date desc;
$$;

-- The read-only RLS policies on the three billing tables also still
-- reference the now-repurposed 'billing.read' key.
drop policy if exists "members_read_billing_approvals" on public.billing_approvals;
create policy "members_read_billing_approvals"
on public.billing_approvals for select to authenticated
using (public.has_permission(organization_id, 'billing.visits.read'));

drop policy if exists "members_read_billing_submissions" on public.billing_submissions;
create policy "members_read_billing_submissions"
on public.billing_submissions for select to authenticated
using (public.has_permission(organization_id, 'billing.visits.read'));

drop policy if exists "members_read_billing_submission_items" on public.billing_submission_items;
create policy "members_read_billing_submission_items"
on public.billing_submission_items for select to authenticated
using (public.has_permission(organization_id, 'billing.visits.read'));

commit;
