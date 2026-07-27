begin;

-- Build 023: the public /apply/:orgSlug page (apply-page.tsx) is the
-- first thing a job applicant ever sees of an agency's brand, and today
-- it shows none of it - no logo, and its CTA buttons all use the same
-- static --color-accent default (apps/web/src/index.css) regardless of
-- which organization the applicant is applying to. Meanwhile
-- organizations.logo_url/primary_color/accent_color have been
-- captured and editable via organizations-page.tsx since Build 014/018,
-- just never read back out on this specific page because
-- get_organization_by_slug() only ever returned id/display_name.
--
-- This closes that gap the same way Build 021's get_document_request_batch
-- already does for the document upload page: extend the one anon-callable
-- lookup RPC this page uses to also return the branding fields, then let
-- the page apply them. accent_color is the field used here (not
-- primary_color, which Build 018 already dedicated to nav-active-state
-- inside the authenticated app shell) - organizations-page.tsx's edit
-- form already presents Primary/Secondary/Accent as three distinct
-- pickers, and "the CTA/interactive color" is exactly what "accent"
-- conventionally means, so this gives that field its first real
-- consumer instead of leaving it to keep sitting unused.
--
-- secondary_color and theme_mode remain unused after this build - giving
-- every button across the authenticated app a dynamic accent color would
-- be a much larger, more visible product change (packages/ui's Button
-- component is shared by every internal page) and is deliberately left
-- for a follow-up decision rather than folded in here.

drop function if exists public.get_organization_by_slug(text);

create function public.get_organization_by_slug(target_slug text)
returns table (id uuid, display_name text, logo_url text, primary_color text, accent_color text)
language sql
stable
security definer
set search_path = public
as $$
  select o.id, o.display_name, o.logo_url, o.primary_color, o.accent_color
  from public.organizations o
  where o.slug = target_slug and o.status = 'active' and o.deleted_at is null;
$$;

revoke all on function public.get_organization_by_slug(text) from public;
grant execute on function public.get_organization_by_slug(text) to anon, authenticated;

commit;
