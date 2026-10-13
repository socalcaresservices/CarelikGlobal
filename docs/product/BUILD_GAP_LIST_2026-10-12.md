# Build gap list: approved mockup vs code (2026-10-12)

Status: PROPOSED. Written from reading the repository on branch `claude/determined-goodall-syvv7s` (head 4cbf8f5). The real app was not run. Nothing is built, tested or deployed.

## Corrections to the demo's status table

- Authorization on Start and Active screens: EXISTS, not PARTIAL-missing.
- Authorization monitor: PARTIAL (a utilisation overview exists), not NOT BUILT.
- Representative signature: exists as a signer role on a drawn signature.
- Three demo behaviors do not match the code: Accept on verbal (G04), unscheduled routed to review (G01), decrease moving Billing Ready back to review (G10). You approved the mockup, so each needs your decision: change the code, or change the mockup.

## Gaps

### G01 Unscheduled visit routing
**CONFLICT** · P0 · size M · migration: Yes (function + additive column)

- **Mockup:** Unscheduled visit starts as provisional with a required reason and ends as UNSCHEDULED — NEEDS REVIEW.
- **Code:** VERIFIED: a signed unscheduled visit is Billing Ready like any other; the screens only label it "Unscheduled" (migration 0030 header). The start route passes no reason (`start_ad_hoc_service_visit($1,$2,$3,'{}',null,$4)`, routes.ts). A flexible caregiver's visit without a shift is treated as normal (service-verification.ts line 88).
- **Gap:** Reason is not captured. Unscheduled visits are not routed to review.
- **Work:** Add a reason (additive column), a server rule that routes unscheduled visits to review, and a server-derived reason code.
- **Decision:** D-U: review for all caregivers, or only fixed-schedule caregivers? Recommended: all except caregivers marked flexible; reason is always captured.

### G02 Schedule variance review
**NOT BUILT** · P1 · size M · migration: Yes (append-only table + function)

- **Mockup:** A visit whose worked time differs from the shift by more than 15 minutes goes to NEEDS SCHEDULE REVIEW.
- **Code:** No variance rule found in the migrations or web code (searched "variance").
- **Gap:** No rule, no threshold, no reason code.
- **Work:** Per-agency threshold, effective-dated and versioned; each visit stores the version it was evaluated under; conservative system default when unset; payer-related rules labeled unverified. This one setting only, no rules engine.
- **Decision:** Decided (D-S, 2026-10-13), now Wave 1. Open: Q-D, the default number (15 minutes proposed, not a verified payer figure) and whether an agency may turn it off (recommended: no).

### G03 Named exception reasons in the exception center
**PARTIAL** · P0 · size M · migration: Functions only

- **Mockup:** Four reasons with labels: AUTHORIZATION REVIEW, UNSCHEDULED — NEEDS REVIEW, CONFIRMATION REVIEW, NEEDS SCHEDULE REVIEW. Office sees the reason on each visit.
- **Code:** VERIFIED: an "Action needed" view exists (reports page, view=exceptions) and review decisions exist (`accept_capped_billable`, `close_not_billable`, migration 0031). The status is a single `administrator_review`; over-authorization is `authorization_status = exceeds_authorization`.
- **Gap:** No server-derived reason code per visit, no grouping by reason, no labels.
- **Work:** One server function returns the reason codes for a visit (server is the system of record); web groups and labels them.
- **Decision:** None. Depends on G01 and G02 for two of the four reasons.

### G04 Resolving a visit the client did not sign
**CONFLICT** · P0 · size S · migration: None

- **Mockup:** Office taps Accept on a verbal or technical-problem visit and it becomes BILLING READY.
- **Code:** VERIFIED: verbal, typed and unable-to-confirm visits lock in `administrator_review` with 0 billable. `close_not_billable` "never makes a visit billable" (migration 0031 header). The routes to billable are a client confirmation link (`POST /v1/visits/{id}/confirmation-requests`), a paper confirmation, or a late-confirmation review.
- **Gap:** The approved mockup lets the office make a visit billable with no client evidence. The code deliberately does not.
- **Work:** Change the mockup, not the code: replace Accept with Request client confirmation, Record paper confirmation, or Close not billable.
- **Decision:** D-V: keep the code's rule (recommended; it matches CLAUDE.md "must not silently become billable") or change it. Changing it needs your explicit approval.

### G05 Screen 3 confirmation options
**PARTIAL** · P0 · size S · migration: None (recommended)

- **Mockup:** Drawn signature, representative signature, assisted mark, verbal only, technical problem, unable, declined.
- **Code:** VERIFIED: the caregiver page offers drawn signature, assisted mark, and signer roles including authorized representative; the no-signer path sends `unable_to_confirm` with two fixed reasons (technical problem, signature missed). The API and database also accept `typed` and `verbal`. `declined` exists only for outage paper records (migration 0028).
- **Gap:** Verbal only and Declined are not offered to the caregiver.
- **Work:** Add the options to the page. Send Declined as `unable_to_confirm` with the reason "Client declined" so no schema change is needed.
- **Decision:** Minor: a distinct stored Declined value would need a migration. Recommended: not now.

### G06 Caregiver attestation record
**PARTIAL** · P0 · size S · migration: Yes (additive column)

- **Mockup:** Caregiver attests; caregiver ID, time and wording version are recorded.
- **Code:** VERIFIED: only `caregiver_attested_at` (migration 0005) is stored.
- **Gap:** No attestation wording or version is recorded.
- **Work:** Add `attestation_version`, set at confirmation; show the attestation text on screen 3.
- **Decision:** None.

### G07 Screen 4 content
**PARTIAL** · P0 · size S · migration: Possibly (function replacement)

- **Mockup:** Locked visit showing worked, confirmed, billable, authorization remaining, confirmation method, reconciliation state, billing state.
- **Code:** VERIFIED (service-verification-page.tsx): shows worked, billable, "Billing ready" or "Needs manager review", and a lock note.
- **Gap:** Missing confirmed amount, authorization remaining, confirmation method, reason, and the named statuses.
- **Work:** Return the extra fields from the confirm function and show them.
- **Decision:** None. Depends on G03.

### G08 Lost signal and refresh
**PARTIAL** · P0 · size S · migration: None

- **Mockup:** Refresh keeps the visit open; End and Submit with no signal do not lose or duplicate anything.
- **Code:** VERIFIED: start and confirm use idempotency keys; an active-visit endpoint restores the visit after refresh; signature recovery exists (migration 0036). No offline queue (consistent with server-set time).
- **Gap:** The 15 failure cases in your directive have not been run against the real flow; the message shown on a network failure is NOT VERIFIED.
- **Work:** Run the failure cases in the harness and pilot; fix messages that do not say the visit is still open.
- **Decision:** None.

### G09 Caregiver picks up an open shift
**NOT BUILT** · P0 · size L · migration: Yes (function, permission)

- **Mockup:** Caregiver taps Pick up on an open or called-out shift; the same shift is assigned, no extra hours.
- **Code:** VERIFIED: no self-claim route (routes.ts). The office assigns (`POST /v1/shifts/{id}/caregiver`, "Open shift filled"/"Replacement after call-out"). `care-opportunities` answers availability for a care request; it does not claim a shift.
- **Gap:** A caregiver cannot take a shift.
- **Work:** New function with the same checks as office assign (assignment, conflict, readiness gate 0042), a row lock so two claims cannot both win, idempotency, audit event, and an Action Needed entry for the office.
- **Decision:** D-P: self-pickup, or the caregiver requests and the office approves. Recommended: self-pickup limited to ready, assigned caregivers with no conflict. Concurrent-claim tests are mandatory.

### G10 Authorization amendment impact
**PARTIAL** · P0 · size L · migration: Yes (new table + function)

- **Mockup:** Amendment keeps the old version, flags affected visits until someone acknowledges them, nothing auto-bills. A decrease moves an unapproved Billing Ready visit back to review.
- **Code:** VERIFIED: amend creates a new version and returns `affectedVisits` (`increase_may_allow_more`, `decrease_now_exceeds`); the client page shows them once (client-detail-page.tsx). Nothing is stored, and visit status is not changed.
- **Gap:** Flags disappear when the page closes. The decrease rule in the demo is not in the code.
- **Work:** Persist impact rows (organization-scoped, RLS), list them in the exception center, add Acknowledge.
- **Decision:** D-A: should a decrease move an unapproved Billing Ready visit back to review? Recommended: yes for unapproved; approved and billed visits are only flagged.

### G11 Mark submitted / billed
**NOT BUILT** · P0 · size M · migration: Yes (additive table)

- **Mockup:** After approval, staff record that they submitted it elsewhere, with an external reference.
- **Code:** VERIFIED: deliberately excluded. Migration 0019: "payer submission (billing.submit), invoices, exports ... Approval is not submission."
- **Gap:** No submitted or billed state.
- **Work:** Additive `billing_submissions` table (one active per approval, reference, who, when, void with reason), a route, a permission, UI, and a Billed column in the report. Records a human action only; nothing is sent to a payer.
- **Decision:** None. Automatic submission stays out of scope.

### G12 Monthly report: the full chain
**PARTIAL** · P0 · size M · migration: Function only

- **Mockup:** Authorized, scheduled, worked, confirmed, billing ready, approved, billed, with a balance check.
- **Code:** VERIFIED: monthly approval summary (approved minutes, visit count, rounding), monthly service summary, and a utilisation overview (authorized, billable, approved, unused).
- **Gap:** No scheduled, worked, confirmed, billing ready or billed columns, and no balance check, in one report.
- **Work:** New server function and report view. Billed column needs G11.
- **Decision:** None. Depends on the accounting fixes below.

### G13 Authorization monitor
**PARTIAL** · P1 · size M · migration: Function only

- **Mockup:** Per client: authorized, used, reserved, left, with Near limit and Over limit.
- **Code:** VERIFIED: `get_utilisation_overview` and a home-page panel exist.
- **Gap:** No used/reserved/left split or derived statuses (decisions D2 and D4).
- **Work:** New function (do not change an existing return type) and UI.
- **Decision:** Do not ship the numbers until F2, F4, F6 and F8 (open accounting risks, still `it.fails` tests) are decided. You told me not to work on them yet.

### G14 Audit log screen
**NOT BUILT** · P1 · size M · migration: Function only

- **Mockup:** Office reads who did what and when.
- **Code:** VERIFIED: `audit_events` table exists (migration 0005); a correction history report exists. No general audit screen found in the web app.
- **Gap:** No screen.
- **Work:** Read function with permission, PHI-minimizing display, UI.
- **Decision:** None.

### G15 Dashboard Action Needed
**PARTIAL** · P1 · size M · migration: Function only

- **Mockup:** Counts for coverage, exceptions by reason, flags, over-limit authorizations, ready for approval, approved awaiting billed.
- **Code:** VERIFIED (action-needed.ts): missing clock-out, awaiting confirmation, visits to review, signatures, unfilled shifts, documents, ready for approval.
- **Gap:** Missing exceptions by reason (G03), amendment flags (G10), over-limit (G13), approved-not-billed (G11).
- **Work:** Extend after those items land. Urgency uses decision D10 (48 hours).
- **Decision:** None.

## Already matching the code

- **Add client with random code**: VERIFIED: trigger builds `CL-` plus 10 hex digits from a random UUID (migration 0003). Prefix differs from the demo's `OG-`; cosmetic.
- **Add authorization**: VERIFIED: `POST /v1/clients/{id}/authorizations`.
- **Schedule blocked when hours run out**: VERIFIED: `create_shift` raises "Not enough authorized time remains" and reserves minutes (migration 0042).
- **Call-out keeps its reservation; replacement uses the same shift**: VERIFIED: schedule page text and `record_shift_callout`/assign functions (migration 0026).
- **Correction keeps the original**: VERIFIED: corrections table and correction history report.
- **Human billing approval, void**: VERIFIED: migration 0019 (`billing_approvals`: approved by, at, minutes, source snapshot, void with reason).
- **No DOB, UCI, Medicaid ID or "EVV" wording on the caregiver visit page**: VERIFIED by search of the web source: no matches.
- **Verbal confirmation is not billable without review**: VERIFIED: zero billable and `administrator_review` (migrations 0006, 0031). Matches your rule.
- **Authorization shown at Start and over-limit warning on Active**: VERIFIED (service-verification-page.tsx): Authorized, Serviced, Remaining tiles and a will-exceed warning. The demo's status table said this was not found; that was wrong.

## To verify in the harness

- Correction of a visit that is already Billing Ready, and of an approved visit (does it require voiding the approval first?). NOT VERIFIED.
- Caregiver screen 1: whether Remaining subtracts hours reserved for other shifts (D2). NOT VERIFIED.
- Replacement after call-out: no duplicate reservation. VERIFIED by reading `record_shift_callout` (shift stays reserved); open accounting risks F2, F4, F6, F8 may still affect totals.

## Suggested order

- **Wave 0: decisions, no code.** D-U (G01), D-V (G04), D-S (G02), D-A (G10), D-P (G09); P1 to P7 from the deployment plan; whether to work on F2, F4, F6, F8.
- **Wave 1: caregiver and exception correctness (P0).** G05, G06, G07 (small, mostly web), G01, G02 and G03 (server rules, the versioned variance setting, reason codes), G09 (pickup with locking and concurrency tests), G08 (failure-case tests). One release, pilot-tested.
- **Wave 2: amendment and billing chain (P0).** G10 (persisted impact), G11 (submitted/billed record), G12 (monthly chain report). One release, pilot-tested.
- **Wave 3: visibility (P1).** G13 (after the accounting risks are settled), G14, G15.

## Ground rules

- Every wave follows docs/TESTING_AND_RELEASE_PROCESS.md: Feature Test Plan, harness seed and screenshots, pilot validation, user acceptance, your GO.
- New migrations start at 0050 and are contiguous after 0049. Anything not yet live ships with them (0047, 0048, 0049 are not deployed).
- Sizes are my estimates, not measurements: S about 1 day, M 2 to 4 days, L 1 to 2 weeks of focused work including tests.
- Nothing here is built, tested or deployed. This is a proposal.
