begin;

-- Same class of bug fixed in 20260719170000_lock_down_function_grants.sql:
-- "revoke all ... from public" doesn't touch the EXECUTE grant Supabase's
-- default-privilege setup gives directly to anon/authenticated at
-- CREATE FUNCTION time. list_audit_logs and list_shifts (both added this
-- session) were missed - get_advisors caught both as callable by anon
-- without signing in at all. Neither should be: both key their access off
-- auth.uid(), which is null for anon, so an anon caller would only ever
-- get back rows with no organization match anyway, but there's no reason
-- to leave the door open.
revoke execute on function public.list_audit_logs(uuid, integer) from anon;
revoke execute on function public.list_shifts(uuid, timestamptz, timestamptz) from anon;

commit;
