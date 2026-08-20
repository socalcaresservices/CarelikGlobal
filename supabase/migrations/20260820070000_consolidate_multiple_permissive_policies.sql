begin;

-- Stage 4: 29 multiple_permissive_policies findings from Supabase's
-- performance advisor, across 27 tables. Same root cause and same fix
-- pattern 20260719200000_fix_advisor_findings.sql already established
-- for feature_flags/organization_memberships/organization_settings:
-- each table has a permissive ALL policy (manage) and a separate
-- permissive SELECT policy (read) that both apply to every SELECT, so
-- Postgres evaluates both instead of one. Split each ALL policy into
-- INSERT/UPDATE/DELETE and fold its condition into the read policy's
-- OR, so SELECT only ever runs one policy. Every USING/WITH CHECK
-- clause below was copied verbatim from production's live pg_policies,
-- not reconstructed, to guarantee no logic drift.

-- client_requested_schedule: a genuine leftover duplicate, not just an
-- overlap to split. 20260813091340 created members_read_..., then
-- 20260813190000 recreated the same read policy as authorized_read_...
-- without dropping the original - both have carried the identical
-- qual (has_permission(organization_id, 'clients.read')) ever since.
-- Drop the orphaned original; authorized_read_... is the one every
-- later migration has treated as canonical.
drop policy if exists "members_read_client_requested_schedule" on public.client_requested_schedule;

-- === 24 standard ALL+SELECT tables ===

drop policy if exists "authorized_manage_candidate_credentials" on public.candidate_credentials;
create policy "authorized_insert_candidate_credentials" on public.candidate_credentials for insert to authenticated
  with check (has_permission(organization_id, 'applicants.update'));
create policy "authorized_update_candidate_credentials" on public.candidate_credentials for update to authenticated
  using (has_permission(organization_id, 'applicants.update')) with check (has_permission(organization_id, 'applicants.update'));
create policy "authorized_delete_candidate_credentials" on public.candidate_credentials for delete to authenticated
  using (has_permission(organization_id, 'applicants.update'));
alter policy "authorized_read_candidate_credentials" on public.candidate_credentials
  using ((deleted_at is null) and (has_permission(organization_id, 'applicants.read') or has_permission(organization_id, 'applicants.update')));

drop policy if exists "authorized_manage_candidate_onboarding" on public.candidate_onboarding;
create policy "authorized_insert_candidate_onboarding" on public.candidate_onboarding for insert to authenticated
  with check (has_permission(organization_id, 'applicants.update'));
create policy "authorized_update_candidate_onboarding" on public.candidate_onboarding for update to authenticated
  using (has_permission(organization_id, 'applicants.update')) with check (has_permission(organization_id, 'applicants.update'));
create policy "authorized_delete_candidate_onboarding" on public.candidate_onboarding for delete to authenticated
  using (has_permission(organization_id, 'applicants.update'));
alter policy "authorized_read_candidate_onboarding" on public.candidate_onboarding
  using (has_permission(organization_id, 'applicants.read') or has_permission(organization_id, 'applicants.update'));

drop policy if exists "authorized_manage_candidate_portal_tokens" on public.candidate_portal_tokens;
create policy "authorized_insert_candidate_portal_tokens" on public.candidate_portal_tokens for insert to authenticated
  with check (has_permission(organization_id, 'applicants.update'));
create policy "authorized_update_candidate_portal_tokens" on public.candidate_portal_tokens for update to authenticated
  using (has_permission(organization_id, 'applicants.update')) with check (has_permission(organization_id, 'applicants.update'));
create policy "authorized_delete_candidate_portal_tokens" on public.candidate_portal_tokens for delete to authenticated
  using (has_permission(organization_id, 'applicants.update'));
alter policy "authorized_read_candidate_portal_tokens" on public.candidate_portal_tokens
  using (has_permission(organization_id, 'applicants.read') or has_permission(organization_id, 'applicants.update'));

drop policy if exists "authorized_manage_candidate_stage_history" on public.candidate_stage_history;
create policy "authorized_insert_candidate_stage_history" on public.candidate_stage_history for insert to authenticated
  with check (has_permission(organization_id, 'applicants.update'));
create policy "authorized_update_candidate_stage_history" on public.candidate_stage_history for update to authenticated
  using (has_permission(organization_id, 'applicants.update')) with check (has_permission(organization_id, 'applicants.update'));
create policy "authorized_delete_candidate_stage_history" on public.candidate_stage_history for delete to authenticated
  using (has_permission(organization_id, 'applicants.update'));
alter policy "authorized_read_candidate_stage_history" on public.candidate_stage_history
  using (has_permission(organization_id, 'applicants.read') or has_permission(organization_id, 'applicants.update'));

drop policy if exists "authorized_manage_assignments" on public.caregiver_assignments;
create policy "authorized_insert_assignments" on public.caregiver_assignments for insert to authenticated
  with check (has_permission(organization_id, 'assignments.update'));
create policy "authorized_update_assignments" on public.caregiver_assignments for update to authenticated
  using (has_permission(organization_id, 'assignments.update')) with check (has_permission(organization_id, 'assignments.update'));
create policy "authorized_delete_assignments" on public.caregiver_assignments for delete to authenticated
  using (has_permission(organization_id, 'assignments.update'));
alter policy "caregivers_read_own_assignments" on public.caregiver_assignments
  using ((caregiver_user_id = (select auth.uid())) or has_permission(organization_id, 'assignments.read') or has_permission(organization_id, 'assignments.update'));

drop policy if exists "authorized_manage_availability" on public.caregiver_availability;
create policy "authorized_insert_availability" on public.caregiver_availability for insert to authenticated
  with check (has_permission(organization_id, 'membership.update'));
create policy "authorized_update_availability" on public.caregiver_availability for update to authenticated
  using (has_permission(organization_id, 'membership.update')) with check (has_permission(organization_id, 'membership.update'));
create policy "authorized_delete_availability" on public.caregiver_availability for delete to authenticated
  using (has_permission(organization_id, 'membership.update'));
alter policy "members_read_availability" on public.caregiver_availability
  using (has_permission(organization_id, 'membership.read') or has_permission(organization_id, 'membership.update') or ((caregiver_user_id = (select auth.uid())) and organization_is_active(organization_id)));

drop policy if exists "authorized_manage_caregiver_record_availability" on public.caregiver_record_availability;
create policy "authorized_insert_caregiver_record_availability" on public.caregiver_record_availability for insert to authenticated
  with check (has_permission(organization_id, 'membership.update'));
create policy "authorized_update_caregiver_record_availability" on public.caregiver_record_availability for update to authenticated
  using (has_permission(organization_id, 'membership.update')) with check (has_permission(organization_id, 'membership.update'));
create policy "authorized_delete_caregiver_record_availability" on public.caregiver_record_availability for delete to authenticated
  using (has_permission(organization_id, 'membership.update'));
alter policy "authorized_read_caregiver_record_availability" on public.caregiver_record_availability
  using (
    has_permission(organization_id, 'membership.read')
    or has_permission(organization_id, 'membership.update')
    or (organization_is_active(organization_id) and (exists (
      select 1 from public.caregiver_records cr
      where cr.id = caregiver_record_availability.caregiver_record_id and cr.linked_user_id = (select auth.uid())
    )))
  );

drop policy if exists "authorized_manage_caregiver_record_credentials" on public.caregiver_record_credentials;
create policy "authorized_insert_caregiver_record_credentials" on public.caregiver_record_credentials for insert to authenticated
  with check (has_permission(organization_id, 'credentials.update'));
create policy "authorized_update_caregiver_record_credentials" on public.caregiver_record_credentials for update to authenticated
  using (has_permission(organization_id, 'credentials.update')) with check (has_permission(organization_id, 'credentials.update'));
create policy "authorized_delete_caregiver_record_credentials" on public.caregiver_record_credentials for delete to authenticated
  using (has_permission(organization_id, 'credentials.update'));
alter policy "authorized_read_caregiver_record_credentials" on public.caregiver_record_credentials
  using (
    (deleted_at is null) and (
      has_permission(organization_id, 'credentials.read')
      or has_permission(organization_id, 'credentials.update')
      or (organization_is_active(organization_id) and (exists (
        select 1 from public.caregiver_records cr
        where cr.id = caregiver_record_credentials.caregiver_record_id and cr.linked_user_id = (select auth.uid())
      )))
    )
  );

drop policy if exists "authorized_manage_caregiver_records" on public.caregiver_records;
create policy "authorized_insert_caregiver_records" on public.caregiver_records for insert to authenticated
  with check (has_permission(organization_id, 'membership.update'));
create policy "authorized_update_caregiver_records" on public.caregiver_records for update to authenticated
  using (has_permission(organization_id, 'membership.update')) with check (has_permission(organization_id, 'membership.update'));
create policy "authorized_delete_caregiver_records" on public.caregiver_records for delete to authenticated
  using (has_permission(organization_id, 'membership.update'));
alter policy "authorized_read_caregiver_records" on public.caregiver_records
  using ((deleted_at is null) and (has_permission(organization_id, 'membership.read') or has_permission(organization_id, 'membership.update') or ((linked_user_id = (select auth.uid())) and organization_is_active(organization_id))));

drop policy if exists "authorized_manage_authorizations" on public.client_authorizations;
create policy "authorized_insert_authorizations" on public.client_authorizations for insert to authenticated
  with check (has_permission(organization_id, 'authorizations.update'));
create policy "authorized_update_authorizations" on public.client_authorizations for update to authenticated
  using (has_permission(organization_id, 'authorizations.update')) with check (has_permission(organization_id, 'authorizations.update'));
create policy "authorized_delete_authorizations" on public.client_authorizations for delete to authenticated
  using (has_permission(organization_id, 'authorizations.update'));
alter policy "members_read_authorizations" on public.client_authorizations
  using ((deleted_at is null) and (has_permission(organization_id, 'authorizations.read') or has_permission(organization_id, 'authorizations.update')));

drop policy if exists "authorized_manage_client_requested_schedule" on public.client_requested_schedule;
create policy "authorized_insert_client_requested_schedule" on public.client_requested_schedule for insert to authenticated
  with check (has_permission(organization_id, 'clients.update'));
create policy "authorized_update_client_requested_schedule" on public.client_requested_schedule for update to authenticated
  using (has_permission(organization_id, 'clients.update')) with check (has_permission(organization_id, 'clients.update'));
create policy "authorized_delete_client_requested_schedule" on public.client_requested_schedule for delete to authenticated
  using (has_permission(organization_id, 'clients.update'));
alter policy "authorized_read_client_requested_schedule" on public.client_requested_schedule
  using (has_permission(organization_id, 'clients.read') or has_permission(organization_id, 'clients.update'));

drop policy if exists "authorized_manage_client_requested_services" on public.client_requested_services;
create policy "authorized_insert_client_requested_services" on public.client_requested_services for insert to authenticated
  with check (has_permission(organization_id, 'clients.update'));
create policy "authorized_update_client_requested_services" on public.client_requested_services for update to authenticated
  using (has_permission(organization_id, 'clients.update')) with check (has_permission(organization_id, 'clients.update'));
create policy "authorized_delete_client_requested_services" on public.client_requested_services for delete to authenticated
  using (has_permission(organization_id, 'clients.update'));
alter policy "members_read_client_requested_services" on public.client_requested_services
  using (has_permission(organization_id, 'clients.read') or has_permission(organization_id, 'clients.update'));

drop policy if exists "authorized_manage_clients" on public.clients;
create policy "authorized_insert_clients" on public.clients for insert to authenticated
  with check (has_permission(organization_id, 'clients.update'));
create policy "authorized_update_clients" on public.clients for update to authenticated
  using (has_permission(organization_id, 'clients.update')) with check (has_permission(organization_id, 'clients.update'));
create policy "authorized_delete_clients" on public.clients for delete to authenticated
  using (has_permission(organization_id, 'clients.update'));
alter policy "members_read_clients" on public.clients
  using ((deleted_at is null) and (has_permission(organization_id, 'clients.read') or has_permission(organization_id, 'clients.update')));

drop policy if exists "manage_credential_types" on public.credential_types;
create policy "insert_credential_types" on public.credential_types for insert to authenticated
  with check ((organization_id is not null) and (has_permission(organization_id, 'credentials.update') or has_permission(organization_id, 'settings.update')));
create policy "update_credential_types" on public.credential_types for update to authenticated
  using ((organization_id is not null) and (has_permission(organization_id, 'credentials.update') or has_permission(organization_id, 'settings.update')))
  with check ((organization_id is not null) and (has_permission(organization_id, 'credentials.update') or has_permission(organization_id, 'settings.update')));
create policy "delete_credential_types" on public.credential_types for delete to authenticated
  using ((organization_id is not null) and (has_permission(organization_id, 'credentials.update') or has_permission(organization_id, 'settings.update')));
alter policy "read_credential_types" on public.credential_types
  using ((deleted_at is null) and ((organization_id is null) or has_permission(organization_id, 'credentials.read') or has_permission(organization_id, 'applicants.read') or has_permission(organization_id, 'credentials.update') or has_permission(organization_id, 'settings.update')));

drop policy if exists "authorized_manage_document_reminder_settings" on public.document_reminder_settings;
create policy "authorized_insert_document_reminder_settings" on public.document_reminder_settings for insert to authenticated
  with check (has_permission(organization_id, 'documents.manage'));
create policy "authorized_update_document_reminder_settings" on public.document_reminder_settings for update to authenticated
  using (has_permission(organization_id, 'documents.manage')) with check (has_permission(organization_id, 'documents.manage'));
create policy "authorized_delete_document_reminder_settings" on public.document_reminder_settings for delete to authenticated
  using (has_permission(organization_id, 'documents.manage'));
alter policy "read_document_reminder_settings" on public.document_reminder_settings
  using (has_permission(organization_id, 'documents.read') or has_permission(organization_id, 'documents.manage'));

drop policy if exists "authorized_manage_document_request_batches" on public.document_request_batches;
create policy "authorized_insert_document_request_batches" on public.document_request_batches for insert to authenticated
  with check (has_permission(organization_id, 'documents.manage'));
create policy "authorized_update_document_request_batches" on public.document_request_batches for update to authenticated
  using (has_permission(organization_id, 'documents.manage')) with check (has_permission(organization_id, 'documents.manage'));
create policy "authorized_delete_document_request_batches" on public.document_request_batches for delete to authenticated
  using (has_permission(organization_id, 'documents.manage'));
alter policy "read_document_request_batches" on public.document_request_batches
  using ((deleted_at is null) and (has_permission(organization_id, 'documents.read') or has_permission(organization_id, 'documents.manage')));

drop policy if exists "authorized_manage_document_requests" on public.document_requests;
create policy "authorized_insert_document_requests" on public.document_requests for insert to authenticated
  with check (has_permission(organization_id, 'documents.manage'));
create policy "authorized_update_document_requests" on public.document_requests for update to authenticated
  using (has_permission(organization_id, 'documents.manage')) with check (has_permission(organization_id, 'documents.manage'));
create policy "authorized_delete_document_requests" on public.document_requests for delete to authenticated
  using (has_permission(organization_id, 'documents.manage'));
alter policy "read_document_requests" on public.document_requests
  using (has_permission(organization_id, 'documents.read') or has_permission(organization_id, 'documents.manage'));

drop policy if exists "authorized_manage_document_types" on public.document_types;
create policy "authorized_insert_document_types" on public.document_types for insert to authenticated
  with check ((organization_id is not null) and has_permission(organization_id, 'documents.manage'));
create policy "authorized_update_document_types" on public.document_types for update to authenticated
  using ((organization_id is not null) and has_permission(organization_id, 'documents.manage'))
  with check ((organization_id is not null) and has_permission(organization_id, 'documents.manage'));
create policy "authorized_delete_document_types" on public.document_types for delete to authenticated
  using ((organization_id is not null) and has_permission(organization_id, 'documents.manage'));
alter policy "read_document_types" on public.document_types
  using ((deleted_at is null) and ((organization_id is null) or has_permission(organization_id, 'documents.read') or has_permission(organization_id, 'documents.manage')));

drop policy if exists "authorized_manage_incident_types" on public.incident_types;
create policy "authorized_insert_incident_types" on public.incident_types for insert to authenticated
  with check (has_permission(organization_id, 'incidents.update'));
create policy "authorized_update_incident_types" on public.incident_types for update to authenticated
  using (has_permission(organization_id, 'incidents.update')) with check (has_permission(organization_id, 'incidents.update'));
create policy "authorized_delete_incident_types" on public.incident_types for delete to authenticated
  using (has_permission(organization_id, 'incidents.update'));
alter policy "members_read_incident_types" on public.incident_types
  using ((deleted_at is null) and (has_permission(organization_id, 'incidents.read') or has_permission(organization_id, 'incidents.create') or has_permission(organization_id, 'incidents.update')));

drop policy if exists "authorized_manage_languages" on public.languages;
create policy "authorized_insert_languages" on public.languages for insert to authenticated
  with check (has_permission(organization_id, 'languages.update'));
create policy "authorized_update_languages" on public.languages for update to authenticated
  using (has_permission(organization_id, 'languages.update')) with check (has_permission(organization_id, 'languages.update'));
create policy "authorized_delete_languages" on public.languages for delete to authenticated
  using (has_permission(organization_id, 'languages.update'));
alter policy "members_read_languages" on public.languages
  using ((deleted_at is null) and (has_permission(organization_id, 'languages.read') or has_permission(organization_id, 'languages.update')));

drop policy if exists "manage_candidate_stage_settings" on public.organization_candidate_stage_settings;
create policy "insert_candidate_stage_settings" on public.organization_candidate_stage_settings for insert to authenticated
  with check (has_permission(organization_id, 'applicants.update') or has_permission(organization_id, 'settings.update'));
create policy "update_candidate_stage_settings" on public.organization_candidate_stage_settings for update to authenticated
  using (has_permission(organization_id, 'applicants.update') or has_permission(organization_id, 'settings.update'))
  with check (has_permission(organization_id, 'applicants.update') or has_permission(organization_id, 'settings.update'));
create policy "delete_candidate_stage_settings" on public.organization_candidate_stage_settings for delete to authenticated
  using (has_permission(organization_id, 'applicants.update') or has_permission(organization_id, 'settings.update'));
alter policy "read_candidate_stage_settings" on public.organization_candidate_stage_settings
  using (has_permission(organization_id, 'applicants.read') or has_permission(organization_id, 'applicants.update') or has_permission(organization_id, 'settings.update'));

drop policy if exists "manage_credential_requirements" on public.organization_credential_requirements;
create policy "insert_credential_requirements" on public.organization_credential_requirements for insert to authenticated
  with check (has_permission(organization_id, 'credentials.update') or has_permission(organization_id, 'settings.update'));
create policy "update_credential_requirements" on public.organization_credential_requirements for update to authenticated
  using (has_permission(organization_id, 'credentials.update') or has_permission(organization_id, 'settings.update'))
  with check (has_permission(organization_id, 'credentials.update') or has_permission(organization_id, 'settings.update'));
create policy "delete_credential_requirements" on public.organization_credential_requirements for delete to authenticated
  using (has_permission(organization_id, 'credentials.update') or has_permission(organization_id, 'settings.update'));
alter policy "read_credential_requirements" on public.organization_credential_requirements
  using (has_permission(organization_id, 'credentials.read') or has_permission(organization_id, 'applicants.read') or has_permission(organization_id, 'settings.read') or has_permission(organization_id, 'credentials.update') or has_permission(organization_id, 'settings.update'));

drop policy if exists "authorized_manage_services" on public.services;
create policy "authorized_insert_services" on public.services for insert to authenticated
  with check (has_permission(organization_id, 'services.update'));
create policy "authorized_update_services" on public.services for update to authenticated
  using (has_permission(organization_id, 'services.update')) with check (has_permission(organization_id, 'services.update'));
create policy "authorized_delete_services" on public.services for delete to authenticated
  using (has_permission(organization_id, 'services.update'));
alter policy "members_read_services" on public.services
  using ((deleted_at is null) and (has_permission(organization_id, 'services.read') or has_permission(organization_id, 'services.update')));

-- shifts: the ALL policy's with_check differs from its using clause
-- (adds a caregiver_record_id integrity check on write) - preserved
-- exactly, only the read fold uses the plain using-clause condition
-- (shifts.update permission), matching what actually gated SELECT
-- under the old ALL policy.
drop policy if exists "authorized_manage_shifts" on public.shifts;
create policy "authorized_insert_shifts" on public.shifts for insert to authenticated
  with check (has_permission(organization_id, 'shifts.update') and ((caregiver_record_id is null) or (exists (
    select 1 from public.caregiver_records cr
    where cr.id = shifts.caregiver_record_id and cr.organization_id = shifts.organization_id and cr.deleted_at is null
  ))));
create policy "authorized_update_shifts" on public.shifts for update to authenticated
  using (has_permission(organization_id, 'shifts.update'))
  with check (has_permission(organization_id, 'shifts.update') and ((caregiver_record_id is null) or (exists (
    select 1 from public.caregiver_records cr
    where cr.id = shifts.caregiver_record_id and cr.organization_id = shifts.organization_id and cr.deleted_at is null
  ))));
create policy "authorized_delete_shifts" on public.shifts for delete to authenticated
  using (has_permission(organization_id, 'shifts.update'));
alter policy "members_read_shifts" on public.shifts
  using (
    has_permission(organization_id, 'shifts.read')
    or has_permission(organization_id, 'shifts.update')
    or (caregiver_user_id = (select auth.uid()))
    or (exists (
      select 1 from public.caregiver_records cr
      where cr.id = shifts.caregiver_record_id and cr.organization_id = shifts.organization_id and cr.linked_user_id = (select auth.uid())
    ))
  );

drop policy if exists "authorized_manage_skills" on public.skills;
create policy "authorized_insert_skills" on public.skills for insert to authenticated
  with check (has_permission(organization_id, 'skills.update'));
create policy "authorized_update_skills" on public.skills for update to authenticated
  using (has_permission(organization_id, 'skills.update')) with check (has_permission(organization_id, 'skills.update'));
create policy "authorized_delete_skills" on public.skills for delete to authenticated
  using (has_permission(organization_id, 'skills.update'));
alter policy "members_read_skills" on public.skills
  using ((deleted_at is null) and (has_permission(organization_id, 'skills.read') or has_permission(organization_id, 'skills.update')));

-- === job_applicant_availability / job_applicant_services ===
-- Three-policy shape: an authenticated-only ALL (manage), an
-- anon+authenticated INSERT (the public application form, gated by
-- applicant_open_for_submission), and an authenticated SELECT (read).
--
-- First attempt at this folded the manage condition into the public
-- INSERT policy's with_check via OR, matching the SELECT-fold pattern
-- everywhere else in this migration. That's wrong here specifically:
-- has_permission() is NOT granted to the anon role (deliberately - see
-- docs/security-review-checklist.md), and this INSERT policy applies
-- to anon. Discovered by testing an anon insert against the folded
-- policy on the demo project: it failed with "permission denied for
-- function has_permission" instead of gracefully evaluating false,
-- which would have broken every real public application-form
-- submission the moment this shipped. Reverted before it ever reached
-- production.
--
-- Correct fix: leave public_submit_application_* completely untouched,
-- and add a separate authenticated-only INSERT policy for
-- has_permission-gated admin inserts. This leaves the INSERT-side
-- multiple_permissive_policies finding unresolved for these two tables
-- (2 of the 29) - an accepted, documented exception rather than a
-- security regression. The SELECT-side finding for both tables (ALL
-- vs SELECT, no anon involved) is still fixed below via the normal
-- fold.
create policy "authorized_update_applicant_availability" on public.job_applicant_availability for update to authenticated
  using (has_permission(organization_id, 'applicants.update')) with check (has_permission(organization_id, 'applicants.update'));
create policy "authorized_delete_applicant_availability" on public.job_applicant_availability for delete to authenticated
  using (has_permission(organization_id, 'applicants.update'));
create policy "authorized_insert_applicant_availability" on public.job_applicant_availability for insert to authenticated
  with check (has_permission(organization_id, 'applicants.update'));
drop policy if exists "authorized_manage_applicant_availability" on public.job_applicant_availability;
alter policy "authorized_read_applicant_availability" on public.job_applicant_availability
  using (has_permission(organization_id, 'applicants.read') or has_permission(organization_id, 'applicants.update'));

create policy "authorized_update_applicant_services" on public.job_applicant_services for update to authenticated
  using (has_permission(organization_id, 'applicants.update')) with check (has_permission(organization_id, 'applicants.update'));
create policy "authorized_delete_applicant_services" on public.job_applicant_services for delete to authenticated
  using (has_permission(organization_id, 'applicants.update'));
create policy "authorized_insert_applicant_services" on public.job_applicant_services for insert to authenticated
  with check (has_permission(organization_id, 'applicants.update'));
drop policy if exists "authorized_manage_applicant_services" on public.job_applicant_services;
alter policy "authorized_read_applicant_services" on public.job_applicant_services
  using (has_permission(organization_id, 'applicants.read') or has_permission(organization_id, 'applicants.update'));

commit;
