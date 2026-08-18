create table public.billing_approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  visit_id uuid not null references public.service_visits(id),
  approved_by uuid not null references auth.users(id),
  approved_at timestamptz not null default now(),
  approved_minutes integer not null,
  notes text,
  source_snapshot jsonb not null,
  voided_at timestamptz,
  voided_by uuid references auth.users(id),
  void_reason text,
  created_at timestamptz not null default now(),
  constraint billing_approvals_minutes_check check (approved_minutes >= 0)
);

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

create policy "members_read_billing_approvals"
on public.billing_approvals for select to authenticated
using (public.has_permission(organization_id, 'billing.read'));

create policy "members_read_billing_submissions"
on public.billing_submissions for select to authenticated
using (public.has_permission(organization_id, 'billing.read'));

create policy "members_read_billing_submission_items"
on public.billing_submission_items for select to authenticated
using (public.has_permission(organization_id, 'billing.read'));
