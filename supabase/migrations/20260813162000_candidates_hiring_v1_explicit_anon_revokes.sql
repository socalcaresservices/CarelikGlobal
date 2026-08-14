begin;

-- Supabase's anon and authenticated roles can retain direct grants even after
-- PUBLIC is revoked. Staff-only Candidate/Hiring RPCs must be denied to anon
-- explicitly. Token-scoped self-service RPCs intentionally remain callable by
-- anon and validate the high-entropy token inside each function.
revoke execute on function public.create_candidate_portal_link(uuid, uuid, integer) from anon;
revoke execute on function public.revoke_candidate_portal_link(uuid, uuid) from anon;
revoke execute on function public.create_manual_candidate(uuid, jsonb) from anon;
revoke execute on function public.preview_candidate_import(uuid, jsonb) from anon;
revoke execute on function public.import_candidates_v1(uuid, jsonb) from anon;
revoke execute on function public.list_candidate_pipeline_stages(uuid) from anon;
revoke execute on function public.list_candidates_v1(uuid) from anon;
revoke execute on function public.list_care_team_records(uuid) from anon;
revoke execute on function public.set_candidate_stage(uuid, uuid, text, text) from anon;
revoke execute on function public.upsert_candidate_onboarding(uuid, uuid, jsonb) from anon;
revoke execute on function public.transfer_candidate_to_care_team(uuid, uuid) from anon;
revoke execute on function public.link_caregiver_record_to_user(uuid, uuid, uuid) from anon;

commit;
