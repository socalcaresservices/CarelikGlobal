begin;

-- The organizations table intentionally has no INSERT policy: creating a
-- tenant is a platform-level action, not something any organization role
-- should be able to do via RLS. This function is the only way to create
-- one, and it enforces platform-owner-only itself (same approach as the
-- other security-definer helpers in this schema).
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

  return new_organization;
end;
$$;

revoke all on function public.create_organization(text, text, text, text, text) from public;
grant execute on function public.create_organization(text, text, text, text, text) to authenticated;

commit;
