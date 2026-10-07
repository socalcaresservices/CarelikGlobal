-- PRODUCTION / verification (read-only). Run as the RDS master user connected
-- to ogevia_prd. Fails (non-zero exit via ON_ERROR_STOP) unless:
--   * only ogevia_prd_app (plus superuser/rds_superuser administrators) can
--     connect to ogevia_prd,
--   * PUBLIC has no CONNECT,
--   * ogevia_prd_app is unprivileged,
--   * the migration ledger is present.
\set ON_ERROR_STOP on
do $$
declare
  v_bad text;
begin
  if has_database_privilege('public', current_database(), 'CONNECT') then
    raise exception 'PUBLIC can connect to the production database';
  end if;
  select string_agg(rolname, ', ') into v_bad
  from pg_roles r
  where r.rolcanlogin and not r.rolsuper and r.rolname <> 'ogevia_prd_app'
    and r.rolname !~ '^(rds|pg_)'
    and not exists (select 1 from pg_auth_members am join pg_roles g on g.oid = am.roleid
                    where am.member = r.oid and g.rolname = 'rds_superuser')
    and has_database_privilege(r.rolname, current_database(), 'CONNECT');
  if v_bad is not null then
    raise exception 'Unexpected roles can connect to the production database: %', v_bad;
  end if;
  if not has_database_privilege('ogevia_prd_app', current_database(), 'CONNECT') then
    raise exception 'ogevia_prd_app cannot connect';
  end if;
  if exists (select 1 from pg_roles where rolname = 'ogevia_prd_app'
             and (rolsuper or rolcreaterole or rolcreatedb or rolbypassrls or rolinherit)) then
    raise exception 'ogevia_prd_app is over-privileged';
  end if;
  if to_regclass('ogevia_meta.schema_migrations') is null then
    raise exception 'Migration ledger missing';
  end if;
end
$$;
select 'production access model verified' as result;
