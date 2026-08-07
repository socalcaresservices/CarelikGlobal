begin;

-- Support access: lets platform staff request time-boxed access into a
-- tenant's operational data for support/debugging, gated on the tenant
-- side approving the request. This migration file is a backfill - the
-- schema below was applied directly via the dashboard SQL Editor (see
-- Build 022 notes on the CLI v2.112.0 api-key timestamp bug on `supabase
-- link`) and is committed here now so the repo's migration history
-- matches what's actually live.
create type public.support_access_status as enum (
  'requested', 'active', 'expired', 'revoked', 'denied'
);

create table public.support_access_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  grantee_user_id uuid not null references auth.users(id) on delete cascade,
  requested_by uuid references auth.users(id) on delete set null,
  reason text not null,
  status public.support_access_status not null default 'requested',
  requested_minutes integer not null default 60,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  expires_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint support_access_minutes_range check (requested_minutes >= 5 and requested_minutes <= 480),
  constraint support_access_reason_not_blank check (length(btrim(reason)) > 0)
);

-- Only one open (requested or active) grant per organization/grantee pair
-- at a time - a platform staffer must resolve or get denied on an
-- existing request before opening another for the same tenant.
create unique index support_access_one_open_per_grantee
  on public.support_access_grants (organization_id, grantee_user_id)
  where status in ('requested', 'active');

create index support_access_org_status_idx
  on public.support_access_grants (organization_id, status);

create index support_access_active_expiry_idx
  on public.support_access_grants (expires_at)
  where status = 'active';

create trigger support_access_grants_set_updated_at
before update on public.support_access_grants
for each row execute function public.set_updated_at();

create trigger support_access_grants_audit
after insert or update or delete on public.support_access_grants
for each row execute function public.write_audit_log();

alter table public.support_access_grants enable row level security;

create policy "read_support_access_grants"
on public.support_access_grants for select
to authenticated
using (
  grantee_user_id = auth.uid()
  or public.is_platform_owner()
  or public.has_permission(organization_id, 'settings.read')
);

-- Platform staff request access into a tenant. Insert happens here
-- rather than through a table policy so the grantee/requested_by/status
-- fields can't be spoofed by the caller.
create or replace function public.request_support_access(
  target_organization_id uuid,
  access_reason text,
  minutes integer default 60
)
returns public.support_access_grants
language plpgsql
security definer
set search_path = public
as $$
declare
  new_grant public.support_access_grants;
begin
  if not public.is_platform_owner() then
    raise exception 'Only platform staff can request support access';
  end if;

  if length(btrim(coalesce(access_reason, ''))) = 0 then
    raise exception 'A reason is required to request support access';
  end if;

  insert into public.support_access_grants (
    organization_id, grantee_user_id, requested_by, reason,
    status, requested_minutes
  )
  values (
    target_organization_id, auth.uid(), auth.uid(), btrim(access_reason),
    'requested', least(greatest(coalesce(minutes, 60), 5), 480)
  )
  returning * into new_grant;

  return new_grant;
end;
$$;

-- Approve/deny happen tenant-side, gated on settings.update (the same
-- permission that gates the rest of organization configuration) - a
-- platform owner cannot self-approve their own request into a tenant,
-- since has_permission(...) is scoped to the tenant's own membership
-- roles and platform_owner has no membership row there.
create or replace function public.approve_support_access(grant_id uuid)
returns public.support_access_grants
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_grant public.support_access_grants;
  target_org uuid;
begin
  select organization_id into target_org
  from public.support_access_grants
  where id = grant_id;

  if target_org is null then
    raise exception 'Support access request not found';
  end if;

  if not public.has_permission(target_org, 'settings.update') then
    raise exception 'You do not have permission to approve support access for this organization';
  end if;

  update public.support_access_grants
  set status = 'active',
      approved_by = auth.uid(),
      approved_at = now(),
      expires_at = now() + make_interval(mins => requested_minutes)
  where id = grant_id
    and status = 'requested'
  returning * into updated_grant;

  if updated_grant.id is null then
    raise exception 'Request is not in a state that can be approved';
  end if;

  return updated_grant;
end;
$$;

create or replace function public.deny_support_access(grant_id uuid)
returns public.support_access_grants
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_grant public.support_access_grants;
  target_org uuid;
begin
  select organization_id into target_org
  from public.support_access_grants
  where id = grant_id;

  if target_org is null then
    raise exception 'Support access request not found';
  end if;

  if not public.has_permission(target_org, 'settings.update') then
    raise exception 'You do not have permission to manage support access for this organization';
  end if;

  update public.support_access_grants
  set status = 'denied'
  where id = grant_id
    and status = 'requested'
  returning * into updated_grant;

  if updated_grant.id is null then
    raise exception 'Request is not in a state that can be denied';
  end if;

  return updated_grant;
end;
$$;

-- Either the grantee (platform staffer giving up access early) or a
-- tenant admin (revoking access they previously approved) may revoke.
create or replace function public.revoke_support_access(grant_id uuid)
returns public.support_access_grants
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_grant public.support_access_grants;
  target_org uuid;
  target_grantee uuid;
begin
  select organization_id, grantee_user_id into target_org, target_grantee
  from public.support_access_grants
  where id = grant_id;

  if target_org is null then
    raise exception 'Support access request not found';
  end if;

  if not (
    target_grantee = auth.uid()
    or public.has_permission(target_org, 'settings.update')
  ) then
    raise exception 'You do not have permission to revoke this support access';
  end if;

  update public.support_access_grants
  set status = 'revoked',
      revoked_by = auth.uid(),
      revoked_at = now()
  where id = grant_id
    and status in ('requested', 'active')
  returning * into updated_grant;

  if updated_grant.id is null then
    raise exception 'Grant is not in a state that can be revoked';
  end if;

  return updated_grant;
end;
$$;

-- Whether the calling platform user currently holds active, unexpired
-- support access into the given organization - used to gate RLS bypass
-- on tenant operational tables (see is_platform_owner() tightening).
create or replace function public.has_active_support_access(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.support_access_grants
    where organization_id = target_organization_id
      and grantee_user_id = auth.uid()
      and status = 'active'
      and expires_at > now()
  );
$$;

-- List grants for a tenant - platform staff (any grant) or a tenant admin
-- with settings.read (grants into their own org) - same bounded-list
-- shape as list_organization_members/list_incidents etc.
create or replace function public.list_support_access_grants(
  target_organization_id uuid,
  result_limit integer default 100
)
returns setof public.support_access_grants
language sql
stable
security definer
set search_path = public
as $$
  select *
  from public.support_access_grants
  where organization_id = target_organization_id
    and (
      public.is_platform_owner()
      or public.has_permission(target_organization_id, 'settings.read')
    )
  order by created_at desc
  limit least(greatest(result_limit, 1), 500);
$$;

revoke all on function public.list_support_access_grants(uuid, integer) from public, anon;
grant execute on function public.list_support_access_grants(uuid, integer) to authenticated;

revoke all on function public.request_support_access(uuid, text, integer) from public, anon;
revoke all on function public.approve_support_access(uuid) from public, anon;
revoke all on function public.deny_support_access(uuid) from public, anon;
revoke all on function public.revoke_support_access(uuid) from public, anon;
revoke all on function public.has_active_support_access(uuid) from public, anon;
grant execute on function public.request_support_access(uuid, text, integer) to authenticated;
grant execute on function public.approve_support_access(uuid) to authenticated;
grant execute on function public.deny_support_access(uuid) to authenticated;
grant execute on function public.revoke_support_access(uuid) to authenticated;
grant execute on function public.has_active_support_access(uuid) to authenticated;

commit;
