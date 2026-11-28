-- READ-ONLY (TEST): the admin overrides of CPR/TB readiness blocks for one caregiver, and what the scheduling rules say about that caregiver right now. Writes nothing.
--   bash TEST_DB_SESSION.sh psql -X -A -F ' | ' -v cg=TEST-CG-01 -f CHECK_READINESS_OVERRIDE.sql
-- Prints the caregiver CODE only (no names or contact details). Reasons are the administrators' own words: use synthetic caregivers in TEST.
\set ON_ERROR_STOP on
begin read only;
select 'database' as k, current_database() as v;
select 'migration_0123_present' as k, to_regclass('ogevia.caregiver_readiness_overrides') is not null as present;
with r as (select c.id, c.organization_id, c.caregiver_code from ogevia.caregiver_records c where c.caregiver_code = :'cg' and c.deleted_at is null)
select 'override' as k, r.caregiver_code, o.requirement, ogevia.readiness_issue_label(o.issue_status) as issue, o.document_valid_until as doc_expiry_date,
       case when o.revoked_at is null then 'ACTIVE' else 'REVOKED' end as state, (o.approved_at at time zone 'America/Los_Angeles') as approved_pt, o.reason,
       (o.revoked_at at time zone 'America/Los_Angeles') as revoked_pt, o.revoke_reason,
       (o.revoked_at is null and cur.status is not null and cur.status <> 'ok' and ogevia.readiness_issue_key(cur.status, cur.document_id, cur.version_id, cur.valid_until) = o.issue_key) as issue_still_applies
  from r join ogevia.caregiver_readiness_overrides o on o.caregiver_record_id = r.id
  left join lateral ogevia.document_requirement_check(o.organization_id, o.caregiver_record_id, o.requirement, null, null) cur on o.revoked_at is null
 order by o.approved_at;
with r as (select c.id, c.organization_id from ogevia.caregiver_records c where c.caregiver_code = :'cg' and c.deleted_at is null),
     w as (select r.*, ((date_trunc('day', now() at time zone o.timezone) + interval '1 day 9 hours') at time zone o.timezone) as s
             from r join ogevia.organizations o on o.id = r.organization_id)
select 'scheduling_check' as k, x.check_name, x.status, x.code, x.enforced, x.message
  from w, lateral ogevia.readiness_checks(w.organization_id, w.id, null, w.s, w.s + interval '1 hour', 'shift', null, null, false) x
 where x.check_name in ('caregiver', 'background', 'cpr', 'tb') order by x.check_name;
with r as (select c.id, c.organization_id from ogevia.caregiver_records c where c.caregiver_code = :'cg' and c.deleted_at is null)
select 'work_approval_recorded' as k, exists (select 1 from ogevia.caregiver_work_approvals a where a.caregiver_record_id = r.id) as recorded,
       (select (s.enforcement_active_from is not null and s.enforcement_active_from <= now()) from ogevia.organization_readiness_settings s where s.organization_id = r.organization_id) as enforcement_on,
       (select count(*) from ogevia.caregiver_compliance_holds h where h.caregiver_record_id = r.id and h.released_at is null) as open_holds
  from r;
rollback;
