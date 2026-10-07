-- PRODUCTION / step 3 (after migrations). Run as the RDS master user connected
-- to ogevia_prd. The password arrives as a psql variable set from stdin by
-- deploy-production.sh (never on a command line, never in a file, never echoed):
--
--   \set app_user ogevia_prd_app
--   \set app_password <value read from the secret>
--   \i 11_prd_app_login.sql
--
-- The login gets ONLY membership in ogevia_app (EXECUTE on ogevia_api.*, no
-- table privileges) and CONNECT on ogevia_prd. NOINHERIT: the Lambda must SET
-- LOCAL ROLE ogevia_app per request (DB_SET_ROLE). It is never a superuser,
-- role/database creator, or RLS bypass. Idempotent: re-running reconciles the
-- role and its password to the secret.
\set ON_ERROR_STOP on
select current_database() = 'ogevia_prd' as in_prd \gset
\if :in_prd
\else
  do $$ begin raise exception 'Refusing: this script only provisions the production database (ogevia_prd)'; end $$;
\endif
select :'app_user' = 'ogevia_prd_app' as login_ok \gset
\if :login_ok
\else
  do $$ begin raise exception 'Refusing: the production application login must be ogevia_prd_app'; end $$;
\endif
select format('create role %I login noinherit password %L', :'app_user', :'app_password')
where not exists (select 1 from pg_roles where rolname = :'app_user')
\gexec
select format('alter role %I login noinherit nosuperuser nocreaterole nocreatedb nobypassrls password %L', :'app_user', :'app_password')
\gexec
select format('grant ogevia_app to %I', :'app_user')
\gexec
select format('grant connect on database %I to %I', current_database(), :'app_user')
\gexec
