-- PRODUCTION / step 1. Run as the RDS master user connected to the `postgres`
-- database (deploy-production.sh does this through the SSM tunnel).
-- Creates ogevia_prd ONLY if it does not exist. Never drops, recreates, or
-- alters an existing database. Idempotent.
\set ON_ERROR_STOP on
select 'create database ogevia_prd'
where not exists (select 1 from pg_database where datname = 'ogevia_prd')
\gexec
-- No role gets implicit access: only roles granted CONNECT explicitly (11_*)
-- can connect, so the test slice's application login cannot.
revoke all on database ogevia_prd from public;
