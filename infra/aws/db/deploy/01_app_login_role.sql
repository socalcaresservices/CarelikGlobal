-- TEST SLICE / step 2 of 3 (after `db:migrate` has applied 0001-0009 to
-- ogevia_sv_test). Run as the RDS master user connected to ogevia_sv_test:
--
--   psql ... -v app_user="$APP_USER" -v app_password="$APP_PASSWORD" -f 01_app_login_role.sql
--
-- APP_USER / APP_PASSWORD come from the existing Secrets Manager secret
-- ogevia/database/app, read by the OPERATOR in their own shell. They are never
-- written to Git, logs, or this repository.
--
-- The login role gets ONLY membership in ogevia_app (EXECUTE on ogevia_api.*,
-- no table privileges) and CONNECT on this database. NOINHERIT: the Lambda
-- must SET LOCAL ROLE ogevia_app per request (DB_SET_ROLE) to act at all.
\set ON_ERROR_STOP on
select format('create role %I login noinherit password %L', :'app_user', :'app_password')
where not exists (select 1 from pg_roles where rolname = :'app_user')
\gexec
select format('alter role %I login noinherit password %L', :'app_user', :'app_password')
\gexec
select format('grant ogevia_app to %I', :'app_user')
\gexec
select format('grant connect on database %I to %I', current_database(), :'app_user')
\gexec
-- Never a superuser, role/database creator, or RLS bypass.
select set_config('ogevia.check_login_role', :'app_user', false);
do $$
begin
  if exists (
    select 1 from pg_roles r
    where r.rolname = current_setting('ogevia.check_login_role')
      and (r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb)
  ) then
    raise exception 'The application login role must not be privileged';
  end if;
end
$$;
