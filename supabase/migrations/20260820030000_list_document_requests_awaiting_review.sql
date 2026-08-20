begin;

-- Stage 3: the Command Center has no signal for document requests a
-- caregiver or candidate has uploaded but staff hasn't verified or
-- rejected yet. list_document_requests_for_subject already exists but
-- is scoped to one subject at a time (it powers the per-candidate
-- Documents card) - there's no organization-wide list an action-center
-- signal can filter/count against. This adds one, following the same
-- "uploaded or pending_review = awaiting review" convention already
-- established by list_candidate_portal_document_batches
-- (candidates_hiring_v1_completion) and the submission_status check
-- in candidates_hiring_v1.
create function public.list_document_requests_awaiting_review(target_organization_id uuid)
returns table (
  id uuid,
  batch_id uuid,
  subject_type public.document_request_subject_type,
  subject_id uuid,
  subject_name text,
  document_type_name text,
  status public.document_request_status,
  uploaded_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    dr.id,
    dr.batch_id,
    b.subject_type,
    b.subject_id,
    b.subject_name,
    dt.name,
    dr.status,
    dr.uploaded_at
  from public.document_requests dr
  join public.document_request_batches b on b.id = dr.batch_id
  join public.document_types dt on dt.id = dr.document_type_id
  where dr.organization_id = target_organization_id
    and b.deleted_at is null
    and dr.status in ('uploaded', 'pending_review')
    and public.has_permission(target_organization_id, 'documents.read')
  order by dr.uploaded_at nulls last;
$$;

revoke all on function public.list_document_requests_awaiting_review(uuid) from public;
grant execute on function public.list_document_requests_awaiting_review(uuid) to authenticated;
revoke execute on function public.list_document_requests_awaiting_review(uuid) from anon;

commit;
