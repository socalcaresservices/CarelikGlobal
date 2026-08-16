-- Supabase projects created after the 2026 Data API privilege change no longer
-- expose new public tables automatically. RLS remains the authorization layer,
-- while these grants expose only the operations used by the authenticated web
-- application. Public candidate workflows continue to use guarded RPCs.

revoke all on table public.candidate_stage_history from anon;
revoke all on table public.candidate_portal_tokens from anon;
revoke all on table public.candidate_credentials from anon;
revoke all on table public.candidate_onboarding from anon;
revoke all on table public.caregiver_records from anon;
revoke all on table public.caregiver_record_availability from anon;
revoke all on table public.caregiver_record_credentials from anon;
revoke all on table public.credential_types from anon;
revoke all on table public.organization_credential_requirements from anon;
revoke all on table public.organization_candidate_stage_settings from anon;
revoke all on table public.client_requested_schedule from anon;

grant select on table public.candidate_stage_history to authenticated;
grant select on table public.candidate_portal_tokens to authenticated;
grant select, update on table public.candidate_credentials to authenticated;
grant select on table public.candidate_onboarding to authenticated;
grant select, insert, update on table public.caregiver_records to authenticated;
grant select on table public.caregiver_record_availability to authenticated;
grant select, insert on table public.caregiver_record_credentials to authenticated;
grant select on table public.client_requested_schedule to authenticated;

-- These configuration tables currently sit behind SECURITY DEFINER RPCs. Keep
-- direct Data API access closed so future UI changes cannot bypass those checks.
revoke all on table public.credential_types from authenticated;
revoke all on table public.organization_credential_requirements from authenticated;
revoke all on table public.organization_candidate_stage_settings from authenticated;
