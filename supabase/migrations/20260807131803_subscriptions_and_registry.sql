begin;

-- Subscription/billing state per organization, plus the platform
-- registry read (list_platform_organizations) that the platform
-- Organizations page renders instead of the tenant-facing org list.
create type public.subscription_plan as enum (
  'trial', 'starter', 'professional', 'enterprise'
);

create type public.subscription_status as enum (
  'trialing', 'active', 'past_due', 'canceled', 'suspended'
);

alter table public.organizations
  add column subscription_plan public.subscription_plan not null default 'trial',
  add column subscription_status public.subscription_status not null default 'trialing',
  add column billing_email text,
  add column trial_ends_at timestamptz,
  add column storage_limit_gb integer not null default 5;

-- Platform-only: change an organization's plan/status. Deliberately
-- narrow (just plan + status) rather than a generic billing-field
-- editor - billing_email/trial_ends_at/storage_limit_gb aren't exposed
-- through any UI yet, so there's nothing calling for a setter on them.
create or replace function public.set_organization_subscription(
  target_organization_id uuid,
  new_plan public.subscription_plan,
  new_status public.subscription_status
)
returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_org public.organizations;
begin
  if not public.is_platform_owner() then
    raise exception 'Only platform staff can manage organization subscriptions';
  end if;

  update public.organizations
  set subscription_plan = new_plan,
      subscription_status = new_status
  where id = target_organization_id
  returning * into updated_org;

  if updated_org.id is null then
    raise exception 'Organization not found';
  end if;

  return updated_org;
end;
$$;

-- Platform registry: one row per organization with the columns the
-- platform Organizations page needs (plan, status, storage, seat count,
-- last login, primary owner) so the page doesn't have to stitch together
-- several direct table reads that platform staff otherwise have no RLS
-- access to. Gated in the WHERE clause (returns zero rows for a
-- non-platform-owner) rather than raising, matching
-- list_organization_members's convention for list-shaped RPCs.
create or replace function public.list_platform_organizations(result_limit integer default 200)
returns table (
  organization_id uuid,
  slug citext,
  display_name text,
  status public.organization_status,
  subscription_plan public.subscription_plan,
  subscription_status public.subscription_status,
  storage_used_bytes bigint,
  storage_limit_gb integer,
  user_count bigint,
  last_login_at timestamptz,
  primary_owner_name text,
  primary_owner_email text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    o.id,
    o.slug,
    o.display_name,
    o.status,
    o.subscription_plan,
    o.subscription_status,
    coalesce(storage.used_bytes, 0),
    o.storage_limit_gb,
    coalesce(members.user_count, 0),
    members.last_login_at,
    owner.display_name,
    owner.email,
    o.created_at
  from public.organizations o
  left join lateral (
    select sum(f.size_bytes) as used_bytes
    from public.files f
    where f.organization_id = o.id
      and f.deleted_at is null
  ) storage on true
  left join lateral (
    select count(*) as user_count, max(u.last_sign_in_at) as last_login_at
    from public.organization_memberships m
    join auth.users u on u.id = m.user_id
    where m.organization_id = o.id
      and m.status = 'active'
  ) members on true
  left join lateral (
    select p.display_name, u.email
    from public.organization_memberships m
    join public.user_profiles p on p.id = m.user_id
    join auth.users u on u.id = m.user_id
    where m.organization_id = o.id
      and m.role = 'organization_owner'
      and m.status = 'active'
    order by m.created_at
    limit 1
  ) owner on true
  where o.deleted_at is null
    and public.is_platform_owner()
  order by o.created_at desc
  limit least(greatest(result_limit, 1), 500);
$$;

revoke all on function public.set_organization_subscription(uuid, public.subscription_plan, public.subscription_status) from public, anon;
revoke all on function public.list_platform_organizations(integer) from public, anon;
grant execute on function public.set_organization_subscription(uuid, public.subscription_plan, public.subscription_status) to authenticated;
grant execute on function public.list_platform_organizations(integer) to authenticated;

commit;
