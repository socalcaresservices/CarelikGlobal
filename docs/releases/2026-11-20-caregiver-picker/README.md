# Caregiver picker (2026-11-20)

Status: **implemented and tested locally. Not deployed.** No migration, no release switch, no AWS change.

The earlier requirements were not available; this is the owner's feature name ("Caregiver picker") read as one shared chooser for the five places that had their own plain dropdown. Rules below are my choices and need owner confirmation.

## Rules
- One component, `apps/web/src/aws/caregiver-picker.tsx`; rules in `caregiver-order.ts`.
- Options sorted A-Z by last name, then first name (case-insensitive, numbers natural); ties keep server order.
- A name shared by another record shows its code beside it (existing `nameWithCode` rule). Callers add their own suffix (for example "planned: no sign-in yet").
- A list of more than 8 caregivers gets a "Find a caregiver" box (name or code). The chosen caregiver stays in the list while searching. No match shows "No caregiver matches that search."
- Still a native select, so a phone uses its own picker.
- Eligibility is unchanged: each caller still decides who may be offered (ready or active for shifts; not inactive for assignments; everyone for outage visits).

## Where it replaces a plain dropdown
Add shift (`schedule-page.tsx`), reassign a shift (`schedule-page.tsx`), assignments card, outage visits, add shift from a missed visit (`scheduling-extras.tsx`).

## Tests
`apps/web/src/aws/caregiver-picker.test.tsx` (6) plus the existing schedule, assignment, outage and scheduling suites (621 tests under `src/aws`, all pass).
