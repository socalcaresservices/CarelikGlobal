# Activating availability enforcement for SoCal Care Services: findings and preconditions

Status: **NOT activated. No production access was used. Activation is an irreversible production policy change performed by the owner.**
Owner request (2026-10-11): block normal assignment on No Match; Admin may override with a reason; Manager may not; every override audited; an override applies to one assignment and never changes stored availability.

## What the code does (VERIFIED by code read at `main` + 0047/0048 branch)
- The switch is `ogevia_api.activate_readiness_enforcement(organization, reason, expected_affected_shifts)` (0042). Needs `readiness.manage` (organization owner). Setup must be complete (CPR and TB document types and validity rules). The caller must pass back the affected-shift count the report showed. **It is not reversible through the API.**
- It is ONE switch, not an availability-only switch. `readiness_enforced` turns on together: approved availability, CPR, TB, mandatory client requirements and every other check except "Service checks" (a separate On/Off). **I cannot honour "availability only" without a code change.**
- 0046 extends it to NEW VISIT STARTS: a caregiver with no approved availability for the time cannot start a visit once active. Caregivers with no recorded availability will be blocked from starting visits. This is the main operational risk.

## Requirements vs. what exists
| Requirement | State |
|---|---|
| Manager cannot override | Met: `availability.override` is held by organization_owner only (0042; test refuses a manager with `OGA03`). |
| Admin override needs a reason; audited | Met (reason 3-500 characters; `availability.override_authorized`, `_used`, `_linked`). |
| Override is for that assignment only; never changes stored availability | **Met only with migration 0047 (built and tested, NOT deployed).** Production today (0042/0046) has the older override: a caregiver + time range, multi-use, 30 minutes. |
| Admin override works | Works in code and tests. **Not verified on production.** |

## Why I did not activate
1. No production database or AWS access exists in this session (and an owner must perform the activation while signed in).
2. The "one assignment only" requirement is not met in production until 0047 is deployed (a YELLOW action awaiting approval).
3. Activation is irreversible through the API and also turns on documents and visit-start checks, which is wider than the request.

## Recommended sequence (each step needs your approval)
1. Deploy 0047 (override repair) together with the API and web (see `README.md` in this folder).
2. In the app, open the readiness report: confirm every active caregiver has approved availability and current CPR/TB, and read the affected-shift count.
3. Decide whether to activate with its full scope (availability + documents + visit-start), or ask for an availability-only mode (a code change, then tests).
4. The owner activates in the app (enter the reason and the reviewed count). Then verify: a Manager assigning an unavailable caregiver is refused; the owner can override once; the shift shows "Assigned with Admin override".
