# Work-hour limit (8 h/day, 40 h/week): what is calculated, and where it falls short of the approved policy

Local, 2026-10-17, migrations through 0066. **Implemented and tested locally; not deployed; not run on TEST or production.** Owner-defined policy, not a verified legal or payer requirement.

## Conclusion

The database enforces **8 hours a day and 40 hours a week on SCHEDULED time**. It does **not** enforce them on **actual worked time**. Full enforcement of the approved policy is therefore **not** claimed. Hours worked beyond the schedule, unscheduled visits, and visits still open are not counted, and a visit that has started is never stopped.

## What is counted (VERIFIED in `0060_agency_work_hour_limits.sql`, `caregiver_hour_load`, `hour_limit_issue_range`, `shifts_work_hours_guard`)

| Question | Answer |
|---|---|
| Which records | Rows in `ogevia.shifts` with `status` `scheduled` or `completed`, for the caregiver record, not cancelled, not called out |
| Which times | The shift's **scheduled** `starts_at` and `ends_at`. Not the visit's `time_in`/`time_out` |
| Day boundary | Agency-local midnight (an overnight 22:00-06:00 shift counts 2 h on the first day, 6 h on the next) |
| Week boundary | Monday 00:00 agency-local through the following Monday |
| When it is checked | Create, reschedule, reassign, call-out replacement, open-shift pickup confirmation, care-request assignment, make-up, every date of a recurring series; plus a database trigger on `shifts` (insert and update of a scheduled, unfinished shift with a caregiver) under the caregiver lock |
| Can anyone override it | No API, role or screen. A manager's looser limit or report mode changes nothing (the stricter limit always wins, block mode). A change is a reviewed migration |
| Which agency | Policy rows are keyed by slug: `socal-care-services` (migration 0060). The synthetic pilot gets its own row only through `db/deploy/06_pilot_work_hour_policy_synthetic.sql`; nothing else is affected |

## Scheduled hours versus actual worked hours

| Situation | Counted? | Why / effect |
|---|---|---|
| Scheduled shift, worked exactly as scheduled | Yes | Counted from the shift row |
| Scheduled shift, caregiver works **longer** than scheduled (overrun) | **No** (extra time) | The shift row keeps its scheduled end; the visit's actual `time_out` is not read. The overrun does not reduce what can be scheduled afterwards |
| Scheduled shift, worked **shorter** or not at all | Counted at scheduled length while the shift stays scheduled or completed | A cancelled or called-out shift is released |
| **Unscheduled** (ad-hoc) visit | **No** | It has no shift row. It is not checked when started either |
| Visit **in progress** | Only through its shift, at scheduled length | Starting a visit does not run the hours check (`visit_start`/`assignment` contexts skip it) and nothing stops or ends a visit |
| Legacy shift with only `caregiver_user_id` (no caregiver record) | **No** | The load query and the trigger key on `caregiver_record_id` |
| Same person on two organizations | No | Counted per organization |
| Shift already over the limit when the policy is applied | Not removed | The rule refuses **new** over-limit shifts; existing ones are listed by the activation preview, section H |

## Where the current behaviour falls short of the approved policy

1. **Actual hours are not measured.** A caregiver can exceed 8 h in a day or 40 h in a week by working past a shift end, by unscheduled visits, or by back-to-back visits that were each scheduled within the limit but ran over. The system will not stop or flag this. *Proposed closure (needs owner approval): a report-and-alert on actual worked minutes from signed/finalized visits, per caregiver per day and week; no automatic termination of a visit.*
2. **Unscheduled visits bypass the check.** A visit started without a shift is neither counted nor refused.
3. **Visit start is not gated by hours.** A visit in progress is never ended by the rule (deliberate, safety), but the system also does not warn the office that a started visit puts the caregiver over the limit.
4. **Stricter payer or legal limits are not modelled.** Only the agency's fixed 8/40 and any stricter manager-set limit apply. Whether California wage-and-hour, overtime, or payer rules require different limits was **not verified** and is outside what this code claims.
5. **Not on TEST or production.** All evidence is local tests on a disposable PostgreSQL and a local browser harness with synthetic data.

## Evidence (local)

`infra/aws/db/test/work-hour-limits.db.test.ts` (exact 8 h / 8 h 01, 40 h / 40 h 01, midnight and Sunday-midnight splitting, series, assignment, concurrency); `apps/sv-api/test/scheduling-rules.db.test.ts` (the same through the API); `infra/aws/db/test/pilot-synthetic-enforcement.db.test.ts` (the synthetic pilot with the fixture policy: 9 h refused, 5 x 8 h then 1 h refused as the 41st hour, another caregiver unaffected, the agency's own policy and all other slugs unchanged); browser scenario `infra/aws/local-harness/browser-scenario.mjs` (a request for a 9-hour open shift is refused with "Over the daily hour limit."; the agency limit is stated on the Hours and limits panel).
