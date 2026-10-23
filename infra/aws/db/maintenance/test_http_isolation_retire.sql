-- TEST DATABASE ONLY. After the HTTP isolation test: suspends the two synthetic agencies it created (slug http-iso-a-* / http-iso-b-*) and disables their
-- synthetic owners, so nothing stays active. Deletes nothing; audit history stays. Refuses any database except ogevia_sv_test.
--   psql ... -d ogevia_sv_test -f test_http_isolation_retire.sql
\set ON_ERROR_STOP on
select current_database() = 'ogevia_sv_test' as in_test \gset
\if :in_test
\else
  do $$ begin raise exception 'Refusing: this runs only in the TEST database ogevia_sv_test.'; end $$;
\endif
begin;
with o as (update ogevia.organizations set status = 'suspended', updated_at = now()
  where slug ~ '^http-iso-[ab]-[0-9a-f]{8}$' and status = 'active' returning 1)
select count(*) as agencies_suspended from o;
with u as (update ogevia.app_users set status = 'disabled', updated_at = now()
  where display_name in ('HTTP isolation owner A (synthetic)', 'HTTP isolation owner B (synthetic)') and status = 'active' returning 1)
select count(*) as owners_disabled from u;
commit;
