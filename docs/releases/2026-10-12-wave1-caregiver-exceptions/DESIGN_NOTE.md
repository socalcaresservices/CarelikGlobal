# Wave 1 design note: caregiver screens, exception reasons, open-shift pickup

**Status: PROPOSED. Nothing is built, tested or deployed. No code has been started.** Decisions are the owner's of 2026-10-13. Companion documents: `FEATURE_TEST_PLAN.md` (this folder), `docs/product/BUILD_GAP_LIST_2026-10-12.md`, and the design-review mockup at https://claude.ai/artifact/4S58c2eXvgDRV3U55CLzVC (a mockup, not the working build), and `docs/product/MENU_INVENTORY_43fce84.md` (real menu and routes by role, with the mockup comparison). Updated 2026-10-13 with the effective-dated rule setting (D-S, now Wave 1) and the real-menu navigation.

**Evidence rule.** Every statement about what the real code does cites `file:line` (repository head `3523c7c`, branch `claude/determined-goodall-syvv7s`) or says NOT VERIFIED. Paths: `R` = `apps/sv-api/src/routes.ts`, `W` = `apps/web/src/pages/service-verification-page.tsx`, migrations are in `infra/aws/db/migrations/`. Migration numbers for new work are provisional and start after 0049; 0047, 0048 and 0049 are not deployed and ship first.

## 1. Decisions applied

| Ref | Decision (owner) | What it means in the design | Real code today |
|---|---|---|---|
| D-V | No visit becomes Billing Ready without a recorded confirmation method. Client cannot confirm, declines, or technical problem: CONFIRMATION REVIEW. The office resolves only with a required reason; who, when, why recorded. No fake signature image. No plain Accept. | The existing recovery path is the design: request a client confirmation (secure link or paper), record the response, review it (accept or reject, reason required), or close as not billable (reason required). | Already this way in the backend: no signature or mark means zero billable and `administrator_review` (`0006_service_verification_api.sql:606-610`); `close_not_billable` never makes a visit billable (`0031_visit_review_decisions.sql:22`); request route `R:1375`; paper form needs a file `R:1428-1450`; review needs a reason `R:1461-1468`; review rows are append-only (`0036_signature_recovery.sql:165`). Whether every step has a web screen: NOT VERIFIED. |
| D-U | Unscheduled visits go to review. Provisional, reason required, status UNSCHEDULED — NEEDS REVIEW. Never fabricate a schedule. The code changes to match. | Start requires a reason; the visit has no shift link and stays that way; confirm routes it to `administrator_review` with reason code UNSCHEDULED. | Today a signed unscheduled visit is Billing Ready (`0030_caregiver_hire_scheduling_billing_review.sql:12-13`) and the start call passes no reason (`R:1062`). **Code change required.** |
| D-A | Retroactive decrease moves any not-yet-approved Billing Ready visit back to review, keeps the worked service, never rewrites Approved or Submitted visits (flag and require human correction). An increase never auto-bills. | Persist an impact record per affected visit; decrease changes status only for unapproved Billing Ready; approved and billed visits get a "human correction required" flag cleared only by a recorded human decision. This is gap G10 (Wave 2); it is designed in section 4.10 so Wave 1 does not conflict with it. | Amendment returns an impact list and changes no visit: the only updates between `0006:894` and `:1025` are to `client_authorizations`; "Nothing is auto-rebilled" is at `0006:995`; the list is shown once at `client-detail-page.tsx:280-284`. **Code change required.** |
| D-P | Build pickup. Exactly one caregiver wins. Retries and double taps never create a second claim. Authorization checked and reserved on the server when the claim is made. | One server function, row lock on the shift, idempotent per caregiver, re-checks authorization inside the same transaction. See Q-R for what "reserved at claim" means given today's behavior. | No self-claim route. The office assigns at `R:810`. `care-opportunities` routes (`R:2070`, `R:2077`) answer availability; anything beyond their names: NOT VERIFIED. **Build required.** |
| D-S | The schedule variance threshold is a per-agency setting, effective-dated and versioned. Each visit stores the rule version it was evaluated under. Changes apply to future visits only and record who and when. With no agency value, a conservative default sends the visit to review. Payer-mandated rules (billing units, rounding, authorization periods) are labeled "unverified, agency responsible for payer compliance"; no rule is presented as verified. Wave 1 scope: this one setting, no general rules engine. | Gap G02 is now in Wave 1. Append-only rule versions per agency; the confirm function reads the rule in effect on the service date and records the version it used; the default is a system value used only when the agency has set none (Q-D). Design in 4.9. | No variance rule found by search of the migrations and web source. **Build required.** |
| Codes | Client codes use `CL-`. | Mockup now shows `CL-` plus 10 hex characters. No code change. | Already: `0003_care_directory.sql:68`. |

## 2. O-1, O-2, O-3 restated, and two new questions

| Ref | The question | Recommended default | If you choose differently |
|---|---|---|---|
| O-1 | A caregiver calls out of a shift, so it becomes open. May that same caregiver pick it up again? | **No.** Refuse with a plain message. The office can reassign the caregiver by hand. | If allowed, a caregiver can undo their own call-out without the office knowing, and the "Needs coverage" count can flicker. If refused, a genuine mistaken call-out needs an office reassignment. |
| O-2 | An unscheduled visit is held for review. How many billable minutes does it carry while it waits? | **The normal capped billable minutes, with billing approval blocked until a review decision exists.** The existing decision `accept_capped_billable` is already offered for drawn or assisted visits with billable minutes above zero (`0031:105-116`), so no new decision type is needed. | If you want zero billable until review, the authorization "used" figure drops while the visit waits, which understates hours used and touches the open accounting risks F2, F4, F6, F8. It would also need a new decision path. |
| O-3 | The caregiver can choose Declined. How is it stored? | **As `unable_to_confirm` with the reason "Client declined" plus the note.** The database accepts that method today (`0005_service_visits.sql:207`; `R:39`). No schema change. | A distinct stored value needs a migration widening the check at `0005:207` and a harder rollback. You could then report declines separately; with the default you can only tell them apart by the reason text. |
| Q-F (new) | D-U says unscheduled visits go to review. The code treats a caregiver marked `flexible` as normal when they visit without a shift (`service-verification.ts:88`; `0030:17-19`). Does D-U apply to flexible caregivers too? | **Yes, apply D-U to everyone**, as you wrote it. | If flexible caregivers are exempt, they skip review but the same exception applies silently. If not exempt, an agency that uses flexible caregivers puts every one of their visits into review and the office workload rises. |
| Q-R (new) | Open shifts today hold their hours from the moment they are scheduled (`0042_readiness_gate.sql:433-437`, reservation insert at `:449`). D-P says reserve at claim time. | **Keep the reservation at scheduling. At claim, the server re-checks that authorization still covers the shift (after any amendment) and binds the existing reservation to the claimant. No second reservation, no change to hours reserved.** | If open shifts should hold no hours until claimed, hours can be used up before a claim and the claim can then fail; it also changes `create_shift` and the accounting rules, which is a larger change and needs its own plan. |
| Q-D (new) | D-S says that with no agency value a conservative default sends the visit to review. What number, and may an agency turn the rule off? The mockup uses **15 minutes** as the system default and offers no Off option. The number is my placeholder, not a verified payer figure. | **15 minutes, no Off option in Wave 1** (the largest an agency can set is 240). | A smaller default sends more visits to review and costs the office time; a larger one reviews fewer visits and protects less. Allowing Off lets an agency stop the check entirely, which is less conservative. |

## 3. Gap status, G01 to G15
Definitions. **COVERED**: decided and designed in this note, with nothing blocking. **OPEN**: not designed here (later wave or not yet scoped). **NEEDS DECISION**: waiting on you.

| ID | Gap | Wave | Status | Why |
|---|---|---|---|---|
| G01 | Unscheduled visit routing | 1 | **NEEDS DECISION** | D-U decided; Q-F open; O-2 default awaiting confirmation |
| G02 | Schedule variance as a versioned agency setting | 1 | **NEEDS DECISION** | D-S decided and designed (4.9); Q-D (default number, no Off option) awaiting confirmation |
| G03 | Named exception reasons | 1 | **COVERED** | Design 4.3; the SCHEDULE reason follows the G02 rule |
| G04 | Resolving a visit with no client signature | 1 | **COVERED** | D-V decided; uses existing backend steps (4.4) |
| G05 | Screen 3 confirmation options | 1 | **NEEDS DECISION** | O-3 default awaiting confirmation |
| G06 | Caregiver attestation record | 1 | **COVERED** | Design 4.6; wording is proposed text you can change |
| G07 | Screen 4 content | 1 | **COVERED** | Design 4.7 |
| G08 | Lost signal and refresh | 1 | **COVERED** | Test-led (test plan 2.6); no new rule |
| G09 | Caregiver picks up an open shift | 1 | **NEEDS DECISION** | D-P decided; O-1 and Q-R open |
| G10 | Authorization amendment impact | 2 | **COVERED** | D-A decided; design 4.10; build in Wave 2 |
| G11 | Mark submitted / billed | 2 | **OPEN** | Not designed here; left out on purpose in `0019_billing_approval.sql:30-31` |
| G12 | Monthly report, full chain | 2 | **OPEN** | Not designed here; depends on G11 |
| G13 | Authorization monitor | 3 | **NEEDS DECISION** | Accounting risks F2, F4, F6, F8 are still unfixed and you asked me not to work on them |
| G14 | Audit log screen | 3 | **OPEN** | Not designed here |
| G15 | Dashboard Action Needed | 3 | **OPEN** | Depends on G03, G10, G11, G13 |

## 4. Design by item (Wave 1 and the pieces other waves depend on)

### 4.1 Principles
- Server decides; the browser never supplies organization, role, time, billable minutes, authorization remaining, or status.
- Additive, reversible migrations: `CREATE OR REPLACE FUNCTION` where the signature is unchanged, additive nullable columns, no existing row rewritten.
- Every new mutation is idempotent through the existing idempotency key pattern (for example `startKey`/`confirmKey` at `W:388-392`).
- Nothing here changes billing approval (`R:1492`) or authorization arithmetic, including the 0049 rule.

### 4.2 G01 Unscheduled visits (D-U)
Start: add a required reason. The start function's parameters after the service are `'{}'` and `null` (`R:1062`); their exact names and types are NOT VERIFIED, so the design review reads the signature in `0042_readiness_gate.sql` (function starting near line 736) before choosing between a new parameter and a new overload. Store the reason in an additive column on `service_visits`. No shift is created or linked.
Confirm: a visit with no linked shift goes to `administrator_review` even when signed, with billable minutes kept (O-2). Billing approval accepts a visit in review only with an active `accept_capped_billable` decision (`0031_visit_review_decisions.sql:28-29`; function at `:325`); the decision offered for a drawn or assisted visit is `accept_capped_billable` (`0031:112-116`).
Failure cases: no reason (422); retry (same key, one visit); old signed unscheduled visits stay Billing Ready and are not retroactively sent to review (stored rows are never rewritten).

### 4.3 G03 Reason codes
One server function returns, per visit in review, an ordered list of codes: AUTHORIZATION (`authorization_status = exceeds_authorization`, set at `0006_service_verification_api.sql:597`), UNSCHEDULED (no shift link), CONFIRMATION (no client signature or mark), and SCHEDULE only when the D-S setting is on. Order: AUTHORIZATION, UNSCHEDULED, CONFIRMATION, SCHEDULE. The web groups and labels them; the headline count is distinct visits. The current Action needed view is at `service-verification-reports-page.tsx:106` and `:1209`; no per-visit reason code was found by search.

### 4.4 G04 Visits with no client signature (D-V)
No new rule. The mockup now follows the backend: Request confirmation (secure link or paper form, `R:1375`), Record the paper form (needs signer name, role, date and a scanned file, `R:1428-1450`), Review the response (accept or reject, reason required, `R:1461-1468`), or Close as not billable (reason, `0031:41`). Open requests move the visit to "awaiting signature" and out of the exception count (`0036_signature_recovery.sql:20-23`). No signature image is created by any office action. Work in Wave 1 is the Action needed screens and labels; whether each step already has a web screen is NOT VERIFIED and is the first thing the design review checks.

### 4.5 G05 Confirmation options
Add Verbal only and Declined to screen 3 (technical problem reasons grow beyond the two at `W:57`). Verbal and Declined require a note; Unable and Technical problem require a reason. All four send `unable_to_confirm` or `verbal` (`W:583-588` today maps the no-signer path to `unable_to_confirm`; `R:39` accepts both). Declined is stored per O-3. Representative signature already exists as a signer role (`W:1239`).

### 4.6 G06 Attestation
Add a nullable `attestation_version` to the confirmation record, set by the server at confirm. Today only `caregiver_attested_at` exists (`0005_service_visits.sql:37`). Proposed wording, version `attest-v1`: "I attest that the times above are correct. My sign-in, the time and this wording are recorded." Old visits show "Not recorded".

### 4.7 G07 Screen 4
Return from the confirm function: worked, confirmed, billable (or "held"), authorization left, confirmation method, reason codes, and billing state. Today the screen shows worked, billable and Billing ready or Needs manager review (`W:1462-1467`). Authorization left comes from the existing balance functions so it equals the client page and Home.

### 4.8 G09 Pickup (D-P)
New function `pickup_open_shift(org, shift, idempotency_key)`, caregiver-only:
1. Lock the shift row (`FOR UPDATE`); two simultaneous claims serialize, the second sees the shift filled and gets "This shift was just filled".
2. Eligible: shift open (no caregiver, scheduled) or called out; caregiver assigned to the client; no overlapping shift (existing overlap check); readiness gate (`0042`) when enforcement is active; not the caregiver who called out (O-1 default); shift not started or past.
3. Authorization re-check inside the same transaction under the authorization lock: refuse if the lineage is over-committed (used plus reserved above the cap, for example after a decrease). Per Q-R default, bind the existing reservation; reserved minutes do not change.
4. Idempotent: same caregiver and same key, or the same caregiver tapping again, returns the first result and writes nothing. Different caregiver after a win: refused.
5. Writes the shift history (same events as office assign: "Open shift filled" / "Replacement after call-out", `0026_staff_shifts_coverage.sql:363`) and an audit event.
Route: new `POST /v1/shifts/{shiftId}/pickup` in `R` and the API stack route list (a `slice-contract.test.ts` requirement per the PR template). Web: Open shifts list on My shifts. IAM for any new route: NOT VERIFIED; pilot check.

### 4.9 G02 Schedule variance rule (D-S), Wave 1
One setting only: the minutes by which worked time may differ from the shift before the visit goes to NEEDS SCHEDULE REVIEW. No rules engine and no other rule is editable.
- **Storage.** New append-only table of rule versions per agency: version number (unique per agency, assigned under a lock), minutes (1 to 240), effective date in the agency's local time, who changed it, when, optional reason. No update or delete (same guard pattern as `billing_approvals`, `0019_billing_approval.sql:63-68`). An effective date earlier than today is refused: changes are never retroactive.
- **Default.** If the agency has no version, a system default applies (15 minutes in the mockup, Q-D), reported as version 0, source "System default". It sends visits over it to review.
- **Evaluation.** The confirm function reads the rule in effect on the service date, evaluates, and records which version and minutes it used. Locked visits are immutable (`0031_visit_review_decisions.sql:11`), so the record goes in an append-only side table keyed by visit rather than in new columns on `service_visits` (design review confirms; whether the lock guard would allow a column write at confirm: NOT VERIFIED). A later correction re-evaluates under the stored version, not the newest.
- **Who.** Changing it needs an existing permission; recommended `organization.update` (Administrator only, `0020:86`), so no new permission. Reading it: Administrator and Manager. Other agencies cannot read or write it.
- **Screen.** A new section in Settings (the real Settings opens Branding, `aws-shell.tsx:165`; `aws-root.tsx:91`). It shows the rule in effect, the history, and the label "Unverified, not a payer rule". Billing units, rounding and authorization periods appear read-only, each labeled "Unverified. Agency responsible for payer compliance." Rounding already has its own page (`aws-root.tsx:92`, `routes.ts:1515-1520`); a billing-units setting was not found (NOT VERIFIED beyond a search of `routes.ts`).
- **Failure cases.** Two administrators saving at once (versions serialize); effective date in the past (refused); minutes outside 1 to 240 (refused); a visit confirmed just before and just after a change (each keeps the version it used); old visits with no stored version (shown as "Not recorded", never re-evaluated).
- **Migration.** New table plus function replacement for confirm; `.down.sql` drops the table, so stored rule history and per-visit versions are lost on rollback (data-loss-on-rollback; your approval first).

### 4.10 G10 Authorization amendment impact (D-A)
Persist one impact row per affected visit (organization-scoped, row-level security, immutable except an acknowledgement). Decrease: an unapproved Billing Ready visit returns to `administrator_review` with reason AUTHORIZATION, worked minutes unchanged; an approved or billed visit is not touched and carries a "human correction required" impact that clears only with a recorded decision (who, when, why). Increase: impact rows say "now fits"; nothing is approved or billed. Approval of a visit not in Billing Ready is already refused except with a review decision (`0031:7-9`, `:28-29`). Billed ("Submitted") visits cannot be corrected until G11 exists. Wave 2.

## 5. Migration, API and screen map (provisional)
| Item | Migration (new, after 0049) | Route | Screen |
|---|---|---|---|
| G01 | additive reason column; replace start and confirm functions | `POST /v1/visits` gains `reason` | screen 1, screen 4 |
| G02 | new append-only rule table and a read function; confirm function records the version | rule read and change routes (new) | Settings |
| G03 | new reason function (read only) | extend the visit list or add a reasons read | Action needed |
| G05 | none (O-3 default) | none | screen 3 |
| G06 | additive `attestation_version`; confirm function | `POST /v1/visits/{id}/confirm` | screen 3 |
| G07 | confirm function returns more fields | confirm result | screen 4 |
| G09 | new pickup function | new `POST /v1/shifts/{id}/pickup` | My shifts |

Each migration needs a `.down.sql` with a rollback class header. Down for an additive column loses values written after deploy and needs your approval before use on production.

## 6. What does not change
Time In and Out come from the server; one open visit per caregiver; no billable minutes without client evidence; billing approval stays a separate human step; authorization arithmetic and the 0049 rule; existing signed and locked visits; no DOB, UCI, Medicaid or payer IDs on caregiver screens; no "EVV compliant" wording; readiness enforcement stays as configured; no deployment, pilot or AWS action.

## 7. What I need from you to start Wave 1
Answer Q-F, O-1, O-2 (confirm the default), O-3 (confirm the default), Q-R and Q-D; then say go. After that: update the Feature Test Plan's assumptions, extend the harness seed, write the failing tests first, then code. Building and any pilot step still follow `docs/TESTING_AND_RELEASE_PROCESS.md` and need your GO.
