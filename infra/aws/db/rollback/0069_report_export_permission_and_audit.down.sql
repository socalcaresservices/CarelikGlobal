-- ROLLBACK 0069 | CLASS: BACKUP REQUIRED (the export ledger is dropped; audit events of exports are kept). Removes the export functions, ledger and permission.
drop function ogevia_api.list_report_exports(uuid, integer);
drop function ogevia_api.record_report_export(uuid, text, jsonb, integer, text);
drop table ogevia.report_exports;
delete from ogevia.role_permissions where permission_key = 'reports.export';
delete from ogevia.permissions where key = 'reports.export';
