-- 0093 (PENDING: infra/aws/db/pending, not in the released set) | CLASS: ADDITIVE (one table, two functions). Not applied to any database.
-- R6: why duplicate staff appear and a safe way to resolve them. list_staff shows staff profiles, caregiver records and sign-in memberships side by side with no
-- shared identity, so one person entered twice (or invited, then added) appears twice. This adds:
--   * list_possible_duplicate_staff: READ-ONLY report of people who share a normalized email, a phone number (digits, 7 or more) or a full name. Changes nothing.
--   * merge_staff_profiles: marks ONE staff profile as a duplicate of another (the duplicate becomes inactive and is linked), with a reason, an append-only link row and
--     an audit event. It refuses unless the two really match (same email, phone or name: a hard match), and refuses a duplicate that has a sign-in, a pending invitation
--     (a caregiver is never a staff profile, so a caregiver can appear in the report but cannot be merged here; caregivers carry schedule and visit history and are resolved in the Care Team). Nothing is deleted and nothing is copied;
--     setting the duplicate active again in Staff reverses it.
-- Rollback: pending/rollback/0093_staff_duplicates.down.sql
create table ogevia.staff_merge_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references ogevia.organizations(id),
  kept_profile_id uuid not null,
  merged_profile_id uuid not null,
  match_basis text not null check (match_basis in ('email', 'phone', 'name')),
  reason text not null check (length(btrim(reason)) between 5 and 500),
  merged_by uuid not null references ogevia.app_users(id),
  merged_at timestamptz not null default now(),
  foreign key (kept_profile_id, organization_id) references ogevia.staff_profiles (id, organization_id),
  foreign key (merged_profile_id, organization_id) references ogevia.staff_profiles (id, organization_id),
  constraint staff_merge_links_distinct check (kept_profile_id <> merged_profile_id),
  constraint staff_merge_links_once unique (merged_profile_id)
);
alter table ogevia.staff_merge_links enable row level security;
create trigger staff_merge_links_append_only before update or delete on ogevia.staff_merge_links
for each row execute function ogevia.append_only_guard();
grant select on table ogevia.staff_merge_links to ogevia_readonly;
create policy readonly_select on ogevia.staff_merge_links for select to ogevia_readonly using (true);

create function ogevia_api.list_possible_duplicate_staff(p_organization_id uuid)
returns table (
  group_id text, match_basis text, staff_key text, source text, profile_id uuid, caregiver_record_id uuid, user_id uuid, display_name text, staff_type_name text,
  contact_email text, phone text, status text, access_status text, can_merge boolean
)
language plpgsql
stable
security definer
set search_path = ogevia, pg_temp
as $$
#variable_conflict use_column
begin
  perform ogevia.staff_guard(p_organization_id, true);
  return query
  with s as (
    select l.*, split_part(l.staff_key, ':', 1) as src,
           lower(btrim(l.contact_email)) as em,
           case when length(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g')) >= 7 then regexp_replace(l.phone, '\D', '', 'g') end as ph,
           lower(regexp_replace(btrim(l.display_name), '\s+', ' ', 'g')) as nm
    from ogevia_api.list_staff(p_organization_id) l
    where l.status = 'active'
      and (l.profile_id is null or not exists (select 1 from ogevia.staff_merge_links k where k.merged_profile_id = l.profile_id))
  ), keys as (
    select 'email'::text as basis, em as k, staff_key from s where em is not null
    union all select 'phone', ph, staff_key from s where ph is not null
    union all select 'name', nm, staff_key from s where nm is not null and nm <> 'name not set'
  ), grp as (
    select basis, k from keys group by basis, k having count(distinct staff_key) > 1
  )
  select md5(g.basis || '|' || g.k), g.basis, s.staff_key, s.src, s.profile_id, s.caregiver_record_id, s.user_id, s.display_name, s.staff_type_name,
         s.contact_email, s.phone, s.status, s.access_status,
         (s.src = 'profile' and s.profile_id is not null and s.user_id is null and s.caregiver_record_id is null and s.access_status = 'none')
  from grp g
  join keys kk on kk.basis = g.basis and kk.k = g.k
  join s on s.staff_key = kk.staff_key
  order by g.basis, md5(g.basis || '|' || g.k), s.display_name, s.staff_key;
end;
$$;

create function ogevia_api.merge_staff_profiles(p_organization_id uuid, p_keep_profile_id uuid, p_duplicate_profile_id uuid, p_reason text)
returns text
language plpgsql
volatile
security definer
set search_path = ogevia, pg_temp
as $$
declare
  v_actor uuid := ogevia.staff_guard(p_organization_id, true);
  v_reason text := btrim(coalesce(p_reason, ''));
  k ogevia.staff_profiles%rowtype; d ogevia.staff_profiles%rowtype;
  v_basis text;
begin
  if p_keep_profile_id = p_duplicate_profile_id then raise exception 'Choose two different records' using errcode = 'OGV22'; end if;
  if length(v_reason) < 5 or length(v_reason) > 500 then raise exception 'Give a reason (5 to 500 characters)' using errcode = 'OGV22'; end if;
  perform pg_advisory_xact_lock(hashtextextended('staff_profile|' || p_organization_id::text, 0));
  select * into k from ogevia.staff_profiles p where p.id = p_keep_profile_id and p.organization_id = p_organization_id;
  select * into d from ogevia.staff_profiles p where p.id = p_duplicate_profile_id and p.organization_id = p_organization_id;
  if k.id is null or d.id is null then raise exception 'Staff member not found' using errcode = 'OGN04'; end if;
  if exists (select 1 from ogevia.staff_merge_links l where l.merged_profile_id = d.id and l.kept_profile_id = k.id) then return 'already_merged'; end if;
  if exists (select 1 from ogevia.staff_merge_links l where l.merged_profile_id = d.id or l.merged_profile_id = k.id) then
    raise exception 'One of these records was already merged into another' using errcode = 'OGC09';
  end if;
  if k.status <> 'active' or d.status <> 'active' then raise exception 'Both records must be active' using errcode = 'OGC09'; end if;
  if d.user_id is not null or d.login_email is not null or d.invited_at is not null then
    raise exception 'The record to merge has a sign-in or an invitation. Resolve it by hand so nobody loses access.' using errcode = 'OGC09';
  end if;
  -- A hard match is required: the same email, the same phone number, or the same full name. Unrelated people can never be merged.
  v_basis := case
    when k.contact_email is not null and lower(btrim(k.contact_email)) = lower(btrim(coalesce(d.contact_email, ''))) then 'email'
    when length(regexp_replace(coalesce(k.phone, ''), '\D', '', 'g')) >= 7 and regexp_replace(k.phone, '\D', '', 'g') = regexp_replace(coalesce(d.phone, ''), '\D', '', 'g') then 'phone'
    when lower(regexp_replace(btrim(k.display_name), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(d.display_name), '\s+', ' ', 'g')) then 'name'
  end;
  if v_basis is null then raise exception 'These records do not match on email, phone or name, so they cannot be merged' using errcode = 'OGC09'; end if;

  update ogevia.staff_profiles set status = 'inactive', updated_at = now() where id = d.id;
  insert into ogevia.staff_merge_links (organization_id, kept_profile_id, merged_profile_id, match_basis, reason, merged_by)
  values (p_organization_id, k.id, d.id, v_basis, v_reason, v_actor);
  perform ogevia.write_audit(p_organization_id, 'staff.merged', 'staff_profiles', d.id, jsonb_build_object('status', 'active'),
    jsonb_build_object('status', 'inactive', 'merged_into', k.id, 'match_basis', v_basis), v_reason);
  return 'merged';
end;
$$;
revoke all on function ogevia_api.list_possible_duplicate_staff(uuid) from public;
revoke all on function ogevia_api.merge_staff_profiles(uuid, uuid, uuid, text) from public;
grant execute on function ogevia_api.list_possible_duplicate_staff(uuid) to ogevia_app;
grant execute on function ogevia_api.merge_staff_profiles(uuid, uuid, uuid, text) to ogevia_app;
