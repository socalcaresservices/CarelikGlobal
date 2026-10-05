-- ROLLBACK 0027_continuity_pack | CLASS: SAFE AUTOMATED (refuses when records would be lost)
-- Refuses while any continuity pack download is recorded: the download history
-- (who received which agency's data, and which outage numbers were issued) must
-- not be lost. Otherwise removes the functions, the table and the permission.
do $$ begin
  if exists (select 1 from ogevia.continuity_exports) then
    raise exception 'ROLLBACK REFUSED: continuity pack downloads are recorded; export them first (they would be lost)';
  end if;
end $$;
drop function if exists ogevia_api.get_continuity_status(uuid);
drop function if exists ogevia_api.create_continuity_pack(uuid, uuid);
drop function if exists ogevia.continuity_guard(uuid);
drop table if exists ogevia.continuity_exports;
delete from ogevia.role_permissions where permission_key = 'continuity.export';
delete from ogevia.permissions where key = 'continuity.export';
