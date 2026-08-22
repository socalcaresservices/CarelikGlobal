begin;

-- Now that client_authorizations carries a $/hour rate (20260822010000),
-- the billing approval pipeline can turn approved minutes into a dollar
-- amount. The rate is snapshotted onto the approval at approve-time (same
-- pattern as source_snapshot already uses for client/service names) so a
-- later authorization amendment never silently changes an already-approved
-- dollar amount - a payer submission report has to reflect what was true
-- when it was approved, not what the rate is today.
alter table public.billing_approvals
  add column rate_cents integer,
  add column amount_cents integer,
  add constraint billing_approvals_rate_check check (rate_cents is null or rate_cents >= 0),
  add constraint billing_approvals_amount_check check (amount_cents is null or amount_cents >= 0);

alter table public.billing_submission_items
  add column submitted_amount_cents integer,
  add constraint billing_submission_items_amount_check check (submitted_amount_cents is null or submitted_amount_cents >= 0);

create or replace function public.approve_visit_for_billing(
  target_visit_id uuid,
  approved_minutes integer,
  notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_visit public.service_visits%rowtype;
  target_client public.clients%rowtype;
  target_service public.services%rowtype;
  approval_id uuid;
  snapshot jsonb;
  auth_rate_cents integer;
  computed_amount_cents integer;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into target_visit from public.service_visits where id = target_visit_id for update;
  if target_visit.id is null then raise exception 'Visit not found'; end if;
  if not public.has_permission(target_visit.organization_id, 'billing.approve') then
    raise exception 'You do not have permission to approve billing for this organization';
  end if;
  if target_visit.status <> 'signed' then
    raise exception 'Only a signed visit can be approved for billing';
  end if;
  if approved_minutes < 0 or approved_minutes > target_visit.worked_minutes then
    raise exception 'Approved minutes must be between 0 and the worked minutes';
  end if;
  if exists (select 1 from public.billing_approvals where visit_id = target_visit_id and voided_at is null) then
    raise exception 'This visit already has an active billing approval';
  end if;

  select * into target_client from public.clients where id = target_visit.client_id;
  select * into target_service from public.services where id = target_visit.service_id;

  select hourly_rate_cents into auth_rate_cents
  from public.client_authorizations
  where id = target_visit.service_authorization_id;

  if auth_rate_cents is not null then
    computed_amount_cents := round(approved_minutes / 60.0 * auth_rate_cents)::integer;
  end if;

  snapshot := jsonb_build_object(
    'visitId', target_visit.id,
    'clientId', target_visit.client_id,
    'clientCode', target_visit.client_code_snapshot,
    'clientName', target_client.first_name || ' ' || target_client.last_name,
    'serviceId', target_visit.service_id,
    'serviceName', target_service.name,
    'caregiverName', target_visit.caregiver_name_snapshot,
    'serviceDate', target_visit.service_date,
    'workedMinutes', target_visit.worked_minutes,
    'billableMinutes', target_visit.billable_minutes,
    'approvedMinutes', approved_minutes,
    'serviceAuthorizationId', target_visit.service_authorization_id,
    'rateCents', auth_rate_cents,
    'amountCents', computed_amount_cents
  );

  insert into public.billing_approvals (
    organization_id, visit_id, approved_by, approved_minutes, notes, source_snapshot,
    rate_cents, amount_cents
  ) values (
    target_visit.organization_id, target_visit.id, auth.uid(), approved_minutes, nullif(trim(notes), ''), snapshot,
    auth_rate_cents, computed_amount_cents
  ) returning id into approval_id;

  return approval_id;
end;
$$;

revoke all on function public.approve_visit_for_billing(uuid, integer, text) from public, anon;
grant execute on function public.approve_visit_for_billing(uuid, integer, text) to authenticated;

create or replace function public.submit_billing_approvals(
  target_organization_id uuid,
  approval_ids uuid[],
  period_start date default null,
  period_end date default null,
  notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  submission_id uuid;
  approval_id uuid;
  target_approval public.billing_approvals%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if not public.has_permission(target_organization_id, 'billing.submit') then
    raise exception 'You do not have permission to submit billing for this organization';
  end if;
  if approval_ids is null or array_length(approval_ids, 1) is null then
    raise exception 'At least one approval must be selected';
  end if;

  insert into public.billing_submissions (organization_id, submitted_by, period_start, period_end, notes)
  values (target_organization_id, auth.uid(), period_start, period_end, nullif(trim(notes), ''))
  returning id into submission_id;

  foreach approval_id in array approval_ids loop
    select * into target_approval from public.billing_approvals
    where id = approval_id and organization_id = target_organization_id
    for update;

    if target_approval.id is null then
      raise exception 'Billing approval % not found in this organization', approval_id;
    end if;
    if target_approval.voided_at is not null then
      raise exception 'Billing approval % has been voided and cannot be submitted', approval_id;
    end if;
    if exists (
      select 1 from public.billing_submission_items
      where billing_approval_id = target_approval.id and voided_at is null
    ) then
      raise exception 'Billing approval % has already been submitted', approval_id;
    end if;

    insert into public.billing_submission_items (
      organization_id, submission_id, billing_approval_id, visit_id, submitted_minutes, submitted_amount_cents
    ) values (
      target_organization_id, submission_id, target_approval.id, target_approval.visit_id,
      target_approval.approved_minutes, target_approval.amount_cents
    );
  end loop;

  return submission_id;
end;
$$;

revoke all on function public.submit_billing_approvals(uuid, uuid[], date, date, text) from public, anon;
grant execute on function public.submit_billing_approvals(uuid, uuid[], date, date, text) to authenticated;

drop function if exists public.list_billing_ready_visits(uuid);

create function public.list_billing_ready_visits(target_organization_id uuid)
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
    and public.has_permission(target_organization_id, 'billing.read')
    and not exists (
      select 1 from public.billing_approvals ba
      where ba.visit_id = v.id and ba.voided_at is null
    )
  order by v.service_date desc;
$$;

revoke all on function public.list_billing_ready_visits(uuid) from public, anon;
grant execute on function public.list_billing_ready_visits(uuid) to authenticated;

drop function if exists public.list_billing_approvals(uuid, boolean);

create function public.list_billing_approvals(
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
    and public.has_permission(target_organization_id, 'billing.read')
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

revoke all on function public.list_billing_approvals(uuid, boolean) from public, anon;
grant execute on function public.list_billing_approvals(uuid, boolean) to authenticated;

drop function if exists public.list_billing_submissions(uuid);

create function public.list_billing_submissions(target_organization_id uuid)
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
    and public.has_permission(target_organization_id, 'billing.read')
  group by s.id, p.display_name, s.submitted_at, s.period_start, s.period_end, s.notes
  order by s.submitted_at desc;
$$;

revoke all on function public.list_billing_submissions(uuid) from public, anon;
grant execute on function public.list_billing_submissions(uuid) to authenticated;

-- A payer submission report / private-pay invoice export needs to list
-- the individual line items in a submission, not just the aggregate
-- totals list_billing_submissions already returns.
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
    and public.has_permission(s.organization_id, 'billing.read')
  order by v.service_date desc;
$$;

revoke all on function public.list_billing_submission_items(uuid) from public, anon;
grant execute on function public.list_billing_submission_items(uuid) to authenticated;

commit;
