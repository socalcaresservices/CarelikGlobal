-- DATABASE ROLLBACK of Wave 1: migrations 0052, 0051, 0050, 0049, 0048, 0047, newest first. REHEARSED on a local database only.
-- Run from infra/aws of the checked-out release SHA (it uses \i db/rollback/...), AFTER the web and API steps of the rollback:
--   psql "$OGEVIA_DATABASE_URL" -f ../../docs/releases/2026-10-14-pilot-readiness/rollback-0047-0052.sql     -- expect the last line 46|0046
-- Pilot first; production only with a separate owner approval and a backup. Each block is its own transaction (as ogevia_owner)
-- and the script stops at the first error (ON_ERROR_STOP), leaving everything above it rolled back and everything below it in place.
--
-- THE DOWN SCRIPTS REFUSE (this is protection, not a bug) when records they cannot keep exist:
--   0050 refuses while any agency visit rule, any recorded rule evaluation, any unscheduled-visit reason or any attestation version
--        exists. After the pilot has used Wave 1 (any confirmed visit stores a rule evaluation) it WILL refuse. The way back is then a
--        forward fix, or a restore of the pre-deployment snapshot to a NEW instance (separate approval), never deleting those rows.
--   0048: accounts disabled while 0048 was live STAY disabled and nothing can re-enable them afterwards: re-enable them FIRST.
--   0047: overrides made under 0047 keep their new columns.
-- After this script `db:verify` reports FAIL by design (it expects 0052).
\set ON_ERROR_STOP on
begin; set local role ogevia_owner; \i db/rollback/0052_reservation_not_counted_when_review_visit_counted_as_used.down.sql
reset role; delete from ogevia_meta.schema_migrations where version = '0052'; commit;
begin; set local role ogevia_owner; \i db/rollback/0051_wave1_open_shift_pickup.down.sql
reset role; delete from ogevia_meta.schema_migrations where version = '0051'; commit;
begin; set local role ogevia_owner; \i db/rollback/0050_wave1_visit_review_and_variance_rule.down.sql
reset role; delete from ogevia_meta.schema_migrations where version = '0050'; commit;
begin; set local role ogevia_owner; \i db/rollback/0049_reservation_not_counted_when_late_confirmation_accepted.down.sql
reset role; delete from ogevia_meta.schema_migrations where version = '0049'; commit;
begin; set local role ogevia_owner; \i db/rollback/0048_account_status_enable_disable.down.sql
reset role; delete from ogevia_meta.schema_migrations where version = '0048'; commit;
begin; set local role ogevia_owner; \i db/rollback/0047_availability_override_one_shift.down.sql
reset role; delete from ogevia_meta.schema_migrations where version = '0047'; commit;
select count(*) || '|' || max(version) as ledger from ogevia_meta.schema_migrations;
