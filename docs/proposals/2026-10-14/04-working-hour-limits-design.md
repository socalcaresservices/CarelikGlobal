# Proposal 4: agency working-hour limits (decision D5)

**Status: PROPOSED. Nothing built.** Direction: configurable agency rules, initial proposed default **8 hours per day and 40 hours per week**; define how hours are calculated (overlaps, overnight, open-shift pickup, workweek boundary); present enforcement and exception behavior for approval.

**Important limits of this proposal.** The 8 and 40 are your proposed defaults. I have not checked them against labor law, payer rules or your regional center's rules, and Ogevia must not describe them as legal limits. Today **no such rule exists** in the AWS data model (VERIFIED: no field, no check). Ogevia also sees only hours worked for this agency; hours a caregiver works elsewhere are invisible.

## 1. The rule (agency setting, versioned like the visit rule from Wave 1)
`daily_limit_minutes` (default 480), `weekly_limit_minutes` (default 2400), `workweek_starts` (day of week and local time; default Sunday 00:00 agency time), `mode`, effective date, reason, who and when; each change is a new version, never on a past date, never rewriting history. Either limit can be left empty (no limit). Only the Administrator changes it. Starting `mode` is **Report only** (same pattern as readiness: measured and shown, nothing blocked) until the Administrator activates it, with the number of existing bookings that would exceed it shown first.

## 2. How hours are counted (per caregiver, across every client and service of the agency)
- **Worked time:** the worked minutes of the caregiver's visits that are ended (signed, in review, or awaiting signature). Voided and corrected-away visits are excluded; a correction counts as its replacement.
- **Scheduled time:** the length of shifts that are scheduled, not cancelled and not called out, **only where no live visit is linked to that shift** (a linked visit counts by what was worked, so nothing is counted twice).
- **Open visit:** counts elapsed time only after it ends; a still-open visit is not counted (shown as "in progress").
- **Overlaps:** time is counted as a **union of intervals** per caregiver, so two overlapping bookings count the overlapping minutes once. (Overlap is separately refused by the existing conflict check; the limit calculation is defined so it stays correct if an override allowed one.)
- **Overnight:** an interval that crosses agency-local midnight is split at midnight; each part counts toward its own local day. The week is the sum of its days.
- **Workweek boundary:** the week runs from the configured start to the same local time seven days later, in the agency time zone. On a daylight-saving change a week is 167 or 169 real hours; the rule uses local clock intervals, not 168 fixed hours.
- **Cancelled and called-out shifts** stop counting immediately. **Unconfirmed visits** count by worked time, not billable time.

## 3. Where it applies
| Action | Report only | Warn | Block |
|---|---|---|---|
| Caregiver picks up an open shift | shown after, nothing stops | shown before the tap; allowed | refused with the reason ("This shift would put you over 8 hours on Tue 10/20: 7 hours already booked") |
| Office assigns or creates a shift | shown in the checks panel | allowed with a required reason | refused unless an exception exists |
| Recurring series | evaluated per occurrence, listed | same | same |
| Visit start (unscheduled) | not limited (work already happening) | same | same: recorded and flagged, never refused |

**Recommendation:** go live in Report only; then Block for caregiver self-pickup and Warn-with-reason for the office. A visit that is already happening is never stopped by this rule; it is flagged.

## 4. Exceptions
A recorded exception is one caregiver, one day or one workweek, with a required reason, who and when, and an expiry; it never lifts any other check; it is audited and listed on the schedule. Pickup never silently bypasses a limit.

## 5. Caregiver and office wording
Short and neutral, no pay or overtime language: "This shift would put you over your agency's 8-hour daily limit." The office sees totals per caregiver per day and week with the limit and what counts.

## 6. Tests (written first)
Union of overlapping intervals; overnight split across two days and across the week boundary; daylight-saving weeks; scheduled shift with a linked visit counted once; cancelled and called-out stop counting; correction replaces; pickup at exactly the limit succeeds and one minute over is refused; concurrent pickups by two caregivers; exception scope and expiry; rule versioning (a change never changes a past evaluation); report-only mode never blocks.

## 7. Dependencies and approvals
Database: versioned rule table and functions, one new check inside the existing assignment and pickup gate. API and web: settings page, pickup message, schedule panel. Needs: your confirmation of the defaults and of every counting rule above (especially "union of overlaps" and "worked time, not billable time"); your choice of mode per action; and your statement of any agency, payer or labor policy these limits are meant to follow, which I will cite and not assume.
