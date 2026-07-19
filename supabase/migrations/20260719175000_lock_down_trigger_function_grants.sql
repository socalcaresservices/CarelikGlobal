begin;

-- Follow-up to 20260719170000_lock_down_function_grants.sql.
--
-- After that migration, has_function_privilege() checks against a live
-- project still showed anon_can=true / authenticated_can=true for
-- handle_new_user, set_updated_at, and write_audit_log. Reason: unlike
-- the functions touched in 20260719170000 (which all had an explicit
-- "revoke all on function ... from public" at creation time), these
-- three never had any revoke statement at all in their original
-- migrations. The implicit PUBLIC grant Postgres adds at CREATE FUNCTION
-- time was therefore still in effect, and PUBLIC grants flow through to
-- every role - including anon and authenticated - regardless of any
-- per-role revoke. Confirmed via direct pg_proc.proacl inspection.
--
-- These are trigger-only functions (Postgres refuses to invoke them
-- directly since they return "trigger", not a normal value) but there is
-- no reason for them to appear executable via /rest/v1/rpc/... at all.
revoke execute on function public.handle_new_user() from public;
revoke execute on function public.set_updated_at() from public;
revoke execute on function public.write_audit_log() from public;

commit;
