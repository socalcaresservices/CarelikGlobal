-- ROLLBACK 0094 | CLASS: SAFE. Drops the function and removes only the CPR/TB types this migration created (audit source 'standard_types_0094') that no document, requirement or request uses.
delete from ogevia.document_types t
 where exists (select 1 from ogevia.audit_events a where a.entity_id = t.id and a.action = 'document_type.created' and a.after_state ->> 'source' = 'standard_types_0094')
   and not exists (select 1 from ogevia.staff_documents d where d.document_type_id = t.id);
drop function if exists ogevia.ensure_standard_document_types(uuid);
