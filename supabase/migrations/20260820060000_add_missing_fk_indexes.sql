begin;

-- Stage 4: covering indexes for every FK column Supabase's performance
-- advisor (unindexed_foreign_keys) flags as missing one. Same rationale
-- and pattern as 20260719200000_fix_advisor_findings.sql's original
-- batch: plain CREATE INDEX (no CONCURRENTLY) is fine here - every one
-- of these tables is small (max ~25 rows in production today), so
-- there is no meaningful lock duration to worry about. This closes the
-- remaining 80 unindexed_foreign_keys findings the earlier batch did
-- not cover (new tables added since).

create index if not exists billing_approvals_approved_by_idx on public.billing_approvals (approved_by);
create index if not exists billing_approvals_voided_by_idx on public.billing_approvals (voided_by);
create index if not exists billing_submission_items_billing_approval_id_idx on public.billing_submission_items (billing_approval_id);
create index if not exists billing_submission_items_voided_by_idx on public.billing_submission_items (voided_by);
create index if not exists billing_submissions_submitted_by_idx on public.billing_submissions (submitted_by);
create index if not exists candidate_credentials_verified_by_idx on public.candidate_credentials (verified_by);
create index if not exists candidate_onboarding_created_by_idx on public.candidate_onboarding (created_by);
create index if not exists candidate_onboarding_organization_id_idx on public.candidate_onboarding (organization_id);
create index if not exists candidate_onboarding_updated_by_idx on public.candidate_onboarding (updated_by);
create index if not exists candidate_portal_tokens_created_by_idx on public.candidate_portal_tokens (created_by);
create index if not exists candidate_portal_tokens_organization_id_idx on public.candidate_portal_tokens (organization_id);
create index if not exists candidate_stage_history_changed_by_idx on public.candidate_stage_history (changed_by);
create index if not exists candidate_stage_history_organization_id_idx on public.candidate_stage_history (organization_id);
create index if not exists caregiver_assignments_created_by_idx on public.caregiver_assignments (created_by);
create index if not exists caregiver_assignments_service_id_idx on public.caregiver_assignments (service_id);
create index if not exists caregiver_assignments_updated_by_idx on public.caregiver_assignments (updated_by);
create index if not exists caregiver_record_availability_organization_id_idx on public.caregiver_record_availability (organization_id);
create index if not exists caregiver_record_credentials_organization_id_idx on public.caregiver_record_credentials (organization_id);
create index if not exists caregiver_record_credentials_source_candidate_credential_id_idx on public.caregiver_record_credentials (source_candidate_credential_id);
create index if not exists caregiver_record_credentials_verified_by_idx on public.caregiver_record_credentials (verified_by);
create index if not exists caregiver_records_applicant_id_idx on public.caregiver_records (applicant_id);
create index if not exists client_authorizations_created_by_idx on public.client_authorizations (created_by);
create index if not exists client_authorizations_superseded_by_id_idx on public.client_authorizations (superseded_by_id);
create index if not exists client_authorizations_updated_by_idx on public.client_authorizations (updated_by);
create index if not exists client_requested_schedule_created_by_idx on public.client_requested_schedule (created_by);
create index if not exists client_requested_schedule_service_id_idx on public.client_requested_schedule (service_id);
create index if not exists client_requested_services_created_by_idx on public.client_requested_services (created_by);
create index if not exists client_requested_services_service_id_idx on public.client_requested_services (service_id);
create index if not exists clients_created_by_idx on public.clients (created_by);
create index if not exists clients_updated_by_idx on public.clients (updated_by);
create index if not exists credential_types_created_by_idx on public.credential_types (created_by);
create index if not exists credential_types_updated_by_idx on public.credential_types (updated_by);
create index if not exists document_reminder_settings_created_by_idx on public.document_reminder_settings (created_by);
create index if not exists document_reminder_settings_updated_by_idx on public.document_reminder_settings (updated_by);
create index if not exists document_request_batches_created_by_idx on public.document_request_batches (created_by);
create index if not exists document_requests_document_type_id_idx on public.document_requests (document_type_id);
create index if not exists document_requests_file_id_idx on public.document_requests (file_id);
create index if not exists document_requests_verified_by_idx on public.document_requests (verified_by);
create index if not exists document_types_created_by_idx on public.document_types (created_by);
create index if not exists document_types_updated_by_idx on public.document_types (updated_by);
create index if not exists incident_types_created_by_idx on public.incident_types (created_by);
create index if not exists incident_types_updated_by_idx on public.incident_types (updated_by);
create index if not exists incidents_created_by_idx on public.incidents (created_by);
create index if not exists incidents_shift_id_idx on public.incidents (shift_id);
create index if not exists incidents_updated_by_idx on public.incidents (updated_by);
create index if not exists job_applicant_services_service_id_idx on public.job_applicant_services (service_id);
create index if not exists job_applicants_hired_caregiver_user_id_idx on public.job_applicants (hired_caregiver_user_id);
create index if not exists job_applicants_reviewed_by_idx on public.job_applicants (reviewed_by);
create index if not exists languages_created_by_idx on public.languages (created_by);
create index if not exists languages_updated_by_idx on public.languages (updated_by);
create index if not exists organization_candidate_stage_settings_created_by_idx on public.organization_candidate_stage_settings (created_by);
create index if not exists organization_candidate_stage_settings_updated_by_idx on public.organization_candidate_stage_settings (updated_by);
create index if not exists organization_credential_requirements_created_by_idx on public.organization_credential_requirements (created_by);
create index if not exists organization_credential_requirements_credential_type_id_idx on public.organization_credential_requirements (credential_type_id);
create index if not exists organization_credential_requirements_updated_by_idx on public.organization_credential_requirements (updated_by);
create index if not exists organization_document_type_preferences_document_type_id_idx on public.organization_document_type_preferences (document_type_id);
create index if not exists organization_document_type_preferences_updated_by_idx on public.organization_document_type_preferences (updated_by);
create index if not exists organizations_plan_definition_id_idx on public.organizations (plan_definition_id);
create index if not exists plan_definitions_created_by_idx on public.plan_definitions (created_by);
create index if not exists service_visits_created_by_idx on public.service_visits (created_by);
create index if not exists service_visits_original_visit_id_idx on public.service_visits (original_visit_id);
create index if not exists service_visits_service_id_idx on public.service_visits (service_id);
create index if not exists service_visits_voided_by_idx on public.service_visits (voided_by);
create index if not exists services_created_by_idx on public.services (created_by);
create index if not exists services_updated_by_idx on public.services (updated_by);
create index if not exists shift_coverage_events_actor_user_id_idx on public.shift_coverage_events (actor_user_id);
create index if not exists shift_coverage_events_original_caregiver_user_id_idx on public.shift_coverage_events (original_caregiver_user_id);
create index if not exists shift_coverage_events_replacement_caregiver_user_id_idx on public.shift_coverage_events (replacement_caregiver_user_id);
create index if not exists shifts_created_by_idx on public.shifts (created_by);
create index if not exists shifts_updated_by_idx on public.shifts (updated_by);
create index if not exists skills_created_by_idx on public.skills (created_by);
create index if not exists skills_updated_by_idx on public.skills (updated_by);
create index if not exists stripe_webhook_events_organization_id_idx on public.stripe_webhook_events (organization_id);
create index if not exists support_access_grants_approved_by_idx on public.support_access_grants (approved_by);
create index if not exists support_access_grants_grantee_user_id_idx on public.support_access_grants (grantee_user_id);
create index if not exists support_access_grants_requested_by_idx on public.support_access_grants (requested_by);
create index if not exists support_access_grants_revoked_by_idx on public.support_access_grants (revoked_by);
create index if not exists visit_corrections_corrected_by_idx on public.visit_corrections (corrected_by);
create index if not exists visit_corrections_corrected_visit_id_idx on public.visit_corrections (corrected_visit_id);
create index if not exists visit_signatures_organization_id_idx on public.visit_signatures (organization_id);

commit;
