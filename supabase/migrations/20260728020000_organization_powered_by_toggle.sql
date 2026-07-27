begin;

-- Layer 3 (Brand Layer) asks for an "Optional Powered by CareLik ON/OFF"
-- toggle - the only branding field from that list that didn't already
-- exist on organizations (logo_url/primary_color/secondary_color/
-- accent_color/theme_mode all shipped with onboarding, 20260727080000).
-- Defaults true so every existing organization keeps showing the
-- current "Powered by CareLik" footer until an owner explicitly turns
-- it off - opt-out, not opt-in, since removing platform attribution is
-- the organization's choice to make, not a silent default.
alter table public.organizations
  add column show_powered_by boolean not null default true;

commit;
