-- OGEVIA production synthetic-data cleanup. PREPARED, NOT EXECUTED, NOT APPROVED. Target: database ogevia_prd ONLY.
-- Owner decision: remove ALL operational data (clients, authorizations, shifts, visits, care requests, caregivers, document metadata) = clean slate.
-- KEEPS: organizations, the administrator's app_users + non-caregiver memberships, roles/permissions, services, agency/organization settings and policies,
--        reference data, and audit_events (never touched; append-only trail, including one entry for this cleanup).
-- One transaction. Default is a DRY RUN that ends with ROLLBACK. Pass -v do_commit=1 to COMMIT.
-- Required variables: exp_clients, exp_auths, exp_shifts (counts the owner reported; the script aborts if the database disagrees).
--   psql "host=... dbname=ogevia_prd user=<master> sslmode=require" -v ON_ERROR_STOP=1 -v exp_clients=4 -v exp_auths=5 -v exp_shifts=36 [-v do_commit=1] -f prd-synthetic-cleanup.sql
\set ON_ERROR_STOP on
begin;
set local role ogevia_owner;   -- table owner: needed to lift and restore the delete guards. Fails closed if the login cannot assume it.
set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- 1. Identity guard: only ever ogevia_prd.
do $$ begin
  if current_database() <> 'ogevia_prd' then raise exception 'ABORT: connected to %, this script is for ogevia_prd only', current_database(); end if;
end $$;
select set_config('ogevia.exp_clients', :'exp_clients', true), set_config('ogevia.exp_auths', :'exp_auths', true), set_config('ogevia.exp_shifts', :'exp_shifts', true) \gset

-- 2. Count guard: the reported scope must match the database exactly.
do $$ declare c bigint; a bigint; s bigint; begin
  select count(*) into c from ogevia.clients; select count(*) into a from ogevia.client_authorizations; select count(*) into s from ogevia.shifts;
  if c <> current_setting('ogevia.exp_clients')::bigint or a <> current_setting('ogevia.exp_auths')::bigint or s <> current_setting('ogevia.exp_shifts')::bigint then
    raise exception 'ABORT: found clients=%, authorizations=%, shifts=% (expected %/%/%)', c, a, s,
      current_setting('ogevia.exp_clients'), current_setting('ogevia.exp_auths'), current_setting('ogevia.exp_shifts');
  end if;
end $$;

-- 3. Before counts for every table.
create temp table cleanup_counts(phase text, tab text, n bigint) on commit drop;
do $$ declare t text; n bigint; begin
  for t in select c.relname from pg_class c join pg_namespace s on s.oid=c.relnamespace where s.nspname='ogevia' and c.relkind='r' order by 1 loop
    execute format('select count(*) from ogevia.%I', t) into n;
    insert into cleanup_counts values ('before', t, n);
  end loop;
end $$;
select tab, n as rows_before from cleanup_counts where phase='before' and n>0 order by tab;

-- 4. Lift ONLY the delete guards on tables being emptied (never audit_events). Restored and verified in step 8, in this same transaction.
alter table ogevia.client_authorizations disable trigger client_authorizations_no_delete;
alter table ogevia.service_visits disable trigger service_visits_no_delete;
alter table ogevia.visit_evidence disable trigger visit_evidence_no_delete;
alter table ogevia.visit_confirmations disable trigger visit_confirmations_no_delete;
alter table ogevia.visit_corrections disable trigger visit_corrections_no_delete;
alter table ogevia.billing_approvals disable trigger billing_approvals_no_delete;
alter table ogevia.document_versions disable trigger document_versions_no_delete;
alter table ogevia.staff_documents disable trigger staff_documents_no_delete;
alter table ogevia.continuity_exports disable trigger continuity_exports_no_delete;
alter table ogevia.outage_visit_records disable trigger outage_visit_records_no_delete;
alter table ogevia.billing_rounding_adjustments disable trigger billing_rounding_adjustments_no_delete;
alter table ogevia.visit_review_decisions disable trigger visit_review_decisions_guard;
alter table ogevia.shift_series_skipped_dates disable trigger shift_series_skipped_dates_no_delete;
alter table ogevia.visit_confirmation_requests disable trigger visit_confirmation_requests_guard;
alter table ogevia.visit_late_confirmations disable trigger visit_late_confirmations_no_delete;
alter table ogevia.visit_late_confirmation_reviews disable trigger visit_late_confirmation_reviews_no_delete;
alter table ogevia.visit_rule_evaluations disable trigger visit_rule_evaluations_no_delete;
alter table ogevia.shift_pickup_requests disable trigger shift_pickup_requests_no_delete;
alter table ogevia.caregiver_background_check_events disable trigger caregiver_background_check_events_no_delete;
alter table ogevia.caregiver_background_checks disable trigger caregiver_background_checks_history;
alter table ogevia.caregiver_compliance_holds disable trigger caregiver_compliance_holds_no_delete;
alter table ogevia.shift_reconciliations disable trigger shift_reconciliations_no_delete;
alter table ogevia.authorization_amendment_impacts disable trigger authorization_amendment_impacts_no_delete;
alter table ogevia.authorization_amendment_impact_acks disable trigger authorization_amendment_impact_acks_no_delete;
alter table ogevia.report_exports disable trigger report_exports_no_delete;
alter table ogevia.visit_authorization_reviews disable trigger visit_authorization_reviews_guard;
alter table ogevia.report_export_events disable trigger report_export_events_no_delete;
alter table ogevia.action_issue_events disable trigger action_issue_events_no_delete;
alter table ogevia.client_document_versions disable trigger client_document_versions_no_delete;
alter table ogevia.client_documents disable trigger client_documents_no_delete;
alter table ogevia.client_service_holds disable trigger client_service_holds_no_delete;
alter table ogevia.issue_notifications disable trigger issue_notifications_guard;

-- 5. Delete, children before parents (all 287 foreign keys are NO ACTION; order computed from the fully migrated schema).
delete from ogevia.caregiver_hour_limits;
delete from ogevia.billing_rounding_adjustments;
delete from ogevia.visit_authorization_reviews;
delete from ogevia.caregiver_onboarding_items;
delete from ogevia.authorization_reservations;
delete from ogevia.shift_readiness_flags;
delete from ogevia.caregiver_availability_state;
delete from ogevia.caregiver_compliance_holds;
delete from ogevia.report_exports;
delete from ogevia.client_preparation;
delete from ogevia.shift_coverage_events;
delete from ogevia.report_export_events;
delete from ogevia.client_experience_requirements;
delete from ogevia.caregiver_background_check_events;
delete from ogevia.care_notifications;
delete from ogevia.outage_visit_records;
delete from ogevia.caregiver_invitations;
delete from ogevia.action_issue_state;
delete from ogevia.idempotency_records;
delete from ogevia.client_document_versions;
delete from ogevia.caregiver_experience;
delete from ogevia.assignment_readiness_flags;
delete from ogevia.client_private_names;
delete from ogevia.visit_review_decisions;
delete from ogevia.continuity_exports;
delete from ogevia.caregiver_availability_windows;
delete from ogevia.visit_corrections;
delete from ogevia.care_request_events;
delete from ogevia.caregiver_background_checks;
delete from ogevia.visit_rule_evaluations;
delete from ogevia.shift_pickup_requests;
delete from ogevia.care_request_offers;
delete from ogevia.caregiver_unavailable_dates;
delete from ogevia.caregiver_zip;
delete from ogevia.visit_confirmations;
delete from ogevia.shift_series_skipped_dates;
delete from ogevia.authorization_amendment_impact_acks;
delete from ogevia.issue_notifications;
delete from ogevia.caregiver_service_approvals;
delete from ogevia.action_issue_events;
delete from ogevia.caregiver_experience_reviews;
delete from ogevia.client_service_zip;
delete from ogevia.shift_reconciliations;
delete from ogevia.availability_overrides;
delete from ogevia.billing_approvals;
delete from ogevia.client_service_holds;
delete from ogevia.document_versions;
delete from ogevia.client_documents;
delete from ogevia.caregiver_assignments;
delete from ogevia.visit_late_confirmation_reviews;
delete from ogevia.care_requests;
delete from ogevia.availability_requests;
delete from ogevia.visit_evidence;
delete from ogevia.authorization_amendment_impacts;
delete from ogevia.staff_documents;
delete from ogevia.visit_late_confirmations;
delete from ogevia.client_care_portals;
delete from ogevia.visit_confirmation_requests;
delete from ogevia.service_visits;
delete from ogevia.shifts;
delete from ogevia.client_authorizations;
delete from ogevia.shift_series;
delete from ogevia.clients;
delete from ogevia.caregiver_records;

-- 6. Caregiver sign-in access: remove caregiver memberships; remove the person row only where nothing retained (audit_events, etc.) points at it.
--    A row still referenced stays as an inert identity with NO membership (it cannot reach any organization). Cognito is not touched.
delete from ogevia.organization_memberships where role = 'caregiver';
do $$ declare u record; gone int := 0; kept int := 0; begin
  for u in select id from ogevia.app_users x where not exists (select 1 from ogevia.organization_memberships m where m.user_id = x.id) loop
    begin
      delete from ogevia.app_users where id = u.id; gone := gone + 1;
    exception when foreign_key_violation then kept := kept + 1;
    end;
  end loop;
  raise notice 'people removed: %, kept inert (referenced by audit or retained history): %', gone, kept;
end $$;

-- 7. Audit the cleanup itself (audit_events is append-only; insert is allowed).
insert into ogevia.audit_events(organization_id, actor_user_id, action, entity_type, reason, occurred_at, after_state)
select o.id, null, 'platform.synthetic_data_cleanup', 'organization', 'Owner-approved removal of synthetic operational data before go-live', now(),
       jsonb_build_object('tables_emptied', 64, 'script', 'prd-synthetic-cleanup.sql')
from ogevia.organizations o;

-- 8. Verification inside the transaction. Any failure raises and the whole transaction rolls back.
do $$ declare t text; n bigint; b bigint; begin
  for t in select unnest(array['caregiver_hour_limits','billing_rounding_adjustments','visit_authorization_reviews','caregiver_onboarding_items','authorization_reservations','shift_readiness_flags','caregiver_availability_state','caregiver_compliance_holds','report_exports','client_preparation','shift_coverage_events','report_export_events','client_experience_requirements','caregiver_background_check_events','care_notifications','outage_visit_records','caregiver_invitations','action_issue_state','idempotency_records','client_document_versions','caregiver_experience','assignment_readiness_flags','client_private_names','visit_review_decisions','continuity_exports','caregiver_availability_windows','visit_corrections','care_request_events','caregiver_background_checks','visit_rule_evaluations','shift_pickup_requests','care_request_offers','caregiver_unavailable_dates','caregiver_zip','visit_confirmations','shift_series_skipped_dates','authorization_amendment_impact_acks','issue_notifications','caregiver_service_approvals','action_issue_events','caregiver_experience_reviews','client_service_zip','shift_reconciliations','availability_overrides','billing_approvals','client_service_holds','document_versions','client_documents','caregiver_assignments','visit_late_confirmation_reviews','care_requests','availability_requests','visit_evidence','authorization_amendment_impacts','staff_documents','visit_late_confirmations','client_care_portals','visit_confirmation_requests','service_visits','shifts','client_authorizations','shift_series','clients','caregiver_records']) loop
    execute format('select count(*) from ogevia.%I', t) into n;
    if n <> 0 then raise exception 'VERIFY FAILED: ogevia.% still has % rows', t, n; end if;
  end loop;
  select c.n into b from cleanup_counts c where c.phase='before' and c.tab='audit_events';
  select count(*) into n from ogevia.audit_events;
  if n < b then raise exception 'VERIFY FAILED: audit_events lost rows (% -> %)', b, n; end if;
  if (select count(*) from ogevia.organizations) <> (select c.n from cleanup_counts c where c.phase='before' and c.tab='organizations') then raise exception 'VERIFY FAILED: organizations changed'; end if;
  if exists (select 1 from ogevia.organization_memberships where role = 'caregiver') then raise exception 'VERIFY FAILED: caregiver memberships remain'; end if;
end $$;

-- 8b. Re-enable every guard and prove it.
alter table ogevia.client_authorizations enable trigger client_authorizations_no_delete;
alter table ogevia.service_visits enable trigger service_visits_no_delete;
alter table ogevia.visit_evidence enable trigger visit_evidence_no_delete;
alter table ogevia.visit_confirmations enable trigger visit_confirmations_no_delete;
alter table ogevia.visit_corrections enable trigger visit_corrections_no_delete;
alter table ogevia.billing_approvals enable trigger billing_approvals_no_delete;
alter table ogevia.document_versions enable trigger document_versions_no_delete;
alter table ogevia.staff_documents enable trigger staff_documents_no_delete;
alter table ogevia.continuity_exports enable trigger continuity_exports_no_delete;
alter table ogevia.outage_visit_records enable trigger outage_visit_records_no_delete;
alter table ogevia.billing_rounding_adjustments enable trigger billing_rounding_adjustments_no_delete;
alter table ogevia.visit_review_decisions enable trigger visit_review_decisions_guard;
alter table ogevia.shift_series_skipped_dates enable trigger shift_series_skipped_dates_no_delete;
alter table ogevia.visit_confirmation_requests enable trigger visit_confirmation_requests_guard;
alter table ogevia.visit_late_confirmations enable trigger visit_late_confirmations_no_delete;
alter table ogevia.visit_late_confirmation_reviews enable trigger visit_late_confirmation_reviews_no_delete;
alter table ogevia.visit_rule_evaluations enable trigger visit_rule_evaluations_no_delete;
alter table ogevia.shift_pickup_requests enable trigger shift_pickup_requests_no_delete;
alter table ogevia.caregiver_background_check_events enable trigger caregiver_background_check_events_no_delete;
alter table ogevia.caregiver_background_checks enable trigger caregiver_background_checks_history;
alter table ogevia.caregiver_compliance_holds enable trigger caregiver_compliance_holds_no_delete;
alter table ogevia.shift_reconciliations enable trigger shift_reconciliations_no_delete;
alter table ogevia.authorization_amendment_impacts enable trigger authorization_amendment_impacts_no_delete;
alter table ogevia.authorization_amendment_impact_acks enable trigger authorization_amendment_impact_acks_no_delete;
alter table ogevia.report_exports enable trigger report_exports_no_delete;
alter table ogevia.visit_authorization_reviews enable trigger visit_authorization_reviews_guard;
alter table ogevia.report_export_events enable trigger report_export_events_no_delete;
alter table ogevia.action_issue_events enable trigger action_issue_events_no_delete;
alter table ogevia.client_document_versions enable trigger client_document_versions_no_delete;
alter table ogevia.client_documents enable trigger client_documents_no_delete;
alter table ogevia.client_service_holds enable trigger client_service_holds_no_delete;
alter table ogevia.issue_notifications enable trigger issue_notifications_guard;
do $$ begin
  if exists (select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='ogevia' and not t.tgisinternal and t.tgenabled <> 'O') then
    raise exception 'VERIFY FAILED: a trigger in schema ogevia is not enabled';
  end if;
end $$;
select case when :{?do_commit} then 'COMMIT requested' else 'DRY RUN: this transaction will be rolled back' end as mode;
\if :{?do_commit}
  commit;
\else
  rollback;
\endif
