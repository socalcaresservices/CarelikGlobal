-- ROLLBACK 0001_roles_schemas_extensions  |  CLASS: FORWARD FIX PREFERRED
-- Run as the administrator. Drops the (empty) schemas. Roles and the
-- btree_gist extension are cluster/database-wide and may be used elsewhere;
-- they are left in place on purpose and removed only by a deliberate,
-- separately approved step.
drop schema if exists ogevia_api;
drop schema if exists ogevia;
delete from ogevia_meta.schema_migrations where version = '0001';
