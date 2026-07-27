begin;

-- Build 021: the public upload page and verification workflow the Build
-- 019 migration explicitly deferred. Three pieces:
--
-- 1) Two narrow anon-callable RPCs that resolve a bearer token to the
--    batch's branding/subject info and its document list - same pattern
--    as get_organization_by_slug/list_public_organization_services on
--    the ApplyPage, so an unauthenticated applicant can see what's being
--    asked of them without any table being opened to anon directly.
-- 2) files.uploaded_by becomes nullable: a public, token-based upload has
--    no authenticated user to attribute it to. Existing authenticated
--    upload paths are unaffected - members_create_files still requires
--    uploaded_by = auth.uid() on that policy's own insert path.
-- 3) A storage read policy + two verify/reject RPCs so staff with
--    documents.read/documents.manage can view an uploaded file and act
--    on it, without needing the separate files.read permission that
--    predates this feature.

alter table public.files alter column uploaded_by drop not null;

-- get_document_request_batch: resolves a token to the batch's org
-- branding + subject info. Returns nothing for an unknown, deleted, or
-- expired token - the frontend treats an empty result as "invalid link"
-- without distinguishing why, so this doesn't leak which case applies.
create function public.get_document_request_batch(target_token text)
returns table (
  batch_id uuid,
  organization_id uuid,
  organization_display_name text,
  organization_logo_url text,
  organization_primary_color text,
  subject_name text,
  message text,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    b.id,
    b.organization_id,
    o.display_name,
    o.logo_url,
    o.primary_color,
    b.subject_name,
    b.message,
    b.expires_at
  from public.document_request_batches b
  join public.organizations o on o.id = b.organization_id
  where b.token = target_token
    and b.deleted_at is null
    and (b.expires_at is null or b.expires_at > now());
$$;

revoke all on function public.get_document_request_batch(text) from public;
grant execute on function public.get_document_request_batch(text) to anon, authenticated;

-- list_document_requests_for_token: the batch's document list for the
-- upload page itself. Same token-scoping as above - no permission check
-- because there is no caller identity to check, only proof of possession
-- of the bearer token.
create function public.list_document_requests_for_token(target_token text)
returns table (
  id uuid,
  document_type_name text,
  category text,
  requires_expiration boolean,
  status public.document_request_status,
  uploaded_at timestamptz,
  rejection_reason text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    dr.id,
    dt.name,
    dt.category,
    dt.requires_expiration,
    dr.status,
    dr.uploaded_at,
    dr.rejection_reason
  from public.document_requests dr
  join public.document_types dt on dt.id = dr.document_type_id
  join public.document_request_batches b on b.id = dr.batch_id
  where b.token = target_token
    and b.deleted_at is null
    and (b.expires_at is null or b.expires_at > now())
  order by dt.name;
$$;

revoke all on function public.list_document_requests_for_token(text) from public;
grant execute on function public.list_document_requests_for_token(text) to anon, authenticated;

-- Extend the staff-facing list with the uploaded file's storage
-- reference, so DocumentsCard can request a signed URL to view it.
-- CREATE OR REPLACE keeps the existing 11 columns in place and appends
-- three - safe for the one caller (DocumentsCard) since Postgres
-- function return-type changes require the additive columns go last.
drop function if exists public.list_document_requests_for_subject(uuid, uuid);

create function public.list_document_requests_for_subject(
  target_organization_id uuid,
  target_subject_id uuid
)
returns table (
  id uuid,
  batch_id uuid,
  document_type_id uuid,
  document_type_name text,
  status public.document_request_status,
  uploaded_at timestamptz,
  expires_at date,
  verified_at timestamptz,
  rejection_reason text,
  notes text,
  batch_token text,
  batch_created_at timestamptz,
  file_id uuid,
  bucket_id text,
  object_path text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    dr.id,
    dr.batch_id,
    dr.document_type_id,
    dt.name,
    dr.status,
    dr.uploaded_at,
    dr.expires_at,
    dr.verified_at,
    dr.rejection_reason,
    dr.notes,
    b.token,
    b.created_at,
    f.id,
    f.bucket_id,
    f.object_path
  from public.document_requests dr
  join public.document_types dt on dt.id = dr.document_type_id
  join public.document_request_batches b on b.id = dr.batch_id
  left join public.files f on f.id = dr.file_id
  where dr.organization_id = target_organization_id
    and b.subject_id = target_subject_id
    and b.deleted_at is null
    and public.has_permission(target_organization_id, 'documents.read')
  order by b.created_at desc, dt.name;
$$;

revoke all on function public.list_document_requests_for_subject(uuid, uuid) from public;
grant execute on function public.list_document_requests_for_subject(uuid, uuid) to authenticated;
revoke execute on function public.list_document_requests_for_subject(uuid, uuid) from anon;

-- Lets anyone with documents.read/documents.manage view an uploaded file
-- without also needing the separate files.read permission that predates
-- this feature and is scoped to a different admin surface (the general
-- file library, not document requests specifically).
create policy "document_reviewers_read_storage" on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'organization-documents'
    and (
      public.has_permission((nullif((storage.foldername(name))[1], ''))::uuid, 'documents.read')
      or public.has_permission((nullif((storage.foldername(name))[1], ''))::uuid, 'documents.manage')
    )
  );

-- verify_document_request / reject_document_request: set verified_by
-- from auth.uid() server-side rather than trusting a client-supplied
-- value, same reasoning as every other set_* function in this schema.
-- Rejecting clears uploaded_at/file_id so the upload page correctly
-- treats the request as awaiting a fresh upload rather than showing a
-- stale "already uploaded" file reference next to the rejection reason.
create function public.verify_document_request(
  target_organization_id uuid,
  target_document_request_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission(target_organization_id, 'documents.manage') then
    raise exception 'You do not have permission to verify documents for this organization';
  end if;

  update public.document_requests
  set status = 'verified',
      verified_by = auth.uid(),
      verified_at = now(),
      rejection_reason = null
  where id = target_document_request_id
    and organization_id = target_organization_id;

  if not found then
    raise exception 'No document request found for that organization';
  end if;
end;
$$;

create function public.reject_document_request(
  target_organization_id uuid,
  target_document_request_id uuid,
  reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission(target_organization_id, 'documents.manage') then
    raise exception 'You do not have permission to reject documents for this organization';
  end if;

  if reason is null or btrim(reason) = '' then
    raise exception 'A rejection reason is required';
  end if;

  update public.document_requests
  set status = 'rejected',
      verified_by = auth.uid(),
      verified_at = now(),
      rejection_reason = btrim(reason)
  where id = target_document_request_id
    and organization_id = target_organization_id;

  if not found then
    raise exception 'No document request found for that organization';
  end if;
end;
$$;

revoke all on function public.verify_document_request(uuid, uuid) from public, anon;
grant execute on function public.verify_document_request(uuid, uuid) to authenticated;

revoke all on function public.reject_document_request(uuid, uuid, text) from public, anon;
grant execute on function public.reject_document_request(uuid, uuid, text) to authenticated;

commit;
