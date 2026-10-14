-- ROLLBACK 0052 | CLASS: SAFE AUTOMATED (function only; no row is read, changed or deleted)
-- Restores the 0049 definition: only an accepted late confirmation takes a reservation out of the reserved total.
create or replace function ogevia.reservation_counted_as_used(p_shift_id uuid)
returns boolean
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select exists (
    select 1
    from ogevia.service_visits v
    join ogevia.visit_review_decisions d on d.visit_id = v.id
    where v.scheduled_shift_id = p_shift_id
      and v.status = 'administrator_review'
      and d.revoked_at is null
      and d.decision = 'accept_late_confirmation'
  );
$$;
