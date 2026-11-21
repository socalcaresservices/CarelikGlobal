# Scheduling refusal message improvements (2026-11-20)

Status: **implemented and tested locally. Not deployed.** No migration, no release switch, no AWS change.

## What changed
- New `apps/web/src/aws/scheduling-refusal.ts`. When the server refuses a scheduling change, the screen keeps the server's sentence word for word and adds one plain "What to do:" step for the refusals we recognise: caregiver already has a shift at that time; already on this shift; called out of this shift; shift just filled or no longer scheduled; not enough authorized time; no current authorization; caregiver not ready to work; visit in progress; shift over, started or linked to a visit; missing reason; shift length; permission; retry. An unrecognised message is shown unchanged. A request that never reached the server says nothing was saved.
- Used by every scheduling form: add shift, assign, call-out, cancel, change time (`schedule-page.tsx`), recurring and single-date changes (`recurring-schedule.tsx`), make-up and add shift from a missed visit (`scheduling-extras.tsx`), pickup confirm and decline (`pickup-requests.tsx`).
- Server messages were not changed (that needs a migration). Wording of the next steps is the builder's and needs owner review.

## Tests
`scheduling-refusal.test.ts` (4: recognised messages, unrecognised and empty, network failure, never twice) and `schedule.test.tsx` (1: a refused assignment shows the sentence plus step in the drawer and changes nothing). Full web suite passes (1367).
