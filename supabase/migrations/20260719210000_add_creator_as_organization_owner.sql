begin;

-- create_organization() never gave the creator a membership row - they
-- could create an organization but wouldn't show up in its own members
-- list, and had no organization-level role at all (only implicit access
-- via is_platform_owner() bypassing permission checks). Discovered by
-- actually creating an org through the live app and finding the Access
-- page empty.
--
-- Fix: give the creator an active organization_owner membership in the
-- same transaction as creating the organization.
create or replace function public.create_organization(
  slug text,
  legal_name text,
  display_name text,
  timezone text default 'America/Los_Angeles',
  country_code text default 'US'
)
returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  new_organization public.organizations;
begin
  if not public.is_platform_owner() then
    raise exception 'Only a platform owner can create organizations';
  end if;

  insert into public.organizations (
    slug, legal_name, display_name, timezone, country_code, created_by, updated_by
  )
  values (
    slug, legal_name, display_name, timezone, country_code, auth.uid(), auth.uid()
  )
  returning * into new_organization;

  insert into public.organization_memberships (
    organization_id, user_id, role, status, joined_at
  )
  values (
    new_organization.id, auth.uid(), 'organization_owner', 'active', now()
  );

  return new_organization;
end;
$$;

commit;
