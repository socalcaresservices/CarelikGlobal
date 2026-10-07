-- ROLLBACK 0004_authorizations  |  CLASS: BACKUP REQUIRED
-- Drops versioned authorizations. Refuses while any authorization exists.
do $$ begin
  if exists (select 1 from ogevia.client_authorizations) then
    raise exception 'Refusing: authorization data exists. Snapshot + owner approval required.';
  end if;
end $$;
drop function if exists ogevia.lock_authorization_lineage(uuid);
drop function if exists ogevia.resolve_current_authorization(uuid, uuid, uuid, date);
drop table if exists ogevia.client_authorizations;
drop function if exists ogevia.forbid_delete();
drop function if exists ogevia.client_authorizations_guard_update();
drop function if exists ogevia.client_authorizations_before_insert();
delete from ogevia_meta.schema_migrations where version = '0004';
