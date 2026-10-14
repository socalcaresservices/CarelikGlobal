-- READ ONLY. Run in a read-only transaction against the PILOT or test database to see what a scheduling-preference migration
-- would touch. Changes nothing. Returns counts only: no names, no codes, no identifiers.
begin read only;

-- 1. How many caregiver records hold each combination today.
select coalesce(hire_type, '(not recorded)') as hire_type, scheduling_mode, count(*) as caregivers
  from ogevia.caregiver_records
 where deleted_at is null
 group by 1, 2
 order by 1, 2;

-- 2. Which of them were EXPLICITLY chosen by a person. The save writes the audit action 'caregiver.employment_set'
--    (set_caregiver_employment, migration 0030). A record with no such event only holds the column default 'fixed'.
select case when exists (select 1 from ogevia.audit_events a
                          where a.entity_type = 'caregiver_records' and a.entity_id = r.id and a.action = 'caregiver.employment_set')
            then 'chosen by a person' else 'column default only' end as origin,
       r.scheduling_mode, count(*) as caregivers
  from ogevia.caregiver_records r
 where r.deleted_at is null
 group by 1, 2
 order by 1, 2;

-- 3. Is anything else reading the column? (Expect: only the visit review functions, as a label.)
select p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('ogevia', 'ogevia_api') and p.prokind = 'f' and pg_get_functiondef(p.oid) ilike '%scheduling_mode%'
 order by 1;
rollback;
