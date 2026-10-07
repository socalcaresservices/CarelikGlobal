-- PROPOSED PRODUCTION MIGRATION. NOT APPLIED. Kept outside supabase/migrations
-- so no pipeline applies it. Apply only after owner approval, as its own change.
--
-- Defect: correct_service_visit (20260824010000) never checks billing
-- approvals. Correcting an approved visit leaves the approval active on the
-- replaced row; the replacement is listed as Billing Ready, can be approved
-- again, and both approvals can be submitted (reproduced: 210 minutes
-- submitted for one 90-minute visit; supabase/tests/billing-correction).
--
-- Fix: a visit with an ACTIVE billing approval cannot change status
-- (corrected or voided) until that approval is voided with a reason
-- (void_billing_approval). Same rule as AWS migration 0019.
-- Data: production had 0 approvals and 0 corrections on 2026-10-04, so no
-- existing row conflicts. Re-runnable. Rollback at the bottom.
begin;

create or replace function public.service_visits_billing_approval_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status is distinct from old.status
     and exists (select 1 from public.billing_approvals b where b.visit_id = old.id and b.voided_at is null) then
    raise exception 'This visit is approved for billing; void the billing approval before correcting it';
  end if;
  return new;
end;
$$;

revoke all on function public.service_visits_billing_approval_guard() from public, anon, authenticated;

drop trigger if exists service_visits_billing_approval_guard on public.service_visits;
create trigger service_visits_billing_approval_guard
before update of status on public.service_visits
for each row execute function public.service_visits_billing_approval_guard();

commit;

-- ROLLBACK (only if the guard must be removed; it changes no data):
--   begin;
--   drop trigger if exists service_visits_billing_approval_guard on public.service_visits;
--   drop function if exists public.service_visits_billing_approval_guard();
--   commit;
