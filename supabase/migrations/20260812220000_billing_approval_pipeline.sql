begin;

-- Billing Ready -> Billing Approved -> Submitted/Billed. Until now a
-- signed visit's billable_minutes was already the final number - nothing
-- stood between "the client signed this" and "this is billing data,"
-- and there was no submission/export history at all. A clean visit could
-- be read as billing-ready by any report, but there was no explicit human
-- approval step and no record of what was ever actually sent to a payer.
--
-- Deliberately additive, not a rework of service_visits.status: "billing
-- ready" is a computed condition (signed, not voided/corrected, no active
-- approval yet - see list_billing_ready_visits below), not a new stored
-- state. "Billing approved" and "submitted/billed" are each represented
-- by the *existence* of an active (non-voided) row in a dedicated table,
-- the same pattern visit_signatures already uses for "signed" - avoids
-- adding another value to service_visit_status that every existing
-- status-list query across the visit RPCs would have had to be re-audited
-- for.

create table public.billing_approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  visit_id uuid not null references public.service_visits(id),
  approved_by uuid not null references auth.users(id),
  approved_at timestamptz not null default now(),
  approved_minutes integer not null,
  notes text,
  -- Frozen at approval time - client/service/authorization/worked-billable
  -- minutes as they stood the moment a human signed off, independent of
  -- anything that changes on the visit or authorization afterward (an
  -- amendment, a later correction creating a new linked visit, etc).
  source_snapshot jsonb not null,
  voided_at timestamptz,
  voided_by uuid references auth.users(id),
  void_reason text,
  created_at timestamptz not null default now(),
  constraint billing_approvals_minutes_check check (approved_minutes >= 0)
);

-- At most one active approval per visit - approving twice (or approving
-- an already-submitted visit's superseding correction) has to go through
-- void first, never silently stack.
create unique index billing_approvals_active_visit_unique
  on public.billing_approvals (visit_id)
  where voided_at is null;
create index billing_approvals_org_idx on public.billing_approvals (organization_id, approved_at desc);

create table public.billing_submissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  submitted_by uuid not null references auth.users(id),
  submitted_at timestamptz not null default now(),
  period_start date,
  period_end date,
  notes text,
  created_at timestamptz not null default now()
);

create index billing_submissions_org_idx on public.billing_submissions (organization_id, submitted_at desc);

create table public.billing_submission_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  submission_id uuid not null references public.billing_submissions(id) on delete cascade,
  billing_approval_id uuid not null references public.billing_approvals(id),
  visit_id uuid not null references public.service_visits(id),
  submitted_minutes integer not null,
  voided_at timestamptz,
  voided_by uuid references auth.users(id),
  void_reason text,
  created_at timestamptz not null default now()
);

-- At most one active submission per visit - the actual "has this been
-- billed" guard. A visit already carrying an active item here can't be
-- submitted again; voiding (a billing-side correction, e.g. a rejected
-- claim) is required before it can be resubmitted.
create unique index billing_submission_items_active_visit_unique
  on public.billing_submission_items (visit_id)
  where voided_at is null;
create index billing_submission_items_submission_idx on public.billing_submission_items (submission_id);
create index billing_submission_items_org_idx on public.billing_submission_items (organization_id);

create trigger billing_approvals_audit
after insert or update or delete on public.billing_approvals
for each row execute function public.write_audit_log();

create trigger billing_submissions_audit
after insert or update or delete on public.billing_submissions
for each row execute function public.write_audit_log();

create trigger billing_submission_items_audit
after insert or update or delete on public.billing_submission_items
for each row execute function public.write_audit_log();

alter table public.billing_approvals enable row level security;
alter table public.billing_submissions enable row level security;
alter table public.billing_submission_items enable row level security;

insert into public.permissions (key, description) values
  ('billing.read', 'View billing-ready visits, approvals, and submission history'),
  ('billing.approve', 'Approve a signed visit''s billable quantity for billing'),
  ('billing.submit', 'Mark approved visits as submitted/billed');

insert into public.role_permissions (role, permission_key)
select role_value, permission_key
from (
  values
    ('organization_owner'::public.system_role, 'billing.read'),
    ('organization_owner'::public.system_role, 'billing.approve'),
    ('organization_owner'::public.system_role, 'billing.submit'),
    ('organization_admin'::public.system_role, 'billing.read'),
    ('organization_admin'::public.system_role, 'billing.approve'),
    ('organization_admin'::public.system_role, 'billing.submit'),
    ('manager'::public.system_role, 'billing.read'),
    ('manager'::public.system_role, 'billing.approve'),
    ('manager'::public.system_role, 'billing.submit'),
    ('coordinator'::public.system_role, 'billing.read'),
    ('read_only'::public.system_role, 'billing.read')
) grants(role_value, permission_key);

-- No insert/update/delete policy on any of these three tables, same
-- reasoning as service_visits/visit_signatures/visit_corrections - every
-- mutation goes through a security-definer function below that validates
-- state transitions and computes the snapshot server-side. Reads only.
create policy "members_read_billing_approvals"
on public.billing_approvals for select to authenticated
using (public.has_permission(organization_id, 'billing.read'));

create policy "members_read_billing_submissions"
on public.billing_submissions for select to authenticated
using (public.has_permission(organization_id, 'billing.read'));

create policy "members_read_billing_submission_items"
on public.billing_submission_items for select to authenticated
using (public.has_permission(organization_id, 'billing.read'));

-- ---------------------------------------------------------------------
-- list_billing_ready_visits: the approval queue - signed, not voided/
-- corrected, no active approval yet. Deliberately excludes
-- administrator_review (still needs approve_visit_billing's separate
-- authorization-exception review first) and draft/awaiting_signature
-- (not yet client-confirmed).
-- ---------------------------------------------------------------------
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
  signed_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    v.id, v.client_id, c.first_name || ' ' || c.last_name,
    sv.name, v.caregiver_name_snapshot, v.service_date,
    v.worked_minutes, v.billable_minutes, v.signed_at
  from public.service_visits v
  join public.services sv on sv.id = v.service_id
  join public.clients c on c.id = v.client_id
  where v.organization_id = target_organization_id
    and v.status = 'signed'
    and public.has_permission(target_organization_id, 'billing.read')
    and not exists (
      select 1 from public.billing_approvals a
      where a.visit_id = v.id and a.voided_at is null
    )
  order by v.service_date desc;
$$;

revoke all on function public.list_billing_ready_visits(uuid) from public, anon;
grant execute on function public.list_billing_ready_visits(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- approve_visit_for_billing: the human approval step. Snapshot is frozen
-- here, independent of anything that changes on the visit/authorization
-- afterward.
-- ---------------------------------------------------------------------
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
    'serviceAuthorizationId', target_visit.service_authorization_id
  );

  insert into public.billing_approvals (
    organization_id, visit_id, approved_by, approved_minutes, notes, source_snapshot
  ) values (
    target_visit.organization_id, target_visit.id, auth.uid(), approved_minutes, nullif(trim(notes), ''), snapshot
  ) returning id into approval_id;

  return approval_id;
end;
$$;

revoke all on function public.approve_visit_for_billing(uuid, integer, text) from public, anon;
grant execute on function public.approve_visit_for_billing(uuid, integer, text) to authenticated;

-- Un-approve before submission - a genuine mistake, not a billing-side
-- correction (that's void_billing_submission_item, once an item has
-- actually been submitted). Blocked once a submission item exists so an
-- approval can't be pulled out from under something already billed.
create or replace function public.void_billing_approval(
  target_approval_id uuid,
  reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.billing_approvals%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if length(btrim(coalesce(reason, ''))) = 0 then
    raise exception 'A reason is required to void a billing approval';
  end if;

  select * into target from public.billing_approvals where id = target_approval_id for update;
  if target.id is null then raise exception 'Billing approval not found'; end if;
  if not public.has_permission(target.organization_id, 'billing.approve') then
    raise exception 'You do not have permission to void billing approvals for this organization';
  end if;
  if target.voided_at is not null then
    raise exception 'This approval has already been voided';
  end if;
  if exists (
    select 1 from public.billing_submission_items
    where billing_approval_id = target.id and voided_at is null
  ) then
    raise exception 'This approval has already been submitted - void the submission item instead';
  end if;

  update public.billing_approvals set
    voided_at = now(), voided_by = auth.uid(), void_reason = btrim(reason)
  where id = target.id;
end;
$$;

revoke all on function public.void_billing_approval(uuid, text) from public, anon;
grant execute on function public.void_billing_approval(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- submit_billing_approvals: batches a set of approvals into one
-- submission event. Every approval must belong to the caller's org, be
-- active (not voided), and not already have an active submission item -
-- checked per-row under a lock so two concurrent submit attempts on an
-- overlapping set can't double-submit the same approval.
-- ---------------------------------------------------------------------
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
      organization_id, submission_id, billing_approval_id, visit_id, submitted_minutes
    ) values (
      target_organization_id, submission_id, target_approval.id, target_approval.visit_id, target_approval.approved_minutes
    );
  end loop;

  return submission_id;
end;
$$;

revoke all on function public.submit_billing_approvals(uuid, uuid[], date, date, text) from public, anon;
grant execute on function public.submit_billing_approvals(uuid, uuid[], date, date, text) to authenticated;

-- Billing-side correction after submission (a rejected claim, a payer
-- adjustment) - voids the submission item without touching the
-- underlying visit or its worked/billable minutes. The approval itself
-- stays intact and voided-but-submitted, matching "previously submitted
-- history is immutable, later corrections create linked correction
-- history" - this row is that link, not a mutation of the original.
create or replace function public.void_billing_submission_item(
  target_item_id uuid,
  reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.billing_submission_items%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if length(btrim(coalesce(reason, ''))) = 0 then
    raise exception 'A reason is required to void a submission item';
  end if;

  select * into target from public.billing_submission_items where id = target_item_id for update;
  if target.id is null then raise exception 'Submission item not found'; end if;
  if not public.has_permission(target.organization_id, 'billing.submit') then
    raise exception 'You do not have permission to void submissions for this organization';
  end if;
  if target.voided_at is not null then
    raise exception 'This submission item has already been voided';
  end if;

  update public.billing_submission_items set
    voided_at = now(), voided_by = auth.uid(), void_reason = btrim(reason)
  where id = target.id;
end;
$$;

revoke all on function public.void_billing_submission_item(uuid, text) from public, anon;
grant execute on function public.void_billing_submission_item(uuid, text) to authenticated;

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
  total_submitted_minutes bigint
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
    coalesce(sum(i.submitted_minutes) filter (where i.voided_at is null), 0)
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

commit;
