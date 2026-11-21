# Production schedule clear: preview and plan (2026-11-21). NOTHING HAS BEEN CHANGED IN PRODUCTION.

## Owner request
No November 2026 shifts on the active schedule. Clear all unworked November shifts (including past dates) and all future scheduled shifts from December 1 onward, so the schedule can be rebuilt. Recurring schedules must not recreate them. Keep all clients, caregivers and authorizations (including authorized hours). Keep worked, verified, billed and payroll-linked November visits in history; if they also show on the active schedule, hide them there without touching the records. Read-only preview first; wait for an explicit GO.

## What the app already does (VERIFIED in the code, migrations 0026, 0034)
- "Clear" = cancel, never delete. `ogevia_api.cancel_shift(org, shift, reason)` sets status `cancelled` with the reason, releases the shift's authorization reservation (authorized hours are unchanged; only reserved time returns), and writes an audit event. It refuses a shift that has a visit (voided and corrected visits do not count) and a shift that came from a Care Request (those are cancelled on the Care Requests page). It works on past dates.
- Recurring series: `ogevia_api.end_shift_series(org, series, from_date, reason)` cancels the series' unworked future shifts from that date, keeps shifts that have started or have a visit, and either ends the series (if it starts on/after that date) or sets `ends_on` to the day before. A series is only ever extended by a person (`extend_shift_series`); the only scheduled job is the compliance sweep, so nothing regenerates a cleared series.
- Ogevia has no payroll feature (0029): nothing is "payroll-linked" inside Ogevia. Billing approvals exist (not submission); the preview reports them.

## What is NOT possible without a change, and what was added
- Cancelled shifts still showed on the office schedule (as "Cancelled"), so clearing alone would not empty the November view. Added (web only, local and unit tested, not deployed): the office schedule now defaults to **Active schedule**, which hides cancelled shifts (any date) and finished shifts (completed, partial, not delivered, no-show) dated before today. A **Show** control (Active schedule / History / Everything) and a hint with a "Show History" button bring them back. Shifts that still need someone (in review, awaiting a decision, missed, delivered-not-verified, needs coverage) are never hidden. Nothing is deleted; records, visits and audit are untouched. Side effect: "Schedule make-up" on a cancelled shift is one click further (Show > History).
- Cancelling and ending series must run as the signed-in Administrator (the functions check the actor). Doing hundreds of shifts one by one in the browser is impractical, so the executor would run these same functions as the owner's identity from a reviewed script (as the seed scripts do); it is not built yet and will be reviewed after the preview.

## Preview (read-only)
`PREVIEW_SCHEDULE_CLEAR.sql` (SELECT-only; temp tables only; ends with ROLLBACK) and `PRD_SCHEDULE_PREVIEW.sh` (production runner). The runner temporarily attaches the application database security group to the admin host to open the tunnel and removes it again (also on failure), as in the earlier production releases; it asks for a typed confirmation first. Output is counts, client codes and visit numbers only. Tested on the local harness (synthetic data); NOT yet run on production.

## Rollback story (for the later clear)
Cancelled shifts cannot be un-cancelled in the app. The clear would be preceded by a verified logical backup of production; restoring from it is the only full undo. A series ended by mistake can be replaced by creating a new series.
