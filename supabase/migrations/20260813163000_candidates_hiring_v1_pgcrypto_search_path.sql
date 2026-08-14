-- Candidate portal functions intentionally pin their search_path. pgcrypto is
-- installed in the trusted extensions schema on hosted Supabase, so include it
-- for environments where earlier Candidate/Hiring migrations are already
-- applied. Fresh installs also use explicitly qualified pgcrypto calls.

alter function public.create_candidate_portal_link(uuid, uuid, integer)
  set search_path = public, extensions;

alter function public.get_candidate_portal(text)
  set search_path = public, extensions;

alter function public.get_candidate_portal_requirements(text)
  set search_path = public, extensions;

alter function public.assert_candidate_portal_writable(text)
  set search_path = public, extensions;

alter function public.list_candidate_portal_document_batches(text)
  set search_path = public, extensions;
