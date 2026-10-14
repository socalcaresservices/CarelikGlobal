# Phase B persona walkthrough (local harness, synthetic data)

Date 2026-10-14. **Local only: nothing here touched AWS, the pilot, Netlify or production.** Commit under test: the code of branch `claude/pilot-readiness-closure` (application code identical to `main` `484135d`; the branch adds tests, `smoke.py` and documentation only). Harness: `harness:setup` (migrations 0001 to 0052, synthetic seed), `harness:build`, `harness:serve`; the real web build and the real API handler on a local PostgreSQL 16; sign-in is the harness stand-in (no Cognito).

**Result: 53 of 53 checks passed, 0 failed.** Each check drives the real screens in Chromium (Administrator, Scheduler, Manager at 1280 px; both caregivers at 390 px with touch) and confirms the result in the database. Screenshots and the visible text of the key screens are in `evidence/phase-b/`; the script and its reset helper are in `evidence/phase-b/scripts/` (`reset.sh` then `node walkthrough.mjs`; needs the harness requirements and Playwright).

## Personas (mapping stated, not assumed)
| Persona in the request | Harness identity and role | Basis |
|---|---|---|
| Administrator | Olivia Owner, `organization_owner` | Administrator view; holds the variance-rule and review permissions |
| Scheduler | Sam Scheduler, `scheduler` | Shifts and coverage; sees client codes only |
| Caregiver | Alex Caregiver and Blair Caregiver, `caregiver` | Alex: unscheduled visits and pick-up; Blair: the unclosed visit and the scheduled clean visit |
| Authorization manager | Morgan Manager, `manager` | There is no role by that name. The Manager holds `authorizations.update` and `billing.approve`: amends authorizations, approves billing. This mapping is mine; the owner should confirm it is the intended person. |

## What was exercised
Scheduling inside and beyond the authorization; a caregiver resuming an unclosed visit from yesterday and submitting it unconfirmed; the clean scheduled visit (start on the shift, refresh during the visit, end, drawn signature, attestation, final screen); two unscheduled visits (drawn signature; verbal only); open-shift pick-up and the called-out refusal; the Administrator's review page, review decision and the agency visit rule; the Manager's authorization balance, amendment (new version), billing approval of the clean and the reviewed visits, and the Manager's read-only view of the rule; a caregiver reaching for office pages.

## Results
| Persona | Catalog ID | Check | Result | Detail |
|---|---|---|---|---|
| Scheduler | SCH-01 | adds a 30-minute shift for Blair; it reserves exactly 30 minutes | PASS | scheduled\|30 |
| Scheduler | SCH-02 | a 24-hour shift beyond the authorization left is refused with the hours stated | PASS | Not enough authorized time remains this month for this shift: 19 hr 30 min available, this shift needs 24 hr |
| Scheduler | USR-01 | client names are not shown to the Scheduler (codes only) | PASS |  |
| Scheduler | NET | no console error or unexpected 4xx/5xx | PASS | http 409 POST /api/v1/shifts \| console: Failed to load resource: the server responded with a status of 409 (Conflict) |
| Caregiver | VIS-31 | an unclosed visit from yesterday is still open after sign-in (resume), with Time In shown | PASS |  |
| Caregiver | VIS-20 | Submit is disabled until the attestation is ticked; nothing is saved | PASS |  |
| Caregiver | VIS-22c | no-confirmation visit: final screen says Needs manager review, Confirmed 0 min, Billable 0 min | PASS | administrator_review\|0\|attest-v1\|unable_to_confirm |
| Caregiver | VIS-24c | a client on today's schedule shows the shift time and asks for NO reason | PASS |  |
| Caregiver | VIS-02 | active screen shows the server Time In and elapsed time | PASS |  |
| Caregiver | VIS-24c | the visit is linked to the scheduled shift by the server | PASS | true |
| Caregiver | VIS-31 | after a page refresh the same active visit is shown | PASS |  |
| Caregiver | VIS-35 | Confirm is disabled until a signature is drawn and the attestation is ticked | PASS |  |
| Caregiver | VIS-22a | clean scheduled visit: signed, billable = worked, attestation attest-v1 | PASS | signed\|25\|25\|attest-v1 |
| Caregiver | VIS-22a | final screen shows worked, confirmed, billable and authorization left, and says it is ready for billing review | PASS | Billing / Billing ready |
| Caregiver | NET | no console error or unexpected 4xx/5xx | PASS |  |
| Authorization | AUT-01 | after the signed visit the shift's reservation is released and the worked minutes are counted once | PASS | before used\|reserved 2490\|480, after 2515\|480, worked 25 |
| Caregiver | VIS-23 | a client not on today's schedule is labeled Unscheduled and a reason is required (Start is disabled while empty) | PASS |  |
| Caregiver | VIS-23 | after the reason the visit starts and the active screen says Unscheduled visit | PASS |  |
| Caregiver | VIS-24 | signed unscheduled visit: status administrator_review, billable minutes kept (12), reason stored | PASS | administrator_review\|12\|Synthetic: manager phoned and asked me to cover |
| Caregiver | VIS-22b | final screen: Needs manager review, 'not on your schedule' sentence, Not billable until reviewed | PASS |  |
| Caregiver | VIS-16 | Verbal only needs the confirming person's name (Confirm is disabled until a name is typed) | PASS |  |
| Caregiver | VIS-16 | verbal-only: goes to review, 0 billable, no signature stored | PASS | administrator_review\|0\|verbal |
| Caregiver | SCH-21b | the shift Alex called out of is NOT offered for pick-up ('You called out') | PASS |  |
| Caregiver | SCH-18 | pick-up moves the shift to Alex: it leaves the open list and Alex now holds it | PASS | open 2->1, Alex upcoming 2 |
| Caregiver | NET | no console error or unexpected 4xx/5xx | PASS |  |
| Administrator | VIS-24 | visit page shows Unscheduled, the caregiver's reason, the attestation version and why it needs review | PASS |  |
| Administrator | VIS-24d | billing review offers 'Review visit', NOT 'Approve', for the unscheduled visit | PASS | Demo Okafor CL-DDF789BB49 Needs review Alex Caregiver Personal care (PCS) 10/14/2026 8:23 AM – 8:35 AM 12 min (0.20 hr) 12 min (0.20 hr) Vie |
| Administrator | VIS-24d | no billing approval exists for it before a review decision | PASS |  |
| Administrator | VIS-28 | a review decision is recorded with a reason and is active | PASS | accept_capped_billable\|active |
| Administrator | VIS-28 | the decision is in the audit trail | PASS | audit rows 1 |
| Administrator | VIS-50 | the default rule shows 15 minutes, labeled as not verified | PASS |  |
| Administrator | VIS-51 | saving creates version 1 (20 minutes) and keeps version 0 listed | PASS | 1:20 |
| Administrator | NET | no console error or unexpected 4xx/5xx | PASS |  |
| Authorization | AUT-01 | client page balance equals the database: billable 41 hr 55 min, hours left 5 min | PASS | used 2515 reserved 480 authorized 3000 |
| Authorization | AUT-01 | the signed visit's 25 minutes appear once (billable includes them; the shift is no longer reserved) | PASS |  |
| Authorization | AUT-04 | an amendment adds version 2 (52 h) and keeps version 1 (50 h) unchanged in the history | PASS | 1:3000:false,2:3120:true |
| Authorization | AUT-04 | hours left rise by exactly the 2 hours added (2 hr 5 min) | PASS | 2 hr 5 min |
| Authorization | OBS-1 | caregiver final screen said "Authorization left 8 hr 5 min" (= authorized - billable, 8 hr 5 min); the office shows "Hours left 5 min" (also subtracts 8 hr of scheduled shifts). Known difference, proposal 01; billing is decided by the server either way | PASS | caregiver 8 hr 5 min; office 5 min |
| Authorization | BIL-01 | a human approves the clean visit: one approval row for exactly the worked minutes, not submitted anywhere | PASS | 1\|25 dialogs:  |
| Authorization | VIS-24d | after the Administrator's review decision, the unscheduled visit can be approved | PASS |  |
| Authorization | VIS-24d | approval of the reviewed unscheduled visit is limited to its capped billable minutes (12) | PASS | 12 |
| Authorization | VIS-55 | the Manager cannot change the variance rule (read-only page, 'only the Administrator') | PASS |  |
| Authorization | ACC-01 | the Manager sees no dollar values on Home | PASS |  |
| Authorization | NET | no console error or unexpected 4xx/5xx | PASS |  |
| Caregiver | USR-02 | Billing review: a caregiver sees no office data (/billing-review) | PASS |  |
| Caregiver | USR-02 | Accounts: a caregiver sees no office data (/accounts) | PASS |  |
| Caregiver | USR-02 | Visit rules: a caregiver sees no office data (/settings/visit-rules) | PASS |  |
| Caregiver | USR-02 | Schedule: a caregiver sees no office data (/schedule) | PASS |  |
| Caregiver | USR-02 | Clients: a caregiver sees no office data (/clients) | PASS |  |
| Caregiver | VIS-40 | 390 px: no horizontal page scroll on /service-verification (390 <= 390) | PASS |  |
| Caregiver | VIS-40 | 390 px: no horizontal page scroll on /my-shifts (390 <= 390) | PASS |  |
| Caregiver | VIS-37 | caregiver screens show client codes only: no client names or payer identifiers on the Verify visit screen | PASS |  |
| Caregiver | NET | no unexpected 4xx/5xx beyond the refused office reads | PASS |  |

## Observations and limitations (stated, not hidden)
1. **Simulated time.** A visit's Time In is moved back with administrator SQL to make minutes pass (the same method as the existing `pilot-e2e` scripts). Server timestamps themselves were real. The refresh test (VIS-31) was run on the real screens.
2. **Different numbers for the caregiver and the office (OBS-1).** For the same client the caregiver's final screen said "Authorization left 8 hr 5 min" (authorized minus billable) while the office client page said "Hours left 5 min" (it also subtracts the 8 hours of scheduled shifts). Neither is a billing figure (the server decides), but a caregiver could believe more time is left than is unreserved. This is the known difference tracked by `docs/proposals/2026-10-14/01-authorization-position-api.md`. Pilot testers should be told. It is not a Wave 1 regression.
3. **Not covered by this walkthrough:** a real phone, slow or lost network at End/Submit (VIS-32/33), two simultaneous claims of one open shift in the browser (covered by the database test with two connections), a second agency in the browser (covered by automated tenant tests), the stand-in sign-in is not Cognito, the authorizer, MFA, or S3/KMS evidence storage (the harness keeps signatures in memory).
4. **Scheduler sees no client names** by design (codes only, "Name not set"): verified.
5. **Duplicate submission and retry** were not driven through the browser; they are covered by the idempotency and parallel-confirmation tests in the database and API suites.
