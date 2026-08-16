-- Close legacy SECURITY DEFINER grants that are not part of a public token flow.
-- PostgreSQL grants EXECUTE to PUBLIC on new functions by default, so revoke
-- both PUBLIC and anon explicitly before restoring authenticated-only access.

revoke all on function public.list_audit_logs(uuid, integer, bigint) from public, anon;
grant execute on function public.list_audit_logs(uuid, integer, bigint) to authenticated;

revoke all on function public.list_organization_credential_types(uuid, text) from public, anon;
grant execute on function public.list_organization_credential_types(uuid, text) to authenticated;

-- Trigger helpers must never be callable through the Data API.
revoke all on function public.set_default_client_code() from public, anon, authenticated;
