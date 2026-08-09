begin;

-- Same class of gap fixed in 20260719175000_lock_down_trigger_function_grants.sql:
-- a trigger function with no explicit revoke keeps its implicit PUBLIC grant,
-- which flows through to anon and authenticated regardless of any per-role
-- revoke added later. set_default_client_code() is trigger-only (Postgres
-- refuses to invoke it directly, since it returns "trigger"), but there's no
-- reason for it to appear executable via /rest/v1/rpc/... at all.
revoke execute on function public.set_default_client_code() from public;

commit;
