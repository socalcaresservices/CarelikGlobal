-- ROLLBACK 0021_staff_documents | CLASS: BACKUP REQUIRED
-- Removes the documents module. Refuses while any document request or
-- version exists: they are employment/compliance records, and the files in
-- S3 ({org}/documents/...) are NOT deleted by this script. Export and get
-- owner approval first.
do $$ begin
  if to_regclass('ogevia.staff_documents') is not null
     and (exists (select 1 from ogevia.staff_documents) or exists (select 1 from ogevia.document_versions)) then
    raise exception 'Refusing: document records exist. Snapshot + owner approval + forward fix required.';
  end if;
end $$;
drop function if exists ogevia_api.get_document_alerts(uuid, integer);
drop function if exists ogevia_api.open_document_version(uuid);
drop function if exists ogevia_api.review_document_version(uuid, text, text, uuid);
drop function if exists ogevia_api.get_document_upload_replay(uuid, uuid);
drop function if exists ogevia_api.register_document_version(uuid, uuid, text, text, text, integer, text, date, date, uuid);
drop function if exists ogevia_api.list_staff_documents(uuid, integer);
drop function if exists ogevia_api.request_staff_document(uuid, uuid, uuid, date, uuid);
drop function if exists ogevia_api.list_document_people(uuid);
drop function if exists ogevia_api.list_document_types(uuid);
drop function if exists ogevia_api.create_document_type(uuid, text, boolean, uuid);
drop function if exists ogevia.document_access(uuid, boolean);
drop function if exists ogevia.my_caregiver_record(uuid);
drop table if exists ogevia.document_versions;
drop table if exists ogevia.staff_documents;
drop table if exists ogevia.document_types;
drop function if exists ogevia.document_versions_guard_update();
drop type if exists ogevia.document_review_status;
delete from ogevia.role_permissions where permission_key in ('documents.read', 'documents.manage', 'documents.manage_own', 'documents.review_own');
delete from ogevia.permissions where key in ('documents.read', 'documents.manage', 'documents.manage_own', 'documents.review_own');
