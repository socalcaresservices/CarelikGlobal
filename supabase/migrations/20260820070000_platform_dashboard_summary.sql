begin;

-- Platform dashboard: platform-routes.tsx's own TODO list has called for
-- this since it was first written (getPlatformRoutes: "TODO: Platform
-- dashboard"). Everything the metrics below need already exists -
-- plan_definitions, organizations' subscriber columns, and
-- get_effective_subscription_status() from 20260809161000 - this adds
-- the aggregation layer, not new source data.

-- Single-row summary: counts by effective status, signups, trials
-- ending soon, and an MRR estimate. One call instead of six separate
-- round trips for a dashboard that only ever needs to answer "how many"
-- and "how much", never row-level detail (that's what Organizations
-- already is).
create function public.get_platform_dashboard_summary()
returns table (
  total_organizations integer,
  trialing_count integer,
  active_count integer,
  past_due_count integer,
  canceled_count integer,
  suspended_count integer,
  trial_expired_count integer,
  new_organizations_last_30_days integer,
  trials_ending_next_7_days integer,
  mrr_cents bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with effective as (
    select
      o.id,
      public.get_effective_subscription_status(o.id) as status,
      o.created_at,
      o.trial_ends_at,
      o.is_complimentary,
      o.billing_cycle,
      coalesce(
        o.custom_monthly_price_cents,
        case when o.billing_cycle = 'annual'
          then round(coalesce(o.custom_annual_price_cents, p.annual_price_cents) / 12.0)
          else p.monthly_price_cents
        end
      ) as effective_monthly_price_cents
    from public.organizations o
    left join public.plan_definitions p on p.id = o.plan_definition_id
  )
  select
    (select count(*)::integer from effective),
    (select count(*)::integer from effective where status = 'trialing'),
    (select count(*)::integer from effective where status = 'active'),
    (select count(*)::integer from effective where status = 'past_due'),
    (select count(*)::integer from effective where status = 'canceled'),
    (select count(*)::integer from effective where status = 'suspended'),
    (select count(*)::integer from effective where status = 'trial_expired'),
    (select count(*)::integer from effective where created_at >= now() - interval '30 days'),
    (select count(*)::integer from effective
      where status = 'trialing' and trial_ends_at is not null
        and trial_ends_at between now() and now() + interval '7 days'),
    (select coalesce(sum(effective_monthly_price_cents), 0)::bigint from effective
      where status = 'active' and not is_complimentary)
  where public.is_platform_owner();
$$;

revoke all on function public.get_platform_dashboard_summary() from public, anon;
grant execute on function public.get_platform_dashboard_summary() to authenticated;

-- Plan distribution: subscriber count per plan, for a breakdown list/
-- chart next to the summary numbers above. Only counts an org toward
-- its plan's *current* version - an org pinned to a retired/superseded
-- version still shows under that plan_key, matching how the platform
-- registry already treats plan_key as the durable identity and version
-- as an implementation detail.
create function public.get_platform_plan_distribution()
returns table (
  plan_key text,
  plan_name text,
  subscriber_count integer
)
language sql
stable
security definer
set search_path = public
as $$
  select p.plan_key, p.name, count(o.id)::integer
  from public.plan_definitions p
  left join public.organizations o on o.plan_definition_id = p.id
  where public.is_platform_owner() and p.is_current = true
  group by p.plan_key, p.name
  order by count(o.id) desc, p.plan_key;
$$;

revoke all on function public.get_platform_plan_distribution() from public, anon;
grant execute on function public.get_platform_plan_distribution() to authenticated;

commit;
