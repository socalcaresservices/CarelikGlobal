begin;

-- organizations.show_powered_by (20260728020000) is fully wired for the
-- authenticated app shell (app-shell.tsx) but was never read by either
-- of the platform's two actual public-facing white-label surfaces - the
-- job application page (apply-page.tsx) and the document upload page
-- (upload-page.tsx). Those are exactly the pages this toggle matters
-- most for (shown to job applicants and clients, not staff), so it's
-- currently a no-op for its primary use case. Same pattern as Build 023's
-- accent_color additions: extend the one anon-callable lookup RPC each
-- page already calls to also return show_powered_by, then let the page
-- render its existing "Powered by CareLik" footer conditionally.

drop function if exists public.get_organization_by_slug(text);

create function public.get_organization_by_slug(target_slug text)
returns table (
  id uuid,
  display_name text,
  logo_url text,
  primary_color text,
  accent_color text,
  show_powered_by boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select o.id, o.display_name, o.logo_url, o.primary_color, o.accent_color, o.show_powered_by
  from public.organizations o
  where o.slug = target_slug and o.status = 'active' and o.deleted_at is null;
$$;

revoke all on function public.get_organization_by_slug(text) from public;
grant execute on function public.get_organization_by_slug(text) to anon, authenticated;

drop function if exists public.get_document_request_batch(text);

create function public.get_document_request_batch(target_token text)
returns table (
  batch_id uuid,
  organization_id uuid,
  organization_display_name text,
  organization_logo_url text,
  organization_primary_color text,
  organization_accent_color text,
  organization_show_powered_by boolean,
  subject_name text,
  message text,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    b.id,
    b.organization_id,
    o.display_name,
    o.logo_url,
    o.primary_color,
    o.accent_color,
    o.show_powered_by,
    b.subject_name,
    b.message,
    b.expires_at
  from public.document_request_batches b
  join public.organizations o on o.id = b.organization_id
  where b.token = target_token
    and b.deleted_at is null
    and (b.expires_at is null or b.expires_at > now());
$$;

revoke all on function public.get_document_request_batch(text) from public;
grant execute on function public.get_document_request_batch(text) to anon, authenticated;

commit;
