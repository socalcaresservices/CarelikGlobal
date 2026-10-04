-- PROPOSED production fix (NOT applied; needs owner approval as a production
-- migration). Same rule as AWS 0019: a visit with an ACTIVE billing approval
-- cannot change status (i.e. cannot be corrected or voided) until that
-- approval is voided with a reason. Works for every caller path, including
-- correct_service_visit, because it guards the row itself.
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
