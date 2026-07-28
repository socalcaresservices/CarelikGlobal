begin;

-- document_request_batches.reminders_sent/last_reminder_sent_at
-- (20260728060000_document_reminders.sql) are written by the now-
-- scheduled queue_document_reminders() cron job but were never read
-- back anywhere - staff had no way to see "3 reminders sent, last on
-- July 24" for an outstanding document request short of querying the
-- database directly. Same additive-columns-at-the-end pattern the file
-- viewing extension already used: CREATE OR REPLACE keeps the existing
-- 15 columns in place and appends 2.
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
  object_path text,
  batch_reminders_sent integer,
  batch_last_reminder_sent_at timestamptz
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
    f.object_path,
    b.reminders_sent,
    b.last_reminder_sent_at
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

commit;
