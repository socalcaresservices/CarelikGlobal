begin;

-- Org logo upload was deliberately deferred in Build 013 (the wizard's
-- Branding step only took a plain URL text field) pending "a real
-- storage-bucket subsystem." That subsystem already exists for internal
-- documents (see 20260715000100_platform_foundation.sql's
-- 'organization-documents' bucket), but that bucket is private and keyed
-- to files.read/files.create/files.delete - wrong fit for a branding
-- asset that needs to render on public surfaces (login screen, the
-- public /apply/:orgSlug page, sidebar) without an authenticated request.
--
-- This adds a separate, public bucket for exactly that: small
-- (5MB), public read (no auth needed to display a logo), write access
-- gated by organization.update (the same permission
-- organizations-page.tsx already checks to allow editing an org's
-- profile) so only an org's own owner/admin - or a platform owner, via
-- has_permission()'s existing unconditional bypass - can upload one.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'organization-branding',
  'organization-branding',
  true,
  5242880,
  array['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']
)
on conflict (id) do nothing;

-- Public bucket already serves GET requests through the public URL
-- endpoint without consulting RLS, but an explicit select policy keeps
-- direct API/listing calls consistent and makes the intent explicit.
create policy "public_read_organization_branding" on storage.objects for select
to public
using (bucket_id = 'organization-branding');

create policy "organization_admins_upload_branding" on storage.objects for insert to authenticated
with check (
  bucket_id = 'organization-branding'
  and public.has_permission(nullif((storage.foldername(name))[1], '')::uuid, 'organization.update')
);

create policy "organization_admins_update_branding" on storage.objects for update to authenticated
using (
  bucket_id = 'organization-branding'
  and public.has_permission(nullif((storage.foldername(name))[1], '')::uuid, 'organization.update')
)
with check (
  bucket_id = 'organization-branding'
  and public.has_permission(nullif((storage.foldername(name))[1], '')::uuid, 'organization.update')
);

create policy "organization_admins_delete_branding" on storage.objects for delete to authenticated
using (
  bucket_id = 'organization-branding'
  and public.has_permission(nullif((storage.foldername(name))[1], '')::uuid, 'organization.update')
);

commit;
