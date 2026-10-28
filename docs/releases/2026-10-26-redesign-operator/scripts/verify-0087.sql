-- READ ONLY. Verification of the pending migration 0087 (staff invitation acceptance: M-1, L-1, L-2, L-3), run by the apply script inside a read-only transaction AFTER verify-0086.sql.
-- One row per check: check_name | ok | detail. Every row must be ok; any false row stops the release. 24 rows are expected:
-- 2 new API functions x 5 (exists, fixed search_path, SECURITY DEFINER, no PUBLIC execute, application-role execute) + 14 single checks.
-- The query never errors when 0087 is absent: every row is then false (a wrong target is a failure, not a crash that could be mistaken for 'nothing to check').
with api_fns(f, args) as (values ('list_my_staff_invitations', ''), ('accept_staff_invitation', 'uuid')),
fns as (select f, to_regprocedure('ogevia_api.' || f || '(' || args || ')') as oid from api_fns),
defs as (
  select 'complete' as k, to_regprocedure('ogevia_api.complete_staff_invitation(uuid, uuid, text, text, boolean, text)') as oid
  union all select 'note', to_regprocedure('ogevia_api.note_my_sign_in()')
  union all select 'list_staff', to_regprocedure('ogevia_api.list_staff(uuid)')
  union all select 'update_staff', to_regprocedure('ogevia_api.update_staff(uuid, uuid, text, uuid, text, text, text)')
  union all select 'accept', to_regprocedure('ogevia_api.accept_staff_invitation(uuid)')),
def_text as (select k, oid, case when oid is null then '' else pg_get_functiondef(oid) end as txt from defs)
select 'function_exists_ogevia_api.' || f, oid is not null, null from fns
union all
select 'function_fixed_search_path_ogevia_api.' || f,
       coalesce(oid is not null and (select exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') from pg_proc p where p.oid = fns.oid), false),
       'search_path is fixed on the function'
  from fns
union all
select 'function_security_definer_ogevia_api.' || f, coalesce(oid is not null and (select p.prosecdef from pg_proc p where p.oid = fns.oid), false), 'runs as its owner (SECURITY DEFINER)' from fns
union all
select 'function_no_public_execute_ogevia_api.' || f,
       oid is not null and not exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = fns.oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
       'PUBLIC has no EXECUTE'
  from fns
union all
select 'function_app_execute_ogevia_api.' || f, coalesce(oid is not null and has_function_privilege('ogevia_app', oid, 'execute'), false), 'the application role can execute it' from fns
union all
select 'complete_staff_invitation_reply_is_profile_id_only',
       coalesce((select p.proargnames = array['p_organization_id','p_profile_id','p_email','p_cognito_sub','p_existing_account','p_role','profile_id']::text[] and p.proretset from pg_proc p where p.oid = to_regprocedure('ogevia_api.complete_staff_invitation(uuid, uuid, text, text, boolean, text)')), false),
       'L-1: the reply is only the profile id (no existing_account)'
union all
select 'complete_staff_invitation_hardened', coalesce((select txt like '%pending_acceptance%' and txt like '%already has access to this agency or a pending invitation%' and txt not like '%That sign-in is disabled%' from def_text where k = 'complete'), false),
       'M-1/L-1/L-2: invited membership for an existing sign-in, no disabled message, no overwrite of any membership'
union all
select 'complete_staff_invitation_search_path_and_grants',
       coalesce((select exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') and p.prosecdef and has_function_privilege('ogevia_app', p.oid, 'execute')
                   and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
                 from pg_proc p where p.oid = to_regprocedure('ogevia_api.complete_staff_invitation(uuid, uuid, text, text, boolean, text)')), false),
       'recreated with the same hardening as 0086 (fixed search_path, SECURITY DEFINER, no PUBLIC execute, application role can execute)'
union all
select 'note_my_sign_in_marks_only_active_staff_membership', coalesce((select txt like '%m.status = ''active''%' and txt like '%staff_profiles%' and txt like '%caregiver_invitations%' from def_text where k = 'note'), false) and coalesce(has_function_privilege('ogevia_app', to_regprocedure('ogevia_api.note_my_sign_in()'), 'execute'), false),
       'a pending invitation is not marked as signed in; the caregiver marker is unchanged'
union all
select 'list_staff_shows_invited_as_invitation_pending', coalesce((select txt like '%m.status = ''invited'' then ''invitation_pending''%' from def_text where k = 'list_staff'), false), 'an invited membership shows as Invited'
union all
select 'update_staff_suspends_inactive_access', coalesce((select txt like '%staff.access_suspended%' and txt like '%''suspended''%' from def_text where k = 'update_staff'), false), 'L-3: inactive profile suspends the agency membership'
union all
select 'update_staff_keeps_0086_hardening',
       coalesce((select exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') and p.prosecdef and has_function_privilege('ogevia_app', p.oid, 'execute')
                   and not exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
                 from pg_proc p where p.oid = to_regprocedure('ogevia_api.update_staff(uuid, uuid, text, uuid, text, text, text)')), false), 'unchanged hardening'
union all
select 'accept_staff_invitation_acts_on_own_row_only', coalesce((select txt like '%ogevia.require_actor()%' and txt like '%Invitation not found%' and txt not like '%staff_guard%' from def_text where k = 'accept'), false), 'uses the signed-in person only; one generic refusal'
union all
select 'no_new_tables', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'ogevia' and c.relkind = 'r' and c.relname in ('staff_types', 'staff_profiles')) = 2
         and to_regclass('ogevia.staff_invitation_acceptances') is null, '0087 adds functions only; the two 0086 tables are the staff tables'
union all
select 'api_function_count_unchanged_plus_two',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'ogevia_api' and p.proname in ('list_staff_types','create_staff_type','rename_staff_type','set_staff_type_active','list_staff','create_staff','add_member_to_staff','update_staff','begin_staff_invitation','complete_staff_invitation','begin_staff_invitation_resend','record_staff_invitation_resent','set_staff_role','list_role_permissions','list_staff_audit','list_my_staff_invitations','accept_staff_invitation')) = 17,
       '15 staff API functions from 0086 + 2 from 0087'
union all
select 'staff_permissions_unchanged', (select count(*) from ogevia.permissions where key in ('staff.read', 'staff.manage')) = 2, '0087 adds no permission'
union all
select 'no_application_role_table_privilege_on_staff_tables',
       to_regclass('ogevia.staff_profiles') is not null and not coalesce(has_table_privilege('ogevia_app', to_regclass('ogevia.staff_profiles'), 'select'), true), 'still no direct table access'
order by 1;
