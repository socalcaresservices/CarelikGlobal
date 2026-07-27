begin;

-- Document Request Engine (Build 019): a centralized, configurable
-- system for requesting documents (CPR cert, TB test, driver license...)
-- from applicants, employees, contractors, and vendors, instead of every
-- workflow inventing its own ad-hoc upload field. Reuses the existing
-- public.files table + organization-documents storage bucket
-- (20260715000100) for the actual uploaded bytes - that table already
-- has owner_type/owner_id/document_type columns built for exactly this
-- polymorphic-attachment shape and has sat unused by the frontend, so
-- this build wires it up rather than inventing a parallel storage
-- record. A document_request's file_id points at a row there once
-- something is uploaded.
--
-- Scope of this build: the document type library, the request/status
-- schema, and an admin-facing "create a request batch" action that
-- generates a secure token. The actual public, unauthenticated upload
-- page that a token resolves to (white-labeled per organization),
-- automated reminders, and the approve/reject/replace verification
-- workflow are deliberately NOT part of this migration - they need
-- their own scoped build once this schema is in place to design against.

create type public.document_request_status as enum (
  'requested',
  'uploaded',
  'pending_review',
  'verified',
  'rejected',
  'expired',
  'missing',
  'replacement_requested'
);

create type public.document_request_subject_type as enum (
  'applicant',
  'employee',
  'contractor',
  'vendor',
  'organization_admin'
);

-- organization_id nullable, on purpose: null rows are platform-default
-- document types (seeded below, at the bottom of this migration),
-- readable by every organization but not editable by them - only an
-- organization's own non-null rows can be added to or deactivated from
-- the app. This is the one lookup-catalog table in this schema that
-- isn't purely org-scoped, because "Resume", "CPR Certification", "I-9"
-- etc. are the same concept everywhere, not something each of hundreds
-- of agencies should have to type in from scratch on day one.
create table public.document_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  name text not null,
  category text,
  requires_expiration boolean not null default false,
  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Only guards against duplicate *custom* names within one organization -
-- platform defaults (organization_id is null) are seeded once by this
-- migration and never through this index, since null <> null in a
-- unique index and duplicate-prevention for the seed list is handled by
-- this migration simply not repeating a name.
create unique index document_types_org_name_unique
  on public.document_types (organization_id, lower(name))
  where deleted_at is null and organization_id is not null;

create index document_types_org_idx on public.document_types (organization_id) where deleted_at is null;

create trigger document_types_set_updated_at
before update on public.document_types
for each row execute function public.set_updated_at();

create trigger document_types_audit
after insert or update or delete on public.document_types
for each row execute function public.write_audit_log();

alter table public.document_types enable row level security;

-- Platform defaults (organization_id is null) are visible to any
-- authenticated user regardless of org membership - they're not
-- sensitive, just a shared vocabulary. An organization's own custom
-- types still require documents.read for that organization.
create policy "read_document_types"
on public.document_types for select
to authenticated
using (
  deleted_at is null
  and (organization_id is null or public.has_permission(organization_id, 'documents.read'))
);

-- organization_id is not null in the using/check clauses so nobody can
-- edit or soft-delete a platform-default row through the app - has_
-- permission(null, ...) only ever returns true for a platform owner,
-- but this is belt-and-suspenders since there's no UI path that would
-- even try to send organization_id: null on an update.
create policy "authorized_manage_document_types"
on public.document_types for all
to authenticated
using (organization_id is not null and public.has_permission(organization_id, 'documents.manage'))
with check (organization_id is not null and public.has_permission(organization_id, 'documents.manage'));

-- One batch per "click Send" - one secure token covers every document
-- type selected in that request, so an applicant gets a single link
-- rather than one per document. subject_id is deliberately NOT a
-- foreign key: a subject can be an applicant (job_applicants.id), a
-- caregiver/employee (auth.users.id via organization_memberships), or
-- eventually a vendor/contractor with no table of its own yet -
-- validated at the application layer instead of the database layer,
-- same tradeoff files.owner_id already made for the same reason.
-- subject_name/subject_email are captured at request time so the batch
-- stays meaningful even if the underlying record changes or is deleted
-- later.
create table public.document_request_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  subject_type public.document_request_subject_type not null,
  subject_id uuid,
  subject_name text not null,
  subject_email text,
  token text not null,
  message text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  deleted_at timestamptz,
  unique (token)
);

create index document_request_batches_org_idx
  on public.document_request_batches (organization_id) where deleted_at is null;
create index document_request_batches_subject_idx
  on public.document_request_batches (organization_id, subject_id) where deleted_at is null;

create trigger document_request_batches_audit
after insert or update or delete on public.document_request_batches
for each row execute function public.write_audit_log();

alter table public.document_request_batches enable row level security;

create policy "read_document_request_batches"
on public.document_request_batches for select
to authenticated
using (deleted_at is null and public.has_permission(organization_id, 'documents.read'));

create policy "authorized_manage_document_request_batches"
on public.document_request_batches for all
to authenticated
using (public.has_permission(organization_id, 'documents.manage'))
with check (public.has_permission(organization_id, 'documents.manage'));

-- organization_id is denormalized from the batch onto every request row
-- (rather than requiring a join for RLS) - same convention shifts.
-- service_id/client_authorizations.service_id already follow for the
-- same reason: RLS predicates that don't need a subquery are cheaper
-- and simpler to reason about.
create table public.document_requests (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.document_request_batches(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  document_type_id uuid not null references public.document_types(id),
  status public.document_request_status not null default 'requested',
  file_id uuid references public.files(id),
  uploaded_at timestamptz,
  expires_at date,
  verified_by uuid references auth.users(id),
  verified_at timestamptz,
  rejection_reason text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index document_requests_batch_idx on public.document_requests (batch_id);
create index document_requests_org_idx on public.document_requests (organization_id);
create index document_requests_status_idx on public.document_requests (organization_id, status);

create trigger document_requests_set_updated_at
before update on public.document_requests
for each row execute function public.set_updated_at();

create trigger document_requests_audit
after insert or update or delete on public.document_requests
for each row execute function public.write_audit_log();

alter table public.document_requests enable row level security;

create policy "read_document_requests"
on public.document_requests for select
to authenticated
using (public.has_permission(organization_id, 'documents.read'));

create policy "authorized_manage_document_requests"
on public.document_requests for all
to authenticated
using (public.has_permission(organization_id, 'documents.manage'))
with check (public.has_permission(organization_id, 'documents.manage'));

insert into public.permissions (key, description) values
  ('documents.read', 'View the document type library and document requests'),
  ('documents.manage', 'Configure document types and send/verify document requests');

insert into public.role_permissions (role, permission_key)
select role_value, new_permissions.key
from (
  values
    ('organization_owner'::public.system_role),
    ('organization_admin'::public.system_role),
    ('manager'::public.system_role),
    ('coordinator'::public.system_role)
) roles(role_value)
cross join (
  select key from public.permissions
  where key in ('documents.read', 'documents.manage')
) new_permissions;

insert into public.role_permissions (role, permission_key) values
  ('read_only', 'documents.read');

-- create_document_request_batch: the one "click Send" action - creates
-- the batch and every requested document_requests row atomically, and
-- hands back the token so the caller can build the shareable link. The
-- token is a random 32-char hex string produced from gen_random_uuid()
-- (128 bits, no dashes) - not the short human-typeable code shown in
-- the product brief's example, since a code short enough to type is
-- also short enough to be guessed/enumerated, and this is a bearer link
-- meant to be shared as a URL/QR code, not manually keyed in.
create function public.create_document_request_batch(
  target_organization_id uuid,
  target_subject_type public.document_request_subject_type,
  target_subject_id uuid,
  target_subject_name text,
  target_subject_email text,
  target_document_type_ids uuid[],
  target_message text default null
)
returns table (batch_id uuid, token text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch_id uuid;
  v_token text;
begin
  if not public.has_permission(target_organization_id, 'documents.manage') then
    raise exception 'You do not have permission to request documents for this organization';
  end if;

  if target_subject_name is null or btrim(target_subject_name) = '' then
    raise exception 'A subject name is required';
  end if;

  if target_document_type_ids is null or array_length(target_document_type_ids, 1) is null then
    raise exception 'Select at least one document to request';
  end if;

  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  insert into public.document_request_batches (
    organization_id, subject_type, subject_id, subject_name, subject_email, token, message, created_by
  ) values (
    target_organization_id, target_subject_type, target_subject_id,
    btrim(target_subject_name), nullif(btrim(coalesce(target_subject_email, '')), ''),
    v_token, nullif(btrim(coalesce(target_message, '')), ''), auth.uid()
  )
  returning id into v_batch_id;

  insert into public.document_requests (batch_id, organization_id, document_type_id)
  select distinct v_batch_id, target_organization_id, dt_id
  from unnest(target_document_type_ids) as dt_id;

  return query select v_batch_id, v_token;
end;
$$;

revoke all on function public.create_document_request_batch(uuid, public.document_request_subject_type, uuid, text, text, uuid[], text) from public;
grant execute on function public.create_document_request_batch(uuid, public.document_request_subject_type, uuid, text, text, uuid[], text) to authenticated;
revoke execute on function public.create_document_request_batch(uuid, public.document_request_subject_type, uuid, text, text, uuid[], text) from anon;

-- list_document_requests_for_subject: every document_requests row for
-- one subject (e.g. one applicant), flattened with the document type
-- name and the batch's token/created_at, so a detail page can render a
-- single status list without a second round trip per batch.
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
  batch_created_at timestamptz
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
    b.created_at
  from public.document_requests dr
  join public.document_types dt on dt.id = dr.document_type_id
  join public.document_request_batches b on b.id = dr.batch_id
  where dr.organization_id = target_organization_id
    and b.subject_id = target_subject_id
    and b.deleted_at is null
    and public.has_permission(target_organization_id, 'documents.read')
  order by b.created_at desc, dt.name;
$$;

revoke all on function public.list_document_requests_for_subject(uuid, uuid) from public;
grant execute on function public.list_document_requests_for_subject(uuid, uuid) to authenticated;
revoke execute on function public.list_document_requests_for_subject(uuid, uuid) from anon;

-- Seed platform-default document types (organization_id null) from the
-- product brief's list - every organization can request any of these
-- immediately, and can still add its own custom types on top.
insert into public.document_types (organization_id, name, category, requires_expiration) values
  (null, 'Resume', 'application', false),
  (null, 'CPR Certification', 'certification', true),
  (null, 'First Aid Certification', 'certification', true),
  (null, 'TB Test', 'medical', true),
  (null, 'Background Check', 'background', false),
  (null, 'Live Scan', 'background', false),
  (null, 'Driver License', 'identity', true),
  (null, 'Auto Insurance', 'insurance', true),
  (null, 'Social Security Card', 'identity', false),
  (null, 'Passport', 'identity', true),
  (null, 'State Identification Card', 'identity', true),
  (null, 'Work Authorization', 'identity', false),
  (null, 'I-9', 'tax', false),
  (null, 'W-4', 'tax', false),
  (null, 'Direct Deposit Form', 'payroll', false),
  (null, 'Professional License', 'license', true),
  (null, 'Vehicle Registration', 'license', true),
  (null, 'Fingerprint Clearance', 'background', false),
  (null, 'HIPAA Acknowledgement', 'compliance', false),
  (null, 'Employee Handbook Acknowledgement', 'compliance', false),
  (null, 'Confidentiality Agreement', 'compliance', false),
  (null, 'Emergency Contact Form', 'contact', false),
  (null, 'Training Certificates', 'certification', true);

commit;
