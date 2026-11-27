-- 0125 rollback (PENDING). SAFE: the migration added one read function and changed no stored value.
drop function if exists ogevia_api.list_authorization_worklist(uuid, date, uuid, uuid, text, text, integer, integer, date, date);
