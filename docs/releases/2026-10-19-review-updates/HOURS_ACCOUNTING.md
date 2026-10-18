# Hours accounting (Batch 2, items 2.2 and 2.3), migration 0079

**Status: IMPLEMENTED and TESTED LOCALLY. NOT DEPLOYED. TEST has 0053-0077 applied; production is unknown. Nothing here was run against AWS.**
Migration `0079_hours_accounting_one_bucket.sql` with rollback `rollback/0079_hours_accounting_one_bucket.down.sql` (SAFE AUTOMATED: functions only, no table, column or stored row changes). No existing migration was edited.

## Definitions (per authorization lineage, per agency-local month)

`Authorized = Billable + Rounding + Pending + Reserved + Hours left`

| Name | What it is | Source rows |
|---|---|---|
| Billable | Confirmed billable minutes: signed visits plus minutes accepted from a late confirmation | `service_visits` (status signed), `visit_review_decisions` (accept_late_confirmation) |
| Rounding | Approved billing rounding adjustments, positive or negative, net of voids. Own line, counted once. Shown only when not zero | `billing_rounding_adjustments` |
| Pending | Worked but not yet billable. (a) billable minutes carried by a visit in administrator review; (b) shift time held while the linked visit awaits confirmation or is in review with nothing billable; (c) worked minutes of an ended visit awaiting confirmation or in review that has no billable minutes and holds no reservation | `service_visits`, `authorization_reservations` |
| Reserved | Scheduled time not yet delivered: shifts ahead, under way, and shifts that ended with no visit record (awaiting a person's decision, including "awaiting record") | `authorization_reservations` via `reservation_bucket` |
| Hours left | Authorized minus the four above. Signed. Negative is displayed as **Over limit** with the amount over | computed |
| Worked, not billable | Reconciliation line OUTSIDE the equation: worked minutes of signed and in-review visits beyond what is counted as Billable or Pending | `service_visits` |

Hours left and Over limit are per authorization. A total across authorizations (Home, the reporting section, the client calendar) adds Hours left over the authorizations that still have time and Over limit over those that are over, side by side. They are never netted: Authorized - Billable - Rounding - Pending - Reserved = Hours left - Over limit on a total, and the screens say so.
Old columns (`billable_minutes`, `remaining_minutes`, `committed_minutes`, `over_limit_minutes`, `reserved_*`) keep their exact meaning; the new columns are `hours_*` (additive). The web now reads `hours_*` and falls back to the old fields only for an older server.

## What was wrong (proved by an independent recompute, `hours-accounting.db.test.ts`)
The old identity `authorized = billable + adjustment + reserved + remaining` always held, because `remaining` was defined as the residual. It could not show a gap, so the gaps were hidden:

1. **Gap: an unscheduled visit awaiting confirmation or in review (no shift, no reservation) was in no bucket.** Example (test): authorized 600, visit worked 45 awaiting confirmation. Old: Billable 0, Reserved 0, Remaining 600, so 45 worked minutes appeared nowhere. New: Pending 45, Hours left 555.
2. **Billable included visits that are only in review.** A 60-minute visit in review on a 130-minute shift was shown as Billable 60. The owner definition puts it in Pending (now Billable 0, Pending 60, Hours left 540; the old `billable_minutes` field still says 60).
3. **Worked time beyond billable was invisible.** Worked 150 on a 100-minute authorization: capped billable 100, 50 minutes appeared nowhere. New: "Worked, not billable 50" (a visible line, not part of the equation, because those minutes are not part of Authorized). With 60 more reserved ahead, that authorization reads Over limit 60 (Hours left -60), while another authorization with 600 unused stays at 600 (test "overages are per authorization").
4. **"Reserved" mixed two things.** Shift time held for a visit awaiting confirmation or review is Pending (worked, not yet billable); Reserved is only not-yet-delivered time. The old `reserved_minutes` total is unchanged; the split is `hours_pending_held_minutes` and `hours_reserved_minutes`.
5. Defensive: `reservation_bucket` now returns no bucket for a reservation whose linked visit is already signed (it is Billable; 0013 releases it at signing, so the test cannot reach a case; the guard prevents a future double count). The 0071 version of the function (awaiting_record for delivered_unverified) was kept and extended, not replaced.

**No double count was found in current flows.** Checked by test: review visit with billable minutes plus its reservation (0052 holds), accepted late confirmation plus its reservation (0049 holds), correction (the original is `corrected`, only the new visit counts), rounding positive and negative (counted once), ended shift reconciled as no service (leaves Reserved).

**The review document example** (Authorized 20,162.3 h, Billable 63.3 h, Hours left 20,067.9 h, 31.1 h unexplained, only Over limit shown; worked 66.5 h vs billable 63.3 h) could not be reproduced here (no production data). Its pattern matches the causes above: 31.1 h is Reserved/Pending/Rounding time that was not displayed, and the 3.2 h between worked and billable is the cap/uncounted time. After 0079 each of those has its own line; run the test-environment numbers through the Details view to confirm.

## Intentional caregiver vs office differences (2.3)
Both are now computed on the server from the same function (`ogevia.hours_breakdown`) and the same records; the screens only display them. A test computes every surface from the same seeded records and asserts they agree.

| Measure | Caregiver Start Visit | Office |
|---|---|---|
| Name | **Left to record** | **Hours left** |
| Deducts | Billable, Rounding, Pending carried by visits in review (exactly `authorization_month_usage`, the room the cap uses at confirmation) | the same, plus shift time held for review, unscheduled pending time, and Reserved (scheduled) time |
| Scheduled reservations deducted? | **No** | **Yes** |
| Why | a caregiver records what happened; confirmation caps against confirmed time | scheduling must not promise hours that are already spoken for |

The caregiver screen states the difference in words from the server numbers ("The office Hours left is lower by X Reserved for scheduled visits and Y Pending"). Identity tested: `left_to_record - office_pending - office_reserved = hours_left`. No unintended discrepancy was found: both used the same records for Billable, Rounding and review-carried time before 0079.

## Surfaces
| Surface | Source | Change |
|---|---|---|
| Home (hours section) | `get_utilisation_overview` | columns Billable, Rounding, Pending, Reserved, Hours left, Over limit, Worked, Worked not billable; equation and "not offset" note |
| Client details | `list_monthly_service_summary` | per authorization Billable, Pending, Hours left or Over limit, with **Details** (full equation) |
| Reports (monthly hours and billing, client calendar) | same + CSV | Rounding, Pending, Reserved, Hours left or Over limit columns, Details per row, CSV columns |
| Reporting section, chain report | `get_monthly_chain_report` (+ server CSV) | same buckets; "Hours accounting adds up" check; Details per row |
| Continuity pack | `create_continuity_pack` | Billable, Rounding, Pending, Reserved, Hours left, Over limit and the equation text |
| Caregiver Start Visit | `list_caregiver_hours_balances`, `get_active_visit_balance` (new, added to the existing routes) | Left to record from the server; difference note; "Serviced" renamed "Confirmed" |

Renamed: "Hours balance" to "Hours left"; "Monthly limit" to "Authorized"; "Used this month" to "Billable this month"; "Over the limit" to "Over limit"; "Left" and "Remaining to schedule" to "Hours left"; "Balance for month" to "Hours for month".

## Concurrency
No lock, reservation write, lineage lock order or confirmation-time cap was touched. `hours_breakdown` is a read-only `stable` function. Existing reservation-race tests (`reconciliation-races`, `reservation-lifecycle`) pass.

## Open items for the owner (not changed)
1. **Pending time that holds no reservation (c) lowers the displayed Hours left but the scheduling guards (`create_shift`, `authorization_month_reserved`) do not count it.** The office can therefore see less Hours left than the scheduler allows. The cap is still applied at confirmation. Decide whether the guards should also count it.
2. **A review closed as not billable on a scheduled visit keeps its shift reservation** (existing behavior noted in 0052), so that time stays Pending indefinitely. Unscheduled closed reviews move to "Worked, not billable". Decide whether closing releases the hold.
3. In-progress (draft) visits with no shift have no worked time yet and are not counted until they end.
4. Only the monthly basis exists, as before; no carryover.

## Tests (all local, synthetic data)
- `infra/aws/db/test/hours-accounting.db.test.ts` (20): every bucket recomputed from raw tables and compared with the server for each authorization: empty; awaiting confirmation (scheduled); in review no signer (scheduled); in review carrying billable; unscheduled awaiting (gap fixed); unscheduled in review (gap fixed); review closed as not billable; draft visit under way; reservations ahead, under way, ended without record and awaiting record; reconciled release; rounding positive and negative; correction; late confirmation accepted; overage with Worked, not billable; per-authorization Over limit never offset (Home totals); all surfaces agree (summary, Home, chain report, continuity pack, caregiver); caregiver equals office when nothing is pending; breakdown function not callable by the app role.
- `apps/sv-api/test/hours-accounting.db.test.ts` (1): new fields through the real handler (summary, Home, chain, CSV header, caregiver services and active visit).
- Web: `authorization-display.test.tsx` (equation lines, Over limit, Details, caregiver note, continuity pack) and `service-verification-page.test.tsx` (server Left to record and difference note); existing Home, reports and client tests updated for the new names.
- Rollback and upgrade rehearsals (`rollback`, `upgrade-*`, `readiness-*`, static migration checks) pass with 0079.
