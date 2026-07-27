-- Build 020: Tenant isolation audit fixes.
--
-- Full audit covered: RLS + policy inventory on all 27 public-schema tables,
-- every SECURITY DEFINER function, storage bucket policies. Two functions and
-- one RLS policy allowed a caller to act outside the organization boundary
-- implied by their own permissions. Fixed below; everything else audited
-- clean (see Build 020 report).
--
-- 1) get_caregiver_location / set_caregiver_profile checked
--    has_permission(target_organization_id, ...) but never verified that
--    target_user_id actually belongs to target_organization_id. Since
--    target_organization_id is caller-supplied, any staff member with
--    membership.read/update in their OWN organization could pass their own
--    org id alongside an arbitrary user_id and read or overwrite that
--    person's profile (city/state/zip/languages/skills) even if that person
--    has no relationship to the caller's organization at all.
--
-- 2) caregiver_availability's self_or_authorized_manage_availability policy
--    let any authenticated user write rows where caregiver_user_id =
--    auth.uid(), for ANY organization_id, with no check that they are a
--    member of that organization. A caregiver could plant availability rows
--    under an organization they don't belong to.
--
-- Fix pattern: mirror the already-correct get_caregiver_notes /
-- set_caregiver_notes functions, which scope through organization_memberships
-- so a mismatched (org, user) pair simply matches no rows.

create or replace function public.get_caregiver_location(target_organization_id uuid, target_user_id uuid)
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
      or (
        public.has_permission(target_organization_id, 'membership.read')
        and exists (
          select 1 from public.organization_memberships m
          where m.organization_id = target_organization_id
            and m.user_id = target_user_id
        )
      )
    );
$$;

create or replace function public.set_caregiver_profile(
  target_organization_id uuid,
  target_user_id uuid,
  new_address_city text,
  new_address_state text,
  new_address_zip text,
  new_languages text[],
  new_skills text[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if target_user_id != auth.uid() then
    if not public.has_permission(target_organization_id, 'membership.update') then
      raise exception 'You do not have permission to edit this caregiver''s profile';
    end if;

    if not exists (
      select 1 from public.organization_memberships m
      where m.organization_id = target_organization_id
        and m.user_id = target_user_id
    ) then
      raise exception 'No membership found for that user in this organization';
    end if;
  end if;

  update public.user_profiles
  set address_city = new_address_city,
      address_state = new_address_state,
      address_zip = new_address_zip,
      languages = coalesce(new_languages, '{}'),
      skills = coalesce(new_skills, '{}')
  where id = target_user_id;

  if not found then
    raise exception 'No profile found for that user';
  end if;
end;
$$;

revoke all on function public.get_caregiver_location(uuid, uuid) from public, anon;
grant execute on function public.get_caregiver_location(uuid, uuid) to authenticated;

revoke all on function public.set_caregiver_profile(uuid, uuid, text, text, text, text[], text[]) from public, anon;
grant execute on function public.set_caregiver_profile(uuid, uuid, text, text, text, text[], text[]) to authenticated;

drop policy if exists self_or_authorized_manage_availability on public.caregiver_availability;

create policy self_or_authorized_manage_availability on public.caregiver_availability
  for all
  to authenticated
  using (
    (caregiver_user_id = auth.uid() and public.is_organization_member(organization_id))
    or public.has_permission(organization_id, 'membership.update')
  )
  with check (
    (caregiver_user_id = auth.uid() and public.is_organization_member(organization_id))
    or public.has_permission(organization_id, 'membership.update')
  );
