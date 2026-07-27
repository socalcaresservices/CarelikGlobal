begin;

-- Same completion as the previous migration, for the other public
-- white-label surface: the document upload page (Build 021) already
-- renders organization_primary_color on its upload buttons since that
-- was the only branding field available at the time. Adding
-- organization_accent_color here lets upload-page.tsx prefer it
-- (falling back to primary_color, then the page's own default) for the
-- same "accent = interactive/CTA color" reasoning as the apply page.
drop function if exists public.get_document_request_batch(text);

create function public.get_document_request_batch(target_token text)
returns table (
  batch_id uuid,
  organization_id uuid,
  organization_display_name text,
  organization_logo_url text,
  organization_primary_color text,
  organization_accent_color text,
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
