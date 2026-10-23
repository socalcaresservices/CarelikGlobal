-- READ ONLY, COUNT ONLY. The figures behind the Home dashboard, read through the application's own functions as the agency's active owner (SET LOCAL ROLE
-- ogevia_app + ogevia_api.begin_request, exactly as the API does). Run it BEFORE and AFTER the cleanup and compare. It ends with ROLLBACK and writes nothing.
--
--   psql ... -v org_slug=socal-care-services -f dashboard_totals.sql
--
-- Output: counts and minutes only. No names, codes or ids. If the database master cannot assume the application role it stops with NOT RUN (never a weaker check).
\set ON_ERROR_STOP on
begin read only;
select o.id as org_id, to_char(date_trunc('month', now() at time zone o.timezone)::date, 'YYYY-MM-DD') as month_start,
       (select u.cognito_sub from ogevia.organization_memberships m join ogevia.app_users u on u.id = m.user_id
         where m.organization_id = o.id and m.role = 'organization_owner' and m.status = 'active' order by m.user_id limit 1) as owner_sub
from ogevia.organizations o where o.slug = :'org_slug' \gset
\if :{?org_id}
\else
  \echo 'STOP: agency not found'
  \quit 1
\endif
do $$ begin
  begin set local role ogevia_app; reset role;
  exception when insufficient_privilege then
    raise exception 'NOT RUN: the database master cannot assume the application role ogevia_app, so the dashboard figures cannot be read as the API reads them.';
  end;
end $$;
set local role ogevia_app;
select 1 as signed_in from (select ogevia_api.begin_request(:'owner_sub', gen_random_uuid())) x;

\echo '== Home tiles: the numbers on the dashboard cards =='
select (c->'needsAttention'->>'count') as needs_attention_tile, (c->'scheduling'->>'count') as scheduling_tile, (c->'caregivers'->>'count') as caregivers_tile,
       (c->'approvals'->'exceptions'->>'count') as approval_exceptions_tile, (c->'approvals'->>'readyForApproval') as ready_for_approval_tile
from (select ogevia_api.get_attention_counts(:'org_id') c) x;
\echo '== Home: Needs attention now, Upcoming staffing, reconciliation (counts and minutes only) =='
select (o->'urgent'->>'itemCount') as needs_attention_now_items, (o->'urgent'->>'shifts') as urgent_shifts, (o->'upcoming'->>'count') as upcoming_staffing_shifts,
       (o->'reconciliation'->>'count') as shifts_with_no_visit_record, (o->'reconciliation'->>'minutes') as reconciliation_minutes,
       (o->'pickups'->>'count') as pickup_requests, (o->'amendmentImpacts'->>'count') as authorization_changes
from (select ogevia_api.get_attention_overview(:'org_id', 48) o) x;
\echo '== Home: Hours this month, summed over services (minutes) =='
select count(*) as service_rows, coalesce(sum(authorized_minutes), 0) as authorized, coalesce(sum(scheduled_minutes), 0) as scheduled, coalesce(sum(committed_minutes), 0) as committed,
       coalesce(sum(reserved_minutes), 0) as reserved, coalesce(sum(needs_reconciliation_minutes), 0) as needs_reconciliation, coalesce(sum(worked_minutes), 0) as worked,
       coalesce(sum(remaining_minutes), 0) as remaining, coalesce(sum(expiring_authorizations), 0) as expiring_authorizations,
       coalesce(sum(near_limit_authorizations), 0) as near_limit_authorizations, coalesce(sum(critical_authorizations), 0) as critical_authorizations
from ogevia_api.get_utilisation_overview(:'org_id', :'month_start'::date);
\echo '== Shifts that ended with no visit record, and the time they still hold =='
select count(*) as shifts_to_reconcile, coalesce(sum(reserved_minutes), 0) as reserved_minutes from ogevia_api.list_shifts_to_reconcile(:'org_id');
\echo '== Schedule: shifts in the next 120 days, and open shifts =='
select (select count(*) from ogevia_api.list_shifts(:'org_id', current_date, current_date + 120)) as upcoming_shifts, (select count(*) from ogevia_api.list_open_shifts(:'org_id')) as open_shifts;
rollback;
