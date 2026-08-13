begin;

-- Internal SECURITY DEFINER helpers are invoked only by other database
-- functions. Browser clients must use the permission-checked public RPCs.
revoke all on function public.assert_candidate_portal_writable(text) from anon, authenticated;
revoke all on function public.revoke_candidate_portal_links_for_applicant(uuid, uuid) from anon, authenticated;

commit;
