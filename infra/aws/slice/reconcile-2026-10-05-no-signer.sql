-- READ-ONLY reconciliation for the 10/05/2026 pilot finding:
-- "the requested client was Synthetic Bulk Test, but the screenshots show
-- Synthetic Client Bravo". Lists every synthetic client and every
-- unable-to-confirm visit since 10/01/2026, with the client each visit is
-- actually linked to. TEST database only (synthetic names). Changes nothing.
begin transaction read only;
\echo '== Synthetic clients (code, caregiver display code, restricted name)'
select c.client_code, c.caregiver_display_code, c.status,
       coalesce(n.legal_first_name || ' ' || n.legal_last_name, '(no restricted name)') as restricted_name,
       to_char(c.created_at at time zone 'America/Los_Angeles', 'MM/DD/YYYY HH12:MI AM') as created_pacific
from ogevia.clients c left join ogevia.client_private_names n on n.client_id = c.id
where c.deleted_at is null
order by c.created_at;
\echo '== Unable-to-confirm visits since 10/01/2026 and the client they are linked to'
select v.visit_number_snapshot as visit, v.client_code_snapshot as code_on_visit, c.client_code as code_now,
       coalesce(n.legal_first_name || ' ' || n.legal_last_name, '(no restricted name)') as restricted_name,
       v.caregiver_name_snapshot as caregiver, v.status, v.worked_minutes, v.billable_minutes,
       case when v.scheduled_shift_id is null then 'unscheduled' else 'scheduled' end as schedule_link,
       to_char(v.time_in at time zone 'America/Los_Angeles', 'MM/DD/YYYY HH12:MI AM') as time_in_pacific,
       vc.confirmation_reason as no_signer_reason
from ogevia.service_visits v
join ogevia.visit_confirmations vc on vc.visit_id = v.id and vc.confirmation_method = 'unable_to_confirm'
join ogevia.clients c on c.id = v.client_id
left join ogevia.client_private_names n on n.client_id = c.id
where v.service_date >= date '2026-10-01'
order by v.time_in;
rollback;
