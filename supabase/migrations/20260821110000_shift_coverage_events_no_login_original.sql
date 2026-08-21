-- Found while running a full Candidate -> Care Team -> Client ->
-- Authorization -> Recurring Schedule -> Call-out -> Replacement -> Visit
-- -> Report scenario end to end: shift_coverage_events.original_caregiver_user_id
-- was NOT NULL, so call_out_shift crashed with a constraint violation the
-- moment a shift's *original* assignee had no login at all - a caregiver
-- who was always a no-login Care Team member could never have their
-- shift called out, regardless of the reassign_shift fix in the previous
-- migration (which only handled the *replacement* side). This predates
-- that fix entirely - it's been broken since call_out_shift shipped.

alter table public.shift_coverage_events alter column original_caregiver_user_id drop not null;
