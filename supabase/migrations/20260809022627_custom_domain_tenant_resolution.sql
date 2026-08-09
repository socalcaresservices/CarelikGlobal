begin;

-- Self-serve custom domain per organization (Build 022 item 4).
-- Uniqueness prevents two tenants from claiming the same domain; the
-- format check is a basic sanity guard, not domain validation - nothing
-- here confirms the tenant actually controls the domain's DNS, that's
-- an operational step outside this app (point the domain at CareLik's
-- hosting and add it in the hosting dashboard).
alter table public.organizations
  add column custom_domain citext unique,
  add constraint organizations_custom_domain_format check (
    custom_domain is null
    or custom_domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
  );

-- Public (anon-callable) lookup so an unauthenticated visitor on a
-- tenant's custom domain still resolves to the right tenant before
-- they've logged in - same reasoning as applicant_open_for_submission()
-- being anon-callable for the public apply flow. Deliberately returns
-- only slug + display_name, nothing else, and only for an active,
-- non-deleted organization.
create or replace function public.resolve_tenant_domain(hostname text)
returns table (slug citext, display_name text)
language sql
stable
security definer
set search_path = public
as $$
  select o.slug, o.display_name
  from public.organizations o
  where o.custom_domain = btrim(hostname)
    and o.deleted_at is null
    and o.status = 'active'
  limit 1;
$$;

revoke all on function public.resolve_tenant_domain(text) from public;
grant execute on function public.resolve_tenant_domain(text) to anon, authenticated;

commit;
