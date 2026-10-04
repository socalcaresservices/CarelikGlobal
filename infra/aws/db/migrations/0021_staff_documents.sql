-- 0021 Minimal Documents & Compliance: staff credential documents.
-- Owner decision 2026-10-03 (docs/product/OGEVIA_UX_CHANGE_LIST.md,
-- "Minimal Documents and Compliance module"). Initial scope: staff
-- (Care Team) documents such as TB, CPR, First Aid and training, requested
-- by the agency, uploaded from a phone, reviewed by a manager.
--
--   * document_types: configurable per agency. Expiry is required only when
--     the agency says so for that type; nothing is assumed (no blanket annual
--     TB / 24-month CPR rule). Sensitive identity/tax/payroll types are not
--     part of this module.
--   * staff_documents: one requested document per caregiver record and type
--     (one open request at a time), with its due date.
--   * document_versions: every upload is a new version, kept forever
--     (append-only; only the one-time review fields are set later). The file
--     lives in the private evidence bucket under
--     {organization_id}/documents/{document_id}/{version_id}; the database
--     holds only metadata (type, size, SHA-256, S3 version id).
--   * Status vocabulary (derived, never stored twice): Requested, Uploaded -
--     awaiting review, Verified, Rejected, plus Expiring / Expired from the
--     actual expiry date and Overdue from the due date, in agency local time.
--     Uploaded never means verified.
--   * Permissions: documents.read / documents.manage (owner, manager);
--     documents.manage_own (caregiver: own requested documents only).
--     Scheduler: none, until Scheduler access is defined.
--   * Viewing a file is audited (document.viewed).

insert into ogevia.permissions (key, description) values
  ('documents.read', 'View staff documents and their files'),
  ('documents.manage', 'Request, review and configure staff documents'),
  ('documents.manage_own', 'Upload and view your own requested documents');
insert into ogevia.role_permissions (role, permission_key) values
  ('organization_owner', 'documents.read'),
  ('organization_owner', 'documents.manage'),
  ('manager', 'documents.read'),
  ('manager', 'documents.manage'),
  ('caregiver', 'documents.manage_own');

create type ogevia.document_review_status as enum ('awaiting_review', 'verified', 'rejected');

create table ogevia.document_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  name text not null check (length(btrim(name)) between 2 and 80),
  requires_expiry boolean not null default false,
  is_active boolean not null default true,
  created_by uuid not null references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index document_types_org_name_unique on ogevia.document_types (organization_id, lower(btrim(name)));

create table ogevia.staff_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  caregiver_record_id uuid not null,
  document_type_id uuid not null,
  due_on date,
  requested_by uuid not null references ogevia.app_users(id),
  requested_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (id, organization_id),
  foreign key (caregiver_record_id, organization_id) references ogevia.caregiver_records (id, organization_id),
  foreign key (document_type_id, organization_id) references ogevia.document_types (id, organization_id)
);
-- One open request per person and type; a replacement is a new version of it.
create unique index staff_documents_one_open
  on ogevia.staff_documents (caregiver_record_id, document_type_id) where closed_at is null;
create index staff_documents_org_idx on ogevia.staff_documents (organization_id);

create table ogevia.document_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  document_id uuid not null,
  version_number integer not null check (version_number >= 1),
  object_key text not null unique,
  s3_version_id text,
  content_type text not null check (content_type in ('application/pdf', 'image/jpeg', 'image/png')),
  byte_size integer not null check (byte_size between 1 and 4000000),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  issued_on date,
  expires_on date,
  uploaded_by uuid not null references ogevia.app_users(id),
  uploaded_at timestamptz not null default now(),
  review_status ogevia.document_review_status not null default 'awaiting_review',
  reviewed_by uuid references ogevia.app_users(id),
  reviewed_at timestamptz,
  rejection_reason text,
  unique (document_id, version_number),
  foreign key (document_id, organization_id) references ogevia.staff_documents (id, organization_id),
  constraint document_versions_dates check (expires_on is null or issued_on is null or expires_on > issued_on),
  constraint document_versions_review_shape check (
    (review_status = 'awaiting_review' and reviewed_by is null and reviewed_at is null and rejection_reason is null)
    or (review_status = 'verified' and reviewed_by is not null and reviewed_at is not null and rejection_reason is null)
    or (review_status = 'rejected' and reviewed_by is not null and reviewed_at is not null
        and length(btrim(coalesce(rejection_reason, ''))) > 0)
  )
);

-- Versions are append-only; the review may be recorded exactly once.
create function ogevia.document_versions_guard_update()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  if old.review_status <> 'awaiting_review' then
    raise exception 'This document version has already been reviewed' using errcode = 'OGC09';
  end if;
  if (to_jsonb(new) - array['review_status', 'reviewed_by', 'reviewed_at', 'rejection_reason'])
     is distinct from (to_jsonb(old) - array['review_status', 'reviewed_by', 'reviewed_at', 'rejection_reason']) then
    raise exception 'Document versions are append-only; upload a new version instead' using errcode = 'OGC09';
  end if;
  return new;
end;
$$;
create trigger document_versions_guard_update before update on ogevia.document_versions
for each row execute function ogevia.document_versions_guard_update();
create trigger document_versions_no_delete before delete on ogevia.document_versions
for each row execute function ogevia.forbid_delete();
create trigger staff_documents_no_delete before delete on ogevia.staff_documents
for each row execute function ogevia.forbid_delete();

alter table ogevia.document_types enable row level security;
alter table ogevia.staff_documents enable row level security;
alter table ogevia.document_versions enable row level security;
create policy readonly_select on ogevia.document_types for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.staff_documents for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.document_versions for select to ogevia_readonly using (true);
grant select on ogevia.document_types, ogevia.staff_documents, ogevia.document_versions to ogevia_readonly;

-- The caller's own active Care Team record in this agency (null if none).
create function ogevia.my_caregiver_record(p_organization_id uuid)
returns uuid
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select r.id from ogevia.caregiver_records r
  where r.organization_id = p_organization_id
    and r.linked_user_id = ogevia.current_user_id()
    and r.deleted_at is null
  limit 1;
$$;

-- May the caller see/upload for this document? Managers: any in their
-- agency (documents.read / documents.manage). Caregivers: only their own.
create function ogevia.document_access(p_document_id uuid, p_write boolean)
returns ogevia.staff_documents
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  d ogevia.staff_documents%rowtype;
begin
  select * into d from ogevia.staff_documents where id = p_document_id;
  if d.id is null or not ogevia.is_active_member(d.organization_id) then
    raise exception 'Document not found' using errcode = 'OGN04';
  end if;
  if ogevia.has_permission(d.organization_id, case when p_write then 'documents.manage' else 'documents.read' end) then
    return d;
  end if;
  if ogevia.has_permission(d.organization_id, 'documents.manage_own')
     and d.caregiver_record_id = ogevia.my_caregiver_record(d.organization_id) then
    return d;
  end if;
  raise exception 'Document not found' using errcode = 'OGN04';
end;
$$;

create function ogevia_api.create_document_type(
  p_organization_id uuid, p_name text, p_requires_expiry boolean, p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_fp text := concat_ws('|', p_organization_id, lower(btrim(coalesce(p_name, ''))), coalesce(p_requires_expiry, false));
  v_prior jsonb;
  v_id uuid;
begin
  if not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'documents.manage') then
    raise exception 'You do not have permission to configure documents' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('create_document_type', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return (v_prior ->> 'id')::uuid; end if;
  if length(btrim(coalesce(p_name, ''))) not between 2 and 80 then
    raise exception 'Enter a document type name between 2 and 80 characters' using errcode = 'OGV22';
  end if;
  if exists (select 1 from ogevia.document_types t where t.organization_id = p_organization_id and lower(btrim(t.name)) = lower(btrim(p_name))) then
    raise exception 'That document type already exists' using errcode = 'OGC09';
  end if;
  insert into ogevia.document_types (organization_id, name, requires_expiry, created_by)
  values (p_organization_id, btrim(p_name), coalesce(p_requires_expiry, false), v_actor) returning id into v_id;
  perform ogevia.write_audit(p_organization_id, 'document_type.created', 'document_types', v_id, null,
    jsonb_build_object('name', btrim(p_name), 'requires_expiry', coalesce(p_requires_expiry, false)), null);
  perform ogevia.idempotency_finish('create_document_type', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('id', v_id));
  return v_id;
end;
$$;

create function ogevia_api.list_document_types(p_organization_id uuid)
returns table (document_type_id uuid, name text, requires_expiry boolean, is_active boolean)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select t.id, t.name, t.requires_expiry, t.is_active
  from ogevia.document_types t
  where t.organization_id = p_organization_id
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and (ogevia.has_permission(p_organization_id, 'documents.read') or ogevia.has_permission(p_organization_id, 'documents.manage_own'))
  order by t.name;
$$;

-- People a document can be requested from (managers only).
create function ogevia_api.list_document_people(p_organization_id uuid)
returns table (caregiver_record_id uuid, display_name text, caregiver_code text)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select r.id, coalesce(nullif(btrim(r.preferred_name), ''), r.first_name) || ' ' || r.last_name, r.caregiver_code
  from ogevia.caregiver_records r
  where r.organization_id = p_organization_id
    and r.deleted_at is null and r.status <> 'inactive'
    and ogevia.require_actor() is not null
    and ogevia.is_active_member(p_organization_id)
    and ogevia.has_permission(p_organization_id, 'documents.read')
  order by 2;
$$;

create function ogevia_api.request_staff_document(
  p_organization_id uuid, p_caregiver_record_id uuid, p_document_type_id uuid, p_due_on date, p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_fp text := concat_ws('|', p_organization_id, p_caregiver_record_id, p_document_type_id, p_due_on);
  v_prior jsonb;
  v_id uuid;
begin
  if not ogevia.is_active_member(p_organization_id) then
    raise exception 'Organization not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(p_organization_id, 'documents.manage') then
    raise exception 'You do not have permission to request documents' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('request_staff_document', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return (v_prior ->> 'id')::uuid; end if;
  if not exists (select 1 from ogevia.caregiver_records r where r.id = p_caregiver_record_id and r.organization_id = p_organization_id and r.deleted_at is null) then
    raise exception 'Care Team member not found' using errcode = 'OGN04';
  end if;
  if not exists (select 1 from ogevia.document_types t where t.id = p_document_type_id and t.organization_id = p_organization_id and t.is_active) then
    raise exception 'Document type not found' using errcode = 'OGN04';
  end if;
  if exists (select 1 from ogevia.staff_documents d where d.caregiver_record_id = p_caregiver_record_id
             and d.document_type_id = p_document_type_id and d.closed_at is null) then
    raise exception 'This document is already requested for this person' using errcode = 'OGC09';
  end if;
  insert into ogevia.staff_documents (organization_id, caregiver_record_id, document_type_id, due_on, requested_by)
  values (p_organization_id, p_caregiver_record_id, p_document_type_id, p_due_on, v_actor) returning id into v_id;
  perform ogevia.write_audit(p_organization_id, 'document.requested', 'staff_documents', v_id, null,
    jsonb_build_object('caregiver_record_id', p_caregiver_record_id, 'document_type_id', p_document_type_id, 'due_on', p_due_on), null);
  perform ogevia.idempotency_finish('request_staff_document', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('id', v_id));
  return v_id;
end;
$$;

-- Managers: every document in the agency. Caregivers: their own only.
-- display_status is derived in agency local time:
--   requested | overdue | awaiting_review | rejected | verified | expiring | expired
create function ogevia_api.list_staff_documents(p_organization_id uuid, p_expiring_window_days integer default 30)
returns table (
  document_id uuid,
  caregiver_record_id uuid,
  person_name text,
  document_type_id uuid,
  document_type_name text,
  requires_expiry boolean,
  due_on date,
  requested_at timestamptz,
  latest_version_id uuid,
  latest_version_number integer,
  latest_content_type text,
  latest_uploaded_at timestamptz,
  latest_review_status ogevia.document_review_status,
  latest_rejection_reason text,
  issued_on date,
  expires_on date,
  verified_expires_on date,
  display_status text,
  days_until integer
)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  with ctx as (
    select ogevia.require_actor() as actor,
           ogevia.is_active_member(p_organization_id) as member,
           ogevia.has_permission(p_organization_id, 'documents.read') as can_all,
           ogevia.has_permission(p_organization_id, 'documents.manage_own') as can_own,
           ogevia.my_caregiver_record(p_organization_id) as own_record,
           ogevia.organization_local_date(p_organization_id, now()) as today
  ), docs as (
    select d.*, t.name as type_name, t.requires_expiry,
           coalesce(nullif(btrim(r.preferred_name), ''), r.first_name) || ' ' || r.last_name as person,
           lv.id as v_id, lv.version_number as v_no, lv.content_type as v_type, lv.uploaded_at as v_at,
           lv.review_status as v_status, lv.rejection_reason as v_reason, lv.issued_on as v_issued, lv.expires_on as v_expires,
           (select vv.expires_on from ogevia.document_versions vv where vv.document_id = d.id and vv.review_status = 'verified'
            order by vv.version_number desc limit 1) as verified_expires,
           exists (select 1 from ogevia.document_versions vv where vv.document_id = d.id and vv.review_status = 'verified') as any_verified
    from ctx
    join ogevia.staff_documents d on d.organization_id = p_organization_id and d.closed_at is null
    join ogevia.document_types t on t.id = d.document_type_id
    join ogevia.caregiver_records r on r.id = d.caregiver_record_id
    left join lateral (
      select v.* from ogevia.document_versions v where v.document_id = d.id order by v.version_number desc limit 1
    ) lv on true
    where ctx.actor is not null and ctx.member
      and (ctx.can_all or (ctx.can_own and d.caregiver_record_id = ctx.own_record))
  )
  select docs.id, docs.caregiver_record_id, docs.person, docs.document_type_id, docs.type_name, docs.requires_expiry,
         docs.due_on, docs.requested_at, docs.v_id, docs.v_no, docs.v_type, docs.v_at, docs.v_status, docs.v_reason,
         docs.v_issued, docs.v_expires, docs.verified_expires,
         case
           when docs.v_status = 'awaiting_review' then 'awaiting_review'
           when docs.verified_expires is not null and docs.verified_expires < ctx.today then 'expired'
           when docs.verified_expires is not null and docs.verified_expires <= ctx.today + p_expiring_window_days then 'expiring'
           when docs.any_verified then 'verified'
           when docs.v_status = 'rejected' then 'rejected'
           when docs.due_on is not null and docs.due_on < ctx.today then 'overdue'
           else 'requested'
         end,
         case
           when docs.verified_expires is not null then docs.verified_expires - ctx.today
           when docs.due_on is not null and not docs.any_verified then docs.due_on - ctx.today
         end
  from docs, ctx
  order by docs.person, docs.type_name;
$$;

-- Called by the API after the file is stored in S3 (same request). The
-- object key is server-built from ids; the caller never chooses it.
create function ogevia_api.register_document_version(
  p_document_id uuid,
  p_version_id uuid,
  p_object_key text,
  p_s3_version_id text,
  p_content_type text,
  p_byte_size integer,
  p_sha256 text,
  p_issued_on date,
  p_expires_on date,
  p_idempotency_key uuid default null
)
returns table (document_version_id uuid, version_number integer)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  d ogevia.staff_documents%rowtype;
  v_requires_expiry boolean;
  v_fp text := concat_ws('|', p_document_id, p_sha256, p_issued_on, p_expires_on);
  v_prior jsonb;
  v_no integer;
begin
  d := ogevia.document_access(p_document_id, false);
  if not (ogevia.has_permission(d.organization_id, 'documents.manage')
          or (ogevia.has_permission(d.organization_id, 'documents.manage_own') and d.caregiver_record_id = ogevia.my_caregiver_record(d.organization_id))) then
    raise exception 'Document not found' using errcode = 'OGN04';
  end if;
  v_prior := ogevia.idempotency_begin('register_document_version', p_idempotency_key, d.organization_id, v_fp);
  if v_prior is not null then
    return query select (v_prior ->> 'id')::uuid, (v_prior ->> 'version_number')::integer;
    return;
  end if;
  if p_object_key <> d.organization_id::text || '/documents/' || d.id::text || '/' || p_version_id::text then
    raise exception 'Invalid object key' using errcode = 'OGV22';
  end if;
  select t.requires_expiry into v_requires_expiry from ogevia.document_types t where t.id = d.document_type_id;
  if v_requires_expiry and p_expires_on is null then
    raise exception 'This document type needs its expiry date' using errcode = 'OGV22';
  end if;
  if p_expires_on is not null and p_issued_on is not null and p_expires_on <= p_issued_on then
    raise exception 'The expiry date must be after the issue date' using errcode = 'OGV22';
  end if;
  if p_issued_on is not null and p_issued_on > ogevia.organization_local_date(d.organization_id, now()) then
    raise exception 'The issue date cannot be in the future' using errcode = 'OGV22';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ogevia.document:' || d.id::text, 0));
  select coalesce(max(v.version_number), 0) + 1 into v_no from ogevia.document_versions v where v.document_id = d.id;
  insert into ogevia.document_versions (id, organization_id, document_id, version_number, object_key, s3_version_id,
    content_type, byte_size, sha256, issued_on, expires_on, uploaded_by)
  values (p_version_id, d.organization_id, d.id, v_no, p_object_key, p_s3_version_id, p_content_type, p_byte_size,
    lower(p_sha256), p_issued_on, p_expires_on, v_actor);
  perform ogevia.write_audit(d.organization_id, 'document.uploaded', 'document_versions', p_version_id, null,
    jsonb_build_object('document_id', d.id, 'version_number', v_no, 'content_type', p_content_type, 'byte_size', p_byte_size,
      'issued_on', p_issued_on, 'expires_on', p_expires_on), null);
  perform ogevia.idempotency_finish('register_document_version', p_idempotency_key, d.organization_id, v_fp,
    jsonb_build_object('id', p_version_id, 'version_number', v_no));
  return query select p_version_id, v_no;
end;
$$;

-- The retry check BEFORE storing a file again (mirrors get_confirmation_replay).
create function ogevia_api.get_document_upload_replay(p_document_id uuid, p_idempotency_key uuid)
returns table (document_version_id uuid, version_number integer)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select (r.response ->> 'id')::uuid, (r.response ->> 'version_number')::integer
  from ogevia.idempotency_records r
  where r.actor_user_id = ogevia.require_actor()
    and r.operation = 'register_document_version'
    and r.idempotency_key = p_idempotency_key
    and (r.response ->> 'id') is not null
    and exists (select 1 from ogevia.document_versions v where v.id = (r.response ->> 'id')::uuid and v.document_id = p_document_id);
$$;

create function ogevia_api.review_document_version(p_version_id uuid, p_decision text, p_reason text, p_idempotency_key uuid default null)
returns text
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v ogevia.document_versions%rowtype;
  v_fp text := concat_ws('|', p_version_id, p_decision, btrim(coalesce(p_reason, '')));
  v_prior jsonb;
begin
  select * into v from ogevia.document_versions where id = p_version_id for update;
  if v.id is null or not ogevia.is_active_member(v.organization_id) then
    raise exception 'Document not found' using errcode = 'OGN04';
  end if;
  if not ogevia.has_permission(v.organization_id, 'documents.manage') then
    raise exception 'You do not have permission to review documents' using errcode = 'OGA03';
  end if;
  v_prior := ogevia.idempotency_begin('review_document_version', p_idempotency_key, v.organization_id, v_fp);
  if v_prior is not null then return v_prior ->> 'decision'; end if;
  if p_decision not in ('verified', 'rejected') then
    raise exception 'Decision must be verified or rejected' using errcode = 'OGV22';
  end if;
  if p_decision = 'rejected' and length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'A reason is required to reject a document' using errcode = 'OGV22';
  end if;
  if v.uploaded_by = v_actor then
    raise exception 'You cannot review a document you uploaded' using errcode = 'OGA03';
  end if;
  if v.review_status <> 'awaiting_review' then
    raise exception 'This document version has already been reviewed' using errcode = 'OGC09';
  end if;
  if exists (select 1 from ogevia.document_versions n where n.document_id = v.document_id and n.version_number > v.version_number) then
    raise exception 'A newer version was uploaded; review that one' using errcode = 'OGC09';
  end if;
  update ogevia.document_versions set review_status = p_decision::ogevia.document_review_status, reviewed_by = v_actor,
    reviewed_at = now(), rejection_reason = case when p_decision = 'rejected' then btrim(p_reason) end
   where id = v.id;
  perform ogevia.write_audit(v.organization_id, 'document.' || p_decision, 'document_versions', v.id,
    jsonb_build_object('review_status', 'awaiting_review'), jsonb_build_object('review_status', p_decision),
    nullif(btrim(coalesce(p_reason, '')), ''));
  perform ogevia.idempotency_finish('review_document_version', p_idempotency_key, v.organization_id, v_fp,
    jsonb_build_object('decision', p_decision));
  return p_decision;
end;
$$;

-- Where the API may read one version's file from; audited as a view.
create function ogevia_api.open_document_version(p_version_id uuid)
returns table (object_key text, s3_version_id text, content_type text, byte_size integer, sha256 text)
language plpgsql
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v ogevia.document_versions%rowtype;
begin
  perform ogevia.require_actor();
  select * into v from ogevia.document_versions where id = p_version_id;
  if v.id is null then
    raise exception 'Document not found' using errcode = 'OGN04';
  end if;
  perform ogevia.document_access(v.document_id, false);
  perform ogevia.write_audit(v.organization_id, 'document.viewed', 'document_versions', v.id, null, null, null);
  return query select v.object_key, v.s3_version_id, v.content_type, v.byte_size, v.sha256;
end;
$$;

-- Counts for Home (managers): agency-local dates.
create function ogevia_api.get_document_alerts(p_organization_id uuid, p_expiring_window_days integer default 30)
returns table (expired integer, expiring integer, overdue integer, awaiting_review integer, rejected integer)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select count(*) filter (where d.display_status = 'expired')::integer,
         count(*) filter (where d.display_status = 'expiring')::integer,
         count(*) filter (where d.display_status = 'overdue')::integer,
         count(*) filter (where d.display_status = 'awaiting_review')::integer,
         count(*) filter (where d.display_status = 'rejected')::integer
  from ogevia_api.list_staff_documents(p_organization_id, p_expiring_window_days) d
  having ogevia.require_actor() is not null
     and ogevia.is_active_member(p_organization_id)
     and ogevia.has_permission(p_organization_id, 'documents.read');
$$;

revoke all on function ogevia.my_caregiver_record(uuid) from public;
revoke all on function ogevia.document_access(uuid, boolean) from public;
revoke all on function ogevia_api.create_document_type(uuid, text, boolean, uuid) from public;
revoke all on function ogevia_api.list_document_types(uuid) from public;
revoke all on function ogevia_api.list_document_people(uuid) from public;
revoke all on function ogevia_api.request_staff_document(uuid, uuid, uuid, date, uuid) from public;
revoke all on function ogevia_api.list_staff_documents(uuid, integer) from public;
revoke all on function ogevia_api.register_document_version(uuid, uuid, text, text, text, integer, text, date, date, uuid) from public;
revoke all on function ogevia_api.get_document_upload_replay(uuid, uuid) from public;
revoke all on function ogevia_api.review_document_version(uuid, text, text, uuid) from public;
revoke all on function ogevia_api.open_document_version(uuid) from public;
revoke all on function ogevia_api.get_document_alerts(uuid, integer) from public;
grant execute on function ogevia_api.create_document_type(uuid, text, boolean, uuid) to ogevia_app;
grant execute on function ogevia_api.list_document_types(uuid) to ogevia_app;
grant execute on function ogevia_api.list_document_people(uuid) to ogevia_app;
grant execute on function ogevia_api.request_staff_document(uuid, uuid, uuid, date, uuid) to ogevia_app;
grant execute on function ogevia_api.list_staff_documents(uuid, integer) to ogevia_app;
grant execute on function ogevia_api.register_document_version(uuid, uuid, text, text, text, integer, text, date, date, uuid) to ogevia_app;
grant execute on function ogevia_api.get_document_upload_replay(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.review_document_version(uuid, text, text, uuid) to ogevia_app;
grant execute on function ogevia_api.open_document_version(uuid) to ogevia_app;
grant execute on function ogevia_api.get_document_alerts(uuid, integer) to ogevia_app;
