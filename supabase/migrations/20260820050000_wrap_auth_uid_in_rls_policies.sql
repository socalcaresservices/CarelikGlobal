begin;

-- Stage 4: Supabase's performance advisor flags 12 RLS policies that
-- call auth.uid() directly in their qual/with_check expression. Called
-- this way, Postgres re-evaluates auth.uid() once per row scanned;
-- wrapped as (select auth.uid()), the planner treats it as a stable
-- InitPlan and evaluates it once per query instead. Pure performance
-- fix - every policy's actual logic (what it allows/denies) is
-- byte-for-byte unchanged, only how the auth.uid() call is spelled.
-- Every USING/WITH CHECK clause below was copied verbatim from
-- production's live pg_policies before editing, not reconstructed from
-- memory or git history, specifically to guarantee no accidental logic
-- drift while making this change.

alter policy "caregivers_read_own_assignments" on public.caregiver_assignments
using ((caregiver_user_id = (select auth.uid())) OR has_permission(organization_id, 'assignments.read'::text));

alter policy "members_read_availability" on public.caregiver_availability
using (has_permission(organization_id, 'membership.read'::text) OR ((caregiver_user_id = (select auth.uid())) AND organization_is_active(organization_id)));

alter policy "authorized_read_caregiver_record_availability" on public.caregiver_record_availability
using (has_permission(organization_id, 'membership.read'::text) OR (organization_is_active(organization_id) AND (EXISTS ( SELECT 1
   FROM caregiver_records cr
  WHERE ((cr.id = caregiver_record_availability.caregiver_record_id) AND (cr.linked_user_id = (select auth.uid())))))));

alter policy "authorized_read_caregiver_record_credentials" on public.caregiver_record_credentials
using ((deleted_at IS NULL) AND (has_permission(organization_id, 'credentials.read'::text) OR (organization_is_active(organization_id) AND (EXISTS ( SELECT 1
   FROM caregiver_records cr
  WHERE ((cr.id = caregiver_record_credentials.caregiver_record_id) AND (cr.linked_user_id = (select auth.uid()))))))));

alter policy "authorized_read_caregiver_records" on public.caregiver_records
using ((deleted_at IS NULL) AND (has_permission(organization_id, 'membership.read'::text) OR ((linked_user_id = (select auth.uid())) AND organization_is_active(organization_id))));

alter policy "authorized_create_incidents" on public.incidents
with check (((has_permission(organization_id, 'incidents.create'::text) AND (reported_by = (select auth.uid()))) OR has_permission(organization_id, 'incidents.update'::text)));

alter policy "members_read_incidents" on public.incidents
using ((deleted_at IS NULL) AND (has_permission(organization_id, 'incidents.read'::text) OR (reported_by = (select auth.uid()))));

alter policy "members_read_service_visits" on public.service_visits
using (has_permission(organization_id, 'visits.read'::text) OR (caregiver_user_id = (select auth.uid())));

alter policy "members_read_shift_coverage_events" on public.shift_coverage_events
using (has_permission(organization_id, 'shifts.read'::text) OR (original_caregiver_user_id = (select auth.uid())) OR (replacement_caregiver_user_id = (select auth.uid())));

alter policy "members_read_shifts" on public.shifts
using (has_permission(organization_id, 'shifts.read'::text) OR (caregiver_user_id = (select auth.uid())) OR (EXISTS ( SELECT 1
   FROM caregiver_records cr
  WHERE ((cr.id = shifts.caregiver_record_id) AND (cr.organization_id = shifts.organization_id) AND (cr.linked_user_id = (select auth.uid()))))));

alter policy "read_support_access_grants" on public.support_access_grants
using ((grantee_user_id = (select auth.uid())) OR is_platform_owner() OR has_permission(organization_id, 'settings.read'::text));

alter policy "members_read_visit_signatures" on public.visit_signatures
using (has_permission(organization_id, 'visits.read'::text) OR (EXISTS ( SELECT 1
   FROM service_visits v
  WHERE ((v.id = visit_signatures.visit_id) AND (v.caregiver_user_id = (select auth.uid()))))));

commit;
