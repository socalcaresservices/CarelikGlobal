-- Billing tables exactly as production defines them (20260812193010 +
-- 20260822020000 amount columns), minus the auth.users foreign keys and the
-- audit triggers, which the stub schema does not carry. SYNTHETIC data only.
alter table public.client_authorizations add column hourly_rate_cents integer;
create table public.billing_approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  visit_id uuid not null references public.service_visits(id),
  approved_by uuid not null,
  approved_at timestamptz not null default now(),
  approved_minutes integer not null,
  notes text,
  source_snapshot jsonb not null,
  voided_at timestamptz, voided_by uuid, void_reason text,
  created_at timestamptz not null default now(),
  rate_cents integer, amount_cents integer,
  constraint billing_approvals_minutes_check check (approved_minutes >= 0)
);
create unique index billing_approvals_active_visit_unique on public.billing_approvals (visit_id) where voided_at is null;
create table public.billing_submissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  submitted_by uuid not null, submitted_at timestamptz not null default now(),
  period_start date, period_end date, notes text, created_at timestamptz not null default now()
);
create table public.billing_submission_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  submission_id uuid not null references public.billing_submissions(id) on delete cascade,
  billing_approval_id uuid not null references public.billing_approvals(id),
  visit_id uuid not null references public.service_visits(id),
  submitted_minutes integer not null,
  voided_at timestamptz, voided_by uuid, void_reason text,
  created_at timestamptz not null default now(),
  submitted_amount_cents integer
);
create unique index billing_submission_items_active_visit_unique on public.billing_submission_items (visit_id) where voided_at is null;

-- Columns/tables correct_service_visit (v3) reads or writes that the shared
-- stub omits (definitions from 20260809042943 / v3, minus auth.users FKs).
alter table public.visit_signatures add column confirmation_method text;
create table public.visit_corrections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  original_visit_id uuid not null references public.service_visits(id),
  corrected_visit_id uuid not null references public.service_visits(id),
  corrected_by uuid not null,
  reason text not null,
  before_snapshot jsonb not null,
  after_snapshot jsonb not null,
  created_at timestamptz not null default now()
);
