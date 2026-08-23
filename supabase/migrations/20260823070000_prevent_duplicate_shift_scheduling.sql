begin;

-- Scheduling audit's remaining item: nothing at the data layer stopped
-- the same client from being scheduled twice for the exact same time
-- window. Found a live example in production before writing this
-- (two 'scheduled' shifts for the same client/caregiver/time slot,
-- created a minute apart - almost certainly a double-click/double-submit
-- on shift creation). That pair was resolved manually per explicit
-- direction (CARE-V-20260719-D370 cancelled with a reason logged in
-- shift_coverage_events, CARE-V-20260719-FBF9 kept) before this
-- constraint was added, per "check existing data before adding
-- constraints." Demo had no such duplicates.
--
-- Scoped to (organization_id, client_id, starts_at, ends_at) rather than
-- also including caregiver_user_id/caregiver_record_id: the duplicate
-- that actually occurred, and the failure mode this guards against, is
-- the same client being double-booked for the same visit - not two
-- different caregivers covering the same client concurrently, which
-- some agencies do intentionally (e.g. two-person transfers). A
-- cancelled shift is excluded so cancelling a mistaken duplicate (as
-- above) or a legitimate re-schedule never blocks the replacement.
create unique index shifts_no_duplicate_active_occurrence
  on public.shifts (organization_id, client_id, starts_at, ends_at)
  where status <> 'cancelled';

commit;
