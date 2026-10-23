-- READ ONLY, COUNT ONLY. Scope preview for removing confirmed TEST records from one agency. It changes NOTHING: the whole script runs in a read-only
-- transaction and ends with ROLLBACK. It deletes, deactivates and audits nothing.
--
--   psql ... -v org_slug=socal-care-services -f test_data_cleanup_preview.sql     (production; run by the owner, in CloudShell)
--
-- Output is table names and counts, status words, and calendar dates. No names, no client or caregiver codes, no ids, no payer or member identifiers.
-- Keep it out of tickets and chat anyway: counts can still identify a small agency.
--
-- What it answers, in order:
--   A. What stays: the agency, its people with sign-ins, its settings.
--   B. How many rows exist per table for this agency (every table with an organization_id), and for tables that only link through a client.
--   C. Evidence for deciding what is test data: client and caregiver counts by status, creation date range, who has worked visits.
--   D. What cannot simply be removed: signed or locked visits, billing approvals and exports. The application protects these on purpose.
\set ON_ERROR_STOP on
begin read only;

\echo '== A. Agency and people that stay (PRESERVED) =='
select o.slug, o.timezone,
       (select count(*) from ogevia.organization_memberships m where m.organization_id = o.id and m.status = 'active') as active_members,
       (select count(*) from ogevia.organization_memberships m where m.organization_id = o.id and m.role = 'organization_owner' and m.status = 'active') as active_owners,
       (select count(*) from ogevia.audit_events a where a.organization_id = o.id) as audit_events_kept
from ogevia.organizations o where o.slug = :'org_slug';

\echo '== B1. Rows per table for this agency (tables with an organization_id; zero rows not shown) =='
select t.table_name,
       (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from ogevia.%I where organization_id = %L', t.table_name, o.id), false, true, '')))[1]::text::bigint as row_count
from ogevia.organizations o
join information_schema.columns c on c.table_schema = 'ogevia' and c.column_name = 'organization_id'
join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
where o.slug = :'org_slug'
  and (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from ogevia.%I where organization_id = %L', t.table_name, o.id), false, true, '')))[1]::text::bigint > 0
order by t.table_name;

\echo '== B2. Rows per table that link to this agency only through a client or a caregiver record (zero rows not shown) =='
select t.table_name, k.link_column,
       (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from ogevia.%I x where x.%I in (select id from ogevia.%I where organization_id = %L)', t.table_name, k.link_column, k.parent, o.id), false, true, '')))[1]::text::bigint as row_count
from ogevia.organizations o
cross join (values ('client_id', 'clients'), ('caregiver_record_id', 'caregiver_records')) as k(link_column, parent)
join information_schema.columns c on c.table_schema = 'ogevia' and c.column_name = k.link_column
join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
where o.slug = :'org_slug'
  and not exists (select 1 from information_schema.columns oc where oc.table_schema = 'ogevia' and oc.table_name = t.table_name and oc.column_name = 'organization_id')
  and (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from ogevia.%I x where x.%I in (select id from ogevia.%I where organization_id = %L)', t.table_name, k.link_column, k.parent, o.id), false, true, '')))[1]::text::bigint > 0
order by t.table_name, k.link_column;

\echo '== C1. Clients by status, with the date range they were created (dates only) =='
select c.status::text as client_status, count(*) as clients, min(c.created_at)::date as first_created, max(c.created_at)::date as last_created,
       count(*) filter (where c.deleted_at is not null) as already_soft_deleted
from ogevia.clients c join ogevia.organizations o on o.id = c.organization_id
where o.slug = :'org_slug' group by 1 order by 1;

\echo '== C2. Caregiver records by status, and how many have a sign-in linked =='
select r.status::text as caregiver_status, count(*) as caregivers, count(*) filter (where r.linked_user_id is not null) as with_sign_in,
       min(r.created_at)::date as first_created, max(r.created_at)::date as last_created
from ogevia.caregiver_records r join ogevia.organizations o on o.id = r.organization_id
where o.slug = :'org_slug' group by 1 order by 1;

\echo '== C3. Shifts by status, and the dates they cover =='
select s.status::text as shift_status, count(*) as shifts, min(s.starts_at)::date as earliest, max(s.starts_at)::date as latest
from ogevia.shifts s join ogevia.organizations o on o.id = s.organization_id
where o.slug = :'org_slug' group by 1 order by 1;

\echo '== C4. Clients with and without any visit or shift (how much of the client list was only ever entered, never worked) =='
select count(*) as clients,
       count(*) filter (where exists (select 1 from ogevia.shifts s where s.client_id = c.id)) as with_a_shift,
       count(*) filter (where exists (select 1 from ogevia.service_visits v where v.client_id = c.id)) as with_a_visit,
       count(*) filter (where not exists (select 1 from ogevia.shifts s where s.client_id = c.id) and not exists (select 1 from ogevia.service_visits v where v.client_id = c.id)) as never_scheduled_or_worked
from ogevia.clients c join ogevia.organizations o on o.id = c.organization_id where o.slug = :'org_slug';

\echo '== C5. Audit events by kind for this agency (counts only; these are KEPT) =='
select split_part(a.action, '.', 1) as audit_kind, count(*) as events, min(a.occurred_at)::date as first_on, max(a.occurred_at)::date as last_on
from ogevia.audit_events a join ogevia.organizations o on o.id = a.organization_id
where o.slug = :'org_slug' group by 1 order by 2 desc, 1;

\echo '== D1. Visits by status: signed, corrected, voided and locked visits are protected by the application (no delete path) =='
select v.status::text as visit_status, count(*) as visits, count(*) filter (where v.locked_at is not null) as locked, count(*) filter (where v.signed_at is not null) as signed
from ogevia.service_visits v join ogevia.organizations o on o.id = v.organization_id
where o.slug = :'org_slug' group by 1 order by 1;

\echo '== D2. Billing approvals (not voided) and report exports that reference this agency =='
select (select count(*) from ogevia.billing_approvals b join ogevia.organizations o on o.id = b.organization_id where o.slug = :'org_slug' and b.voided_at is null) as billing_approvals_active,
       (select count(*) from ogevia.report_exports e join ogevia.organizations o on o.id = e.organization_id where o.slug = :'org_slug') as report_exports,
       (select count(*) from ogevia.continuity_exports e join ogevia.organizations o on o.id = e.organization_id where o.slug = :'org_slug') as continuity_exports;

\echo '== E. Clients that hold PROTECTED records (delete-protected tables; these clients cannot be removed), counted per table =='
with pairs as materialized (
  select distinct c2.relname as table_name, k.via, k.cond
    from pg_trigger g
    join pg_proc p on p.oid = g.tgfoid
    join pg_class c2 on c2.oid = g.tgrelid and c2.relnamespace = 'ogevia'::regnamespace
    join (values ('client_id', 'client', 'where x.client_id ='),
                 ('shift_id',  'a shift', 'join ogevia.shifts s on s.id = x.shift_id where s.client_id ='),
                 ('visit_id',  'a visit', 'join ogevia.service_visits v on v.id = x.visit_id where v.client_id =')) as k(col, via, cond)
      on exists (select 1 from information_schema.columns ic where ic.table_schema = 'ogevia' and ic.table_name = c2.relname and ic.column_name = k.col)
   where p.proname = 'forbid_delete' and not g.tgisinternal
), counted as materialized (
  select pr.table_name, pr.via,
         (xpath('/row/n/text()', query_to_xml(format('select count(distinct c.id) as n from ogevia.clients c where c.organization_id = %L and exists (select 1 from ogevia.%I x %s c.id)', o.id, pr.table_name, pr.cond), false, true, '')))[1]::text::bigint as clients_affected
    from ogevia.organizations o cross join pairs pr where o.slug = :'org_slug'
)
select table_name as protected_table, via as linked_through, clients_affected from counted where clients_affected > 0 order by clients_affected desc, table_name;

\echo '== E2. Clients with NO protected record (removable) versus with at least one (kept), by the tables above =='
select count(*) as clients_in_agency,
       count(*) filter (where not exists (select 1 from ogevia.client_authorizations x where x.client_id = c.id)
                          and not exists (select 1 from ogevia.client_documents x where x.client_id = c.id)
                          and not exists (select 1 from ogevia.client_service_holds x where x.client_id = c.id)
                          and not exists (select 1 from ogevia.service_visits x where x.client_id = c.id)) as no_authorization_document_hold_or_visit
from ogevia.clients c join ogevia.organizations o on o.id = c.organization_id where o.slug = :'org_slug';

rollback;
