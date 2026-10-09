# Current decisions and remaining risks — PR #76 review

The owner chose PR #76 as the canonical release. Do not merge competing PR #75 readiness migrations first. See [deployment handoff](DEPLOYMENT_AND_ROLLBACK.md) for the exact merge and rollout order.

Completed: Administrator-only required CPR/TB verification; readiness checks for every new live visit including managers; final mandatory client-requirement checks for shifts, rescheduling, reassignment, recurring materialization and standing relationships; administrator experience/preferences/ZIP forms; honest report-only assignment wording; no location dataset/provider introduced.

Remaining gaps and decisions:

- Nothing is deployed. Real Cognito login/MFA, role menus and post-deployment API permissions remain to be checked as listed in the handoff.
- Report-only is a rollout aid and does not meet the current verified CPR/TB requirement. Finish explicit agency validity rules, records, reviews, availability and services, then activate before real work.
- Distance remains unavailable without an approved source/licence/vintage. ZIP input alone does not calculate distance. Weights and radius are provisional, pending approval.
- Recurring-series preview does not yet enumerate missing mandatory experience as a per-occurrence skip reason. Final materialization refuses it transactionally; an apparently acceptable preview cannot bypass the final checks.
- An unscheduled live visit has no known planned end. Start checks cover its start/minimum interval; they cannot promise document/availability coverage for an unknown future duration. Use scheduled work when whole planned-interval proof is required. Visits already running are not interrupted.
- Time-driven expiry is recomputed at checks/report time; no new scheduler proactively creates stored flags just because time passes.
- An Administrator with direct database write privileges can bypass application rules, as before. Matching has not been load-tested; actual phone hardware and assistive technology were not tested here.
- The legacy Supabase application is outside this AWS readiness implementation. Do not advertise its older proxy-based CareScore as measured proximity or as an enforcement gate.
- Archive/reapply is not operational record restoration. Use the data-preserving application rollback; a full restoration/import plan remains separate work if schema downgrade becomes necessary.
