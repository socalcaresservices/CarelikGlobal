-- READ-ONLY. Run BEFORE migration 0049 (and again after). Counts the open reservations that 0049 stops counting as "reserved":
-- shifts whose linked visit is in administrator_review with an active accepted late-confirmation decision.
select count(*) as reservations, coalesce(sum(r.reserved_minutes), 0) as reserved_minutes
from ogevia.authorization_reservations r
where r.released_at is null
  and exists (
    select 1
    from ogevia.service_visits v
    join ogevia.visit_review_decisions d on d.visit_id = v.id
    where v.scheduled_shift_id = r.shift_id
      and v.status = 'administrator_review'
      and d.revoked_at is null
      and d.decision = 'accept_late_confirmation');
