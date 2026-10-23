-- TEST DATABASE ONLY. Creates two NEW synthetic agencies, each with one owner, and COMMITS them so the deployed TEST API can be exercised against them over
-- HTTP (slice/isolation_http.py). Nothing else is created: no clients, caregivers, authorizations, shifts, visits or documents. It refuses any database
-- except ogevia_sv_test. The agencies are labelled synthetic and are suspended afterwards by test_http_isolation_retire.sql (nothing is deleted; audit stays).
--
--   psql ... -d ogevia_sv_test -f test_http_isolation_seed.sql
--
-- Output: one row  org_a|sub_a|org_b|sub_b  (random ids; the "sub" values are not real Cognito users, the script invokes the API handler with them).
\set ON_ERROR_STOP on
select current_database() = 'ogevia_sv_test' as in_test \gset
\if :in_test
\else
  do $$ begin raise exception 'Refusing: this runs only in the TEST database ogevia_sv_test.'; end $$;
\endif
begin;
with a as (insert into ogevia.app_users (cognito_sub, display_name) values (gen_random_uuid()::text, 'HTTP isolation owner A (synthetic)') returning id, cognito_sub),
     b as (insert into ogevia.app_users (cognito_sub, display_name) values (gen_random_uuid()::text, 'HTTP isolation owner B (synthetic)') returning id, cognito_sub),
     oa as (insert into ogevia.organizations (slug, display_name, timezone) values ('http-iso-a-' || substr(md5(random()::text), 1, 8), 'HTTP isolation agency A (synthetic)', 'America/Los_Angeles') returning id),
     ob as (insert into ogevia.organizations (slug, display_name, timezone) values ('http-iso-b-' || substr(md5(random()::text), 1, 8), 'HTTP isolation agency B (synthetic)', 'America/Los_Angeles') returning id),
     m as (insert into ogevia.organization_memberships (organization_id, user_id, role, status)
             select oa.id, a.id, 'organization_owner'::ogevia.system_role, 'active'::ogevia.membership_status from oa, a union all select ob.id, b.id, 'organization_owner'::ogevia.system_role, 'active'::ogevia.membership_status from ob, b returning 1)
select oa.id as org_a, a.cognito_sub as sub_a, ob.id as org_b, b.cognito_sub as sub_b from oa, a, ob, b, (select count(*) from m) mm;
commit;
