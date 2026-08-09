begin;

-- Same class of gap fixed previously for set_default_client_code() in
-- 20260809043500_lock_down_client_code_trigger_grant.sql: creating a
-- function grants PUBLIC execute by default unless revoked. A trigger
-- function has no legitimate reason to be callable directly via
-- PostgREST (/rest/v1/rpc/set_shift_visit_number) - triggers fire with
-- the definer's rights regardless of role grants, so revoking these
-- doesn't affect the trigger itself, only closes the direct-call path.
revoke all on function public.set_shift_visit_number() from public, anon, authenticated;

commit;
