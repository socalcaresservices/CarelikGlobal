-- Run from infra/aws (it uses \i db/rollback/...). Pilot first; production only with a separate owner approval. See ../DEPLOYMENT_PLAN.md section 10.
\set ON_ERROR_STOP on
begin; set local role ogevia_owner; \i db/rollback/0049_reservation_not_counted_when_late_confirmation_accepted.down.sql
reset role; delete from ogevia_meta.schema_migrations where version = '0049'; commit;
begin; set local role ogevia_owner; \i db/rollback/0048_account_status_enable_disable.down.sql
reset role; delete from ogevia_meta.schema_migrations where version = '0048'; commit;
begin; set local role ogevia_owner; \i db/rollback/0047_availability_override_one_shift.down.sql
reset role; delete from ogevia_meta.schema_migrations where version = '0047'; commit;
select count(*) || '|' || max(version) as ledger from ogevia_meta.schema_migrations;
