-- Versioned private attachments for agency business documents.
create table ogevia.business_document_files (
  id uuid primary key,
  document_id uuid not null references ogevia.business_documents(id),
  object_key text not null,
  storage_version text,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  content_type text not null,
  created_at timestamptz not null default now()
);
create index business_document_files_document_idx on ogevia.business_document_files(document_id, created_at desc);
alter table ogevia.business_document_files enable row level security;

create function ogevia_api.list_business_document_files(p_org uuid)
returns table(document_id uuid, id uuid, created_at timestamptz)
language sql stable security definer set search_path = ogevia, pg_temp as $$
  select f.document_id, f.id, f.created_at
  from ogevia.business_document_files f join ogevia.business_documents d on d.id=f.document_id
  where d.organization_id=p_org and ogevia.is_active_member(p_org) and ogevia.has_permission(p_org,'accounts.manage')
  order by f.created_at desc, f.id;
$$;

create function ogevia_api.open_business_document_file(p_org uuid, p_id uuid)
returns table(object_key text, storage_version text, sha256 text, content_type text)
language sql stable security definer set search_path = ogevia, pg_temp as $$
  select f.object_key,f.storage_version,f.sha256,f.content_type
  from ogevia.business_document_files f join ogevia.business_documents d on d.id=f.document_id
  where f.id=p_id and d.organization_id=p_org and ogevia.is_active_member(p_org)
    and ogevia.has_permission(p_org,'accounts.manage');
$$;

create function ogevia_api.register_business_document_file(
  p_org uuid,p_doc uuid,p_id uuid,p_key text,p_version text,p_sha text,p_type text
) returns uuid language plpgsql security definer set search_path = ogevia, pg_temp as $$
begin
  if not ogevia.is_active_member(p_org) or not ogevia.has_permission(p_org,'accounts.manage') then
    raise exception 'Forbidden' using errcode='OGA03';
  end if;
  if not exists(select 1 from ogevia.business_documents d where d.organization_id=p_org and d.id=p_doc for update) then
    raise exception 'Document not found' using errcode='OGN04';
  end if;
  if p_key <> p_org::text || '/documents/' || p_doc::text || '/' || p_id::text then
    raise exception 'Invalid attachment storage key' using errcode='OGV22';
  end if;
  insert into ogevia.business_document_files(id,document_id,object_key,storage_version,sha256,content_type)
    values(p_id,p_doc,p_key,p_version,p_sha,p_type) on conflict (id) do nothing;
  if found then
    update ogevia.business_documents set reviewed_at=null,updated_at=date_trunc('milliseconds',clock_timestamp()) where id=p_doc;
    perform ogevia.write_audit(p_org,'business_document.attachment_added','business_documents',p_doc,null,jsonb_build_object('attachment_id',p_id),null);
  elsif not exists(select 1 from ogevia.business_document_files where id=p_id and document_id=p_doc and sha256=p_sha and content_type=p_type) then
    raise exception 'This upload was already used for a different file' using errcode='OGC09';
  end if;
  return p_id;
end;
$$;
revoke all on function ogevia_api.list_business_document_files(uuid) from public;
revoke all on function ogevia_api.open_business_document_file(uuid,uuid) from public;
revoke all on function ogevia_api.register_business_document_file(uuid,uuid,uuid,text,text,text,text) from public;
grant execute on function ogevia_api.list_business_document_files(uuid) to ogevia_app;
grant execute on function ogevia_api.open_business_document_file(uuid,uuid) to ogevia_app;
grant execute on function ogevia_api.register_business_document_file(uuid,uuid,uuid,text,text,text,text) to ogevia_app;
