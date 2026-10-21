-- PRODUCTION / move ONE existing person's sign-in to the production user pool WITHOUT creating a second person record.
-- Run as the RDS master user inside the approved database window (g4-relink-sign-in-prd.sh does this; never by hand).
--
--   psql -X -v ON_ERROR_STOP=1 -v expected_db=ogevia_prd -v old_sub=<current Cognito sub> -v new_sub=<sub in the production pool> \
--        -v approval_ref=<approval reference> -d ogevia_prd -f 16_prd_relink_sign_in.sql
--
-- What it does: changes ONLY ogevia.app_users.cognito_sub of the person that currently holds old_sub. The person's id is unchanged, so every
-- membership, caregiver link, invitation, assignment, visit and audit row that points at the person keeps pointing at the same person
-- (94 foreign keys reference app_users(id)). One audit event per agency the person belongs to records the move (before/after sign-in).
-- What it refuses (nothing is changed): a database other than expected_db; malformed or equal sign-ins; no person holds old_sub; the new sign-in
-- is already linked to a person record (that would be a duplicate person: resolve it first); the person is disabled or has no membership.
-- Idempotent: running it again after it succeeded changes nothing. Reversible: run it again with old_sub and new_sub SWAPPED (g4 "undo").
-- It does not touch Cognito, passwords, agencies, memberships or any other table.
\set ON_ERROR_STOP on
\if :{?expected_db}
\else
  \set expected_db ogevia_prd
\endif
\if :{?old_sub}
\else
  do $$ begin raise exception 'Refusing: set old_sub, new_sub and approval_ref.'; end $$;
\endif
\if :{?new_sub}
\else
  do $$ begin raise exception 'Refusing: set old_sub, new_sub and approval_ref.'; end $$;
\endif
\if :{?approval_ref}
\else
  do $$ begin raise exception 'Refusing: set old_sub, new_sub and approval_ref.'; end $$;
\endif
select current_database() = :'expected_db' as in_expected \gset
\if :in_expected
\else
  do $$ begin raise exception 'Refusing: the sign-in relink runs only against the production database.'; end $$;
\endif
begin;
-- \gset keeps the values out of the output (they are sign-in ids)
select set_config('ogevia.rl_old', :'old_sub', true) as a, set_config('ogevia.rl_new', :'new_sub', true) as b, set_config('ogevia.rl_ref', :'approval_ref', true) as c \gset rl_
do $$
declare
  v_old text := current_setting('ogevia.rl_old');
  v_new text := current_setting('ogevia.rl_new');
  v_ref text := current_setting('ogevia.rl_ref');
  v_person ogevia.app_users%rowtype;
  v_target ogevia.app_users%rowtype;
  v_memberships int;
  v_org uuid;
  v_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if v_old !~ v_uuid or v_new !~ v_uuid then raise exception 'Both sign-in ids must be lower-case UUIDs'; end if;
  if v_old = v_new then raise exception 'The old and new sign-in ids are the same'; end if;
  if v_ref !~ '^[A-Za-z0-9._-]{6,64}$' then raise exception 'The approval reference is malformed'; end if;

  select * into v_person from ogevia.app_users where cognito_sub = v_old for update;
  select * into v_target from ogevia.app_users where cognito_sub = v_new;

  if v_person.id is null then
    -- Already done by an earlier run of this procedure? Then say so and change nothing.
    if v_target.id is not null and exists (
         select 1 from ogevia.audit_events a
          where a.action = 'account.sign_in_relinked' and a.entity_id = v_target.id
            and a.before_state ->> 'sign_in' = v_old and a.after_state ->> 'sign_in' = v_new) then
      raise notice 'ALREADY RELINKED: person record % already uses the new sign-in. Nothing was changed.', v_target.id;
      return;
    end if;
    raise exception 'No person record uses the old sign-in. Nothing was changed.';
  end if;

  if v_target.id is not null then
    select count(*) into v_memberships from ogevia.organization_memberships where user_id = v_target.id;
    raise exception 'The new sign-in is ALREADY linked to a different person record (%, % membership(s)). Relinking would duplicate or merge people. Resolve that record first. Nothing was changed.', v_target.id, v_memberships;
  end if;

  if v_person.status <> 'active' then raise exception 'The person record is % (not active). Nothing was changed.', v_person.status; end if;
  select count(*) into v_memberships from ogevia.organization_memberships where user_id = v_person.id;
  if v_memberships = 0 then raise exception 'The person record has no agency membership, so there is nothing to carry over. Nothing was changed.'; end if;

  update ogevia.app_users set cognito_sub = v_new, updated_at = now() where id = v_person.id;
  for v_org in select distinct organization_id from ogevia.organization_memberships where user_id = v_person.id loop
    perform ogevia.write_audit(v_org, 'account.sign_in_relinked', 'app_users', v_person.id,
      jsonb_build_object('sign_in', v_old), jsonb_build_object('sign_in', v_new, 'approval', v_ref, 'source', '16_prd_relink_sign_in.sql'),
      'Sign-in moved to the production user pool; the person record, memberships and history are unchanged');
  end loop;
  raise notice 'RELINKED: person record % kept; % agency membership(s) unchanged.', v_person.id, v_memberships;
end
$$;
commit;
\echo '--- the person now (no sign-in ids shown): agency | role | membership'
select o.slug, m.role::text, m.status::text
from ogevia.app_users u join ogevia.organization_memberships m on m.user_id = u.id join ogevia.organizations o on o.id = m.organization_id
where u.cognito_sub = :'new_sub' or u.cognito_sub = :'old_sub' order by o.slug;
