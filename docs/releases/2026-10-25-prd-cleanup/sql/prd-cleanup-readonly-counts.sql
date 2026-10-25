-- READ ONLY. Run against ogevia_prd only. Changes nothing (read-only transaction).
--   psql "host=... dbname=ogevia_prd user=<read login> sslmode=require" -v ON_ERROR_STOP=1 -f prd-cleanup-readonly-counts.sql
begin read only;
select current_database() as db, current_user as login;
do $$ begin if current_database() <> 'ogevia_prd' then raise exception 'ABORT: not ogevia_prd'; end if; end $$;
-- A. every table with rows (no names, no identifiers)
select c.relname as tab, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from ogevia.%I', c.relname), false, true, '')))[1]::text::bigint as n
from pg_class c join pg_namespace s on s.oid=c.relnamespace where s.nspname='ogevia' and c.relkind='r'
order by n desc, tab;
-- B. the three reported counts
select (select count(*) from ogevia.clients) clients, (select count(*) from ogevia.client_authorizations) authorizations, (select count(*) from ogevia.shifts) shifts;
-- C. record-level evidence: dates, roles, who created (no names, no emails)
select 'clients' as what, min(created_at) as first_created, max(created_at) as last_created, count(*) from ogevia.clients
union all select 'shifts', min(created_at), max(created_at), count(*) from ogevia.shifts
union all select 'caregiver_records', min(created_at), max(created_at), count(*) from ogevia.caregiver_records
union all select 'service_visits', min(created_at), max(created_at), count(*) from ogevia.service_visits;
select role, status, count(*) from ogevia.organization_memberships group by 1,2 order by 1,2;
select o.slug, o.display_name, (select count(*) from ogevia.organization_memberships m where m.organization_id=o.id) as members from ogevia.organizations o;
select action, count(*) from ogevia.audit_events group by 1 order by 2 desc limit 15;
-- D. sign-in identities and their access (cognito_sub is an identifier: keep this output in the operator's session, do not paste it into chat or tickets)
select u.cognito_sub, coalesce(m.role::text,'(no membership)') as role, coalesce(m.status::text,'-') as membership_status, u.status as person_status,
       exists (select 1 from ogevia.caregiver_records c where c.linked_user_id = u.id) as has_caregiver_record
from ogevia.app_users u left join ogevia.organization_memberships m on m.user_id = u.id order by role, u.created_at;
-- E. object-store references held by rows that will be deleted (keys are system-generated UUID paths; no names). Used to inventory S3, never to delete it.
select 'visit_evidence' as src, object_key, object_version_id as version from ogevia.visit_evidence
union all select 'visit_late_confirmations', evidence_object_key, evidence_version_id from ogevia.visit_late_confirmations where evidence_object_key is not null
union all select 'client_document_versions', object_key, s3_version_id from ogevia.client_document_versions
union all select 'document_versions', object_key, s3_version_id from ogevia.document_versions order by 1, 2;
-- F. object-store reference on a RETAINED row (organization logo): must survive
select 'organizations.logo' as src, logo_object_key from ogevia.organizations where logo_object_key is not null;
rollback;
