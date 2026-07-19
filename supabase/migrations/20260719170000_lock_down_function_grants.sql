begin;

-- Every function in this schema was, until now, callable by unauthenticated
-- (anon) requests, including claim_domain_events / complete_domain_event /
-- fail_domain_event which have no internal auth check at all - meaning
-- anyone could hit /rest/v1/rpc/claim_domain_events and mutate the outbox.
--
-- "revoke all on function ... from public" (used throughout this schema)
-- only revokes the implicit PUBLIC pseudo-role grant. It does NOT revoke
-- privileges Supabase's default-privilege setup already grants directly
-- to the anon/authenticated/service_role roles at CREATE FUNCTION time.
-- Those need an explicit "revoke execute ... from <role>" naming the role.
--
-- Confirmed by querying has_function_privilege('anon', ...) directly:
-- every function in public, including the service_role-only outbox
-- functions, returned true for anon before this migration.

-- Meant only for the trusted worker (service_role) - never anon/authenticated.
revoke execute on function public.claim_domain_events(integer) from anon, authenticated;
revoke execute on function public.complete_domain_event(uuid) from anon, authenticated;
revoke execute on function public.fail_domain_event(uuid, text, integer) from anon, authenticated;

-- Meant for signed-in users only; each one is a no-op/returns nothing
-- meaningful for anon in practice (they all key off auth.uid(), which is
-- null for anon), but they shouldn't be reachable at all.
revoke execute on function public.is_platform_owner() from anon;
revoke execute on function public.is_organization_member(uuid) from anon;
revoke execute on function public.has_permission(uuid, text) from anon;
revoke execute on function public.accept_organization_invitation(uuid) from anon;
revoke execute on function public.list_organization_members(uuid) from anon;
revoke execute on function public.create_organization(text, text, text, text, text) from anon;

-- Trigger-only functions. Postgres already refuses to invoke these
-- directly (they return "trigger", not a normal value) regardless of
-- grants, but there's no reason for them to appear callable via
-- /rest/v1/rpc/... at all.
revoke execute on function public.handle_new_user() from anon, authenticated;
revoke execute on function public.set_updated_at() from anon, authenticated;
revoke execute on function public.write_audit_log() from anon, authenticated;

commit;
