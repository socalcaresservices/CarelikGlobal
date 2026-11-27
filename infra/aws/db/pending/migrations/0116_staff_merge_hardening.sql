-- 0116 (PENDING: infra/aws/db/pending, not in any release) | CLASS: ADDITIVE except one constraint drop (staff_merge_links_once, replaced by the same rule in the functions).
-- Not applied to any database. Release Train 2, priority D: duplicate staff merge hardening. Depends on 0106.
--   * preview_staff_merge: the two records side by side, the fields where they CONFLICT (both filled, different), the blanks the kept record would gain, and every blocker.
--   * merge_staff_profiles_v2: a conflict must be resolved explicitly per field ('keep' or 'duplicate'); blanks on the kept record are filled from the duplicate. The
--     before and after of both records are stored (append-only snapshot) in the same transaction. The old merge_staff_profiles now delegates here (one code path).
--   * unmerge_staff_profiles (rollback protection): undoes ONE merge made with a snapshot, only while the kept record is exactly as the merge left it and the duplicate is still
--     an inactive record with no sign-in or invitation; otherwise it refuses and says why. It restores the kept record's earlier values and reactivates the duplicate. The
--     reversal is recorded (append-only); the merge link stays as history. The same pair can be merged again afterwards.
--   * list_staff_merges: the merge history (who, when, why, basis, reversed?, can it be undone now).
--   * list_possible_duplicate_staff: same report as 0106, but a REVERSED merge no longer hides the duplicate.
-- Rollback: pending/rollback/0116_staff_merge_hardening.down.sql
alter table ogevia.staff_merge_links drop constraint staff_merge_links_once;

create table ogevia.staff_merge_snapshots (
  link_id uuid primary key references ogevia.staff_merge_links(id),
  organization_id uuid not null references ogevia.organizations(id),
  kept_before jsonb not null, kept_after jsonb not null, dup_before jsonb not null, resolutions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table ogevia.staff_merge_snapshots enable row level security;
revoke all on ogevia.staff_merge_snapshots from public;
create trigger staff_merge_snapshots_append_only before update or delete on ogevia.staff_merge_snapshots for each row execute function ogevia.append_only_guard();
grant select on ogevia.staff_merge_snapshots to ogevia_readonly;
create policy readonly_select on ogevia.staff_merge_snapshots for select to ogevia_readonly using (true);

create table ogevia.staff_merge_reversals (
  link_id uuid primary key references ogevia.staff_merge_links(id),
  organization_id uuid not null references ogevia.organizations(id),
  reversed_by uuid not null references ogevia.app_users(id),
  reversed_at timestamptz not null default now(),
  reason text not null check (length(btrim(reason)) between 5 and 500)
);
alter table ogevia.staff_merge_reversals enable row level security;
revoke all on ogevia.staff_merge_reversals from public;
create trigger staff_merge_reversals_append_only before update or delete on ogevia.staff_merge_reversals for each row execute function ogevia.append_only_guard();
grant select on ogevia.staff_merge_reversals to ogevia_readonly;
create policy readonly_select on ogevia.staff_merge_reversals for select to ogevia_readonly using (true);

-- The link that currently hides a profile as "merged", if any (a reversed merge no longer counts).
create function ogevia.staff_merge_active_link(p_organization_id uuid, p_profile_id uuid)
returns uuid language sql stable set search_path = ogevia, pg_temp as $$
  select l.id from ogevia.staff_merge_links l
   where l.organization_id = p_organization_id and l.merged_profile_id = p_profile_id
     and not exists (select 1 from ogevia.staff_merge_reversals r where r.link_id = l.id)
   order by l.merged_at desc limit 1;
$$;

create function ogevia.staff_merge_fields(p ogevia.staff_profiles)
returns jsonb language sql immutable set search_path = ogevia, pg_temp as $$
  select jsonb_build_object('display_name', p.display_name, 'staff_type_id', p.staff_type_id, 'contact_email', p.contact_email, 'phone', p.phone, 'status', p.status);
$$;

create or replace function ogevia_api.list_possible_duplicate_staff(p_organization_id uuid)
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
      and (l.profile_id is null or ogevia.staff_merge_active_link(p_organization_id, l.profile_id) is null)
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


-- Shared by the preview and the merge: the blockers, the match basis, the conflicts and the fills.
create function ogevia.staff_merge_analysis(p_organization_id uuid, p_keep uuid, p_dup uuid)
returns jsonb language plpgsql stable set search_path = ogevia, pg_temp as $$
declare
  k ogevia.staff_profiles%rowtype; d ogevia.staff_profiles%rowtype;
  v_basis text; v_block text[] := '{}'; v_conf jsonb := '[]'::jsonb; v_fill jsonb := '[]'::jsonb;
  v_kt text; v_dt text;
begin
  select * into k from ogevia.staff_profiles p where p.id = p_keep and p.organization_id = p_organization_id;
  select * into d from ogevia.staff_profiles p where p.id = p_dup and p.organization_id = p_organization_id;
  if k.id is null or d.id is null then raise exception 'Staff member not found' using errcode = 'OGN04'; end if;
  if k.id = d.id then raise exception 'Choose two different records' using errcode = 'OGV22'; end if;
  if ogevia.staff_merge_active_link(p_organization_id, k.id) is not null or ogevia.staff_merge_active_link(p_organization_id, d.id) is not null then
    v_block := array_append(v_block, 'One of these records was already merged into another'); end if;
  if k.status <> 'active' or d.status <> 'active' then v_block := array_append(v_block, 'Both records must be active'); end if;
  if d.user_id is not null or d.login_email is not null or d.invited_at is not null then
    v_block := array_append(v_block, 'The record to merge has a sign-in or an invitation. Resolve it by hand so nobody loses access.'); end if;
  v_basis := case
    when k.contact_email is not null and lower(btrim(k.contact_email)) = lower(btrim(coalesce(d.contact_email, ''))) then 'email'
    when length(regexp_replace(coalesce(k.phone, ''), '\D', '', 'g')) >= 7 and regexp_replace(k.phone, '\D', '', 'g') = regexp_replace(coalesce(d.phone, ''), '\D', '', 'g') then 'phone'
    when lower(regexp_replace(btrim(k.display_name), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(d.display_name), '\s+', ' ', 'g')) then 'name'
  end;
  if v_basis is null then v_block := array_append(v_block, 'These records do not match on email, phone or name, so they cannot be merged'); end if;
  select t.name into v_kt from ogevia.staff_types t where t.id = k.staff_type_id;
  select t.name into v_dt from ogevia.staff_types t where t.id = d.staff_type_id;
  if lower(btrim(k.display_name)) <> lower(btrim(d.display_name)) then v_conf := v_conf || jsonb_build_object('field', 'display_name', 'keep', k.display_name, 'duplicate', d.display_name); end if;
  if k.staff_type_id <> d.staff_type_id then v_conf := v_conf || jsonb_build_object('field', 'staff_type_id', 'keep', v_kt, 'duplicate', v_dt); end if;
  if k.contact_email is not null and d.contact_email is not null and lower(btrim(k.contact_email)) <> lower(btrim(d.contact_email)) then v_conf := v_conf || jsonb_build_object('field', 'contact_email', 'keep', k.contact_email, 'duplicate', d.contact_email); end if;
  if k.phone is not null and d.phone is not null and regexp_replace(k.phone, '\D', '', 'g') <> regexp_replace(d.phone, '\D', '', 'g') then v_conf := v_conf || jsonb_build_object('field', 'phone', 'keep', k.phone, 'duplicate', d.phone); end if;
  if k.contact_email is null and d.contact_email is not null then v_fill := v_fill || jsonb_build_object('field', 'contact_email', 'value', d.contact_email); end if;
  if k.phone is null and d.phone is not null then v_fill := v_fill || jsonb_build_object('field', 'phone', 'value', d.phone); end if;
  return jsonb_build_object('keep', jsonb_build_object('profileId', k.id, 'displayName', k.display_name, 'staffType', v_kt, 'email', k.contact_email, 'phone', k.phone),
    'duplicate', jsonb_build_object('profileId', d.id, 'displayName', d.display_name, 'staffType', v_dt, 'email', d.contact_email, 'phone', d.phone),
    'matchBasis', v_basis, 'conflicts', v_conf, 'fills', v_fill, 'blockers', to_jsonb(v_block), 'canMerge', cardinality(v_block) = 0);
end;
$$;

create function ogevia_api.preview_staff_merge(p_organization_id uuid, p_keep_profile_id uuid, p_duplicate_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
begin
  perform ogevia.staff_guard(p_organization_id, true);
  return ogevia.staff_merge_analysis(p_organization_id, p_keep_profile_id, p_duplicate_profile_id);
end;
$$;

create function ogevia_api.merge_staff_profiles_v2(p_organization_id uuid, p_keep_profile_id uuid, p_duplicate_profile_id uuid, p_reason text, p_resolutions jsonb default '{}'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.staff_guard(p_organization_id, true);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_a jsonb; k ogevia.staff_profiles%rowtype; d ogevia.staff_profiles%rowtype; k2 ogevia.staff_profiles%rowtype;
  v_c jsonb; v_field text; v_pick text; v_unresolved text[] := '{}';
  v_name text; v_type uuid; v_email text; v_phone text; v_link uuid;
begin
  if p_keep_profile_id = p_duplicate_profile_id then raise exception 'Choose two different records' using errcode = 'OGV22'; end if;
  if length(v_reason) < 5 or length(v_reason) > 500 then raise exception 'Give a reason (5 to 500 characters)' using errcode = 'OGV22'; end if;
  if p_resolutions is null or jsonb_typeof(p_resolutions) <> 'object' then raise exception 'Resolutions must be an object' using errcode = 'OGV22'; end if;
  perform pg_advisory_xact_lock(hashtextextended('staff_profile|' || p_organization_id::text, 0));
  if exists (select 1 from ogevia.staff_merge_links l where l.merged_profile_id = p_duplicate_profile_id and l.kept_profile_id = p_keep_profile_id
               and l.organization_id = p_organization_id and not exists (select 1 from ogevia.staff_merge_reversals r where r.link_id = l.id)) then
    return jsonb_build_object('state', 'already_merged');
  end if;
  v_a := ogevia.staff_merge_analysis(p_organization_id, p_keep_profile_id, p_duplicate_profile_id);
  if not (v_a ->> 'canMerge')::boolean then raise exception '%', v_a -> 'blockers' ->> 0 using errcode = 'OGC09'; end if;
  select * into k from ogevia.staff_profiles where id = p_keep_profile_id;
  select * into d from ogevia.staff_profiles where id = p_duplicate_profile_id;
  v_name := k.display_name; v_type := k.staff_type_id; v_email := k.contact_email; v_phone := k.phone;
  for v_c in select * from jsonb_array_elements(v_a -> 'conflicts') loop
    v_field := v_c ->> 'field'; v_pick := p_resolutions ->> v_field;
    if v_pick is null or v_pick not in ('keep', 'duplicate') then v_unresolved := v_unresolved || v_field; continue; end if;
    if v_pick = 'duplicate' then
      if v_field = 'display_name' then v_name := d.display_name;
      elsif v_field = 'staff_type_id' then v_type := d.staff_type_id;
      elsif v_field = 'contact_email' then v_email := d.contact_email;
      elsif v_field = 'phone' then v_phone := d.phone; end if;
    end if;
  end loop;
  if cardinality(v_unresolved) > 0 then
    raise exception 'Choose which value to keep for: %', array_to_string(v_unresolved, ', ') using errcode = 'OGV22';
  end if;
  if exists (select 1 from jsonb_object_keys(p_resolutions) f where f not in ('display_name', 'staff_type_id', 'contact_email', 'phone')) then
    raise exception 'Unknown field in the choices' using errcode = 'OGV22';
  end if;
  v_email := coalesce(v_email, d.contact_email); v_phone := coalesce(v_phone, d.phone);
  -- the duplicate is made inactive (never deleted, its own values stay) and the kept record gets the chosen values
  update ogevia.staff_profiles set status = 'inactive', updated_at = now() where id = d.id;
  update ogevia.staff_profiles set display_name = v_name, staff_type_id = v_type, contact_email = v_email, phone = v_phone, updated_at = now() where id = k.id;
  select * into k2 from ogevia.staff_profiles where id = k.id;
  insert into ogevia.staff_merge_links (organization_id, kept_profile_id, merged_profile_id, match_basis, reason, merged_by)
  values (p_organization_id, k.id, d.id, v_a ->> 'matchBasis', v_reason, v_actor) returning id into v_link;
  insert into ogevia.staff_merge_snapshots (link_id, organization_id, kept_before, kept_after, dup_before, resolutions)
  values (v_link, p_organization_id, ogevia.staff_merge_fields(k), ogevia.staff_merge_fields(k2), ogevia.staff_merge_fields(d), p_resolutions);
  perform ogevia.write_audit(p_organization_id, 'staff.merged', 'staff_profiles', d.id, jsonb_build_object('status', 'active'),
    jsonb_build_object('status', 'inactive', 'merged_into', k.id, 'match_basis', v_a ->> 'matchBasis', 'resolutions', p_resolutions, 'fills', v_a -> 'fills'), v_reason);
  return jsonb_build_object('state', 'merged', 'linkId', v_link);
end;
$$;

-- The 0106 entry point now uses the same code path: with a conflict it refuses and names the fields (use the wizard / resolutions).
create or replace function ogevia_api.merge_staff_profiles(p_organization_id uuid, p_keep_profile_id uuid, p_duplicate_profile_id uuid, p_reason text)
returns text language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
begin
  return ogevia_api.merge_staff_profiles_v2(p_organization_id, p_keep_profile_id, p_duplicate_profile_id, p_reason, '{}'::jsonb) ->> 'state';
end;
$$;

create function ogevia_api.unmerge_staff_profiles(p_organization_id uuid, p_link_id uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = ogevia, pg_temp as $$
declare
  v_actor uuid := ogevia.staff_guard(p_organization_id, true);
  v_reason text := btrim(coalesce(p_reason, ''));
  l ogevia.staff_merge_links%rowtype; s ogevia.staff_merge_snapshots%rowtype; k ogevia.staff_profiles%rowtype; d ogevia.staff_profiles%rowtype;
begin
  if length(v_reason) < 5 or length(v_reason) > 500 then raise exception 'Give a reason (5 to 500 characters)' using errcode = 'OGV22'; end if;
  perform pg_advisory_xact_lock(hashtextextended('staff_profile|' || p_organization_id::text, 0));
  select * into l from ogevia.staff_merge_links where id = p_link_id and organization_id = p_organization_id;
  if l.id is null then raise exception 'Merge not found' using errcode = 'OGN04'; end if;
  if exists (select 1 from ogevia.staff_merge_reversals r where r.link_id = l.id) then return jsonb_build_object('state', 'already_reversed'); end if;
  select * into s from ogevia.staff_merge_snapshots where link_id = l.id;
  if s.link_id is null then raise exception 'This merge was made before undo was available and cannot be undone here' using errcode = 'OGC09'; end if;
  select * into k from ogevia.staff_profiles where id = l.kept_profile_id;
  select * into d from ogevia.staff_profiles where id = l.merged_profile_id;
  if ogevia.staff_merge_fields(k) is distinct from s.kept_after then
    raise exception 'The kept record was changed after the merge, so the merge cannot be undone safely' using errcode = 'OGC09'; end if;
  if d.status <> 'inactive' or d.user_id is not null or d.login_email is not null or d.invited_at is not null then
    raise exception 'The merged record was changed after the merge, so the merge cannot be undone safely' using errcode = 'OGC09'; end if;
  if ogevia.staff_merge_active_link(p_organization_id, d.id) is distinct from l.id then
    raise exception 'The merged record is part of a different merge' using errcode = 'OGC09'; end if;
  -- put the kept record's earlier values back, then bring the duplicate back
  update ogevia.staff_profiles set display_name = s.kept_before ->> 'display_name', staff_type_id = (s.kept_before ->> 'staff_type_id')::uuid,
         contact_email = s.kept_before ->> 'contact_email', phone = s.kept_before ->> 'phone', updated_at = now() where id = k.id;
  update ogevia.staff_profiles set status = s.dup_before ->> 'status', updated_at = now() where id = d.id;
  insert into ogevia.staff_merge_reversals (link_id, organization_id, reversed_by, reason) values (l.id, p_organization_id, v_actor, v_reason);
  perform ogevia.write_audit(p_organization_id, 'staff.unmerged', 'staff_profiles', d.id, jsonb_build_object('status', 'inactive', 'merged_into', k.id),
    jsonb_build_object('status', s.dup_before ->> 'status', 'restored_kept_values', true), v_reason);
  return jsonb_build_object('state', 'reversed');
end;
$$;

create function ogevia_api.list_staff_merges(p_organization_id uuid, p_limit integer default 50)
returns table (link_id uuid, kept_profile_id uuid, kept_name text, merged_profile_id uuid, merged_name text, match_basis text, reason text, merged_at timestamptz, merged_by_name text,
               has_snapshot boolean, reversed_at timestamptz, reversed_reason text, can_undo boolean)
language plpgsql stable security definer set search_path = ogevia, pg_temp as $$
begin
  perform ogevia.staff_guard(p_organization_id, true);
  p_limit := greatest(1, least(coalesce(p_limit, 50), 200));
  return query
    select l.id, l.kept_profile_id, k.display_name::text, l.merged_profile_id, d.display_name::text, l.match_basis::text, l.reason::text, l.merged_at, u.display_name::text,
           s.link_id is not null, r.reversed_at, r.reason::text,
           (r.link_id is null and s.link_id is not null and ogevia.staff_merge_fields(k) is not distinct from s.kept_after and d.status = 'inactive' and d.user_id is null
              and d.login_email is null and d.invited_at is null and ogevia.staff_merge_active_link(p_organization_id, d.id) is not distinct from l.id)
    from ogevia.staff_merge_links l
    join ogevia.staff_profiles k on k.id = l.kept_profile_id join ogevia.staff_profiles d on d.id = l.merged_profile_id
    left join ogevia.app_users u on u.id = l.merged_by
    left join ogevia.staff_merge_snapshots s on s.link_id = l.id left join ogevia.staff_merge_reversals r on r.link_id = l.id
    where l.organization_id = p_organization_id order by l.merged_at desc, l.id limit p_limit;
end;
$$;

revoke all on function ogevia.staff_merge_active_link(uuid, uuid) from public;
revoke all on function ogevia.staff_merge_fields(ogevia.staff_profiles) from public;
revoke all on function ogevia.staff_merge_analysis(uuid, uuid, uuid) from public;
revoke all on function ogevia_api.preview_staff_merge(uuid, uuid, uuid) from public;
revoke all on function ogevia_api.merge_staff_profiles_v2(uuid, uuid, uuid, text, jsonb) from public;
revoke all on function ogevia_api.unmerge_staff_profiles(uuid, uuid, text) from public;
revoke all on function ogevia_api.list_staff_merges(uuid, integer) from public;
grant execute on function ogevia_api.preview_staff_merge(uuid, uuid, uuid) to ogevia_app;
grant execute on function ogevia_api.merge_staff_profiles_v2(uuid, uuid, uuid, text, jsonb) to ogevia_app;
grant execute on function ogevia_api.unmerge_staff_profiles(uuid, uuid, text) to ogevia_app;
grant execute on function ogevia_api.list_staff_merges(uuid, integer) to ogevia_app;
