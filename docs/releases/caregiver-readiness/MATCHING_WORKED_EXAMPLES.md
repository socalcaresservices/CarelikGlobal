# Matching: worked examples (provisional rule `v0-provisional-50-25-25`)

Eligibility is decided first by the same checks as the commit-time gate. The score only orders people who are already eligible and never rescues a failed check.
Weights are **provisional** and recorded with every result. These examples are reproduced as assertions in `infra/aws/db/test/matching.db.test.ts`.

## Formula
availability = 50 x (eligible occurrences / total) | location = 25 x max(0, 1 - miles/25) ("Approx. distance", ZIP centroids) | experience = 25 x (administrator-confirmed
wanted tags / wanted tags). Total = points / weights of the *applicable* components x 100. A component whose input is missing is "missing" (never 0, never full);
the candidate shows "Score incomplete" and, if any eligible candidate is incomplete, the list is **not** ordered by score. Ties: higher score, already assigned to the
client, fewer minutes already scheduled that week, caregiver code. Distance 25 mi is a soft scoring shape, not a travel limit (a 40 mi caregiver is still eligible).

## Example 1: one fully covered shift (the limitation)
Three eligible caregivers, one shift: availability = 50, 50, 50. **It cannot rank anyone.** Differences come only from location and experience, so when those are
missing the list is ordered by the deterministic tie-breakers and says "Score incomplete". Proposal that stays meaningful: keep availability as a *coverage* signal
(it matters for recurring work and partial coverage) and treat continuity (already assigned to the client) and workload that week as the visible tie-breakers.
Do not call availability a quality score for single shifts.

## Example 2: complete inputs (test values)
Client wants {ABA, Dementia care}, both preferred. A1: 0 mi, both confirmed -> 50 + 25 + 25 = **100%**. A2: 12.5 mi, one confirmed -> 50 + 12.5 + 12.5 = **75%**.
A3: 40 mi, reviewed with nothing confirmed -> 50 + 0 + 0 = **50%** (still eligible). Reviewed-no-match (0) differs from not-reviewed (missing).

## Example 3: recurring work, 4 dates
A1 covers 4/4 -> availability 50. A2 is unavailable on one date -> 3/4 -> 37.5 and eligibility "Partly covered" (listed after fully covered caregivers; the uncovered
date is named). Occurrences A2 cannot cover are never treated as assigned.

## Example 4: mandatory requirement
If the client marks "Dementia care" mandatory, a caregiver without an administrator-confirmed tag is **not eligible** ("Required experience not confirmed: Dementia care.")
whatever their score. A caregiver report alone does not satisfy it.
