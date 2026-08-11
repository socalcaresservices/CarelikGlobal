begin;

-- The prior "revoke execute ... from public" wasn't enough - pg_proc.proacl
-- showed anon and authenticated held EXPLICIT individual EXECUTE grants
-- (Supabase's default-privilege auto-grant on new/replaced functions in
-- the public schema), not an inherited PUBLIC grant, so revoking from
-- "public" alone didn't touch them. Revoke from the actual roles.
revoke execute on function public.prevent_tenant_subscription_edit() from anon, authenticated;

commit;
