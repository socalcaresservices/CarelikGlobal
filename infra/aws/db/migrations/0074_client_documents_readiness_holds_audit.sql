-- 0074 Client documents, client readiness and service holds, the client's audit timeline and a duplicate-name check (Board 2 decisions 6, 7, 12, 13, 14, 15, 16).
--
-- CLIENT DOCUMENTS (14): a document type has a category and may need an expiry date; an agency says which types each SERVICE requires. A client's document moves through
-- Missing, Pending Review, Approved, Expired or Rejected, with version history. UPLOAD IS NOT APPROVAL: a new version is always Pending Review, and only a person with
-- documents.manage who did not upload it (unless they hold documents.review_own) can approve or reject it. Files live in the same private evidence bucket as staff documents.
-- READINESS (15): a client being prepared is Draft or Pending and cannot be scheduled; activating needs every document the client's services require to be Approved (and none
-- Expired); a client who is not being prepared is Active, Inactive is shown as On hold and Discharged as Closed (the stored client status is unchanged). A person with
-- clients.manage can place a SERVICE HOLD on one client service (with a reason) and release it with a note; other services of that client are not affected.
-- A reservation for a shift of a client who is being prepared, or whose service is on hold, is refused by a trigger on authorization_reservations, so every scheduling path
-- is covered the same way (the 0065 pattern). Expiry of an authorization is not a stored hold: new scheduling outside the period is already refused, and the renewal screen shows it.
-- AUDIT TIMELINE (12): who did what and when for a client and its authorizations, with the names of the fields that changed but never their values (names are PHI).
-- DUPLICATE CHECK (13): same legal name (ignoring case and spacing), or the same last name and the same first three letters, for people with clients.names.read.
-- Rollback: BACKUP REQUIRED (client documents, versions, requirements, holds and stages are dropped; evidence files stay in the bucket; audit events are kept).

create function ogevia.stable_uuid(p_seed text)
returns uuid
language sql
immutable
set search_path = ogevia, pg_temp
as $$ select (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-8' || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid from (select md5(p_seed) as h) x $$;
revoke all on function ogevia.stable_uuid(text) from public;

create table ogevia.client_document_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  name text not null check (length(btrim(name)) between 2 and 80),
  category text not null check (category in ('consent', 'authorization', 'assessment', 'insurance', 'identity', 'other')),
  requires_expiry boolean not null default false,
  active boolean not null default true,
  created_by uuid not null references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index client_document_types_name on ogevia.client_document_types (organization_id, lower(btrim(name)));
create table ogevia.client_document_requirements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  service_id uuid not null,
  document_type_id uuid not null,
  created_by uuid not null references ogevia.app_users(id),
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references ogevia.app_users(id),
  foreign key (service_id, organization_id) references ogevia.services (id, organization_id),
  foreign key (document_type_id, organization_id) references ogevia.client_document_types (id, organization_id)
);
create unique index client_document_requirements_open on ogevia.client_document_requirements (service_id, document_type_id) where removed_at is null;
create table ogevia.client_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  client_id uuid not null,
  document_type_id uuid not null,
  created_at timestamptz not null default now(),
  unique (id, organization_id),
  unique (client_id, document_type_id),
  foreign key (client_id, organization_id) references ogevia.clients (id, organization_id),
  foreign key (document_type_id, organization_id) references ogevia.client_document_types (id, organization_id)
);
create table ogevia.client_document_versions (
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
  foreign key (document_id, organization_id) references ogevia.client_documents (id, organization_id),
  constraint client_document_versions_dates check (expires_on is null or issued_on is null or expires_on > issued_on),
  constraint client_document_versions_review_shape check (
    (review_status = 'awaiting_review' and reviewed_by is null and reviewed_at is null and rejection_reason is null)
    or (review_status = 'verified' and reviewed_by is not null and reviewed_at is not null and rejection_reason is null)
    or (review_status = 'rejected' and reviewed_by is not null and reviewed_at is not null and length(btrim(coalesce(rejection_reason, ''))) > 0))
);
create function ogevia.client_document_versions_guard_update()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
begin
  if old.review_status <> 'awaiting_review' then raise exception 'This document version has already been reviewed' using errcode = 'OGC09'; end if;
  if (to_jsonb(new) - array['review_status', 'reviewed_by', 'reviewed_at', 'rejection_reason']) is distinct from (to_jsonb(old) - array['review_status', 'reviewed_by', 'reviewed_at', 'rejection_reason']) then
    raise exception 'Document versions are append-only; upload a new version instead' using errcode = 'OGC09';
  end if;
  return new;
end;
$$;
create trigger client_document_versions_guard_update before update on ogevia.client_document_versions for each row execute function ogevia.client_document_versions_guard_update();
create trigger client_document_versions_no_delete before delete on ogevia.client_document_versions for each row execute function ogevia.forbid_delete();
create trigger client_documents_no_delete before delete on ogevia.client_documents for each row execute function ogevia.forbid_delete();
create table ogevia.client_service_holds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  client_id uuid not null,
  service_id uuid not null,
  reason text not null check (length(btrim(reason)) between 10 and 500),
  opened_by uuid not null references ogevia.app_users(id),
  opened_at timestamptz not null default now(),
  released_by uuid references ogevia.app_users(id),
  released_at timestamptz,
  release_note text,
  foreign key (client_id, organization_id) references ogevia.clients (id, organization_id),
  foreign key (service_id, organization_id) references ogevia.services (id, organization_id),
  check ((released_at is null and released_by is null and release_note is null) or (released_at is not null and released_by is not null and length(btrim(coalesce(release_note, ''))) >= 10))
);
create unique index client_service_holds_open on ogevia.client_service_holds (client_id, service_id) where released_at is null;
create trigger client_service_holds_no_delete before delete on ogevia.client_service_holds for each row execute function ogevia.forbid_delete();
create table ogevia.client_preparation (
  client_id uuid primary key,
  organization_id uuid not null references ogevia.organizations(id),
  stage text not null check (stage in ('draft', 'pending')),
  note text check (note is null or length(note) <= 500),
  updated_by uuid not null references ogevia.app_users(id),
  updated_at timestamptz not null default now(),
  foreign key (client_id, organization_id) references ogevia.clients (id, organization_id)
);
alter table ogevia.client_document_types enable row level security;
alter table ogevia.client_document_requirements enable row level security;
alter table ogevia.client_documents enable row level security;
alter table ogevia.client_document_versions enable row level security;
alter table ogevia.client_service_holds enable row level security;
alter table ogevia.client_preparation enable row level security;
create policy readonly_select on ogevia.client_document_types for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.client_document_requirements for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.client_documents for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.client_document_versions for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.client_service_holds for select to ogevia_readonly using (true);
create policy readonly_select on ogevia.client_preparation for select to ogevia_readonly using (true);
grant select on ogevia.client_document_types, ogevia.client_document_requirements, ogevia.client_documents, ogevia.client_document_versions, ogevia.client_service_holds, ogevia.client_preparation to ogevia_readonly;

-- state of one client document: missing | awaiting_review | review_overdue is for the issue list; here: missing, pending_review, approved, expired, rejected
create function ogevia.client_document_state(p_organization_id uuid, p_client_id uuid, p_type_id uuid)
returns text
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select coalesce((
    select case when v.review_status = 'awaiting_review' then 'pending_review'
                when v.review_status = 'rejected' then 'rejected'
                when v.expires_on is not null and v.expires_on < ogevia.organization_local_date(p_organization_id, now()) then 'expired'
                else 'approved' end
    from ogevia.client_documents d join ogevia.client_document_versions v on v.document_id = d.id
    where d.client_id = p_client_id and d.document_type_id = p_type_id
    order by v.version_number desc limit 1), 'missing');
$$;
revoke all on function ogevia.client_document_state(uuid, uuid, uuid) from public;

create function ogevia.client_gate(p_organization_id uuid, p_client_id uuid, p_service_id uuid)
returns text
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select case when exists (select 1 from ogevia.client_preparation p where p.client_id = p_client_id) then 'This client is still being prepared and cannot be scheduled yet'
              when exists (select 1 from ogevia.client_service_holds h where h.client_id = p_client_id and h.service_id = p_service_id and h.released_at is null) then 'This service is on hold for this client'
         end;
$$;
revoke all on function ogevia.client_gate(uuid, uuid, uuid) from public;

create function ogevia.client_gate_reservation()
returns trigger
language plpgsql
set search_path = ogevia, pg_temp
as $$
declare
  v_msg text;
begin
  if new.shift_id is null then return new; end if;
  select ogevia.client_gate(sh.organization_id, sh.client_id, sh.service_id) into v_msg from ogevia.shifts sh where sh.id = new.shift_id;
  if v_msg is not null then raise exception '%', v_msg using errcode = 'OGC09'; end if;
  return new;
end;
$$;
create trigger client_gate_reservation before insert on ogevia.authorization_reservations for each row execute function ogevia.client_gate_reservation();

create function ogevia_api.list_client_document_types(p_organization_id uuid)
returns table (document_type_id uuid, name text, category text, requires_expiry boolean, active boolean, required_for jsonb)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'documents.read') then raise exception 'You do not have permission to see client documents' using errcode = 'OGA03'; end if;
  return query
  select t.id, t.name, t.category, t.requires_expiry, t.active,
         coalesce((select jsonb_agg(jsonb_build_object('serviceId', s.id, 'serviceName', s.name) order by s.name) from ogevia.client_document_requirements r join ogevia.services s on s.id = r.service_id
                    where r.document_type_id = t.id and r.removed_at is null), '[]'::jsonb)
  from ogevia.client_document_types t where t.organization_id = p_organization_id order by lower(t.name);
end;
$$;

create function ogevia_api.save_client_document_type(p_organization_id uuid, p_name text, p_category text, p_requires_expiry boolean, p_active boolean default true, p_idempotency_key uuid default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_name text := btrim(coalesce(p_name, ''));
  v_fp text := concat_ws('|', p_organization_id, lower(v_name), p_category, p_requires_expiry, p_active);
  v_prior jsonb;
  v_id uuid;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'documents.manage') then raise exception 'You do not have permission to configure client documents' using errcode = 'OGA03'; end if;
  v_prior := ogevia.idempotency_begin('save_client_document_type', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return (v_prior ->> 'id')::uuid; end if;
  if length(v_name) < 2 or length(v_name) > 80 then raise exception 'Give the document a name of 2 to 80 characters' using errcode = 'OGV22'; end if;
  if p_category is null or p_category not in ('consent', 'authorization', 'assessment', 'insurance', 'identity', 'other') then raise exception 'Choose a category' using errcode = 'OGV22'; end if;
  insert into ogevia.client_document_types (organization_id, name, category, requires_expiry, active, created_by)
  values (p_organization_id, v_name, p_category, coalesce(p_requires_expiry, false), coalesce(p_active, true), v_actor)
  on conflict (organization_id, lower(btrim(name))) do update set category = excluded.category, requires_expiry = excluded.requires_expiry, active = excluded.active
  returning id into v_id;
  perform ogevia.write_audit(p_organization_id, 'client_document_type.saved', 'client_document_types', v_id, null, jsonb_build_object('category', p_category, 'requires_expiry', coalesce(p_requires_expiry, false), 'active', coalesce(p_active, true)), null);
  perform ogevia.idempotency_finish('save_client_document_type', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('id', v_id));
  return v_id;
end;
$$;

create function ogevia_api.set_client_document_requirement(p_organization_id uuid, p_service_id uuid, p_document_type_id uuid, p_required boolean, p_idempotency_key uuid default null)
returns boolean
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_fp text := concat_ws('|', p_organization_id, p_service_id, p_document_type_id, p_required);
  v_prior jsonb;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'documents.manage') then raise exception 'You do not have permission to configure client documents' using errcode = 'OGA03'; end if;
  v_prior := ogevia.idempotency_begin('set_client_document_requirement', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return coalesce((v_prior ->> 'required')::boolean, false); end if;
  if not exists (select 1 from ogevia.client_document_types t where t.id = p_document_type_id and t.organization_id = p_organization_id)
     or not exists (select 1 from ogevia.services s where s.id = p_service_id and s.organization_id = p_organization_id) then raise exception 'Not found' using errcode = 'OGN04'; end if;
  if coalesce(p_required, false) then
    insert into ogevia.client_document_requirements (organization_id, service_id, document_type_id, created_by) values (p_organization_id, p_service_id, p_document_type_id, v_actor) on conflict do nothing;
  else
    update ogevia.client_document_requirements set removed_at = now(), removed_by = v_actor where service_id = p_service_id and document_type_id = p_document_type_id and removed_at is null;
  end if;
  perform ogevia.write_audit(p_organization_id, case when coalesce(p_required, false) then 'client_document_requirement.added' else 'client_document_requirement.removed' end, 'services', p_service_id, null,
    jsonb_build_object('document_type_id', p_document_type_id), null);
  perform ogevia.idempotency_finish('set_client_document_requirement', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('required', coalesce(p_required, false)));
  return coalesce(p_required, false);
end;
$$;

create function ogevia_api.list_client_documents(p_organization_id uuid, p_client_id uuid)
returns table (document_type_id uuid, name text, category text, requires_expiry boolean, state text, required_for jsonb, document_id uuid, latest_version_id uuid, version_number integer,
               uploaded_at timestamptz, uploaded_by_name text, issued_on date, expires_on date, reviewed_by_name text, reviewed_at timestamptz, rejection_reason text, version_count integer)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'documents.read') then raise exception 'You do not have permission to see client documents' using errcode = 'OGA03'; end if;
  if not exists (select 1 from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id and c.deleted_at is null) then raise exception 'Client not found' using errcode = 'OGN04'; end if;
  return query
  with svc as (select distinct a.service_id from ogevia.client_authorizations a where a.client_id = p_client_id and a.organization_id = p_organization_id and a.is_current),
  req as (
    select r.document_type_id, jsonb_agg(jsonb_build_object('serviceId', s.id, 'serviceName', s.name) order by s.name) as required_for
    from ogevia.client_document_requirements r join svc on svc.service_id = r.service_id join ogevia.services s on s.id = r.service_id
    where r.removed_at is null group by r.document_type_id),
  have as (select d.id as document_id, d.document_type_id from ogevia.client_documents d where d.client_id = p_client_id)
  select t.id, t.name, t.category, t.requires_expiry, ogevia.client_document_state(p_organization_id, p_client_id, t.id), coalesce(req.required_for, '[]'::jsonb),
         h.document_id, v.id, v.version_number, v.uploaded_at, ou.display_name, v.issued_on, v.expires_on, ru.display_name, v.reviewed_at, v.rejection_reason,
         (select count(*)::int from ogevia.client_document_versions x where x.document_id = h.document_id)
  from ogevia.client_document_types t
  left join req on req.document_type_id = t.id
  left join have h on h.document_type_id = t.id
  left join ogevia.client_document_versions v on v.document_id = h.document_id and v.version_number = (select max(v2.version_number) from ogevia.client_document_versions v2 where v2.document_id = h.document_id)
  left join ogevia.app_users ou on ou.id = v.uploaded_by
  left join ogevia.app_users ru on ru.id = v.reviewed_by
  where t.organization_id = p_organization_id and (req.document_type_id is not null or h.document_id is not null)
  order by (req.document_type_id is null), lower(t.name);
end;
$$;

create function ogevia_api.ensure_client_document(p_organization_id uuid, p_client_id uuid, p_document_type_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_id uuid;
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'documents.manage') then raise exception 'You do not have permission to upload client documents' using errcode = 'OGA03'; end if;
  if not exists (select 1 from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id and c.deleted_at is null) then raise exception 'Client not found' using errcode = 'OGN04'; end if;
  if not exists (select 1 from ogevia.client_document_types t where t.id = p_document_type_id and t.organization_id = p_organization_id and t.active) then raise exception 'Document type not found' using errcode = 'OGN04'; end if;
  insert into ogevia.client_documents (organization_id, client_id, document_type_id) values (p_organization_id, p_client_id, p_document_type_id) on conflict (client_id, document_type_id) do nothing;
  select d.id into v_id from ogevia.client_documents d where d.client_id = p_client_id and d.document_type_id = p_document_type_id;
  return v_id;
end;
$$;

create function ogevia_api.get_client_document_upload_replay(p_document_id uuid, p_idempotency_key uuid)
returns table (document_version_id uuid, version_number integer)
language sql
stable
security definer
set search_path = ogevia, pg_temp
as $$
  select (r.response ->> 'id')::uuid, (r.response ->> 'version_number')::integer
  from ogevia.idempotency_records r
  where r.actor_user_id = ogevia.require_actor()
    and r.operation = 'register_client_document_version'
    and r.idempotency_key = p_idempotency_key
    and (r.response ->> 'id') is not null
    and exists (select 1 from ogevia.client_document_versions v where v.id = (r.response ->> 'id')::uuid and v.document_id = p_document_id);
$$;

create function ogevia_api.register_client_document_version(
  p_document_id uuid, p_version_id uuid, p_object_key text, p_s3_version_id text, p_content_type text, p_byte_size integer, p_sha256 text, p_issued_on date, p_expires_on date, p_idempotency_key uuid default null)
returns table (document_version_id uuid, version_number integer)
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  d ogevia.client_documents%rowtype;
  v_requires_expiry boolean;
  v_fp text := concat_ws('|', p_document_id, p_sha256, p_issued_on, p_expires_on);
  v_prior jsonb;
  v_no integer;
begin
  select * into d from ogevia.client_documents x where x.id = p_document_id;
  if d.id is null or not ogevia.is_active_member(d.organization_id) or not ogevia.has_permission(d.organization_id, 'documents.manage') then raise exception 'Document not found' using errcode = 'OGN04'; end if;
  v_prior := ogevia.idempotency_begin('register_client_document_version', p_idempotency_key, d.organization_id, v_fp);
  if v_prior is not null then return query select (v_prior ->> 'id')::uuid, (v_prior ->> 'version_number')::integer; return; end if;
  if p_object_key <> d.organization_id::text || '/client-documents/' || d.id::text || '/' || p_version_id::text then raise exception 'Invalid object key' using errcode = 'OGV22'; end if;
  select t.requires_expiry into v_requires_expiry from ogevia.client_document_types t where t.id = d.document_type_id;
  if v_requires_expiry and p_expires_on is null then raise exception 'This document type needs its expiry date' using errcode = 'OGV22'; end if;
  if p_expires_on is not null and p_issued_on is not null and p_expires_on <= p_issued_on then raise exception 'The expiry date must be after the issue date' using errcode = 'OGV22'; end if;
  if p_issued_on is not null and p_issued_on > ogevia.organization_local_date(d.organization_id, now()) then raise exception 'The issue date cannot be in the future' using errcode = 'OGV22'; end if;
  perform pg_advisory_xact_lock(hashtextextended('ogevia.client_document:' || d.id::text, 0));
  select coalesce(max(v.version_number), 0) + 1 into v_no from ogevia.client_document_versions v where v.document_id = d.id;
  insert into ogevia.client_document_versions (id, organization_id, document_id, version_number, object_key, s3_version_id, content_type, byte_size, sha256, issued_on, expires_on, uploaded_by)
  values (p_version_id, d.organization_id, d.id, v_no, p_object_key, p_s3_version_id, p_content_type, p_byte_size, lower(p_sha256), p_issued_on, p_expires_on, v_actor);
  perform ogevia.write_audit(d.organization_id, 'client_document.uploaded', 'client_document_versions', p_version_id, null,
    jsonb_build_object('document_id', d.id, 'client_id', d.client_id, 'version_number', v_no, 'content_type', p_content_type, 'byte_size', p_byte_size, 'issued_on', p_issued_on, 'expires_on', p_expires_on), null);
  perform ogevia.idempotency_finish('register_client_document_version', p_idempotency_key, d.organization_id, v_fp, jsonb_build_object('id', p_version_id, 'version_number', v_no));
  return query select p_version_id, v_no;
end;
$$;

create function ogevia_api.review_client_document_version(p_version_id uuid, p_decision text, p_reason text, p_idempotency_key uuid default null)
returns text
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v ogevia.client_document_versions%rowtype;
  v_fp text := concat_ws('|', p_version_id, p_decision, btrim(coalesce(p_reason, '')));
  v_prior jsonb;
  v_self boolean;
  v_client uuid;
begin
  select * into v from ogevia.client_document_versions x where x.id = p_version_id for update;
  if v.id is null or not ogevia.is_active_member(v.organization_id) then raise exception 'Document not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(v.organization_id, 'documents.manage') then raise exception 'You do not have permission to review documents' using errcode = 'OGA03'; end if;
  v_prior := ogevia.idempotency_begin('review_client_document_version', p_idempotency_key, v.organization_id, v_fp);
  if v_prior is not null then return v_prior ->> 'decision'; end if;
  if p_decision not in ('verified', 'rejected') then raise exception 'Decision must be verified or rejected' using errcode = 'OGV22'; end if;
  if p_decision = 'rejected' and length(btrim(coalesce(p_reason, ''))) = 0 then raise exception 'A reason is required to reject a document' using errcode = 'OGV22'; end if;
  v_self := v.uploaded_by = v_actor;
  if v_self and not ogevia.has_permission(v.organization_id, 'documents.review_own') then raise exception 'You cannot review a document you uploaded; ask the Administrator or another manager' using errcode = 'OGA03'; end if;
  if v.review_status <> 'awaiting_review' then raise exception 'This document version has already been reviewed' using errcode = 'OGC09'; end if;
  if exists (select 1 from ogevia.client_document_versions n where n.document_id = v.document_id and n.version_number > v.version_number) then raise exception 'A newer version was uploaded; review that one' using errcode = 'OGC09'; end if;
  update ogevia.client_document_versions set review_status = p_decision::ogevia.document_review_status, reviewed_by = v_actor, reviewed_at = now(), rejection_reason = case when p_decision = 'rejected' then btrim(p_reason) end where id = v.id;
  select d.client_id into v_client from ogevia.client_documents d where d.id = v.document_id;
  perform ogevia.write_audit(v.organization_id, 'client_document.' || p_decision, 'client_document_versions', v.id, jsonb_build_object('review_status', 'awaiting_review'),
    jsonb_build_object('review_status', p_decision, 'client_id', v_client, 'self_review', v_self), nullif(btrim(coalesce(p_reason, '')), ''));
  perform ogevia.idempotency_finish('review_client_document_version', p_idempotency_key, v.organization_id, v_fp, jsonb_build_object('decision', p_decision));
  return p_decision;
end;
$$;

create function ogevia_api.open_client_document_version(p_version_id uuid)
returns table (object_key text, s3_version_id text, content_type text, sha256 text)
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v ogevia.client_document_versions%rowtype;
begin
  perform ogevia.require_actor();
  select * into v from ogevia.client_document_versions x where x.id = p_version_id;
  if v.id is null or not ogevia.is_active_member(v.organization_id) or not ogevia.has_permission(v.organization_id, 'documents.read') then raise exception 'Document not found' using errcode = 'OGN04'; end if;
  perform ogevia.write_audit(v.organization_id, 'client_document.opened', 'client_document_versions', v.id, null, jsonb_build_object('document_id', v.document_id), null);
  return query select v.object_key, v.s3_version_id, v.content_type, v.sha256;
end;
$$;

create function ogevia_api.get_client_readiness(p_organization_id uuid, p_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  c ogevia.clients%rowtype;
  v_today date := ogevia.organization_local_date(p_organization_id, now());
  v_prep ogevia.client_preparation%rowtype;
  v_services jsonb;
  v_ready boolean;
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'visits.read') or ogevia.has_permission(p_organization_id, 'clients.manage') or ogevia.has_permission(p_organization_id, 'documents.read')) then
    raise exception 'You do not have permission to see client readiness' using errcode = 'OGA03';
  end if;
  select * into c from ogevia.clients x where x.id = p_client_id and x.organization_id = p_organization_id and x.deleted_at is null;
  if c.id is null then raise exception 'Client not found' using errcode = 'OGN04'; end if;
  select * into v_prep from ogevia.client_preparation p where p.client_id = p_client_id;
  with a as (
    select distinct on (a.service_id) a.service_id, a.period_start, a.period_end
    from ogevia.client_authorizations a where a.client_id = p_client_id and a.organization_id = p_organization_id and a.is_current order by a.service_id, a.period_end desc),
  s as (
    select a.service_id, sv.name as service_name, a.period_start, a.period_end,
           case when a.period_end < v_today then 'expired' when a.period_start > v_today then 'not_started' else 'valid' end as auth_state,
           coalesce((select jsonb_agg(jsonb_build_object('documentTypeId', t.id, 'name', t.name, 'state', ogevia.client_document_state(p_organization_id, p_client_id, t.id)) order by lower(t.name))
                       from ogevia.client_document_requirements r join ogevia.client_document_types t on t.id = r.document_type_id where r.service_id = a.service_id and r.removed_at is null), '[]'::jsonb) as reqs,
           (select h.id from ogevia.client_service_holds h where h.client_id = p_client_id and h.service_id = a.service_id and h.released_at is null) as hold_id
    from a join ogevia.services sv on sv.id = a.service_id)
  select coalesce(jsonb_agg(jsonb_build_object(
           'serviceId', s.service_id, 'serviceName', s.service_name, 'authorization', jsonb_build_object('periodStart', s.period_start, 'periodEnd', s.period_end, 'state', s.auth_state),
           'requirements', s.reqs,
           'unmet', (select count(*) from jsonb_array_elements(s.reqs) q where q ->> 'state' <> 'approved'),
           'hold', case when s.hold_id is null then null else (select jsonb_build_object('holdId', h.id, 'reason', h.reason, 'openedAt', h.opened_at, 'openedByName', u.display_name) from ogevia.client_service_holds h left join ogevia.app_users u on u.id = h.opened_by where h.id = s.hold_id) end,
           'state', case when s.hold_id is not null then 'held' when s.auth_state = 'expired' then 'authorization_expired'
                         when exists (select 1 from jsonb_array_elements(s.reqs) q where q ->> 'state' <> 'approved') then 'needs_documents' else 'ready' end) order by s.service_name), '[]'::jsonb),
         coalesce(bool_and(s.hold_id is null and not exists (select 1 from jsonb_array_elements(s.reqs) q where q ->> 'state' <> 'approved')), true)
    into v_services, v_ready
  from s;
  return jsonb_build_object('clientId', c.id, 'status', c.status::text,
    'stage', case when v_prep.client_id is not null then v_prep.stage when c.status = 'inactive' then 'on_hold' when c.status = 'discharged' then 'closed' else 'active' end,
    'stageNote', v_prep.note, 'canSchedule', v_prep.client_id is null and c.status = 'active', 'ready', v_ready, 'services', v_services);
end;
$$;

create function ogevia_api.set_client_preparation(p_organization_id uuid, p_client_id uuid, p_stage text, p_note text, p_idempotency_key uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_fp text := concat_ws('|', p_organization_id, p_client_id, p_stage, btrim(coalesce(p_note, '')));
  v_prior jsonb;
  c ogevia.clients%rowtype;
  v_before text;
  v_r jsonb;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'clients.manage') then raise exception 'You do not have permission to change a client''s stage' using errcode = 'OGA03'; end if;
  v_prior := ogevia.idempotency_begin('set_client_preparation', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return v_prior; end if;
  if p_stage is null or p_stage not in ('draft', 'pending', 'active') then raise exception 'Stage must be draft, pending or active' using errcode = 'OGV22'; end if;
  select * into c from ogevia.clients x where x.id = p_client_id and x.organization_id = p_organization_id and x.deleted_at is null for update;
  if c.id is null then raise exception 'Client not found' using errcode = 'OGN04'; end if;
  if c.status <> 'active' then raise exception 'Only an active client can be put into preparation; change the status first' using errcode = 'OGC09'; end if;
  select p.stage into v_before from ogevia.client_preparation p where p.client_id = p_client_id;
  if p_stage = 'active' then
    v_r := ogevia_api.get_client_readiness(p_organization_id, p_client_id);
    if not (v_r ->> 'ready')::boolean then
      raise exception 'This client cannot be activated yet: % service requirement(s) are not approved or a service is on hold', (select coalesce(sum((s ->> 'unmet')::int), 0) + count(*) filter (where s -> 'hold' <> 'null'::jsonb) from jsonb_array_elements(v_r -> 'services') s) using errcode = 'OGC09';
    end if;
    delete from ogevia.client_preparation where client_id = p_client_id;
  else
    insert into ogevia.client_preparation (client_id, organization_id, stage, note, updated_by) values (p_client_id, p_organization_id, p_stage, nullif(btrim(coalesce(p_note, '')), ''), v_actor)
    on conflict (client_id) do update set stage = excluded.stage, note = excluded.note, updated_by = v_actor, updated_at = now();
  end if;
  perform ogevia.write_audit(p_organization_id, 'client.stage_changed', 'client_preparation', p_client_id, jsonb_build_object('stage', coalesce(v_before, 'active')), jsonb_build_object('stage', p_stage), nullif(btrim(coalesce(p_note, '')), ''));
  v_r := jsonb_build_object('clientId', p_client_id, 'stage', p_stage);
  perform ogevia.idempotency_finish('set_client_preparation', p_idempotency_key, p_organization_id, v_fp, v_r);
  return v_r;
end;
$$;

create function ogevia_api.open_client_service_hold(p_organization_id uuid, p_client_id uuid, p_service_id uuid, p_reason text, p_idempotency_key uuid default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_fp text := concat_ws('|', p_organization_id, p_client_id, p_service_id, btrim(coalesce(p_reason, '')));
  v_prior jsonb;
  v_id uuid;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'clients.manage') then raise exception 'You do not have permission to hold a service' using errcode = 'OGA03'; end if;
  v_prior := ogevia.idempotency_begin('open_client_service_hold', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return (v_prior ->> 'id')::uuid; end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'Write the reason for the hold (at least 10 characters)' using errcode = 'OGV22'; end if;
  if not exists (select 1 from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id and c.deleted_at is null)
     or not exists (select 1 from ogevia.services s where s.id = p_service_id and s.organization_id = p_organization_id) then raise exception 'Not found' using errcode = 'OGN04'; end if;
  if exists (select 1 from ogevia.client_service_holds h where h.client_id = p_client_id and h.service_id = p_service_id and h.released_at is null) then raise exception 'This service is already on hold for this client' using errcode = 'OGC09'; end if;
  insert into ogevia.client_service_holds (organization_id, client_id, service_id, reason, opened_by) values (p_organization_id, p_client_id, p_service_id, btrim(p_reason), v_actor) returning id into v_id;
  perform ogevia.write_audit(p_organization_id, 'client.service_hold_opened', 'client_service_holds', v_id, null, jsonb_build_object('client_id', p_client_id, 'service_id', p_service_id), btrim(p_reason));
  perform ogevia.idempotency_finish('open_client_service_hold', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('id', v_id));
  return v_id;
end;
$$;

create function ogevia_api.release_client_service_hold(p_organization_id uuid, p_hold_id uuid, p_note text, p_idempotency_key uuid default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.require_actor();
  v_fp text := concat_ws('|', p_organization_id, p_hold_id, btrim(coalesce(p_note, '')));
  v_prior jsonb;
  h ogevia.client_service_holds%rowtype;
begin
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'clients.manage') then raise exception 'You do not have permission to release a hold' using errcode = 'OGA03'; end if;
  v_prior := ogevia.idempotency_begin('release_client_service_hold', p_idempotency_key, p_organization_id, v_fp);
  if v_prior is not null then return p_hold_id; end if;
  if length(btrim(coalesce(p_note, ''))) < 10 then raise exception 'Write what was checked before releasing the hold (at least 10 characters)' using errcode = 'OGV22'; end if;
  select * into h from ogevia.client_service_holds x where x.id = p_hold_id and x.organization_id = p_organization_id for update;
  if h.id is null then raise exception 'Hold not found' using errcode = 'OGN04'; end if;
  if h.released_at is not null then raise exception 'This hold was already released' using errcode = 'OGC09'; end if;
  update ogevia.client_service_holds set released_at = now(), released_by = v_actor, release_note = btrim(p_note) where id = h.id;
  perform ogevia.write_audit(p_organization_id, 'client.service_hold_released', 'client_service_holds', h.id, jsonb_build_object('client_id', h.client_id, 'service_id', h.service_id), null, btrim(p_note));
  perform ogevia.idempotency_finish('release_client_service_hold', p_idempotency_key, p_organization_id, v_fp, jsonb_build_object('id', p_hold_id));
  return p_hold_id;
end;
$$;

create function ogevia_api.list_client_audit(p_organization_id uuid, p_client_id uuid, p_limit integer default 100)
returns table (occurred_at timestamptz, action text, actor_name text, reason text, fields text[])
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'clients.manage') or ogevia.has_permission(p_organization_id, 'authorizations.update') or ogevia.has_permission(p_organization_id, 'visits.manage')) then
    raise exception 'You do not have permission to see the client history' using errcode = 'OGA03';
  end if;
  if not exists (select 1 from ogevia.clients c where c.id = p_client_id and c.organization_id = p_organization_id) then raise exception 'Client not found' using errcode = 'OGN04'; end if;
  return query
  select e.occurred_at, e.action, u.display_name, e.reason,
         coalesce((select array_agg(k order by k) from jsonb_object_keys(case when jsonb_typeof(e.after_state) = 'object' then e.after_state else '{}'::jsonb end) k), array[]::text[])
  from ogevia.audit_events e left join ogevia.app_users u on u.id = e.actor_user_id
  where e.organization_id = p_organization_id
    and ((e.entity_type in ('clients', 'client_preparation') and e.entity_id = p_client_id)
      or (e.entity_type = 'client_authorizations' and e.entity_id in (select a.id from ogevia.client_authorizations a where a.client_id = p_client_id))
      or (e.entity_type = 'client_service_holds' and e.entity_id in (select h.id from ogevia.client_service_holds h where h.client_id = p_client_id))
      or (e.entity_type = 'client_document_versions' and e.entity_id in (select v.id from ogevia.client_document_versions v join ogevia.client_documents d on d.id = v.document_id where d.client_id = p_client_id)))
  order by e.occurred_at desc, e.id desc
  limit greatest(1, least(coalesce(p_limit, 100), 300));
end;
$$;

create function ogevia_api.get_client_issue_history(p_organization_id uuid, p_client_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not (ogevia.has_permission(p_organization_id, 'visits.read') or ogevia.has_permission(p_organization_id, 'shifts.manage') or ogevia.has_permission(p_organization_id, 'documents.read')) then
    raise exception 'You do not have permission to see attention items' using errcode = 'OGA03';
  end if;
  return jsonb_build_object('resolved', coalesce((
    select jsonb_agg(jsonb_build_object('issueKey', s.issue_key, 'kind', s.kind, 'reason', s.reason, 'firstSeenAt', s.first_seen_at, 'resolvedAt', s.resolved_at, 'reopenCount', s.reopen_count) order by s.resolved_at desc)
    from (select * from ogevia.action_issue_state x where x.organization_id = p_organization_id and x.client_id = p_client_id and x.status = 'resolved' order by x.resolved_at desc limit 25) s), '[]'::jsonb));
end;
$$;

create function ogevia_api.find_possible_duplicate_clients(p_organization_id uuid, p_first_name text, p_last_name text, p_exclude_client_id uuid default null)
returns table (client_id uuid, client_code text, first_name text, last_name text, status text, match text)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_f text := lower(regexp_replace(btrim(coalesce(p_first_name, '')), '\s+', ' ', 'g'));
  v_l text := lower(regexp_replace(btrim(coalesce(p_last_name, '')), '\s+', ' ', 'g'));
begin
  perform ogevia.require_actor();
  if not ogevia.is_active_member(p_organization_id) then raise exception 'Organization not found' using errcode = 'OGN04'; end if;
  if not ogevia.has_permission(p_organization_id, 'clients.names.read') then raise exception 'You do not have permission to see client names' using errcode = 'OGA03'; end if;
  if length(v_f) = 0 or length(v_l) = 0 then return; end if;
  return query
  select c.id, c.client_code, n.legal_first_name, n.legal_last_name, c.status::text,
         case when lower(regexp_replace(btrim(n.legal_first_name), '\s+', ' ', 'g')) = v_f then 'same_name' else 'similar_name' end
  from ogevia.client_private_names n join ogevia.clients c on c.id = n.client_id
  where n.organization_id = p_organization_id and c.deleted_at is null and (p_exclude_client_id is null or c.id <> p_exclude_client_id)
    and lower(regexp_replace(btrim(n.legal_last_name), '\s+', ' ', 'g')) = v_l
    and (lower(regexp_replace(btrim(n.legal_first_name), '\s+', ' ', 'g')) = v_f or (length(v_f) >= 3 and left(lower(btrim(n.legal_first_name)), 3) = left(v_f, 3)))
  order by 6, n.legal_first_name limit 10;
end;
$$;

-- the issue list now includes required client documents
create or replace function ogevia.action_issue_rows(p_organization_id uuid, p_can_cover boolean, p_can_visits boolean, p_can_docs boolean, p_can_comp boolean, p_can_bill boolean, p_urgent_hours integer default 48)
returns table (issue_key text, kind text, reason text, queue text, category text, severity text, deadline timestamptz, since timestamptz,
               client_id uuid, caregiver_record_id uuid, service_id uuid, shift_id uuid, visit_id uuid, entity_id uuid)
language plpgsql
stable
set search_path = ogevia, pg_temp
as $$
declare
  v_win interval := make_interval(hours => p_urgent_hours);
begin
  return query
  with raw as (
    -- uncovered shifts: now / inside the window / beyond it
    select 'shift'::text k, case when ogevia.shift_is_called_out(sh.id) then 'uncovered_called_out' else 'uncovered_open' end r,
           case when sh.starts_at > now() + v_win then 'upcoming_staffing' else 'needs_attention_now' end q, 'coverage'::text cat,
           case when sh.starts_at > now() + v_win then 'routine' else ogevia.attention_shift_tier(sh.starts_at, now()) end sev,
           sh.starts_at dl, sh.starts_at sn, sh.client_id cl, null::uuid cg, sh.service_id sv, sh.id sf, null::uuid vs, sh.id en
    from ogevia.shifts sh
    where p_can_cover and sh.organization_id = p_organization_id and sh.status = 'scheduled' and sh.ends_at > now()
      and ogevia.shift_coverage_state(sh) = 'needs_coverage'
    union all
    -- shifts whose caregiver is blocked (compliance hold or a required document)
    select 'shift', case f.kind when 'compliance' then 'compliance_hold' else 'documents_not_current' end,
           case when sh.starts_at > now() + v_win then 'upcoming_staffing' else 'needs_attention_now' end, 'compliance',
           case when sh.starts_at > now() + v_win then 'routine' else ogevia.attention_shift_tier(sh.starts_at, now()) end,
           sh.starts_at, sh.starts_at, sh.client_id, f.caregiver_record_id, sh.service_id, sh.id, null::uuid, sh.id
    from ogevia.shift_readiness_flags f join ogevia.shifts sh on sh.id = f.shift_id
    where (p_can_comp or p_can_cover) and f.organization_id = p_organization_id and f.kind in ('compliance', 'document') and f.resolved_at is null
      and sh.status = 'scheduled' and sh.ends_at > now() and not ogevia.shift_is_called_out(sh.id)
    union all
    select 'visit', 'missing_clock_out', 'needs_attention_now', 'visits', 'urgent', coalesce(s.ends_at, v.time_in + interval '12 hours'), v.time_in, v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.service_visits v left join ogevia.shifts s on s.id = v.scheduled_shift_id
    where p_can_visits and v.organization_id = p_organization_id and v.status = 'draft' and v.time_out is null
      and ((s.id is not null and s.ends_at < now()) or (s.id is null and v.time_in <= now() - interval '12 hours'))
    union all
    select 'visit', 'in_progress_on_hold', 'needs_attention_now', 'compliance', 'critical', v.time_in, v.time_in, v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.service_visits v
    join ogevia.caregiver_records cr on cr.organization_id = v.organization_id and (cr.id = v.caregiver_record_id or (v.caregiver_record_id is null and cr.linked_user_id = v.caregiver_user_id))
    where (p_can_comp or p_can_visits) and v.organization_id = p_organization_id and v.status = 'draft' and v.time_out is null and ogevia.caregiver_blocked_now(v.organization_id, cr.id)
    union all
    -- visit review stream
    select 'visit', 'pending_confirmation', 'visit_review', 'visits', 'routine', v.time_out + make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'confirmation_overdue')), v.time_out, v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.service_visits v where p_can_visits and v.organization_id = p_organization_id and v.status = 'awaiting_signature' and v.time_out is not null
      and v.time_out > now() - make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'confirmation_overdue'))
    union all
    select 'visit', 'confirmation_overdue', 'visit_review', 'visits', 'urgent', v.time_out + make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'confirmation_overdue')), v.time_out, v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.service_visits v where p_can_visits and v.organization_id = p_organization_id and v.status = 'awaiting_signature' and v.time_out is not null
      and v.time_out <= now() - make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'confirmation_overdue'))
    union all
    select 'visit', 'needs_review', 'visit_review', 'visits',
           case when ogevia.visit_review_entered_at(v.id) <= now() - make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'review_overdue')) then 'urgent' else 'routine' end,
           ogevia.visit_review_entered_at(v.id) + make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'review_overdue')), ogevia.visit_review_entered_at(v.id), v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.service_visits v where p_can_visits and v.organization_id = p_organization_id and v.status = 'administrator_review'
      and not exists (select 1 from ogevia.visit_review_decisions d where d.visit_id = v.id and d.revoked_at is null) and ogevia.visit_recovery_state(v.id) is null
    union all
    select 'visit', 'late_response', 'visit_review', 'visits',
           case when ogevia.visit_late_response_at(v.id) <= now() - make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'review_overdue')) then 'urgent' else 'routine' end,
           ogevia.visit_late_response_at(v.id) + make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'review_overdue')), ogevia.visit_late_response_at(v.id), v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.service_visits v where p_can_visits and v.organization_id = p_organization_id and v.status = 'administrator_review' and ogevia.visit_recovery_state(v.id) = 'response_to_review'
    union all
    select 'visit', 'ready_for_approval', 'ready_for_approval', 'visits', 'routine', null::timestamptz, v.signed_at, v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.service_visits v where p_can_bill and v.organization_id = p_organization_id and v.status in ('signed', 'administrator_review') and ogevia.visit_billing_state(v.id) in ('ready_for_review', 'voided')
    union all
    select 'visit', 'authorization_decreased', 'visit_review', 'authorization', 'routine', null::timestamptz, h.created_at, v.client_id, v.caregiver_record_id, v.service_id, null::uuid, v.id, v.id
    from ogevia.visit_authorization_reviews h join ogevia.service_visits v on v.id = h.visit_id and v.status in ('signed', 'administrator_review')
    where p_can_visits and h.organization_id = p_organization_id and h.resolved_at is null
    union all
    -- pickup requests, reconciliation, amendment impacts
    select 'pickup_request', 'pending_pickup', 'pickup_requests', 'staffing', 'routine', null::timestamptz, r.requested_at, sh.client_id, null::uuid, sh.service_id, sh.id, null::uuid, r.id
    from ogevia.shift_pickup_requests r join ogevia.shifts sh on sh.id = r.shift_id
    where p_can_cover and r.organization_id = p_organization_id and r.status = 'pending' and sh.status = 'scheduled' and sh.ends_at > now()
    union all
    select 'shift', 'reconcile_' || ogevia.reservation_bucket(r.id)::text, 'reconciliation', 'authorization', 'routine', null::timestamptz, sh.ends_at, sh.client_id, null::uuid, sh.service_id, sh.id, null::uuid, sh.id
    from ogevia.authorization_reservations r join ogevia.shifts sh on sh.id = r.shift_id
    where p_can_cover and r.organization_id = p_organization_id and r.released_at is null and ogevia.reservation_bucket(r.id) in ('unreconciled', 'awaiting_record')
    union all
    select 'impact', i.impact_kind::text, 'authorization_changes', 'authorization', 'routine', null::timestamptz, i.created_at,
           coalesce(sh.client_id, v.client_id), null::uuid, coalesce(sh.service_id, v.service_id), i.shift_id, i.visit_id, i.id
    from ogevia.authorization_amendment_impacts i
    left join ogevia.shifts sh on sh.id = i.shift_id left join ogevia.service_visits v on v.id = i.visit_id
    where p_can_cover and i.organization_id = p_organization_id
      and not exists (select 1 from ogevia.authorization_amendment_impact_acks k where k.impact_id = i.id)
      and case when i.shift_id is not null then ogevia.reservation_bucket(i.reservation_id) is not null
               else exists (select 1 from ogevia.service_visits v2 where v2.id = i.visit_id and v2.status in ('signed', 'administrator_review')) end
  ), docs as (
    select d.document_id, d.caregiver_record_id, d.display_status, d.latest_uploaded_at, d.due_on, d.expires_on, d.currency_status
    from ogevia_api.list_staff_documents(p_organization_id, null) d where p_can_docs
  )
  select ('' || x.k || ':' || x.r || ':' || x.en::text)::text, x.k, x.r, x.q, x.cat, x.sev, x.dl, x.sn, x.cl, x.cg, x.sv, x.sf, x.vs, x.en
  from raw x
  union all
  select 'document:' || (case when d.display_status in ('expired', 'overdue') then d.display_status
                               when d.display_status = 'awaiting_review' then (case when esc.escalated then 'review_overdue' else 'awaiting_review' end)
                               when d.display_status = 'expiring' then 'expiring' else 'rejected' end) || ':' || d.document_id::text,
         'document', case when d.display_status in ('expired', 'overdue') then d.display_status
                          when d.display_status = 'awaiting_review' then (case when esc.escalated then 'review_overdue' else 'awaiting_review' end)
                          when d.display_status = 'expiring' then 'expiring' else 'rejected' end,
         'documents_compliance', 'documents',
         case when d.display_status in ('expired', 'overdue') or (d.display_status = 'awaiting_review' and esc.escalated) then 'urgent' else 'routine' end,
         case when d.display_status = 'awaiting_review' then d.latest_uploaded_at + make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'document_review_overdue'))
              else coalesce(d.expires_on::timestamptz, d.due_on::timestamptz) end,
         coalesce(d.latest_uploaded_at, now()), null::uuid, d.caregiver_record_id, null::uuid, null::uuid, null::uuid, d.document_id
  from docs d
  cross join lateral (select (d.display_status = 'awaiting_review'
              and (d.latest_uploaded_at <= now() - make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'document_review_overdue'))
                   or d.currency_status = 'expired'
                   or exists (select 1 from ogevia.shift_readiness_flags f join ogevia.shifts sh on sh.id = f.shift_id
                               where f.organization_id = p_organization_id and f.caregiver_record_id = d.caregiver_record_id and f.kind = 'document' and f.resolved_at is null
                                 and sh.status = 'scheduled' and sh.ends_at > now() and not ogevia.shift_is_called_out(sh.id)))) as escalated) esc
  where d.display_status in ('expired', 'overdue', 'expiring', 'awaiting_review', 'rejected')
  union all
  -- client documents (0074): a REQUIRED document that is expired is urgent; one waiting for review or rejected is routine (the routine review deadline moves it up like a staff document)
  select 'client_document:' || cd.state || ':' || cd.document_type_id::text || ':' || cd.client_id::text, 'client_document', cd.state, 'documents_compliance', 'documents',
         case when cd.state = 'expired' or (cd.state = 'review_overdue') then 'urgent' else 'routine' end,
         case when cd.state in ('awaiting_review', 'review_overdue') then cd.uploaded_at + make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'document_review_overdue')) else cd.expires_on::timestamptz end,
         coalesce(cd.uploaded_at, now()), cd.client_id, null::uuid, null::uuid, null::uuid, null::uuid,
         ogevia.stable_uuid('client_document:' || cd.client_id::text || ':' || cd.document_type_id::text)
  from (
    select x.client_id, x.document_type_id, x.uploaded_at, x.expires_on,
           case when x.review_status is null then null
                when x.review_status = 'awaiting_review' then (case when x.uploaded_at <= now() - make_interval(hours => ogevia.attention_rule_hours(p_organization_id, 'document_review_overdue')) then 'review_overdue' else 'awaiting_review' end)
                when x.review_status = 'rejected' then 'rejected'
                when x.expires_on is not null and x.expires_on < ogevia.organization_local_date(p_organization_id, now()) then 'expired' end as state
    from (
      select d.client_id, d.document_type_id, v.uploaded_at, v.expires_on, v.review_status
      from ogevia.client_documents d
      join ogevia.client_document_versions v on v.document_id = d.id and v.version_number = (select max(v2.version_number) from ogevia.client_document_versions v2 where v2.document_id = d.id)
      join ogevia.clients c on c.id = d.client_id and c.status = 'active' and c.deleted_at is null
      where p_can_docs and d.organization_id = p_organization_id
        and exists (select 1 from ogevia.client_document_requirements r join ogevia.client_authorizations a on a.service_id = r.service_id and a.client_id = d.client_id and a.is_current
                     where r.document_type_id = d.document_type_id and r.removed_at is null)
    ) x
  ) cd
  where cd.state is not null
  union all
  select 'caregiver:compliance_hold:' || h.caregiver_record_id::text, 'caregiver', 'compliance_hold', 'documents_compliance', 'compliance', 'routine', null::timestamptz, h.opened_at,
         null::uuid, h.caregiver_record_id, null::uuid, null::uuid, null::uuid, h.caregiver_record_id
  from ogevia.caregiver_compliance_holds h where p_can_comp and h.organization_id = p_organization_id and h.released_at is null;
end;
$$;

revoke all on function ogevia_api.list_client_document_types(uuid) from public;
revoke all on function ogevia_api.save_client_document_type(uuid, text, text, boolean, boolean, uuid) from public;
revoke all on function ogevia_api.set_client_document_requirement(uuid, uuid, uuid, boolean, uuid) from public;
revoke all on function ogevia_api.list_client_documents(uuid, uuid) from public;
revoke all on function ogevia_api.ensure_client_document(uuid, uuid, uuid) from public;
revoke all on function ogevia_api.get_client_document_upload_replay(uuid, uuid) from public;
revoke all on function ogevia_api.register_client_document_version(uuid, uuid, text, text, text, integer, text, date, date, uuid) from public;
revoke all on function ogevia_api.review_client_document_version(uuid, text, text, uuid) from public;
revoke all on function ogevia_api.open_client_document_version(uuid) from public;
revoke all on function ogevia_api.get_client_readiness(uuid, uuid) from public;
revoke all on function ogevia_api.set_client_preparation(uuid, uuid, text, text, uuid) from public;
revoke all on function ogevia_api.open_client_service_hold(uuid, uuid, uuid, text, uuid) from public;
revoke all on function ogevia_api.release_client_service_hold(uuid, uuid, text, uuid) from public;
revoke all on function ogevia_api.list_client_audit(uuid, uuid, integer) from public;
revoke all on function ogevia_api.get_client_issue_history(uuid, uuid) from public;
revoke all on function ogevia_api.find_possible_duplicate_clients(uuid, text, text, uuid) from public;
grant execute on function ogevia_api.list_client_document_types(uuid) to ogevia_app;
grant execute on function ogevia_api.save_client_document_type(uuid, text, text, boolean, boolean, uuid) to ogevia_app;
grant execute on function ogevia_api.set_client_document_requirement(uuid, uuid, uuid, boolean, uuid) to ogevia_app;
grant execute on function ogevia_api.list_client_documents(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.ensure_client_document(uuid, uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.get_client_document_upload_replay(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.register_client_document_version(uuid, uuid, text, text, text, integer, text, date, date, uuid) to ogevia_app;
grant execute on function ogevia_api.review_client_document_version(uuid, text, text, uuid) to ogevia_app;
grant execute on function ogevia_api.open_client_document_version(uuid) to ogevia_app;
grant execute on function ogevia_api.get_client_readiness(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.set_client_preparation(uuid, uuid, text, text, uuid) to ogevia_app;
grant execute on function ogevia_api.open_client_service_hold(uuid, uuid, uuid, text, uuid) to ogevia_app;
grant execute on function ogevia_api.release_client_service_hold(uuid, uuid, text, uuid) to ogevia_app;
grant execute on function ogevia_api.list_client_audit(uuid, uuid, integer) to ogevia_app;
grant execute on function ogevia_api.get_client_issue_history(uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.find_possible_duplicate_clients(uuid, text, text, uuid) to ogevia_app;
