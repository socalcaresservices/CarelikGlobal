begin;

-- Small additive companion to set_caregiver_profile(): lets the caregiver
-- detail page show a caregiver's current location/languages/skills.
-- Gated on self OR membership.read (a lower bar than membership.update,
-- since this is read-only and membership.read is already what gates
-- seeing the caregiver's page at all).
create or replace function public.get_caregiver_location(
  target_organization_id uuid,
  target_user_id uuid
)
returns table (
  address_city text,
  address_state text,
  address_zip text,
  languages text[],
  skills text[]
)
language sql
stable
security definer
set search_path = public
as $$
  select p.address_city, p.address_state, p.address_zip, p.languages, p.skills
  from public.user_profiles p
  where p.id = target_user_id
    and (
      target_user_id = auth.uid()
      or public.has_permission(target_organization_id, 'membership.read')
    );
$$;

revoke all on function public.get_caregiver_location(uuid, uuid) from public;
grant execute on function public.get_caregiver_location(uuid, uuid) to authenticated;
revoke execute on function public.get_caregiver_location(uuid, uuid) from anon;

commit;
