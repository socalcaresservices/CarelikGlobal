# Service Verification v3 — Build Verification

**Repository status (2026-08-24): implemented and locally green; not approved
for deployment.** The caregiver phone flow, manager correction safeguards, and
monthly hours calendar are built. The migration has not been executed in any
environment during this build, so database behavior and tenant isolation remain
release blockers.

## Implemented

- A three-state caregiver phone flow: Select → Visit → Confirm.
- Assigned-client picker exposes internal client codes only; no client legal
  name, date of birth, address, or UCI is returned to this screen.
- A client with one active authorized service is auto-selected; a client with
  multiple services requires an exact service choice.
- Time In and Time Out are database timestamps. The caregiver cannot type or
  backdate either value.
- One open visit is enforced for both linked caregiver users and Care Team
  records, including the awaiting-signature state.
- Refresh recovery returns an ended, awaiting-signature visit to confirmation.
- Client/guardian signature confirms the displayed client code, service, date,
  Time In, Time Out, and total time.
- A no-signer visit is saved as unverified with zero billable minutes and is
  routed to manager review.
- Manager time corrections preserve the original row and record actor, time,
  reason, and before/after snapshots. Corrections reject future times,
  cross-authorization dates, and caregiver overlaps.
- Monthly manager calendar aggregates daily worked time by caregiver and shows
  billable time when it differs.
- The screen states `Not EVV` and `No GPS`; no location is collected.

## Repository evidence

- Focused Service Verification tests: **25 passed**.
- Full workspace tests: **677 passed** (web 476, shared 118, UI 73, auth 10).
- Full workspace typecheck: passed.
- Full workspace lint: passed.
- Production frontend build: passed (the repository's existing large-chunk
  warning remains non-blocking).
- Migration static review: every new/replaced `SECURITY DEFINER` function has
  an explicit search path, public/anonymous execution is revoked, and only the
  intended authenticated RPCs are granted.

These checks do not prove that PostgreSQL can execute the migration or that RLS
behaves correctly with real sessions.

## Still required in non-production Supabase

1. Apply `20260824010000_service_verification_v3.sql` to an isolated project or
   Supabase development branch.
2. Test with two organizations, two caregivers, two clients, one single-service
   authorization, and one client with at least nine authorized services.
3. Verify caregivers can list only assigned client codes and cannot obtain a
   client legal name through the retired v2 picker.
4. Verify a second open visit is rejected during both `draft` and
   `awaiting_signature` states, including double taps and concurrent requests.
5. Verify expired assignments, expired authorizations, revoked memberships,
   and cross-organization IDs are denied.
6. Verify refresh recovery after Time Out, signature retry after an interrupted
   upload, and no-signer submission with zero verified/billable minutes.
7. Verify a manager correction retains the original record and creates a
   correction row with actor, reason, before, and after values.
8. Verify correction attempts are denied for overlaps, future Time Out, and
   dates outside the authorization period.
9. Run security and performance advisors after migration application.

## Post-migration verification queries

Run these read-only queries in the target Supabase SQL editor after the
migration succeeds.

```sql
-- The v3 RPC and single-open-visit indexes exist.
select to_regprocedure('public.get_active_service_visit_v3(uuid)') as v3_rpc,
       to_regclass('public.service_visits_one_open_per_caregiver_user') as user_open_index,
       to_regclass('public.service_visits_one_open_per_caregiver_record') as record_open_index;

-- Anonymous access is denied; authenticated access exists only where intended.
select p.proname,
       has_function_privilege('anon', p.oid, 'execute') as anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'list_assigned_visit_clients',
    'get_active_service_visit_v3',
    'start_ad_hoc_service_visit',
    'end_service_visit',
    'confirm_service_visit',
    'correct_service_visit',
    'list_startable_shifts_for_client'
  )
order by p.proname;

-- This must return zero rows.
select caregiver_user_id, count(*)
from public.service_visits
where caregiver_user_id is not null
  and status in ('draft', 'awaiting_signature')
group by caregiver_user_id
having count(*) > 1;

-- No-signer records must remain unverified and nonbillable.
select v.id, v.status, v.verified_minutes, v.billable_minutes
from public.service_visits v
join public.visit_signatures s on s.visit_id = v.id
where s.confirmation_method = 'unable_to_confirm'
  and (
    v.status <> 'administrator_review'
    or v.verified_minutes <> 0
    or v.billable_minutes <> 0
  );

-- Every corrected replacement must have a dedicated audit row.
select v.id
from public.service_visits v
left join public.visit_corrections c on c.corrected_visit_id = v.id
where v.original_visit_id is not null
  and c.id is null;
```

The last three queries must return zero rows. For the privileges query,
`anon_can_execute` must be false for every row;
`list_startable_shifts_for_client` must also be false for authenticated users.

## Production deployment order

Netlify does not run database migrations.

1. Complete and retain the non-production evidence above.
2. Take or confirm the required production backup/recovery point.
3. Apply the migration manually to production Supabase.
4. Run the post-migration queries and authenticated smoke tests.
5. Merge the frontend PR to `main` only after the database checks pass.
6. Let Netlify deploy the frontend, then verify the caregiver RPC flow and
   manager calendar against production.

If the production migration or verification fails, stop before merging the
frontend. Capture the exact error and use a reviewed forward migration or the
approved database recovery procedure; do not delete visit or audit records to
force a retry.
