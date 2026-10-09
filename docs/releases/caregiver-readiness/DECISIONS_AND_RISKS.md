# Decisions taken, policy decisions still open, and concrete risks

## Decisions taken (reversible, evidence-based defaults; change on instruction)
1. **Report-only first.** Every agency, including new ones, starts report-only; activation is explicit, audited, owner-only, needs a reason, the
   reviewed affected-shift count, and complete CPR/TB setup. There is no API to deactivate (rollback is the data-preserving migration rollback).
2. **Care-request availability stays required at all times** (it was before). Candidate lists treat "Not provided" as not available even in
   report-only mode.
3. **Mandatory client requirements are enforced immediately**: they are new data, so no existing work can be stranded.
4. **Standing assignments:** an assignment that takes effect (caregiver Ready/Active) needs ready CPR/TB (and approval when Service checks are On)
   on its first day. A *planned* assignment (caregiver not yet Ready) grants nothing and is allowed. Each dated shift/visit is re-checked.
5. **Layering:** later-approved availability wins for the dates it covers; the hours entered before this release are layer 0; history is never
   overwritten. A specific-date layer replaces that day's hours; an "unavailable" date also blocks the early hours of an overnight window from the day before.
6. **Experience:** only administrator-confirmed tags earn points or satisfy a mandatory requirement. A caregiver's report earns nothing. Missing review
   is "missing" (not zero).
7. **Overrides:** availability only; one caregiver and time range; 30 minutes; reason required; every use audited.
8. **No dataset, no geocoding.** Distance exists only if a platform administrator loads a ZIP-centroid table with source, licence and vintage.

## Policy decisions needed from the owner (recommended default first)
| # | Question | Known | Unknown | Recommendation | If chosen otherwise |
|---|---|---|---|---|---|
| 1 | Who may *verify* CPR/TB? Today `documents.manage` = administrator **and manager** (existing module) | Brief says "administrator-verified" | Whether a manager counts | Keep (reuse existing), restrict later by one permission | Restricting means managers can no longer clear caregivers |
| 2 | Owner who is also a caregiver | Service self-approval is blocked; availability/document self-review is allowed and recorded (existing precedent) | Policy for a one-person agency | Keep | Blocking all self-review can stall tiny agencies |
| 3 | Scoring weights 50/25/25 and the 25-mile soft radius | Provisional, versioned, not approved | Approved ranking policy | Treat as provisional; see worked examples | Changing a weight needs a new rule version |
| 4 | Store ZIPs (caregiver home, client service) and load a centroid dataset | Only 5-digit ZIPs, admin-only, never returned | HIPAA/privacy review; dataset licence/vintage (US Census ZCTA is public domain but **not verified here**) | Defer until reviewed | Location stays "missing" and scores stay incomplete |
| 5 | Notifying administrators of new availability requests | Not built; requests appear on Care Team | Channel | Add to the existing attention summary | Requests may sit unseen |
| 6 | When to switch Service checks On | Off by default | After review of the 'Review services' list | After pairs are reviewed | Turning On early blocks scheduling |

## Concrete risks and unprotected paths
* **Planned -> Ready transition** is not re-checked when a caregiver becomes Ready (shift, visit and care-request gates still apply).
* **Time-driven expiry** has no scheduler: flags are written on events; the readiness report and checks recompute live, so expiry is caught at commit
  time, but stored "document" flags for an expiry that simply arrives are not created until a verification/rule change or a re-check.
* **Manager-started visits** and **visits already in progress** are deliberately not gated (brief). A manager can still start an unscheduled visit.
* **The legacy Supabase application** (Netlify-era) is not covered; it has its own CareScore (see MARKETING_CLAIMS_REVIEW.md).
* **Direct database access** by an administrator bypasses every rule (as before).
* **Matching cost** is candidates x occurrences x checks (<= 30 occurrences): fine for small agencies; not load-tested.
* **Experience/ZIP/client-wish screens are NOT BUILT** (API and database only). Without them, almost every score reads "Score incomplete".
* **Hidden coupling:** `list_available_caregivers` now delegates to the matching engine; any consumer outside this repo that relied on the older
  availability-only rule will see fewer candidates (intended).
* **Verified paths** (test scans `pg_proc` for every function that writes a caregiver onto a shift): `create_shift`, `reschedule_shift`,
  `assign_shift_caregiver`, `assign_care_request`, `series_materialize` (via `series_evaluate`) are gated; `create_assignment`, `start_ad_hoc_service_visit` are gated.
  Call-out, cancellation and record-link functions remove or relink a caregiver and commit nobody. A new function that writes a shift fails that test until reviewed.

## Locking (identical order everywhere)
`ogevia.lock_caregiver(caregiver)` is the first lock in: shift create/reschedule/reassign, series, care-request assignment (taken *before* the
request row), standing assignment, visit start, service approve/revoke/bulk, availability apply, document review (CPR/TB types), experience review,
and rule changes. Unprotected by it: reads, the report, and the override authorisation (it commits no work).
