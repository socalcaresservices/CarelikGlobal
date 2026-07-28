begin;

-- organization-branding is a *public* bucket (20260727100000) - anyone
-- with organization.update can upload a logo, and the resulting object
-- is served directly, unauthenticated, at a public storage URL. Every
-- current render goes through <img src>, which is safe for SVG, but the
-- public URL itself can also be opened directly in a browser tab (or
-- linked/shared) - and a browser navigating straight to an SVG executes
-- any <script> it contains in the Supabase project's origin. A
-- compromised or malicious org admin could use that as a stored-XSS
-- vector. No existing objects in this bucket are SVGs (confirmed via
-- storage.objects before this migration), so this is a clean allowlist
-- tightening, not a backfill.
update storage.buckets
set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
where id = 'organization-branding';

commit;
