begin;

-- Managers review service delivery. Only owners prepare and submit billing.
delete from public.role_permissions
where role = 'manager'
  and permission_key = 'billing.submit';

-- A manager may create or amend the operational terms of an authorization,
-- but may never set, replace, clear, or infer its rate. An amendment made by
-- a manager silently carries the existing rate forward to the new version.
create or replace function public.protect_authorization_financial_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  prior_rate integer;
begin
  if auth.uid() is null
     or public.has_permission(NEW.organization_id, 'billing.update') then
    return NEW;
  end if;

  if TG_OP = 'INSERT' then
    if NEW.supersedes_id is not null then
      select a.hourly_rate_cents
      into prior_rate
      from public.client_authorizations a
      where a.id = NEW.supersedes_id
        and a.organization_id = NEW.organization_id;
      NEW.hourly_rate_cents := prior_rate;
    else
      NEW.hourly_rate_cents := null;
    end if;
    return NEW;
  end if;

  if NEW.hourly_rate_cents is distinct from OLD.hourly_rate_cents then
    raise exception 'Only an organization owner can change billing rates';
  end if;

  return NEW;
end;
$$;

revoke all on function public.protect_authorization_financial_fields() from public, anon, authenticated;

drop trigger if exists client_authorizations_protect_financial_fields
on public.client_authorizations;
create trigger client_authorizations_protect_financial_fields
before insert or update of hourly_rate_cents
on public.client_authorizations
for each row execute function public.protect_authorization_financial_fields();

-- RLS cannot hide one column. Remove broad SELECT and grant only the
-- operational columns used by scheduling. Owners receive the rate through the
-- owner-gated RPC below; service_role retains its server-side access.
revoke select on table public.client_authorizations from public, anon, authenticated;
grant select (
  id, organization_id, client_id, payer, max_monthly_hours, period_start,
  period_end, notes, created_by, updated_by, created_at, updated_at, deleted_at,
  service_id, authorization_number, version_number, is_current, supersedes_id,
  superseded_by_id, received_date, source_reference, change_reason
) on table public.client_authorizations to authenticated;

-- The organization row also contains subscription, Stripe, pricing, tax, and
-- plan-override fields. Keep those out of direct tenant reads. Existing
-- owner/platform billing RPCs continue to expose them to their intended roles.
revoke select on table public.organizations from public, anon, authenticated;
grant select (
  id, slug, legal_name, display_name, status, timezone, country_code,
  created_by, updated_by, created_at, updated_at, deleted_at, dba,
  business_license, org_type, website, agency_code, address_street,
  address_suite, address_city, address_state, address_zip, address_country,
  primary_contact_name, contact_email, contact_phone, emergency_phone,
  logo_url, primary_color, secondary_color, accent_color, theme_mode,
  show_powered_by, custom_domain
) on table public.organizations to authenticated;

-- Full billing rows and raw audit JSON are never direct tenant-table reads.
-- Security-definer list RPCs below return only the fields appropriate to the
-- caller. This prevents a manager from bypassing the interface with REST.
revoke select on table public.billing_approvals from public, anon, authenticated;
revoke select on table public.billing_submissions from public, anon, authenticated;
revoke select on table public.billing_submission_items from public, anon, authenticated;
revoke select on table public.audit_logs from public, anon, authenticated;

drop policy if exists "members_read_billing_approvals" on public.billing_approvals;
create policy "owners_read_billing_approvals"
on public.billing_approvals for select to authenticated
using (public.has_permission(organization_id, 'billing.read'));

drop policy if exists "members_read_billing_submissions" on public.billing_submissions;
create policy "owners_read_billing_submissions"
on public.billing_submissions for select to authenticated
using (public.has_permission(organization_id, 'billing.read'));

drop policy if exists "members_read_billing_submission_items" on public.billing_submission_items;
create policy "owners_read_billing_submission_items"
on public.billing_submission_items for select to authenticated
using (public.has_permission(organization_id, 'billing.read'));

drop policy if exists "authorized_read_audit" on public.audit_logs;
create policy "owners_read_full_audit_values"
on public.audit_logs for select to authenticated
using (public.has_permission(organization_id, 'billing.read'));

-- Managers still need the hours, client, service, and expiration portions of
-- authorizations. The rate is returned only to an owner.
create or replace function public.list_client_authorizations(
  target_organization_id uuid,
  result_limit integer default 200
)
returns table (
  id uuid,
  client_id uuid,
  client_name text,
  service_id uuid,
  service_name text,
  payer text,
  authorization_number text,
  max_monthly_hours numeric,
  period_start date,
  period_end date,
  notes text,
  hours_used_this_month numeric,
  hours_scheduled_this_month numeric,
  version_number integer,
  received_date date,
  source_reference text,
  hourly_rate_cents integer
)
language sql
stable
security definer
set search_path = public
as $$
  select
    a.id,
    a.client_id,
    c.first_name || ' ' || c.last_name,
    a.service_id,
    sv.name,
    a.payer,
    a.authorization_number,
    a.max_monthly_hours,
    a.period_start,
    a.period_end,
    a.notes,
    usage.hours_used_this_month,
    usage.hours_scheduled_this_month,
    a.version_number,
    a.received_date,
    a.source_reference,
    case
      when public.has_permission(target_organization_id, 'billing.read')
        then a.hourly_rate_cents
      else null
    end
  from public.client_authorizations a
  join public.clients c on c.id = a.client_id
  join public.services sv on sv.id = a.service_id
  cross join lateral (
    select
      coalesce(
        sum(extract(epoch from (least(s.ends_at, w.window_end) - greatest(s.starts_at, w.window_start))) / 3600.0)
          filter (where s.status = 'completed'),
        0
      ) as hours_used_this_month,
      coalesce(
        sum(extract(epoch from (least(s.ends_at, w.window_end) - greatest(s.starts_at, w.window_start))) / 3600.0)
          filter (where s.status = 'scheduled'),
        0
      ) as hours_scheduled_this_month
    from (
      select
        greatest(date_trunc('month', now()), a.period_start::timestamptz) as window_start,
        least(date_trunc('month', now()) + interval '1 month', a.period_end::timestamptz + interval '1 day') as window_end
    ) w
    left join public.shifts s
      on s.client_id = a.client_id
     and s.service_id = a.service_id
     and s.organization_id = a.organization_id
     and s.status in ('completed', 'scheduled')
     and s.starts_at < w.window_end
     and s.ends_at > w.window_start
  ) usage
  where a.organization_id = target_organization_id
    and a.deleted_at is null
    and a.is_current = true
    and public.has_permission(target_organization_id, 'authorizations.read')
  order by a.period_start desc
  limit least(greatest(result_limit, 1), 500);
$$;

revoke all on function public.list_client_authorizations(uuid, integer) from public, anon;
grant execute on function public.list_client_authorizations(uuid, integer) to authenticated;

-- The visit-review RPCs keep one stable response shape for the frontend, but
-- financial cells are NULL unless the caller also has billing.read.
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
    case when public.has_permission(target_organization_id, 'billing.read')
      then a.hourly_rate_cents else null end,
    case
      when public.has_permission(target_organization_id, 'billing.read')
       and a.hourly_rate_cents is not null
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
    case when public.has_permission(target_organization_id, 'billing.read')
      then a.rate_cents else null end,
    case when public.has_permission(target_organization_id, 'billing.read')
      then a.amount_cents else null end,
    coalesce(p.display_name, 'Administrator'), a.approved_at,
    a.voided_at is not null,
    exists (
      select 1 from public.billing_submission_items i
      where i.billing_approval_id = a.id and i.voided_at is null
    )
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

-- Submission batches and their line items are an owner-only financial view.
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
    and public.has_permission(target_organization_id, 'billing.read')
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
    and public.has_permission(s.organization_id, 'billing.read')
  order by v.service_date desc;
$$;

-- Generic audit rows contain complete before/after JSON. Redact top-level
-- financial fields and the nested approval snapshot for operational callers.
create or replace function public.redact_financial_audit_values(payload jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select case
    when payload is null then null
    else
      (
        payload - array[
          'hourly_rate_cents', 'rate_cents', 'amount_cents',
          'submitted_amount_cents', 'tax_id', 'currency', 'metadata',
          'subscription_plan', 'subscription_status', 'billing_email',
          'trial_ends_at', 'storage_limit_gb', 'plan_definition_id',
          'trial_started_at', 'billing_cycle', 'billing_cycle_anchor',
          'custom_monthly_price_cents', 'custom_annual_price_cents',
          'override_max_active_clients', 'override_max_active_caregivers',
          'override_max_administrators', 'is_complimentary',
          'override_reason', 'override_expires_at', 'stripe_customer_id',
          'stripe_subscription_id', 'stripe_price_id',
          'stripe_current_period_start', 'stripe_current_period_end',
          'stripe_synced_event_created_at'
        ]::text[]
      )
      || case
        when jsonb_typeof(payload->'source_snapshot') = 'object' then
          jsonb_build_object(
            'source_snapshot',
            (payload->'source_snapshot') - array['rateCents', 'amountCents']::text[]
          )
        else '{}'::jsonb
      end
  end;
$$;

revoke all on function public.redact_financial_audit_values(jsonb) from public, anon, authenticated;

create or replace function public.list_audit_logs(
  target_organization_id uuid,
  result_limit integer default 200,
  before_id bigint default null
)
returns table (
  id bigint,
  occurred_at timestamptz,
  actor_user_id uuid,
  actor_display_name text,
  action text,
  entity_type text,
  entity_id text,
  source text,
  old_values jsonb,
  new_values jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select
    a.id,
    a.occurred_at,
    a.actor_user_id,
    coalesce(p.display_name, case when a.actor_user_id is null then 'System' else 'Unknown user' end),
    a.action,
    a.entity_type,
    a.entity_id,
    a.source,
    case when public.has_permission(target_organization_id, 'billing.read')
      then a.old_values else public.redact_financial_audit_values(a.old_values) end,
    case when public.has_permission(target_organization_id, 'billing.read')
      then a.new_values else public.redact_financial_audit_values(a.new_values) end
  from public.audit_logs a
  left join public.user_profiles p on p.id = a.actor_user_id
  where a.organization_id = target_organization_id
    and (before_id is null or a.id < before_id)
    and public.has_permission(target_organization_id, 'audit.read')
  order by a.occurred_at desc
  limit least(greatest(result_limit, 1), 500);
$$;

revoke all on function public.list_audit_logs(uuid, integer, bigint) from public, anon;
grant execute on function public.list_audit_logs(uuid, integer, bigint) to authenticated;

commit;
