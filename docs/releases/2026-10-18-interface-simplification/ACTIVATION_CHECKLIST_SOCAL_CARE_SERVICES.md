# Activation checklist: compliance and readiness enforcement for SoCal Care Services

**Status: PROPOSED. Nothing in this document has been run against the real tenant. Enforcement is NOT activated anywhere.** Written 2026-10-17 on the local branch `integration/compliance-attention-onto-scheduling-recruiting` (migrations through 0066, not deployed, not pushed).

The compliance rules (background clearance, CPR/TB within 14 days of hire, hold on expiry) are **owner-defined rules, not verified legal requirements**. This checklist does not assert that any of them is a statutory or payer requirement.

## 0. What this checklist is, and what it cannot tell you

| | |
|---|---|
| Real tenant | slug `socal-care-services` (`infra/aws/db/deploy/12_prd_bootstrap_tenant.sql`) |
| Affected caregivers and shifts for the real tenant | **UNKNOWN.** I have no read access to the live database and did not query it. The names, counts and shifts below are produced only by running the read-only preview (section 2) against the real database, by someone authorized to do so, immediately before the decision. |
| Evidence that the preview matches what activation does | Local synthetic test only: `infra/aws/db/test/pilot-synthetic-enforcement.db.test.ts` (the caregivers it lists are exactly the caregivers held, and the shifts it lists are exactly the shifts flagged, after activation and one scheduled run). That is not proof of TEST or production behaviour. |

## 1. What activation does (and does not do)

Activation is one owner action: `ogevia_api.activate_readiness_enforcement(org, reason, expected_affected_shifts)`. It sets `organization_readiness_settings.enforcement_active_from = now()` and writes an audit event and a setting-event row with the readiness report. Nothing else changes at that moment.

After it, and not before:

- Scheduling, assignment and visit start apply the readiness checks (background clearance, CPR, TB, availability) as blocks instead of report-only.
- The scheduled run (EventBridge rule in the API stack, every 15 minutes; **not deployed**) and the "Check now" button evaluate every Ready/Active caregiver. A caregiver with a blocking requirement gets a **compliance hold**: shifts and standing assignments are **flagged**, not cancelled, moved or reassigned.
- A **visit already in progress is never ended** by the system. The office sees it on the Caregiver holds page and in Needs attention now; the caregiver can still end it.
- The work-hour policy (8 h/day, 40 h/week) is **independent of this switch**. It is a migration (0060), always in block mode, scoped to slug `socal-care-services`. It applies the moment migration 0060 runs on the real database, whether or not enforcement is activated. Its scope and limits are stated in `WORK_HOUR_CALCULATION_SCOPE.md`.

It does not: send a message to anyone, cancel a shift, remove a caregiver, change an authorization, bill anything, or touch a visit.

## 2. Before the owner decides: produce the affected-caregiver and affected-shift list

Read-only. The script runs in a read-only transaction and ends with ROLLBACK; it contains no write statement. Its output carries caregiver codes, client codes and shift ids only (no names, no payer or member identifiers). Keep the output out of tickets and chat.

```
psql "<real-database read-only connection>" -X -A -F'|' -v org_slug=socal-care-services \
     -f infra/aws/db/preview/enforcement_activation_preview.sql
```

Access to the real database must follow `TEMP_DB_ACCESS_PROCEDURE.md`. I did not run this against any live database.

Sections of the output, and what to do with each:

| Section | Lists | Owner decision it supports |
|---|---|---|
| A | Organization, enforcement state, work-hour policy in force | Confirm enforcement is off and policy v1 is present |
| B | Ready/Active caregivers who **would be held**, with each blocking requirement (background, CPR, TB, hire date missing, after deadline) | Fix the record, or accept that the caregiver is held |
| C | Future scheduled shifts that a hold would **flag** (shift id, time, client code, in progress now) | Decide who covers them before activation |
| D | Standing assignments a hold would flag | Same |
| E | **Visits in progress** for those caregivers | Arrange safe coverage; activation will not end them |
| F | Scheduled shifts where CPR/TB is expired or expires **during** the shift (0066) | Renew the document or move the shift |
| G | Future shifts the general readiness gate would block today (documents, availability, other; service approvals excluded) | Same as C |
| H | Future shifts **already over** 8 h/day or 40 h/week | Reschedule or reassign; the rule will refuse any new such shift |
| I | Totals | Compare with section B/C counts |

Record the totals in the decision record below. The expected-affected-shifts number passed to the activation function must equal the server's own count at the moment of activation; if work changes in between, the function refuses ("The affected work changed since you reviewed it. Review the report again.").

## 3. Preconditions the system will check, and ones it will not

| Precondition | Checked by the system? |
|---|---|
| CPR and TB each have a document type and a validity rule | **Yes.** Activation is refused until `setupComplete` (seen in the local pilot test: "Finish the CPR and TB setup first"). |
| Expected affected-shift count matches | **Yes.** |
| Caller is an owner/administrator with readiness-manage permission | **Yes.** |
| Hire date recorded for every Ready/Active caregiver | **No.** A caregiver with no hire date and a missing CPR/TB is held immediately (`missing_no_hire_date`). Section B shows them. |
| Background clearance verified for every Ready/Active caregiver | **No.** A caregiver without verified approved clearance is held. Section B shows them. |
| Availability recorded | **No.** Missing availability is reported in the readiness report (`availabilityNotProvided`). |
| The scheduled run is deployed and the rule is enabled | **No.** The EventBridge rule is defined in the API stack but nothing has been deployed. Until it is, holds open only when someone uses "Check now" or the document/profile triggers fire; the gate itself still refuses immediately. |
| Office staff know who covers each affected shift | **No.** That is a human step; sections C, D, E exist for it. |

## 4. Proposed sequence (each step needs the owner's explicit approval; none has been taken)

1. Owner approves running the preview read-only against the real database (access per `TEMP_DB_ACCESS_PROCEDURE.md`).
2. Run the preview; save the output outside the repository; fix records (hire dates, clearance, documents) that are wrong rather than true.
3. Re-run the preview. Record totals (section I) and the section B list in the decision record below.
4. Arrange coverage for sections C, D and E. Confirm who handles a visit in progress.
5. Confirm the scheduled run is deployed (a separate release decision, `docs/TESTING_AND_RELEASE_PROCESS.md`) or accept manual "Check now" until it is.
6. Re-run the preview immediately before activation; the totals must match step 3 or be explained.
7. Owner activates (reason required). The system audits it.
8. Immediately run "Check now"; compare the holds that open with section B and the flagged shifts with section C. Any difference is a defect to report, not to hide.
9. Rollback: there is no "deactivate" function. `enforcement_active_from` can only be cleared by a database change under the release process; that is a deliberate property. Holds that are open can be released only by resolving the requirement (the owner's rule). Plan on activation being one-way.

## 5. Decision record (blank until the owner acts)

| Item | Value |
|---|---|
| Preview run by / when / against | |
| Ready/Active caregivers | |
| Caregivers who would be held | |
| Future shifts flagged | |
| Standing assignments flagged | |
| Visits in progress at preview | |
| Shifts with CPR/TB expiring (section F) | |
| Shifts already over 8 h/40 h (section H) | |
| Coverage plan recorded | |
| Scheduled run deployed? | |
| Owner approval (name, date) | |
