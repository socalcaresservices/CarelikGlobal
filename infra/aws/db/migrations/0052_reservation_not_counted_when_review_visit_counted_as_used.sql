-- 0052 Authorization accounting: a minute is counted once, as USED or as RESERVED, for every visit in review (defect D2,
-- owner-approved 2026-10-14; the same defect as F1/0049, for the remaining cases).
--
-- Defect (reproduced in db/test/authorization-single-bucket.db.test.ts): authorization_month_usage counts the billable
-- minutes of signed AND administrator_review visits (0036), but a linked shift's reservation is released only when its visit
-- becomes 'signed' (0013). 0049 excluded the reservation from the reserved total only for an accepted late confirmation.
-- A scheduled visit that is in review WITH billable minutes - for example because its length differs from its shift by more
-- than the agency's schedule rule (0050), or because it went over the authorization - was therefore counted as used AND its
-- shift stayed reserved: a 60-minute visit on a 130-minute shift counted 190 minutes.
--
-- Rule (one definition, ogevia.reservation_counted_as_used, extended): a reservation is NOT part of the reserved total while
-- its shift has a linked visit in administrator_review whose minutes are counted as used, that is, with billable minutes above
-- zero, or with an ACTIVE accept_late_confirmation decision (0049). A review visit with no billable minutes and no accepted
-- late confirmation uses nothing, so its shift stays reserved (unchanged).
--
-- What this does NOT change: no stored row, status, billable minute, billing approval, decision or audit event; the
-- reservation row is never released, deleted or edited, so the result is reversible (a correction that voids the visit
-- or a decision that changes its billable minutes changes the answer on the next read). Only this one internal function is
-- replaced; the three functions that call it (authorization_month_reserved, care_request_reserved_usage and
-- list_monthly_service_summary, all from 0049) are untouched.

create or replace function ogevia.reservation_counted_as_used(p_shift_id uuid)
returns boolean
language sql
stable
set search_path = ogevia, pg_temp
as $$
  select exists (
    select 1
    from ogevia.service_visits v
    where v.scheduled_shift_id = p_shift_id
      and v.status = 'administrator_review'
      and (
        coalesce(v.billable_minutes, 0) > 0
        or exists (
          select 1 from ogevia.visit_review_decisions d
          where d.visit_id = v.id and d.revoked_at is null and d.decision = 'accept_late_confirmation'
        )
      )
  );
$$;
