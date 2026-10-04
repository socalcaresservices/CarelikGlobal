-- 05 TEST ONLY: obviously synthetic legal names for the SCS pilot's synthetic
-- clients, so printed calendars can be checked with a "full name" (0020).
-- Refuses to run anywhere except database ogevia_sv_test, agency
-- scs-pilot-synthetic. Re-runnable. Every name set is audited.
-- Usage: psql ... -d ogevia_sv_test -v ON_ERROR_STOP=1 -f 05_seed_synthetic_client_names.sql
\set ON_ERROR_STOP on
begin;
do $$
declare
  v_org uuid;
  v_actor uuid;
  c record;
  i integer := 0;
  v_names text[] := array['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
begin
  if current_database() <> 'ogevia_sv_test' then
    raise exception 'Refusing: synthetic names are seeded only into ogevia_sv_test (this is %)', current_database();
  end if;
  select id into v_org from ogevia.organizations where slug = 'scs-pilot-synthetic';
  if v_org is null then raise exception 'Refusing: agency scs-pilot-synthetic not found'; end if;
  select m.user_id into v_actor from ogevia.organization_memberships m
   where m.organization_id = v_org and m.role in ('organization_owner', 'manager') and m.status = 'active'
   order by m.role, m.user_id limit 1;
  if v_actor is null then raise exception 'Refusing: no active owner or manager to record as the editor'; end if;
  for c in select id, client_code from ogevia.clients where organization_id = v_org and deleted_at is null order by client_code loop
    i := i + 1;
    insert into ogevia.client_private_names (client_id, organization_id, legal_first_name, legal_last_name, updated_by)
    values (c.id, v_org, 'Synthetic', 'Client ' || v_names[1 + (i - 1) % array_length(v_names, 1)], v_actor)
    on conflict (client_id) do nothing;
    if found then
      insert into ogevia.audit_events (organization_id, actor_user_id, action, entity_type, entity_id, reason, after_state)
      values (v_org, v_actor, 'client.legal_name_set', 'clients', c.id, 'TEST synthetic seed 05',
              jsonb_build_object('legal_first_name', 'Synthetic', 'legal_last_name', 'Client ' || v_names[1 + (i - 1) % array_length(v_names, 1)]));
    end if;
  end loop;
  raise notice 'Synthetic client names present for % clients of scs-pilot-synthetic', i;
end $$;
commit;
