begin;

-- Caregiver notes: internal, staff-authored notes about a caregiver -
-- same model as incidents/credentials (records staff keep about a
-- caregiver), not a self-editable profile field like
-- set_caregiver_profile's location/languages/skills. Gives the Workforce
-- Profile a Notes tab, matching the one Client detail already has
-- (client_detail's care_notes) - profile pages should share the same
-- tab set where the underlying concept exists for both.
--
-- Lives on organization_memberships, not user_profiles, so a note one
-- agency keeps about a caregiver never leaks to another agency the same
-- person might also work for. This deliberately does NOT follow
-- get_caregiver_location's existing user_profiles-based pattern for
-- address/languages/skills - that's a pre-existing tenant-isolation gap
-- in this schema, not something this build changes.
alter table public.organization_memberships add column notes text;

-- No self-edit carve-out (unlike set_caregiver_profile) - these are
-- staff notes about a caregiver, not the caregiver's own profile, so
-- only membership.update can write them.
create function public.set_caregiver_notes(
  target_organization_id uuid,
  target_user_id uuid,
  new_notes text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_permission(target_organization_id, 'membership.update') then
    raise exception 'You do not have permission to edit notes for this caregiver';
  end if;

  update public.organization_memberships
  set notes = new_notes
  where organization_id = target_organization_id
    and user_id = target_user_id;

  if not found then
    raise exception 'No membership found for that user in this organization';
  end if;
end;
$$;

revoke all on function public.set_caregiver_notes(uuid, uuid, text) from public;
grant execute on function public.set_caregiver_notes(uuid, uuid, text) to authenticated;
revoke execute on function public.set_caregiver_notes(uuid, uuid, text) from anon;

-- Deliberately a standalone RPC rather than folded into
-- get_caregiver_location (which already returns a caregiver's own
-- location/languages/skills to themselves via a self-or-membership.read
-- gate): these are staff notes ABOUT the caregiver, not their own
-- profile, so a caregiver must not be able to read them about
-- themselves the way they can their own address/skills. membership.read
-- only, no self carve-out - reusing get_caregiver_location's function
-- for this would have silently given every caregiver read access to
-- their own staff notes via that self-carve-out.
create function public.get_caregiver_notes(
  target_organization_id uuid,
  target_user_id uuid
)
returns table (notes text)
language sql
stable
security definer
set search_path = public
as $$
  select m.notes
  from public.organization_memberships m
  where m.organization_id = target_organization_id
    and m.user_id = target_user_id
    and public.has_permission(target_organization_id, 'membership.read');
$$;

revoke all on function public.get_caregiver_notes(uuid, uuid) from public;
grant execute on function public.get_caregiver_notes(uuid, uuid) to authenticated;
revoke execute on function public.get_caregiver_notes(uuid, uuid) from anon;

commit;
