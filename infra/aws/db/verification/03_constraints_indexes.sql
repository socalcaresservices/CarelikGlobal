-- READ ONLY. Integrity constraints and indexes the invariants depend on.
with c(name) as (values
  ('client_authorizations_one_current_per_coverage'), ('client_authorizations_period_check'),
  ('service_visits_time_check'), ('service_visits_worked_range'), ('service_visits_billable_le_worked'),
  ('service_visits_draft_shape'), ('service_visits_locked_shape'), ('service_visits_voided_shape'),
  ('visit_evidence_key_shape'), ('visit_confirmations_method_evidence'), ('visit_confirmations_visit_id_key'),
  ('visit_corrections_original_visit_id_key')
), i(name) as (values
  ('service_visits_one_open_per_caregiver_user'), ('service_visits_one_open_per_caregiver_record'),
  ('service_visits_shift_unique'), ('client_authorizations_current_lookup_idx'),
  ('service_visits_authorization_date_idx'), ('caregiver_assignments_lookup_idx')
), t(name) as (values
  ('service_visits_guard_update'), ('service_visits_no_delete'), ('client_authorizations_immutable'),
  ('visit_confirmations_append_only'), ('visit_evidence_append_only'), ('visit_corrections_append_only'),
  ('audit_events_append_only'), ('audit_events_no_delete')
)
select 'constraint:' || name as check_name,
       exists (select 1 from pg_constraint k join pg_namespace n on n.oid = k.connamespace
               where n.nspname = 'ogevia' and k.conname = c.name and k.convalidated) as ok,
       null::text as detail
from c
union all
select 'index:' || name, exists (select 1 from pg_indexes where schemaname = 'ogevia' and indexname = i.name), null
from i
union all
select 'trigger_enabled:' || name,
       exists (select 1 from pg_trigger g join pg_class r on r.oid = g.tgrelid join pg_namespace n on n.oid = r.relnamespace
               where n.nspname = 'ogevia' and g.tgname = t.name and g.tgenabled = 'O'), null
from t;
