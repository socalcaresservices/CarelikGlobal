-- PRODUCTION / step 4. Run as the RDS master user connected to ogevia_prd,
-- AFTER migrations. Creates the SoCal Care Services organization (the first
-- tenant). No clients, caregivers, authorizations or any other data: real
-- records are entered through the application. Idempotent by slug.
\set ON_ERROR_STOP on
select current_database() = 'ogevia_prd' as in_prd \gset
\if :in_prd
\else
  do $$ begin raise exception 'Refusing: tenant bootstrap runs only in the production database (ogevia_prd).'; end $$;
\endif
begin;
with created as (
  insert into ogevia.organizations (slug, display_name, timezone)
  values ('socal-care-services', 'SoCal Care Services', 'America/Los_Angeles')
  on conflict (slug) do nothing
  returning id
)
select ogevia.write_audit(id, 'organization.bootstrapped', 'organizations', id, null,
         jsonb_build_object('slug', 'socal-care-services', 'source', 'deploy-production.sh'), null)
from created;
commit;
select count(*) as organizations from ogevia.organizations where slug = 'socal-care-services';
