-- PRODUCTION / step 5. Run as the RDS master user connected to ogevia_prd,
-- AFTER the tenant exists and AFTER the administrator's sign-in was created by
-- the application's identity function (Cognito AdminCreateUser: temporary
-- password emailed by Cognito, password change + TOTP MFA at first sign-in).
-- This script receives only the Cognito `sub`; it never sees a password.
--
--   \set admin_sub '<cognito sub>'
--   \set admin_name '<display name, or empty>'
--   \i 13_prd_bootstrap_admin.sql
--
-- Links the sign-in to SoCal Care Services as organization_owner. Idempotent.
-- Refuses to add a second, different owner: further staff are managed in the
-- application.
\set ON_ERROR_STOP on
select current_database() = 'ogevia_prd' as in_prd \gset
\if :in_prd
\else
  do $$ begin raise exception 'Refusing: administrator bootstrap runs only in the production database (ogevia_prd).'; end $$;
\endif
begin;
-- psql does not interpolate variables inside $$ bodies; pass them as transaction-local settings.
select set_config('ogevia.bootstrap_sub', :'admin_sub', true), set_config('ogevia.bootstrap_name', :'admin_name', true);
do $$
declare
  v_org uuid;
  v_user uuid;
  v_member ogevia.organization_memberships%rowtype;
  v_other int;
begin
  select id into v_org from ogevia.organizations where slug = 'socal-care-services';
  if v_org is null then
    raise exception 'Tenant socal-care-services does not exist; run the tenant bootstrap first';
  end if;

  insert into ogevia.app_users (cognito_sub, display_name)
  values (current_setting('ogevia.bootstrap_sub'), nullif(btrim(current_setting('ogevia.bootstrap_name')), ''))
  on conflict (cognito_sub) do nothing;
  select id into v_user from ogevia.app_users where cognito_sub = current_setting('ogevia.bootstrap_sub');

  select * into v_member from ogevia.organization_memberships
  where organization_id = v_org and user_id = v_user for update;
  if v_member.id is not null then
    if v_member.role <> 'organization_owner' or v_member.status <> 'active' then
      raise exception 'This sign-in already has a different membership (% / %) in the tenant; resolve it in the application', v_member.role, v_member.status;
    end if;
    return; -- already bootstrapped
  end if;

  select count(*) into v_other from ogevia.organization_memberships
  where organization_id = v_org and role = 'organization_owner' and status = 'active';
  if v_other > 0 then
    raise exception 'The tenant already has an active owner; add staff through the application';
  end if;

  insert into ogevia.organization_memberships (organization_id, user_id, role, status)
  values (v_org, v_user, 'organization_owner', 'active');
  perform ogevia.write_audit(v_org, 'organization.owner_bootstrapped', 'organizations', v_org, null,
    jsonb_build_object('user_id', v_user, 'role', 'organization_owner', 'source', 'deploy-production.sh'), null);
end
$$;
commit;
select count(*) as active_owners from ogevia.organization_memberships m
join ogevia.organizations o on o.id = m.organization_id
where o.slug = 'socal-care-services' and m.role = 'organization_owner' and m.status = 'active';
