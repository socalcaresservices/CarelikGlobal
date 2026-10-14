# Proposal 2: scheduling preference: Not set, Fixed, Flexible, Mixed (decision D3)

**Status: PROPOSED. Nothing built.** Direction: these are descriptive preferences, **not eligibility restrictions**; a Fixed caregiver may accept an additional open shift if every applicable check passes; inspect existing data first; **do not automatically reclassify caregivers.**

## Data inspection
- **Pilot or production data: NOT inspected.** I have no AWS access. Run the read-only script `read-only-caregiver-scheduling-preferences.sql` in this folder (counts only, no names or identifiers) and send me the result before the migration is finalized.
- Local test data (seeded, synthetic): 4 caregiver records, all `fixed`, hire type "not recorded", **0 chosen by a person** (no `caregiver.employment_set` audit event), so every value is the column default.
- **Why that matters (VERIFIED, migration 0030):** `scheduling_mode` is `NOT NULL DEFAULT 'fixed'` with values fixed and flexible, so a never-chosen caregiver and a deliberately Fixed one look identical in the column. The audit event is the only evidence of a deliberate choice.
- **Who reads the column (VERIFIED, local catalog):** `get_visit_review`, `list_billing_review_visits`, `list_service_visits` (labels such as "Flexible visit, no shift required"), `list_caregivers` and `set_caregiver_employment`. Nothing uses it to decide eligibility, and the open-shift pickup function does not read it.

## Proposal (migration 0053, additive in effect)
1. `alter column scheduling_mode drop not null`, drop the default, and replace the check with `null, 'fixed', 'flexible', 'mixed'`.
2. **No existing row is changed.** Existing caregivers keep what they hold today. New records start as Not set.
3. `set_caregiver_employment` accepts Not set (null) and Mixed. The UI shows "Not set" for null; hire type is renamed "Not set" instead of "Not recorded"; hire type, scheduling preference and family relationship stay three separate fields.
4. Optional, your call (D3b): an office list "Preferences never chosen", built from the audit evidence, so people can confirm them. Not automatic; nothing is reclassified.
5. Rollback: refuses while any row is Not set or Mixed (it would lose information); otherwise restores the old constraint and default.

## Things that must not change (tests)
Pickup works for Fixed, Flexible, Mixed and Not set caregivers when the checks pass and refuses by the same rules otherwise; hire type and family relationship never change eligibility; the labels on visit screens for Fixed and Flexible are unchanged; Not set and Mixed show a neutral label.

## Open question
What should Mixed change besides a label? Today Fixed and Flexible differ only in labels, so Mixed would too. Say if you want it to drive something (for example order in an open-shift offer).
