begin;

-- Organization onboarding: today create_organization() only captures the
-- four fields a tenant needs to technically exist (slug/legal_name/
-- display_name/timezone/country_code). Onboarding a real agency needs
-- a lot more - business identity, address, a point of contact, and
-- starter branding - none of which existed on this table. Every new
-- column here is nullable (nothing forces existing rows, all created
-- through the old minimal call, to backfill anything) except currency
-- and theme_mode, which get sane defaults so old rows read correctly
-- without a backfill.
alter table public.organizations
  add column dba text,
  add column tax_id text,
  add column business_license text,
  add column org_type text,
  add column website text,
  add column currency text not null default 'USD',
  add column agency_code text,
  add column address_street text,
  add column address_suite text,
  add column address_city text,
  add column address_state text,
  add column address_zip text,
  add column address_country text,
  add column primary_contact_name text,
  add column contact_email text,
  add column contact_phone text,
  add column emergency_phone text,
  add column logo_url text,
  add column primary_color text,
  add column secondary_color text,
  add column accent_color text,
  add column theme_mode text not null default 'light';

alter table public.organizations
  add constraint organizations_theme_mode_check check (theme_mode in ('light', 'dark'));

-- Case-sensitive on purpose (unlike the slug's lower() index) - agency
-- codes are conventionally already uppercase, and normalizing them would
-- fight whatever convention an agency's back office already uses.
create unique index organizations_agency_code_unique
  on public.organizations (agency_code)
  where agency_code is not null;

-- create_organization() extended in place, not replaced with a parallel
-- function: every new parameter is optional with a default, so the
-- three existing call sites (organizations-page.tsx's old form, and any
-- other future minimal caller) keep working unchanged. The new
-- "Add Organization" wizard is the only caller that passes the full
-- set. default_services seeds the org's configurable service catalog
-- (public.services, Build 003) in the same transaction as everything
-- else, so a brand-new org isn't left with an empty catalog before
-- anyone's had a chance to configure it - still fully editable
-- afterward via Settings, never a fixed list.
create or replace function public.create_organization(
  slug text,
  legal_name text,
  display_name text,
  timezone text default 'America/Los_Angeles',
  country_code text default 'US',
  dba text default null,
  tax_id text default null,
  business_license text default null,
  org_type text default null,
  website text default null,
  currency text default 'USD',
  agency_code text default null,
  address_street text default null,
  address_suite text default null,
  address_city text default null,
  address_state text default null,
  address_zip text default null,
  address_country text default null,
  primary_contact_name text default null,
  contact_email text default null,
  contact_phone text default null,
  emergency_phone text default null,
  logo_url text default null,
  primary_color text default null,
  secondary_color text default null,
  accent_color text default null,
  theme_mode text default 'light',
  default_services text[] default '{}'
)
returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  new_organization public.organizations;
  service_name text;
begin
  if not public.is_platform_owner() then
    raise exception 'Only a platform owner can create organizations';
  end if;

  insert into public.organizations (
    slug, legal_name, display_name, timezone, country_code,
    dba, tax_id, business_license, org_type, website, currency, agency_code,
    address_street, address_suite, address_city, address_state, address_zip, address_country,
    primary_contact_name, contact_email, contact_phone, emergency_phone,
    logo_url, primary_color, secondary_color, accent_color, theme_mode,
    created_by, updated_by
  )
  values (
    slug, legal_name, display_name, timezone, country_code,
    dba, tax_id, business_license, org_type, website, coalesce(currency, 'USD'), agency_code,
    address_street, address_suite, address_city, address_state, address_zip, address_country,
    primary_contact_name, contact_email, contact_phone, emergency_phone,
    logo_url, primary_color, secondary_color, accent_color, coalesce(theme_mode, 'light'),
    auth.uid(), auth.uid()
  )
  returning * into new_organization;

  insert into public.organization_memberships (
    organization_id, user_id, role, status, joined_at
  )
  values (
    new_organization.id, auth.uid(), 'organization_owner', 'active', now()
  );

  foreach service_name in array coalesce(default_services, '{}') loop
    if trim(service_name) <> '' then
      insert into public.services (organization_id, name, created_by, updated_by)
      values (new_organization.id, trim(service_name), auth.uid(), auth.uid())
      on conflict do nothing;
    end if;
  end loop;

  return new_organization;
end;
$$;

-- Revoking from public alone left anon with execute on this specific
-- overload in practice (confirmed via pg_proc.proacl after applying -
-- the original 5-param create_organization() didn't have this problem,
-- but this new 28-param overload did, likely because Supabase's default
-- privileges grant anon/authenticated/service_role execute directly on
-- newly created functions rather than through PUBLIC). Revoke from both
-- explicitly so create_organization stays platform-owner-only in
-- practice, not just in the is_platform_owner() check inside it.
revoke all on function public.create_organization(
  text, text, text, text, text, text, text, text, text, text, text, text,
  text, text, text, text, text, text, text, text, text, text,
  text, text, text, text, text, text[]
) from public, anon;
grant execute on function public.create_organization(
  text, text, text, text, text, text, text, text, text, text, text, text,
  text, text, text, text, text, text, text, text, text, text,
  text, text, text, text, text, text[]
) to authenticated;

commit;
