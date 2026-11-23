-- TASK 8 (owner brief 2026-10-30): every Ready/Active caregiver who is missing a verified background check, CPR or TB, with their due dates under the
-- agency's CPR/TB rule (hire date + the agency setting, default 30 days; 0086). READ ONLY. NOT RUN by Claude against any shared database.
-- Run in a read-only transaction, as the owner, on the DEMO database only after migration 0086 is applied there:
--   psql "$DEMO_URL" -v ON_ERROR_STOP=1 -f TASK8_ACTIVE_CAREGIVER_GAPS.sql
-- Output has caregiver codes only (no names, contact details or document contents). Replace the organization id below.
begin read only;
\set org '''00000000-0000-0000-0000-000000000000'''

select c.caregiver_code,
       c.status                                              as stored_status,
       ogevia.caregiver_work_status(c.organization_id, c.id) as calculated_status,
       c.hire_date,
       ogevia.compliance_grace_days(c.organization_id)       as agency_due_days,
       case when c.hire_date is null then null else c.hire_date + ogevia.compliance_grace_days(c.organization_id) end as default_due_date,
       ogevia.background_clearance_state(c.organization_id, c.id) as background_state,   -- 'approved' = verified approved; anything else is a gap
       coalesce(cpr.status, 'not_recorded') as cpr_status, cprg.due_date as cpr_due_date, (cprg.due_date is not null and cprg.due_date < current_date and coalesce(cpr.status, 'x') <> 'ok') as cpr_overdue_today,
       coalesce(tb.status, 'not_recorded')  as tb_status,  tbg.due_date  as tb_due_date,  (tbg.due_date  is not null and tbg.due_date  < current_date and coalesce(tb.status, 'x')  <> 'ok') as tb_overdue_today,
       ogevia.caregiver_has_signed_in(c.organization_id, c.id) as has_signed_in,
       (select count(*) from ogevia.caregiver_cpr_tb_extensions x where x.caregiver_record_id = c.id) as extensions_on_file
from ogevia.caregiver_records c
left join lateral ogevia.document_requirement_check(c.organization_id, c.id, 'cpr', null, null) cpr on true
left join lateral ogevia.document_requirement_check(c.organization_id, c.id, 'tb', null, null) tb on true
cross join lateral ogevia.compliance_grace_for(c.organization_id, c.id, now(), 'cpr') cprg
cross join lateral ogevia.compliance_grace_for(c.organization_id, c.id, now(), 'tb') tbg
where c.organization_id = :org::uuid and c.deleted_at is null and c.status in ('ready', 'active')
  and (ogevia.background_clearance_state(c.organization_id, c.id) <> 'approved' or coalesce(cpr.status, 'x') <> 'ok' or coalesce(tb.status, 'x') <> 'ok')
order by (ogevia.background_clearance_state(c.organization_id, c.id) <> 'approved') desc, least(cprg.due_date, tbg.due_date) nulls first, c.caregiver_code;

rollback;
