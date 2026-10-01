-- READ ONLY. Required tables and API functions exist.
with required_tables(t) as (values
  ('app_users'), ('organizations'), ('organization_memberships'), ('permissions'), ('role_permissions'),
  ('caregiver_records'), ('clients'), ('services'), ('caregiver_assignments'), ('shifts'),
  ('shift_coverage_events'), ('client_authorizations'), ('service_visits'), ('visit_evidence'),
  ('visit_confirmations'), ('visit_corrections'), ('audit_events'), ('idempotency_records')
), required_functions(f) as (values
  ('begin_request'), ('get_active_service_visit'), ('list_assigned_visit_clients'),
  ('list_authorized_services_for_client'), ('start_ad_hoc_service_visit'), ('end_service_visit'),
  ('register_visit_evidence'), ('confirm_service_visit'), ('void_service_visit'),
  ('correct_service_visit'), ('amend_client_authorization'), ('list_service_visits'),
  ('list_visit_corrections'), ('list_billing_review_visits'),
  ('get_my_context'), ('get_visit_signature_evidence'), ('get_confirmation_replay')
)
select 'table_exists:' || t as check_name,
       exists (select 1 from pg_tables where schemaname = 'ogevia' and tablename = t) as ok,
       null::text as detail
from required_tables
union all
select 'api_function_exists:' || f,
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'ogevia_api' and p.proname = f), null
from required_functions;
