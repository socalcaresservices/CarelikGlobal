-- READ ONLY. Visit state invariants, orphans, and duplicates.
select 'no_duplicate_open_visits_per_caregiver' as check_name, count(*) = 0 as ok, 'caregivers=' || count(*) as detail
from (select caregiver_user_id from ogevia.service_visits
      where caregiver_user_id is not null and status in ('draft', 'awaiting_signature')
      group by 1 having count(*) > 1) x
union all
select 'submitted_root_visits_have_one_confirmation', count(*) = 0, 'missing=' || count(*)
from ogevia.service_visits v
where v.original_visit_id is null and v.status in ('signed', 'administrator_review', 'corrected')
  and not exists (select 1 from ogevia.visit_confirmations c where c.visit_id = v.id)
union all
select 'draft_and_awaiting_visits_have_no_confirmation', count(*) = 0, 'violations=' || count(*)
from ogevia.service_visits v join ogevia.visit_confirmations c on c.visit_id = v.id
where v.status in ('draft', 'awaiting_signature')
union all
select 'signature_confirmations_have_visit_evidence', count(*) = 0, 'violations=' || count(*)
from ogevia.visit_confirmations c
left join ogevia.visit_evidence e on e.id = c.evidence_id and e.visit_id = c.visit_id
where c.confirmation_method in ('draw', 'assisted_mark') and e.id is null
union all
select 'unconfirmed_visits_have_zero_billable', count(*) = 0, 'violations=' || count(*)
from ogevia.service_visits v join ogevia.visit_confirmations c on c.visit_id = v.id
where c.confirmation_method in ('unable_to_confirm', 'typed', 'verbal') and c.confirmation_version >= 3
  and v.original_visit_id is null and v.billable_minutes <> 0
union all
select 'billable_never_exceeds_worked', count(*) = 0, 'violations=' || count(*)
from ogevia.service_visits where billable_minutes > worked_minutes
union all
select 'corrected_originals_have_correction_record', count(*) = 0, 'missing=' || count(*)
from ogevia.service_visits v
where v.status = 'corrected'
  and not exists (select 1 from ogevia.visit_corrections k where k.original_visit_id = v.id)
union all
select 'correction_rows_point_to_root', count(*) = 0, 'violations=' || count(*)
from ogevia.service_visits v join ogevia.service_visits r on r.id = v.original_visit_id
where r.original_visit_id is not null
union all
select 'orphan_evidence', count(*) = 0, 'orphans=' || count(*)
from ogevia.visit_evidence e where not exists (select 1 from ogevia.service_visits v where v.id = e.visit_id)
union all
select 'every_state_change_audited', count(*) = 0, 'unaudited_visits=' || count(*)
from ogevia.service_visits v
where not exists (select 1 from ogevia.audit_events a where a.entity_id = v.id)
union all
select 'info:open_visits_older_than_24h', true, 'count=' || count(*)
from ogevia.service_visits where status = 'draft' and time_in < now() - interval '24 hours';
