begin;

-- Ogevia Architecture Reset (item 22): stable, hyphenated slug matching
-- the mandate's explicit example - organizations.slug is now load-bearing
-- URL routing (app.ogevia.com/org/<slug>), not just a cosmetic label, so
-- it needs to be predictable and match documented examples exactly.
update public.organizations
set slug = 'socal-care-services'
where slug = 'socalcareservices';

-- Item 23/28: Ogethinks stays a real, isolated second tenant for
-- cross-organization RLS isolation testing (item 28's explicit
-- requirement - a client created under SoCal must be provably
-- unreachable from an Ogethinks-only account, and vice versa). Reversing
-- the 20260809141427 suspension: that migration's own comment already
-- noted "no RLS policy or permission function in this schema currently
-- checks organizations.status" - it is a pure lifecycle label with no
-- security effect either way, so reactivating it here does not weaken
-- anything; it only makes Ogethinks usable again for the isolation test
-- this directive requires.
update public.organizations
set status = 'active'
where slug = 'ogethinks';

commit;
