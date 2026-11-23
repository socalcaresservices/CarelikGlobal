\set ON_ERROR_STOP on
\if :{?fresh_only}
\else
  \set fresh_only false
\endif
\if :fresh_only
-- Isolated cutover: fail if the name already exists; never adopt or overwrite it.
create database ogevia_sv_test;
\else
-- TEST SLICE / step 1 of 3 (YELLOW: run only under the consolidated approval).
-- Run as the RDS master user, connected to the `postgres` database, through
-- the SSM port-forward documented in docs/aws/TEST_SLICE_DEPLOYMENT_APPROVAL.md.
-- Creates a SEPARATE database for synthetic test data so the future production
-- database starts clean. Idempotent.
select 'create database ogevia_sv_test'
where not exists (select 1 from pg_database where datname = 'ogevia_sv_test')
\gexec
revoke all on database ogevia_sv_test from public;

\endif
\if :fresh_only
revoke all on database ogevia_sv_test from public;
\endif
