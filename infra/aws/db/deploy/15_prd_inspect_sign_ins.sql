-- PRODUCTION / READ ONLY. Maps every person record in the production database to its access, so the owner can see which existing record
-- each sign-in belongs to BEFORE any sign-in is moved to the new user pool. Selects NO email, NO Cognito sub, NO hash of one, no client or
-- caregiver name beyond the display name the person gave themselves. Nothing is written (BEGIN READ ONLY ... ROLLBACK).
--   psql -X -At -F $'\t' -v ON_ERROR_STOP=1 -d ogevia_prd -f 15_prd_inspect_sign_ins.sql
\set ON_ERROR_STOP on
\if :{?expected_db}
\else
  \set expected_db ogevia_prd
\endif
select current_database() = :'expected_db' as in_expected \gset
\if :in_expected
\else
  do $$ begin raise exception 'Refusing: the sign-in inspection runs only against the production database.'; end $$;
\endif
begin read only;
\echo '--- agencies'
select o.slug, o.status, o.created_at::date from ogevia.organizations o order by o.created_at;
\echo '--- person records: person_id | display name | record status | has a sign-in | agency | role | membership | caregiver code | invitation'
select u.id, coalesce(nullif(btrim(u.display_name), ''), '(no name)'), u.status,
       case when u.cognito_sub is null then 'NO sign-in' else 'sign-in linked' end,
       coalesce(o.slug, '(no agency)'), coalesce(m.role::text, '-'), coalesce(m.status::text, '-'),
       coalesce(cr.caregiver_code, '-'),
       case when i.id is null then '-' when i.first_signed_in_at is null then 'invited, not yet signed in' else 'signed in' end
from ogevia.app_users u
left join ogevia.organization_memberships m on m.user_id = u.id
left join ogevia.organizations o on o.id = m.organization_id
left join ogevia.caregiver_records cr on cr.linked_user_id = u.id and cr.organization_id = m.organization_id and cr.deleted_at is null
left join ogevia.caregiver_invitations i on i.user_id = u.id and i.organization_id = m.organization_id
order by o.slug nulls last, m.role, u.created_at;
\echo '--- checks that protect against duplicates'
select 'agencies' k, count(*)::text v from ogevia.organizations;
select 'person records' k, count(*)::text v from ogevia.app_users;
select 'person records linked to a sign-in' k, count(*)::text v from ogevia.app_users where cognito_sub is not null;
select 'person records with NO membership (possible stray duplicates)' k, count(*)::text v
  from ogevia.app_users u where not exists (select 1 from ogevia.organization_memberships m where m.user_id = u.id);
select 'person records sharing a display name (possible duplicates)' k, count(*)::text v
  from (select lower(btrim(display_name)) from ogevia.app_users where nullif(btrim(display_name), '') is not null group by 1 having count(*) > 1) x;
select 'active owners per agency: ' || o.slug k, count(*)::text v
  from ogevia.organizations o left join ogevia.organization_memberships m on m.organization_id = o.id and m.role = 'organization_owner' and m.status = 'active' group by o.slug order by o.slug;
rollback;
