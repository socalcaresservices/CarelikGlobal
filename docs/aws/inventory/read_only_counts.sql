-- READ ONLY inventory counts for one Ogevia database (run once per database: ogevia_prd, ogevia_sv_test).
-- Emits counts, dates and agency slugs/names only. It selects NO client names, caregiver names, emails, Cognito subs, notes, or signatures.
-- Everything runs inside a READ ONLY transaction that is rolled back; it cannot change data.
--   psql -X -At -v ON_ERROR_STOP=1 -f read_only_counts.sql
\set ON_ERROR_STOP on
begin read only;
select 'database' k, current_database() v;
select 'migrations' k, count(*)::text || ' / max ' || coalesce(max(version), 'none') v from ogevia_meta.schema_migrations;

\echo '--- agencies (slug | status | created | seed-marker | name)'
select o.slug || ' | ' || o.status || ' | ' || o.created_at::date || ' | '
       || case when o.id::text like '7e570000-%' or o.id::text like '5c500000-%' then 'SEED-ID(synthetic)' else 'no-seed-marker' end
       || ' | ' || o.display_name
from ogevia.organizations o order by o.created_at;

\echo '--- sign-in identities'
select 'app_users total' k, count(*)::text v from ogevia.app_users;
select 'app_users linked to a Cognito sub' k, count(*)::text v from ogevia.app_users where cognito_sub is not null;
select 'app_users by status ' || status k, count(*)::text v from ogevia.app_users group by status order by 1;
select 'app_users created ' k, coalesce(min(created_at)::date::text, 'n/a') || ' .. ' || coalesce(max(created_at)::date::text, 'n/a') v from ogevia.app_users;
select 'users with an active membership in 2+ agencies' k, count(*)::text v
from (select user_id from ogevia.organization_memberships where status = 'active' group by user_id having count(*) > 1) x;

\echo '--- memberships by agency, role, status'
select o.slug || ' | ' || m.role || ' | ' || m.status || ' = ' || count(*)
from ogevia.organization_memberships m join ogevia.organizations o on o.id = m.organization_id
group by o.slug, m.role, m.status order by 1;

\echo '--- invitations'
select 'caregiver_invitations total / first sign-in recorded' k,
       count(*)::text || ' / ' || count(first_signed_in_at) v from ogevia.caregiver_invitations;

\echo '--- records by agency (live rows only; counts, never names)'
select o.slug || ' | caregivers=' || (select count(*) from ogevia.caregiver_records c where c.organization_id = o.id and c.deleted_at is null)
    || ' linked=' || (select count(*) from ogevia.caregiver_records c where c.organization_id = o.id and c.deleted_at is null and c.linked_user_id is not null)
    || ' | clients=' || (select count(*) from ogevia.clients c where c.organization_id = o.id and c.deleted_at is null)
    || ' (seed-id ' || (select count(*) from ogevia.clients c where c.organization_id = o.id and c.id::text like any (array['7e570000-%','5c500000-%'])) || ')'
    || ' | authorizations=' || (select count(*) from ogevia.client_authorizations a where a.organization_id = o.id)
    || ' | shifts=' || (select count(*) from ogevia.shifts s where s.organization_id = o.id)
    || ' | assignments=' || (select count(*) from ogevia.caregiver_assignments a where a.organization_id = o.id)
from ogevia.organizations o order by o.created_at;

\echo '--- visits by agency and status'
select o.slug || ' | ' || v.status || ' = ' || count(*) || ' (first ' || min(v.created_at)::date || ', last ' || max(v.created_at)::date || ')'
from ogevia.service_visits v join ogevia.organizations o on o.id = v.organization_id
group by o.slug, v.status order by 1;
select 'visits with signature/evidence rows' k, count(*)::text v from ogevia.visit_evidence;
select 'visit confirmations' k, count(*)::text v from ogevia.visit_confirmations;
select 'billing approvals (all / active)' k, count(*)::text || ' / ' || count(*) filter (where voided_at is null) v from ogevia.billing_approvals;
select 'visits in the last 7 days' k, count(*)::text v from ogevia.service_visits where created_at > now() - interval '7 days';

\echo '--- audit trail: earliest/latest and most common actions'
select 'audit_events' k, count(*)::text || ' (' || coalesce(min(occurred_at)::date::text, 'n/a') || ' .. ' || coalesce(max(occurred_at)::date::text, 'n/a') || ')' v from ogevia.audit_events;
select 'action ' || action k, count(*)::text v from ogevia.audit_events group by action order by count(*) desc, action limit 15;
rollback;
