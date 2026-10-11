# OGV-DATA-001 Appendix B: Functions and triggers

Part of [OGV-DATA-001](OGV-DATA-001-database-and-data-dictionary.md) (draft v0.1, inspection date 2026-10-11, commit `f0f1405`, schema as produced by migrations `0001` to `0048`). The 175 `ogevia_api` functions are the only database surface the application role can execute. All are `SECURITY DEFINER`, owned by `ogevia_owner`, with a pinned `search_path`; none is executable by `PUBLIC`. Function bodies are in the migrations (the latest definition wins).

Generated from the PostgreSQL catalogs of a local build of the 48 repository migrations (PostgreSQL 16.15); see the master document's method and limitations. Production's recorded level is `46|0046`, so objects added by `0047` and `0048` are not in production. Sensitivity labels are the author's analysis, not a compliance determination.

## B.1 `ogevia_api` functions (175)

An API route maps to one of these functions; the route table is `apps/sv-api/src/routes.ts`.

| Function | Arguments | Returns |
|---|---|---|
| `activate_readiness_enforcement` | `p_organization_id uuid, p_reason text, p_expected_affected_shifts integer` | `jsonb` |
| `amend_client_authorization` | `p_authorization_id uuid, p_monthly_authorized_minutes integer, p_period_start date, p_period_end date, p_payer text, p_reason text, p_authorization_number text DEFAULT NULL::text, p_received_date date DEFAULT NULL::date, p_source_reference text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(new_authorization_id uuid, new_version_number integer, affected_visit_id uuid, affected_visit_status service_visit_status, affected_service_date date, affected_worked_minutes integer, affected_b…` |
| `approve_billing_rounding_adjustment` | `p_organization_id uuid, p_visit_id uuid, p_lineage_id uuid, p_service_date date, p_notes text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(adjustment_id uuid, base_minutes integer, proposed_minutes integer, adjustment_minutes integer, proposed_units numeric, capped_by_authorization boolean)` |
| `approve_caregiver_service` | `p_organization_id uuid, p_caregiver_record_id uuid, p_service_id uuid, p_effective_from date, p_effective_until date, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `uuid` |
| `approve_visit_for_billing` | `p_visit_id uuid, p_approved_minutes integer, p_notes text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid` | `uuid` |
| `assign_care_request` | `p_organization_id uuid, p_request_id uuid, p_offer_id uuid` | `uuid` |
| `assign_shift_caregiver` | `p_organization_id uuid, p_shift_id uuid, p_caregiver_record_id uuid, p_reason text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid` | `text` |
| `authorize_availability_override` | `p_organization_id uuid, p_caregiver_record_id uuid, p_range_start timestamp with time zone, p_range_end timestamp with time zone, p_reason text, p_client_id uuid` | `uuid` |
| `begin_caregiver_invitation` | `p_organization_id uuid, p_caregiver_record_id uuid, p_email text` | `text` |
| `begin_invitation_resend` | `p_organization_id uuid, p_caregiver_record_id uuid` | `text` |
| `begin_request` | `p_cognito_sub text, p_request_id uuid DEFAULT NULL::uuid` | `uuid` |
| `bulk_approve_reviewed_services` | `p_organization_id uuid, p_pairs jsonb, p_expected_count integer, p_effective_from date, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `jsonb` |
| `call_out_my_shift` | `p_organization_id uuid, p_shift_id uuid, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `text` |
| `cancel_shift` | `p_organization_id uuid, p_shift_id uuid, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `integer` |
| `change_shift_series_from` | `p_organization_id uuid, p_series_id uuid, p_from date, p_caregiver_record_id uuid, p_weekdays smallint[], p_start time without time zone, p_end time without time zone, p_ends_on date, p_on_conflict text, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(series_id uuid, cancelled integer, created integer, skipped integer, kept integer)` |
| `check_paper_confirmation_upload` | `p_request_id uuid, p_organization_id uuid` | `boolean` |
| `clear_organization_logo` | `p_organization_id uuid` | `void` |
| `close_missed_service_visit` | `p_visit_id uuid, p_time_out timestamp with time zone, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(visit_id uuid, worked_minutes integer, time_in timestamp with time zone, time_out timestamp with time zone)` |
| `complete_caregiver_invitation` | `p_organization_id uuid, p_caregiver_record_id uuid, p_email text, p_cognito_sub text, p_existing_account boolean` | `TABLE(invitation_id uuid, existing_account boolean)` |
| `confirm_service_visit` | `p_visit_id uuid, p_signer_role visit_signer_role, p_confirmation_method text, p_evidence_id uuid DEFAULT NULL::uuid, p_typed_signer_name text DEFAULT NULL::text, p_signer_relationship text DEFAULT NULL::text, p_confirmation_reason text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(visit_id uuid, status service_visit_status, authorization_status visit_authorization_status, worked_minutes integer, billable_minutes integer, month_to_date_minutes bigint, remaining_minutes big…` |
| `correct_service_visit` | `p_visit_id uuid, p_new_time_in timestamp with time zone, p_new_time_out timestamp with time zone, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `uuid` |
| `create_assignment` | `p_organization_id uuid, p_caregiver_record_id uuid, p_client_id uuid, p_service_id uuid, p_effective_start date, p_effective_end date DEFAULT NULL::date, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(assignment_id uuid, has_authorization boolean, grants_access boolean)` |
| `create_caregiver` | `p_organization_id uuid, p_first_name text, p_last_name text, p_preferred_name text DEFAULT NULL::text, p_status text DEFAULT 'onboarding'::text, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(caregiver_record_id uuid, caregiver_code text)` |
| `create_client` | `p_organization_id uuid, p_first_name text, p_last_name text, p_city text DEFAULT NULL::text, p_client_type_id uuid DEFAULT NULL::uuid, p_caregiver_display_code text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(client_id uuid, client_code text)` |
| `create_client_authorization` | `p_organization_id uuid, p_client_id uuid, p_service_id uuid, p_payer text, p_monthly_authorized_minutes integer, p_period_start date, p_period_end date, p_authorization_number text DEFAULT NULL::text, p_received_date date DEFAULT NULL::date, p_source_reference text DEFAULT NULL::text, p_hourly_rate_cents integer DEFAULT NULL::integer, p_idempotency_key uuid DEFAULT NULL::uuid` | `uuid` |
| `create_client_care_portal` | `p_organization_id uuid, p_client_id uuid, p_token_hash text, p_label text DEFAULT NULL::text` | `uuid` |
| `create_client_type` | `p_organization_id uuid, p_name text, p_idempotency_key uuid DEFAULT NULL::uuid` | `uuid` |
| `create_continuity_pack` | `p_organization_id uuid, p_request_key uuid` | `jsonb` |
| `create_document_type` | `p_organization_id uuid, p_name text, p_requires_expiry boolean, p_idempotency_key uuid DEFAULT NULL::uuid` | `uuid` |
| `create_experience_tag` | `p_organization_id uuid, p_label text` | `uuid` |
| `create_service` | `p_organization_id uuid, p_code text, p_name text, p_idempotency_key uuid DEFAULT NULL::uuid` | `uuid` |
| `create_shift` | `p_organization_id uuid, p_client_id uuid, p_service_id uuid, p_local_date date, p_start time without time zone, p_end time without time zone, p_caregiver_record_id uuid DEFAULT NULL::uuid, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(shift_id uuid, starts_at timestamp with time zone, ends_at timestamp with time zone, reserved_minutes integer, remaining_minutes bigint)` |
| `create_shift_series` | `p_organization_id uuid, p_client_id uuid, p_service_id uuid, p_caregiver_record_id uuid, p_weekdays smallint[], p_start time without time zone, p_end time without time zone, p_starts_on date, p_ends_on date, p_on_conflict text DEFAULT 'refuse'::text, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(series_id uuid, created integer, skipped integer, reserved_minutes integer, generated_through date)` |
| `create_visit_confirmation_request` | `p_visit_id uuid, p_channel text, p_recipient_name text, p_recipient_role text, p_identity_check text, p_token_hash text, p_code_hash text, p_expires_in_days integer, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(request_id uuid, expires_at timestamp with time zone, is_new boolean)` |
| `decide_visit_review` | `p_visit_id uuid, p_decision text, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `uuid` |
| `disable_account` | `p_organization_id uuid, p_user_id uuid, p_reason text` | `TABLE(cognito_sub text, disable_sign_in boolean)` |
| `enable_account` | `p_organization_id uuid, p_user_id uuid, p_reason text` | `text` |
| `end_assignment` | `p_organization_id uuid, p_assignment_id uuid, p_end_date date, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `text` |
| `end_service_visit` | `p_visit_id uuid, p_task_categories text[] DEFAULT NULL::text[], p_service_notes text DEFAULT NULL::text` | `TABLE(visit_id uuid, worked_minutes integer, time_in timestamp with time zone, time_out timestamp with time zone)` |
| `end_shift_series` | `p_organization_id uuid, p_series_id uuid, p_from date, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(cancelled integer, released_minutes integer, kept integer)` |
| `evaluate_assignment_readiness` | `p_organization_id uuid, p_caregiver_record_id uuid, p_service_id uuid, p_starts timestamp with time zone, p_ends timestamp with time zone, p_context text DEFAULT 'shift'::text, p_exclude_shift uuid DEFAULT NULL::uuid, p_client_id uuid DEFAULT NULL::uuid` | `jsonb` |
| `evaluate_assignment_readiness_local` | `p_organization_id uuid, p_caregiver_record_id uuid, p_service_id uuid, p_local_date date, p_start time without time zone, p_end time without time zone, p_context text DEFAULT 'shift'::text, p_exclude_shift uuid DEFAULT NULL::uuid, p_client_id uuid DEFAULT NULL::uuid` | `jsonb` |
| `extend_shift_series` | `p_organization_id uuid, p_series_id uuid, p_through date, p_on_conflict text DEFAULT 'refuse'::text, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(created integer, skipped integer, generated_through date)` |
| `get_active_service_visit` | `p_organization_id uuid` | `TABLE(visit_id uuid, visit_number text, client_code text, service_code text, service_name text, scheduled_starts_at timestamp with time zone, scheduled_ends_at timestamp with time zone, time_in timest…` |
| `get_attention_summary` | `p_organization_id uuid, p_unscheduled_open_hours integer DEFAULT 12, p_unconfirmed_minutes integer DEFAULT 60` | `TABLE(missing_time_out integer, not_confirmed integer, needs_review integer, billing_ready_unapproved integer, total integer, uncovered_shifts integer, documents_blocking integer, documents_to_review …` |
| `get_availability` | `p_organization_id uuid, p_caregiver_record_id uuid DEFAULT NULL::uuid` | `jsonb` |
| `get_caregiver_experience` | `p_organization_id uuid, p_caregiver_record_id uuid DEFAULT NULL::uuid` | `jsonb` |
| `get_client_experience_requirements` | `p_organization_id uuid, p_client_id uuid` | `TABLE(tag_id uuid, label text, mandatory boolean)` |
| `get_confirmation_replay` | `p_visit_id uuid, p_idempotency_key uuid` | `TABLE(visit_id uuid, status service_visit_status, authorization_status visit_authorization_status, worked_minutes integer, billable_minutes integer, month_to_date_minutes bigint, remaining_minutes big…` |
| `get_continuity_status` | `p_organization_id uuid` | `TABLE(last_downloaded_at timestamp with time zone, last_downloaded_by text, hours_since numeric, downloads_last_7_days integer, outage_numbers_issued integer)` |
| `get_document_alerts` | `p_organization_id uuid, p_expiring_window_days integer DEFAULT NULL::integer` | `TABLE(expired integer, expiring integer, overdue integer, awaiting_review integer, rejected integer)` |
| `get_document_readiness` | `p_organization_id uuid, p_caregiver_record_id uuid DEFAULT NULL::uuid, p_starts timestamp with time zone DEFAULT NULL::timestamp with time zone, p_ends timestamp with time zone DEFAULT NULL::timestamp with time zone` | `jsonb` |
| `get_document_upload_replay` | `p_document_id uuid, p_idempotency_key uuid` | `TABLE(document_version_id uuid, version_number integer)` |
| `get_late_confirmation_evidence` | `p_late_confirmation_id uuid` | `TABLE(object_key text, version_id text, content_type text, byte_size integer, sha256 text)` |
| `get_matching_zip` | `p_organization_id uuid, p_record_id uuid, p_kind text` | `jsonb` |
| `get_my_availability` | `p_organization_id uuid` | `TABLE(window_id uuid, weekday smallint, specific_date date, start_local time without time zone, end_local time without time zone)` |
| `get_my_context` | `` | `TABLE(organization_id uuid, organization_slug text, organization_name text, organization_timezone text, role system_role, permissions text[])` |
| `get_my_profile` | `` | `TABLE(user_id uuid, display_name text)` |
| `get_organization_branding` | `p_organization_id uuid` | `TABLE(organization_id uuid, display_name text, accent_color text, logo_sha256 text, legal_name text, address_street text, address_city text, address_state text, address_zip text, contact_phone text, c…` |
| `get_organization_logo` | `p_organization_id uuid` | `TABLE(object_key text, s3_version_id text, content_type text, sha256 text)` |
| `get_public_care_portal` | `p_token_hash text` | `TABLE(organization_name text, client_code text, service_id uuid, service_code text, service_name text, period_end date)` |
| `get_readiness_status` | `p_organization_id uuid` | `jsonb` |
| `get_utilisation_overview` | `p_organization_id uuid, p_month_start date` | `TABLE(service_id uuid, service_code text, service_name text, client_count integer, authorized_minutes integer, scheduled_minutes integer, worked_minutes integer, billable_minutes integer, review_minut…` |
| `get_visit_review` | `p_visit_id uuid` | `TABLE(visit_id uuid, organization_id uuid, visit_number text, visit_status service_visit_status, client_id uuid, client_code text, client_name text, caregiver_name text, service_code text, service_nam…` |
| `get_visit_signature_evidence` | `p_visit_id uuid` | `TABLE(evidence_id uuid, organization_id uuid, object_key text, object_version_id text, content_type text, byte_size integer, sha256_hex text)` |
| `get_work_requirement_setup` | `p_organization_id uuid` | `jsonb` |
| `list_accounts` | `p_organization_id uuid` | `TABLE(user_id uuid, display_name text, role text, membership_status text, account_status text, caregiver_record_id uuid, caregiver_code text, caregiver_name text, invited_at timestamp with time zone, …` |
| `list_assigned_visit_clients` | `p_organization_id uuid` | `TABLE(client_id uuid, client_code text, next_scheduled_starts_at timestamp with time zone, next_scheduled_ends_at timestamp with time zone, active_service_count integer, next_scheduled_service_id uuid…` |
| `list_assignments` | `p_organization_id uuid, p_client_id uuid DEFAULT NULL::uuid, p_caregiver_record_id uuid DEFAULT NULL::uuid` | `TABLE(assignment_id uuid, caregiver_record_id uuid, caregiver_code text, caregiver_name text, client_id uuid, client_code text, client_name text, service_id uuid, service_code text, service_name text,…` |
| `list_authorized_services_for_client` | `p_organization_id uuid, p_client_id uuid` | `TABLE(service_id uuid, service_code text, service_name text, service_color text, authorization_id uuid, monthly_authorized_minutes integer, minutes_used_this_month bigint, minutes_scheduled_this_month…` |
| `list_availability_requests` | `p_organization_id uuid, p_status text DEFAULT 'pending'::text` | `TABLE(request_id uuid, caregiver_record_id uuid, caregiver_code text, caregiver_name text, kind text, status text, source text, reason text, effective_from date, effective_until date, windows jsonb, r…` |
| `list_available_caregivers` | `p_organization_id uuid, p_request_id uuid` | `TABLE(caregiver_record_id uuid, caregiver_name text, current_client_match boolean, availability_source text)` |
| `list_billing_approvals` | `p_organization_id uuid, p_date_from date, p_date_to date` | `TABLE(billing_approval_id uuid, visit_id uuid, visit_number text, service_date date, approved_minutes integer, billable_minutes_at_approval integer, approved_at timestamp with time zone, approved_by_n…` |
| `list_billing_review_visits` | `p_organization_id uuid, p_date_from date, p_date_to date` | `TABLE(visit_id uuid, visit_number text, client_id uuid, service_id uuid, service_code text, authorization_id uuid, authorization_lineage_id uuid, authorization_version integer, service_date date, time…` |
| `list_billing_rounding_policies` | `p_organization_id uuid` | `TABLE(policy_id uuid, payer text, service_id uuid, service_name text, version integer, method text, increment_minutes integer, basis text, payer_rule_reference text, payer_rule_date date, effective_fr…` |
| `list_billing_rounding_preview` | `p_organization_id uuid, p_from date, p_to date` | `TABLE(unit_kind text, unit_key text, visit_id uuid, visit_number text, visit_count integer, authorization_lineage_id uuid, client_code text, service_name text, payer text, service_date date, time_in t…` |
| `list_care_alert_staff` | `p_organization_id uuid` | `TABLE(user_id uuid, display_name text, selected boolean)` |
| `list_care_request_offers` | `p_organization_id uuid, p_request_id uuid` | `TABLE(offer_id uuid, caregiver_record_id uuid, caregiver_name text, status care_offer_status, responded_at timestamp with time zone)` |
| `list_care_requests` | `p_organization_id uuid, p_status care_request_status DEFAULT NULL::care_request_status` | `TABLE(request_id uuid, client_code text, service_id uuid, service_code text, service_name text, starts_at timestamp with time zone, ends_at timestamp with time zone, requested_minutes integer, status …` |
| `list_caregiver_service_approvals` | `p_organization_id uuid, p_caregiver_record_id uuid DEFAULT NULL::uuid` | `TABLE(approval_id uuid, caregiver_record_id uuid, caregiver_code text, caregiver_name text, service_id uuid, service_code text, service_name text, state text, effective_from date, effective_until date…` |
| `list_caregivers` | `p_organization_id uuid` | `TABLE(caregiver_record_id uuid, caregiver_code text, first_name text, last_name text, preferred_name text, status text, has_sign_in boolean, sign_in_status text, active_assignments integer, open_visit…` |
| `list_client_authorizations` | `p_organization_id uuid, p_client_id uuid` | `TABLE(authorization_id uuid, lineage_id uuid, version_number integer, is_current boolean, supersedes_id uuid, superseded_by_id uuid, service_id uuid, service_code text, service_name text, payer text, …` |
| `list_client_directory` | `p_organization_id uuid` | `TABLE(client_id uuid, client_code text, caregiver_display_code text, status client_status, legal_first_name text, legal_last_name text)` |
| `list_client_portal_options` | `p_organization_id uuid` | `TABLE(client_id uuid, client_code text)` |
| `list_client_types` | `p_organization_id uuid` | `TABLE(client_type_id uuid, name text, is_active boolean)` |
| `list_clients` | `p_organization_id uuid` | `TABLE(client_id uuid, client_code text, caregiver_display_code text, status client_status, legal_first_name text, legal_last_name text, city text, client_type_id uuid, client_type_name text, current_a…` |
| `list_correction_history_report` | `p_organization_id uuid, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date, p_client_id uuid DEFAULT NULL::uuid, p_service_id uuid DEFAULT NULL::uuid, p_caregiver_user_id uuid DEFAULT NULL::uuid, p_corrected_by_user_id uuid DEFAULT NULL::uuid, p_status service_visit_status DEFAULT NULL::service_visit_status` | `TABLE(correction_id uuid, visit_number text, client_id uuid, client_code text, service_id uuid, service_code text, service_name text, service_date date, caregiver_user_id uuid, caregiver_name text, co…` |
| `list_document_people` | `p_organization_id uuid` | `TABLE(caregiver_record_id uuid, display_name text, caregiver_code text)` |
| `list_document_readiness` | `p_organization_id uuid` | `TABLE(caregiver_record_id uuid, caregiver_code text, caregiver_name text, caregiver_status text, cpr_status text, cpr_valid_until date, tb_status text, tb_valid_until date, future_shifts_at_risk integ…` |
| `list_document_types` | `p_organization_id uuid` | `TABLE(document_type_id uuid, name text, requires_expiry boolean, is_active boolean, reminder_days integer[], uses_agency_default boolean)` |
| `list_experience_tags` | `p_organization_id uuid` | `TABLE(tag_id uuid, label text)` |
| `list_monthly_approval_summary` | `p_organization_id uuid, p_month_start date, p_client_id uuid DEFAULT NULL::uuid` | `TABLE(authorization_lineage_id uuid, approved_minutes integer, approved_visit_count integer, rounding_adjustment_minutes integer)` |
| `list_monthly_service_summary` | `p_organization_id uuid, p_month_start date, p_client_id uuid DEFAULT NULL::uuid` | `TABLE(client_id uuid, client_code text, service_id uuid, service_code text, service_name text, authorization_lineage_id uuid, authorization_period_start date, authorization_period_end date, authorized…` |
| `list_my_care_opportunities` | `p_organization_id uuid` | `TABLE(offer_id uuid, care_request_id uuid, status care_offer_status, service_code text, service_name text, starts_at timestamp with time zone, ends_at timestamp with time zone, client_label text)` |
| `list_my_shifts` | `p_organization_id uuid` | `TABLE(shift_id uuid, starts_at timestamp with time zone, ends_at timestamp with time zone, client_code text, service_name text, coverage_state text, can_call_out boolean)` |
| `list_outage_reconciliation` | `p_organization_id uuid, p_open_only boolean DEFAULT false` | `TABLE(outage_number integer, issued_at timestamp with time zone, state text, visit_id uuid, visit_number text, client_code text, caregiver_name text, service_date date, time_in timestamp with time zon…` |
| `list_readiness_flags` | `p_organization_id uuid, p_kind text DEFAULT NULL::text` | `TABLE(flag_id uuid, subject text, subject_id uuid, caregiver_record_id uuid, caregiver_code text, kind text, reason_code text, starts_at timestamp with time zone, ends_at timestamp with time zone, cre…` |
| `list_service_flags` | `p_organization_id uuid` | `TABLE(flag_id uuid, subject text, subject_id uuid, caregiver_record_id uuid, caregiver_code text, reason_code text, starts_at timestamp with time zone, ends_at timestamp with time zone, created_at tim…` |
| `list_service_review_pairs` | `p_organization_id uuid` | `TABLE(caregiver_record_id uuid, caregiver_code text, caregiver_name text, caregiver_status text, service_id uuid, service_code text, service_name text, active_assignments integer, future_shifts intege…` |
| `list_service_visits` | `p_organization_id uuid, p_client_id uuid DEFAULT NULL::uuid, p_caregiver_user_id uuid DEFAULT NULL::uuid, p_service_id uuid DEFAULT NULL::uuid, p_date_from date DEFAULT NULL::date, p_date_to date DEFAULT NULL::date, p_status service_visit_status DEFAULT NULL::service_visit_status` | `TABLE(id uuid, visit_number text, client_id uuid, client_code text, caregiver_user_id uuid, caregiver_name text, service_id uuid, service_name text, service_date date, time_in timestamp with time zone…` |
| `list_services` | `p_organization_id uuid` | `TABLE(service_id uuid, code text, name text, is_active boolean)` |
| `list_shift_coverage` | `p_organization_id uuid, p_shift_id uuid` | `TABLE(event_type text, created_at timestamp with time zone, reason text, original_caregiver_name text, replacement_caregiver_name text, recorded_by text)` |
| `list_shift_series` | `p_organization_id uuid` | `TABLE(series_id uuid, status text, client_id uuid, client_code text, client_name text, service_id uuid, service_code text, service_name text, caregiver_record_id uuid, caregiver_name text, weekdays sm…` |
| `list_shifts` | `p_organization_id uuid, p_from date, p_to date, p_client_id uuid DEFAULT NULL::uuid` | `TABLE(shift_id uuid, starts_at timestamp with time zone, ends_at timestamp with time zone, local_date date, coverage_state text, shift_status text, client_id uuid, client_code text, client_name text, …` |
| `list_staff_care_notifications` | `p_organization_id uuid` | `TABLE(notification_id uuid, care_request_id uuid, event_key text, created_at timestamp with time zone)` |
| `list_staff_documents` | `p_organization_id uuid, p_expiring_window_days integer DEFAULT NULL::integer` | `TABLE(document_id uuid, caregiver_record_id uuid, person_name text, document_type_id uuid, document_type_name text, requires_expiry boolean, due_on date, requested_at timestamp with time zone, latest_…` |
| `list_visit_confirmation_requests` | `p_visit_id uuid` | `TABLE(request_id uuid, channel text, recipient_name text, recipient_role text, identity_check text, state text, failed_code_attempts integer, expires_at timestamp with time zone, created_by_name text,…` |
| `list_visit_corrections` | `p_visit_id uuid` | `TABLE(id uuid, corrected_by uuid, corrected_by_name text, reason text, before_snapshot jsonb, after_snapshot jsonb, created_at timestamp with time zone)` |
| `location_data_status` | `p_organization_id uuid` | `jsonb` |
| `mark_outage_number_unused` | `p_organization_id uuid, p_outage_number integer, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(outage_number integer, state text)` |
| `match_caregivers` | `p_organization_id uuid, p_service_id uuid, p_client_id uuid, p_intervals jsonb, p_care_request_id uuid DEFAULT NULL::uuid, p_rule_version text DEFAULT NULL::text` | `jsonb` |
| `match_caregivers_for_request` | `p_organization_id uuid, p_request_id uuid, p_rule_version text DEFAULT NULL::text` | `jsonb` |
| `note_my_sign_in` | `` | `void` |
| `open_document_version` | `p_version_id uuid` | `TABLE(object_key text, s3_version_id text, content_type text, byte_size integer, sha256 text)` |
| `prepare_account_enable` | `p_organization_id uuid, p_user_id uuid` | `TABLE(cognito_sub text, sign_in_disabled boolean)` |
| `preview_availability_request` | `p_organization_id uuid, p_request_id uuid` | `jsonb` |
| `preview_shift_series` | `p_organization_id uuid, p_client_id uuid, p_service_id uuid, p_caregiver_record_id uuid, p_weekdays smallint[], p_start time without time zone, p_end time without time zone, p_starts_on date, p_ends_on date DEFAULT NULL::date` | `TABLE(local_date date, starts_at timestamp with time zone, ends_at timestamp with time zone, minutes integer, month_start date, authorization_lineage_id uuid, authorized_minutes integer, used_minutes …` |
| `public_cancel_assigned_offer` | `p_token_hash text, p_reason text` | `care_request_status` |
| `public_cancel_care_request` | `p_token_hash text, p_request_id uuid, p_reason text DEFAULT NULL::text` | `care_request_status` |
| `public_create_care_request` | `p_token_hash text, p_service_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_note text, p_request_key uuid` | `TABLE(request_id uuid, status care_request_status, short_notice boolean)` |
| `public_get_care_offer` | `p_token_hash text` | `TABLE(offer_id uuid, status care_offer_status, service_code text, service_name text, starts_at timestamp with time zone, ends_at timestamp with time zone, client_label text)` |
| `public_get_care_request` | `p_token_hash text, p_request_id uuid` | `TABLE(request_id uuid, status care_request_status, service_code text, service_name text, starts_at timestamp with time zone, ends_at timestamp with time zone, caregiver_name text)` |
| `public_list_care_requests` | `p_token_hash text` | `TABLE(request_id uuid, status care_request_status, service_code text, service_name text, starts_at timestamp with time zone, ends_at timestamp with time zone, short_notice boolean, caregiver_name text…` |
| `public_open_visit_confirmation` | `p_token_hash text, p_code_hash text` | `TABLE(status text, organization_id uuid, agency_name text, recipient_name text, service_name text, service_date date, time_in timestamp with time zone, time_out timestamp with time zone, worked_minute…` |
| `public_respond_care_offer` | `p_token_hash text, p_available boolean, p_note text DEFAULT NULL::text` | `care_offer_status` |
| `public_respond_visit_confirmation` | `p_token_hash text, p_code_hash text, p_late_confirmation_id uuid, p_outcome text, p_method text, p_signer_name text, p_dispute_reason text, p_attested boolean, p_evidence_object_key text, p_evidence_version_id text, p_evidence_byte_size integer, p_evidence_sha256 text, p_response_key uuid` | `TABLE(status text, late_confirmation_id uuid)` |
| `record_invitation_resent` | `p_organization_id uuid, p_caregiver_record_id uuid` | `integer` |
| `record_outage_visit` | `p_organization_id uuid, p_outage_number integer, p_client_id uuid, p_service_id uuid, p_caregiver_record_id uuid, p_local_date date, p_time_in time without time zone, p_time_out time without time zone, p_paper_confirmation text, p_signer_name text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(visit_id uuid, visit_number text, worked_minutes integer, authorization_status text, outage_number integer)` |
| `record_paper_visit_confirmation` | `p_request_id uuid, p_late_confirmation_id uuid, p_signer_name text, p_signer_role text, p_signed_on date, p_evidence_object_key text, p_evidence_version_id text, p_evidence_content_type text, p_evidence_byte_size integer, p_evidence_sha256 text, p_idempotency_key uuid DEFAULT NULL::uuid` | `uuid` |
| `record_shift_callout` | `p_organization_id uuid, p_shift_id uuid, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `text` |
| `register_document_version` | `p_document_id uuid, p_version_id uuid, p_object_key text, p_s3_version_id text, p_content_type text, p_byte_size integer, p_sha256 text, p_issued_on date, p_expires_on date, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(document_version_id uuid, version_number integer)` |
| `register_visit_evidence` | `p_visit_id uuid, p_object_key text, p_object_version_id text, p_content_type text, p_byte_size integer, p_sha256_hex text, p_idempotency_key uuid DEFAULT NULL::uuid` | `uuid` |
| `rename_service` | `p_organization_id uuid, p_service_id uuid, p_name text, p_idempotency_key uuid DEFAULT NULL::uuid` | `void` |
| `replace_care_alert_staff` | `p_organization_id uuid, p_user_ids uuid[]` | `void` |
| `replace_my_availability` | `p_organization_id uuid, p_windows jsonb, p_unavailable_dates jsonb DEFAULT '[]'::jsonb` | `void` |
| `report_my_experience` | `p_organization_id uuid, p_tag_ids uuid[]` | `void` |
| `request_availability_change` | `p_organization_id uuid, p_kind text, p_windows jsonb, p_effective_from date, p_effective_until date, p_reason text, p_base_version integer, p_idempotency_key uuid DEFAULT NULL::uuid` | `uuid` |
| `request_staff_document` | `p_organization_id uuid, p_caregiver_record_id uuid, p_document_type_id uuid, p_due_on date, p_idempotency_key uuid DEFAULT NULL::uuid` | `uuid` |
| `reschedule_shift` | `p_organization_id uuid, p_shift_id uuid, p_local_date date, p_start time without time zone, p_end time without time zone, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(shift_id uuid, starts_at timestamp with time zone, ends_at timestamp with time zone, reserved_minutes integer, remaining_minutes bigint)` |
| `respond_my_care_opportunity` | `p_organization_id uuid, p_offer_id uuid, p_available boolean, p_note text DEFAULT NULL::text` | `care_offer_status` |
| `review_availability_request` | `p_organization_id uuid, p_request_id uuid, p_decision text, p_note text, p_idempotency_key uuid DEFAULT NULL::uuid` | `jsonb` |
| `review_caregiver_experience` | `p_organization_id uuid, p_caregiver_record_id uuid, p_confirmed_tag_ids uuid[], p_note text DEFAULT NULL::text` | `void` |
| `review_document_version` | `p_version_id uuid, p_decision text, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `text` |
| `review_late_visit_confirmation` | `p_late_confirmation_id uuid, p_outcome text, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(review_id uuid, decision_id uuid, accepted_minutes integer, capped_by_authorization boolean)` |
| `revoke_caregiver_service` | `p_organization_id uuid, p_approval_id uuid, p_reason text, p_effective_on date DEFAULT NULL::date, p_idempotency_key uuid DEFAULT NULL::uuid` | `jsonb` |
| `revoke_client_care_portals` | `p_organization_id uuid, p_client_id uuid` | `integer` |
| `revoke_visit_confirmation_request` | `p_request_id uuid, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `uuid` |
| `revoke_visit_review_decision` | `p_decision_id uuid, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `uuid` |
| `send_care_offer` | `p_organization_id uuid, p_request_id uuid, p_caregiver_record_id uuid, p_token_hash text` | `uuid` |
| `set_assignment_family_relationship` | `p_organization_id uuid, p_assignment_id uuid, p_relationship text, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(assignment_id uuid, family_relationship text)` |
| `set_availability_direct` | `p_organization_id uuid, p_caregiver_record_id uuid, p_kind text, p_windows jsonb, p_effective_from date, p_effective_until date, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `jsonb` |
| `set_billing_rounding_policy` | `p_organization_id uuid, p_payer text, p_service_id uuid, p_method text, p_increment_minutes integer, p_basis text, p_payer_rule_reference text, p_payer_rule_date date, p_effective_from date, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(policy_id uuid, version integer)` |
| `set_caregiver_employment` | `p_organization_id uuid, p_caregiver_record_id uuid, p_hire_type text, p_scheduling_mode text, p_reason text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(caregiver_record_id uuid, hire_type text, scheduling_mode text)` |
| `set_caregiver_status` | `p_organization_id uuid, p_caregiver_record_id uuid, p_status text, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(ended_assignments integer, sign_in_status text)` |
| `set_caregiver_zip` | `p_organization_id uuid, p_caregiver_record_id uuid, p_zip text` | `void` |
| `set_client_experience_requirements` | `p_organization_id uuid, p_client_id uuid, p_requirements jsonb, p_reason text` | `void` |
| `set_client_legal_name` | `p_organization_id uuid, p_client_id uuid, p_first_name text, p_last_name text, p_idempotency_key uuid DEFAULT NULL::uuid` | `void` |
| `set_client_service_zip` | `p_organization_id uuid, p_client_id uuid, p_zip text` | `void` |
| `set_client_status` | `p_organization_id uuid, p_client_id uuid, p_status client_status, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `void` |
| `set_document_reminder_days` | `p_organization_id uuid, p_document_type_id uuid, p_days integer[], p_idempotency_key uuid DEFAULT NULL::uuid` | `integer[]` |
| `set_document_work_requirement` | `p_organization_id uuid, p_requirement text, p_document_type_id uuid, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `void` |
| `set_my_display_name` | `p_display_name text` | `text` |
| `set_organization_branding` | `p_organization_id uuid, p_display_name text, p_accent_color text, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(organization_id uuid, display_name text, accent_color text)` |
| `set_organization_letterhead` | `p_organization_id uuid, p_legal_name text, p_address_street text, p_address_city text, p_address_state text, p_address_zip text, p_contact_phone text, p_contact_email text, p_idempotency_key uuid DEFAULT NULL::uuid` | `TABLE(organization_id uuid, legal_name text, address_street text, address_city text, address_state text, address_zip text, contact_phone text, contact_email text)` |
| `set_organization_logo` | `p_organization_id uuid, p_logo_id uuid, p_object_key text, p_s3_version_id text, p_content_type text, p_byte_size integer, p_sha256 text, p_idempotency_key uuid DEFAULT NULL::uuid` | `text` |
| `set_requirement_policy` | `p_organization_id uuid, p_requirement text, p_validity_basis text, p_validity_days integer, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `void` |
| `set_service_active` | `p_organization_id uuid, p_service_id uuid, p_active boolean, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `void` |
| `set_service_checks` | `p_organization_id uuid, p_enabled boolean, p_reason text` | `jsonb` |
| `start_ad_hoc_service_visit` | `p_organization_id uuid, p_client_id uuid, p_service_id uuid, p_task_categories text[] DEFAULT '{}'::text[], p_service_notes text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid` | `uuid` |
| `update_caregiver` | `p_organization_id uuid, p_caregiver_record_id uuid, p_first_name text, p_last_name text, p_preferred_name text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid` | `void` |
| `update_client` | `p_organization_id uuid, p_client_id uuid, p_first_name text, p_last_name text, p_city text DEFAULT NULL::text, p_client_type_id uuid DEFAULT NULL::uuid, p_caregiver_display_code text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid` | `void` |
| `void_billing_approval` | `p_approval_id uuid, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `uuid` |
| `void_billing_rounding_adjustment` | `p_adjustment_id uuid, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid` | `uuid` |
| `void_service_visit` | `p_visit_id uuid, p_reason text` | `void` |
| `withdraw_availability_request` | `p_organization_id uuid, p_request_id uuid` | `void` |

## B.2 Internal `ogevia` function names (122)

Not executable by the application role. Used by the API functions and triggers. `(definer)` marks `SECURITY DEFINER`.

`accounts_manage_guard`, `assert_client_requirements`, `assert_ready_for_assignment`, `assert_ready_for_work`, `assert_valid_caregiver_assignment`, `assignment_admin_guard`, `authorization_covers`, `authorization_month_reserved`, `authorization_month_usage`, `availability_actor_record`, `availability_apply`, `availability_blocked_days`, `availability_check_windows`, `availability_covered_future_shifts`, `availability_covers`, `availability_day`, `availability_is_noop`, `availability_layer_ranges`, `availability_override_for`, `availability_pattern`, `availability_status`, `billing_approvals_guard_update`, `billing_approvals_rounding_guard`, `billing_rounding_adjustments_guard_update`, `callout_shift`, `care_offer_by_token`, `care_portal_by_token`, `care_request_reserved_usage`, `caregiver_admin_guard`, `caregiver_has_active_assignment`, `caregiver_has_current_shift`, `check_caregiver_names`, `check_shift_caregiver`, `client_admin_guard`, `client_authorizations_before_insert`, `client_authorizations_guard_update`, `client_requirement_issues`, `client_requirements_commit_guard`, `client_type_in_org`, `confirmation_request_check`, `confirmation_request_state`, `continuity_guard`, `contrast_with_white`, `current_request_id`, `current_user_id`, `document_access`, `document_flag_impact`, `document_readiness`, `document_reminder_days_for`, `document_requirement_check`, `document_versions_guard_update`, `forbid_delete`, `forbid_update`, `format_duration`, `has_permission`, `idempotency_begin`, `idempotency_finish`, `is_active_caregiver`, `is_active_member`, `link_availability_override_to_shift` (definer), `local_time_issue`, `local_times_issue`, `lock_authorization_lineage`, `lock_caregiver`, `lock_series`, `lock_staff_shift`, `match_scheduled_shift_for_visit`, `matching_manage_guard`, `my_caregiver_record`, `new_live_visit_readiness_guard`, `normalize_invitation_email`, `organization_is_active`, `organization_local_date`, `outage_guard`, `outage_number_check`, `readiness_checks`, `readiness_enforced`, `readiness_manage_guard`, `readiness_message`, `readiness_outcome`, `readiness_read_guard`, `release_reservation_for_signed_visit`, `require_actor`, `require_clear_local_times`, `requirement_admin_guard`, `resolve_current_authorization`, `round_minutes`, `rounding_policy_for`, `rounding_proposal`, `rounding_units`, `series_cancel_from`, `series_evaluate`, `series_lock`, `series_materialize`, `series_occurrences`, `series_validate`, `service_admin_guard`, `service_approval_dates`, `service_approval_guard`, `service_approval_status`, `service_flag_impact`, `service_visits_billing_approval_guard`, `service_visits_guard_update`, `set_default_client_code`, `set_human_visit_number`, `shift_admin_guard`, `shift_coverage_state`, `shift_is_called_out`, `shift_is_care_request`, `sync_record_assignment_access`, `valid_reminder_days`, `valid_weekdays`, `visit_confirmation_requests_guard`, `visit_matches_snapshot`, `visit_recovery_state`, `visit_review_allowed`, `visit_review_decisions_guard`, `visit_review_reasons`, `visit_shift_early_arrival`, `visit_snapshot_for_confirmation`, `write_audit`, `zip_distance_miles`

## B.3 Triggers (45)

| Table | Trigger | Function |
|---|---|---|
| `audit_events` | `audit_events_append_only` | `forbid_update` |
| `audit_events` | `audit_events_no_delete` | `forbid_delete` |
| `billing_approvals` | `billing_approvals_guard_update` | `billing_approvals_guard_update` |
| `billing_approvals` | `billing_approvals_no_delete` | `forbid_delete` |
| `billing_approvals` | `billing_approvals_rounding_guard` | `billing_approvals_rounding_guard` |
| `billing_rounding_adjustments` | `billing_rounding_adjustments_guard_update` | `billing_rounding_adjustments_guard_update` |
| `billing_rounding_adjustments` | `billing_rounding_adjustments_no_delete` | `forbid_delete` |
| `billing_rounding_policies` | `billing_rounding_policies_no_delete` | `forbid_delete` |
| `billing_rounding_policies` | `billing_rounding_policies_no_update` | `forbid_update` |
| `caregiver_assignments` | `assignments_client_requirements` | `client_requirements_commit_guard` |
| `caregiver_assignments` | `caregiver_assignments_assert_valid` | `assert_valid_caregiver_assignment` |
| `caregiver_records` | `caregiver_records_sync_assignment_access` | `sync_record_assignment_access` |
| `client_authorizations` | `client_authorizations_immutable` | `client_authorizations_guard_update` |
| `client_authorizations` | `client_authorizations_no_delete` | `forbid_delete` |
| `client_authorizations` | `client_authorizations_set_lineage` | `client_authorizations_before_insert` |
| `clients` | `clients_set_default_client_code` | `set_default_client_code` |
| `continuity_exports` | `continuity_exports_no_delete` | `forbid_delete` |
| `continuity_exports` | `continuity_exports_no_update` | `forbid_update` |
| `document_versions` | `document_versions_guard_update` | `document_versions_guard_update` |
| `document_versions` | `document_versions_no_delete` | `forbid_delete` |
| `outage_visit_records` | `outage_visit_records_no_delete` | `forbid_delete` |
| `outage_visit_records` | `outage_visit_records_no_update` | `forbid_update` |
| `service_visits` | `new_live_visit_readiness` | `new_live_visit_readiness_guard` |
| `service_visits` | `service_visits_billing_approval_guard` | `service_visits_billing_approval_guard` |
| `service_visits` | `service_visits_guard_update` | `service_visits_guard_update` |
| `service_visits` | `service_visits_human_visit_number` | `set_human_visit_number` |
| `service_visits` | `service_visits_no_delete` | `forbid_delete` |
| `service_visits` | `service_visits_release_reservation` | `release_reservation_for_signed_visit` |
| `shift_series_skipped_dates` | `shift_series_skipped_dates_no_delete` | `forbid_delete` |
| `shift_series_skipped_dates` | `shift_series_skipped_dates_no_update` | `forbid_update` |
| `shifts` | `shifts_client_requirements` | `client_requirements_commit_guard` |
| `shifts` | `shifts_link_availability_override` | `link_availability_override_to_shift` |
| `staff_documents` | `staff_documents_no_delete` | `forbid_delete` |
| `visit_confirmation_requests` | `visit_confirmation_requests_guard` | `visit_confirmation_requests_guard` |
| `visit_confirmations` | `visit_confirmations_append_only` | `forbid_update` |
| `visit_confirmations` | `visit_confirmations_no_delete` | `forbid_delete` |
| `visit_corrections` | `visit_corrections_append_only` | `forbid_update` |
| `visit_corrections` | `visit_corrections_no_delete` | `forbid_delete` |
| `visit_evidence` | `visit_evidence_append_only` | `forbid_update` |
| `visit_evidence` | `visit_evidence_no_delete` | `forbid_delete` |
| `visit_late_confirmation_reviews` | `visit_late_confirmation_reviews_no_delete` | `forbid_delete` |
| `visit_late_confirmation_reviews` | `visit_late_confirmation_reviews_no_update` | `forbid_update` |
| `visit_late_confirmations` | `visit_late_confirmations_no_delete` | `forbid_delete` |
| `visit_late_confirmations` | `visit_late_confirmations_no_update` | `forbid_update` |
| `visit_review_decisions` | `visit_review_decisions_guard` | `visit_review_decisions_guard` |
