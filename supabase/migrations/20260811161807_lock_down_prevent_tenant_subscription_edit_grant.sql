begin;

-- Same gap as 20260719175000_lock_down_trigger_function_grants.sql:
-- prevent_tenant_subscription_edit() (20260807133158) never had an
-- explicit revoke, so the implicit PUBLIC grant Postgres adds at CREATE
-- FUNCTION time was still in effect, flowing through to anon and
-- authenticated regardless of any per-role revoke - confirmed via
-- get_advisors() flagging it as anon-callable via /rest/v1/rpc/. It's a
-- trigger-only function (Postgres refuses to invoke it directly since it
-- returns "trigger", not a normal value) but there's no reason for it to
-- appear executable via the REST API at all.
revoke execute on function public.prevent_tenant_subscription_edit() from public;

commit;
