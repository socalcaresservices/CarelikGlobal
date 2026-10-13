# Feature test plan: 2026-10-12-wave1-caregiver-exceptions

**Status: PROPOSED. Nothing is built, tested or deployed.** Written before any code, per `docs/TESTING_AND_RELEASE_PROCESS.md`. Source of scope: `docs/product/BUILD_GAP_LIST_2026-10-12.md` (Wave 1: G01, G03, G05, G06, G07, G08, G09). Template: `docs/release-process/FEATURE_TEST_PLAN_TEMPLATE.md`.

Evidence words: **VERIFIED** (read in the repository on branch `claude/determined-goodall-syvv7s`, head 546a38f), **ASSUMED** (a design choice this plan depends on that the owner has not decided), **UNKNOWN**. Test files marked *proposed* do not exist yet. Files without that mark were found in the repository; a pointer is not a PASS, the test must be run.

## 0. Decisions this plan depends on (nothing is coded until each is answered)
| Ref | Question | Assumption used below | Cases that change if the answer changes |
|---|---|---|---|
| D-U | Do unscheduled visits require review? | **Decided 2026-10-13: yes.** Provisional, reason required, UNSCHEDULED — NEEDS REVIEW, no schedule created. Q-F (flexible caregivers) is open; until answered, VIS-24b is written for both answers. | VIS-23, VIS-24, VIS-24b, VIS-24d, VIS-25 |
| D-V | Can the office make a no-client-evidence visit billable? | **Decided 2026-10-13: no plain Accept.** Only: request confirmation, record the paper form, review the response with a reason, or close as not billable; who, when and why recorded; no fake signature image. | VIS-15, VIS-16, VIS-43 |
| D-P | Self-pickup or request-and-approve? | **Decided 2026-10-13: build pickup.** One winner, double taps and retries create no second claim, authorization checked on the server at claim. Q-R (reservation timing) and O-1 are open. | SCH-18 to SCH-27 |
| O-1 | May the caregiver who called out pick the same shift back up? | Recommended default: no (SCH-21b). Cases SCH-21b and SCH-21c are written both ways until the owner answers. See `DESIGN_NOTE.md` section 2. | SCH-21b/c |
| O-2 | What billable minutes does an unscheduled visit held for review carry? | ASSUMED: the normal capped billable minutes are kept (not zeroed), and billing approval is blocked until a review decision exists. Reusing the existing decision `accept_capped_billable` (migration 0031) needs a design review, because its text says it applies when a client signed and the visit exceeded authorization. | VIS-24, VIS-24d |
| O-3 | Is a distinct stored value for Declined needed? | ASSUMED no: Declined is sent as `unable_to_confirm` with the reason "Client declined". No schema change for it. | VIS-15 |

Out of scope for Wave 1: schedule variance (G02), persisted amendment impact (G10), submitted/billed (G11), chain report (G12), authorization monitor (G13), audit screen (G14), dashboard changes beyond the Action Needed counts named below (G15). Accounting risks F2, F4, F6, F7, F8 are untouched. No payer, EVV or GPS work.

## 1. The change
| Field | Value |
|---|---|
| Problem or requirement (owner's words, source) | Approved mockup (owner, "MOCKUP APPROVED", 2026-10-12): caregiver completes four screens simply; clean visit becomes Billing Ready automatically; problem visits go to the exception center **with the reason**; client who cannot sign has verbal / declined / unable / technical-problem choices; caregiver attests; open shifts can be picked up with no duplicate shift and no double-counted hours. Source of gaps: build gap list. |
| What changes, per role | **Caregiver:** screen 3 gains Verbal only, Declined and a technical-problem choice with reasons, and shows the attestation wording; screen 1 requires a reason for an unscheduled start; screen 4 shows confirmed amount, authorization left, confirmation method and the named reason; My shifts gains Open shifts with Pick up. **Manager/Owner:** each visit in Action needed shows its reason (AUTHORIZATION REVIEW, UNSCHEDULED — NEEDS REVIEW, CONFIRMATION REVIEW); an unscheduled visit by a fixed-schedule caregiver now waits for review; a picked-up shift appears as filled, same shift, same reserved hours. **Scheduler:** open shifts can be taken by a caregiver. |
| What must NOT change | Server-set Time In and Time Out. One open visit per caregiver. No billable minutes without client evidence (D-V). Billing approval stays a separate human step. Authorization cap and reservation arithmetic (including the 0049 rule). Existing signed and locked visits stay readable and unchanged. Call-out and office assignment behave as today. No DOB, UCI, Medicaid or payer ID on caregiver screens. No "EVV compliant" wording. Readiness enforcement stays as configured. |
| Migrations, routes, screens touched | Migrations (numbers provisional, contiguous after 0049; every earlier undeployed migration ships first: 0047, 0048, 0049): additive reason column for unscheduled starts; additive `attestation_version`; replacement of the start/confirm functions (routing, reason codes, result fields); new review-reason function; new pickup function. Routes: `POST /v1/visits` (reason), `POST /v1/visits/{id}/confirm` (attestation, result fields), a reasons read (new or added to the visit list), `POST /v1/shifts/{id}/pickup` (new), `GET /v1/my-shifts` (open shifts). Screens: `service-verification-page.tsx` (screens 1 to 4), My shifts, Action needed (`service-verification-reports-page.tsx`, `action-needed.ts`). |
| Catalog areas required (process 6.3) | VIS, EVV, AUT, RPT, SCH (pickup), DSH (counts), plus R; migration rollback cases; isolation cases (SCH-13). |
| Harness data needed | Add to `infra/aws/local-harness/setup.ts`: (a) a caregiver with `scheduling_mode = flexible` and one `fixed`, both assigned to a synthetic client; (b) a client with 2 h authorization left (for the exceed case); (c) two open shifts and one called-out shift for the same client; (d) two caregivers assigned to that client, one with a conflicting shift; (e) a caregiver not assigned to the client; (f) one visit created before the change in each existing state. Synthetic names only. |
| Things only the pilot can prove | Cognito sign-in as two real test caregivers at the same time (pickup race over the real API Gateway and authorizer); signature object in private S3 and not in logs (EVV-02, EVV-03); behaviour over a real phone network (airplane mode at End and Submit); CloudFront/web bundle on a real phone; IAM for any new route; RDS TLS. |

## 2. Test cases
Rollback column: "Down" means the `.down.sql` of the migrations in this release (newest first) restores the previous function definitions and drops the additive columns; web and API redeploy the previous artifact first. Down on a column loses the values written after deploy: classify as data-loss-on-rollback and require owner approval before it is run on production.

### 2.1 Screen 3: confirmation options (G05)
| ID | What to test | How to test | Expected result | Rollback |
|---|---|---|---|---|
| VIS-14 | Screen 3 offers every confirmation choice | Web: `apps/web/src/pages/service-verification-page.test.tsx` (extend). Harness: Alex, confirm any ended visit | Choices listed: Drawn signature, Authorized representative, Assisted mark, Verbal only, Technical problem, Unable to confirm, Declined. Each shows only its own fields (signature box, or a required reason or note) | Redeploy previous web bundle |
| VIS-15 | Declined is stored as unable-to-confirm with the reason | Auto: `apps/sv-api/test/workflow.db.test.ts` (extend). Harness: choose Declined | Method stored `unable_to_confirm`, reason "Client declined" plus the note; visit `administrator_review`, **0 billable**, reason code CONFIRMATION | Down not needed (no schema change); web rollback |
| VIS-16 | Verbal only goes to review (control, matches the owner's rule) | Auto: `signature-recovery.db.test.ts` (pointer, run it); web case for the new choice. Harness: choose Verbal only with a note | `administrator_review`, 0 billable, note required, reason code CONFIRMATION; appears in Action needed | Web rollback |
| VIS-17 | Representative signature is billable like a client signature (control) | Auto: `workflow.db.test.ts` signer-role case. Harness: Authorized representative, relationship typed, signature drawn | Status `signed` (Billing Ready); signer role and relationship stored | n/a (control) |
| VIS-18 | Assisted mark behaves as a signature (control) | Auto: `workflow.db.test.ts`. Harness: Assisted mark | Status `signed`; evidence image stored (pilot: private S3) | n/a |
| VIS-19 | Technical problem keeps its two reasons and one more | Web case; harness | Reason list contains the existing "Technical problem prevented signing" and "Signature was accidentally missed before departure" unchanged, plus the new choices; visit goes to review, 0 billable | Web rollback |
| VIS-35 | Missing evidence is refused | Auto: API refuses a drawn/assisted confirmation with no image, a representative with no relationship, Verbal/Declined/Unable with no note or reason. Web: Submit disabled or error shown | HTTP 422 with a plain message for each; nothing saved; visit still open | n/a |

### 2.2 Attestation (G06)
| ID | What to test | How to test | Expected result | Rollback |
|---|---|---|---|---|
| VIS-20 | Submit is refused without the attestation | Auto: API. Web: leave the box unticked | Refused; visit stays open | Web/API rollback |
| VIS-21 | Attestation records caregiver, time and wording version | Auto *proposed* `infra/aws/db/test/wave1-attestation.db.test.ts`: confirm a visit, read the row | `caregiver_attested_at` set by the server; `attestation_version` equals the current version string; caregiver is the authenticated user, not a client-supplied id | Down drops the column (data-loss-on-rollback for new rows) |
| VIS-21b | Old visits stay readable | Auto *proposed*, extends `infra/aws/db/test/upgrade-*` pattern: migrate a database with signed visits created before the change | Old visits load in lists, review, reports and corrections; `attestation_version` is NULL and shown as "Not recorded", never an error | Down |
| VIS-21c | Client cannot supply the attestation version | Auto: send `attestationVersion` in the body | Ignored or refused; stored value is the server's | n/a |

### 2.3 Screen 4 content (G07)
| ID | What to test | How to test | Expected result | Rollback |
|---|---|---|---|---|
| VIS-22a | Clean visit shows all fields | Web test with a fake backend; harness: 3:00 scheduled, 3:00 worked, drawn signature, 30:00 authorized with 5:00 used | Worked 3:00, Confirmed 3:00, Billable 3:00, Authorization left 22:00 (30:00 − 5:00 − 3:00), Confirmation "Drawn signature", Reconciliation "Clean", Billing "Billing ready", line "Billing ready does not mean billed" | Web/API rollback |
| VIS-22b | Exceeding visit shows the reason | Harness: 2:00 left, worked 3:00, signed | Status AUTHORIZATION REVIEW; Billable 2:00 held; Authorization left 0:00; reason text names the shortfall (1:00) | same |
| VIS-22c | No-signer visit shows zero confirmed | Harness: Verbal only | Confirmed 0:00, Billable "Held for office review", status CONFIRMATION REVIEW | same |
| VIS-22d | Numbers equal the server's | Auto *proposed*: API result of confirm equals the same visit read back from the visit list and the authorization balance function | Identical minutes in all three | same |

### 2.4 Unscheduled visits and reasons (G01, G03)
| ID | What to test | How to test | Expected result | Rollback |
|---|---|---|---|---|
| VIS-23 | Unscheduled start requires a reason | Auto *proposed* `apps/sv-api/test/wave1-unscheduled.db.test.ts`; web case; harness: Start unscheduled with no reason | Refused ("A reason is required"); no visit row; reason options shown | Down |
| VIS-24 | Unscheduled visit by a **fixed** caregiver goes to review (D-U) | Auto *proposed*; harness: fixed caregiver, unscheduled, signed, within authorization | `administrator_review`; reason code UNSCHEDULED; reason text stored and shown; billable minutes retained (O-2); billing approval **refused** until a review decision exists | Down |
| VIS-24b | Unscheduled visit by a **flexible** caregiver stays Billing Ready (control) | Auto *proposed*; harness | `signed`; reason stored; label "Flexible visit" as today | Down |
| VIS-24c | A scheduled visit is unaffected (control) | Auto: `visit-shift-link.db.test.ts` (pointer, run it) | Linked visit unchanged: `signed` when clean | n/a |
| VIS-24d | Reviewing an unscheduled visit allows approval only after a decision | Auto *proposed*: approve before and after the decision | Before: refused with the review message. After: approval allowed up to the capped billable minutes; approved minutes never exceed billable | Down |
| VIS-25 | Reason codes are derived on the server for every combination | Auto *proposed* `infra/aws/db/test/wave1-review-reasons.db.test.ts` | Clean: none. Exceeds only: AUTHORIZATION. Unscheduled only: UNSCHEDULED. No-signer only: CONFIRMATION. Exceeds + unscheduled: AUTHORIZATION first, UNSCHEDULED second. All three: AUTHORIZATION, UNSCHEDULED, CONFIRMATION. Same order on every read | Down |
| VIS-26 | The exception center groups and labels by reason | Web: `service-verification-reports-page.test.tsx` (extend); harness: Morgan, Action needed | One entry per visit, each with all its reasons as labels; filter by reason works; a visit with two reasons appears once in the headline count | Web rollback |
| VIS-27 | Old data gets correct reasons | Auto *proposed*: upgrade test with pre-change visits in `administrator_review` (no-signer, exceeding) | Reasons computed correctly from stored facts; no stored row changed; pre-change unscheduled visits that are already `signed` stay Billing Ready (not retroactively sent to review) | Down |
| VIS-28 | Review decision on an unscheduled visit is audited and revocable | Auto *proposed* (extends `visit-review.db.test.ts`) | Decision, actor, time, reason recorded; revoke returns the visit to waiting unless approved | Down |
| VIS-29 | Other agency and wrong role | Auto: `tenant-assignment-visit.db.test.ts` (pointer) plus *proposed* reasons case | Another agency's visits and reasons are not returned; a caregiver can read reasons only for their own visit | n/a |

### 2.5 Open-shift pickup (G09)
| ID | What to test | How to test | Expected result | Rollback |
|---|---|---|---|---|
| SCH-18 | Main path: caregiver picks up an open shift | Auto *proposed* `apps/sv-api/test/wave1-pickup.db.test.ts`; harness: Alex, My shifts, Open shifts, Pick up | The same shift row gets Alex; state "covered"; reserved minutes unchanged (shift 2:00 stays 2:00 reserved); history line "Open shift filled: Alex"; shows in Alex's My shifts | Down (function only); web rollback |
| SCH-19 | Two caregivers claim the same shift at once | Auto *proposed*: two connections, one shift, start together | Exactly one succeeds; the other gets "This shift was just filled"; one assignment, one history line, reservation unchanged | Down |
| SCH-20 | Refusals | Auto *proposed*, one case each | Not assigned to the client; overlapping shift for the caregiver; shift already filled; shift cancelled; shift in the past or started: each refused with its own plain message, nothing saved. When readiness enforcement is active and the caregiver is not ready: refused (`readiness-gate.db.test.ts` pointer) | Down |
| SCH-21 | Called-out shift picked up by someone else | Auto *proposed*; harness: Blake calls out, Alex picks up | Still one shift; history shows the call-out then the pickup; reservation unchanged; no duplicate; Action needed unfilled count falls by one | Down |
| SCH-21b | The caregiver who called out tries to pick the same shift up (O-1, answer A: refused) | Auto *proposed* | Refused with a message | Down |
| SCH-21c | Same (O-1, answer B: allowed) | Auto *proposed* | Allowed; history shows both events | Down |
| SCH-22 | Retry with the same key | Auto *proposed* | One assignment; same result returned; no second history line | Down |
| SCH-23 | Wrong role, other agency, no login | Auto *proposed* plus `shift-access.db.test.ts`, `access-roles.db.test.ts` (pointers) | A user without a caregiver record cannot pick up; another agency's open shifts are not listed and cannot be claimed; unauthenticated call is 401 (pilot) | Down |
| SCH-24 | The office sees it | Harness: Morgan after Alex's pickup | Schedule shows Alex; Home "Unfilled shifts" count down by one; Audit event exists (read through the database in the harness) | Web rollback |
| SCH-26 | Pickup is refused when authorization no longer covers the shift | Auto *proposed*: create an open shift, amend the authorization down so used plus reserved exceeds the cap, then claim | Refused with "Authorization no longer covers this shift"; the shift stays open; nothing saved | Down |
| SCH-27 | Double tap by the same caregiver | Auto *proposed*; web: tap Pick up twice fast | One claim, one history line, one audit event; the second call returns the first result | Down |
| SCH-25 | Authorization arithmetic is untouched by pickup | Auto: extend `authorization-accounting-risks.db.test.ts` with a pickup then a visit | After pickup: used 0, reserved 120. After the visit signs: used 120, reserved 0. Never both | Down |

### 2.5b D-V: no plain Accept
| ID | What to test | How to test | Expected result | Rollback |
|---|---|---|---|---|
| VIS-43 | The office cannot make a visit without client confirmation billable in one step | Auto: `visit-review.db.test.ts`, `signature-recovery.db.test.ts` (pointers, run them); web test on Action needed | The only choices for a no-signer visit are request confirmation, record the paper form, review the response, close not billable; each requires its inputs and a reason; the decision shows who, when and why; no signature image is created; the visit becomes billable only after an accepted confirmation | Web rollback |

### 2.6 Failure cases on the visit flow (G08)
Directive failure cases 3, 4, 14 and 15 and duplicate start/finalize. Cases already covered by an existing test are marked; run them.
| ID | What to test | How to test | Expected result | Rollback |
|---|---|---|---|---|
| VIS-30 | Duplicate Start, End and Submit make one record | Auto: `workflow.db.test.ts` idempotency cases (pointer, run it); extend for the new fields | One visit, one confirmation; second call returns the first result | n/a |
| VIS-31 | Refresh in each state | Harness: reload on screen 2, then after End, then after Submit | Screen 2 same Time In and elapsed; after End the same screen 3; after Submit screen 4 or Home. Never a blank or a second visit | n/a |
| VIS-32 | Network loss at End | Pilot, real phone, airplane mode, tap END VISIT. Web: failed `end` request | Message says nothing was sent and the visit is still open; no Time Out recorded; retry after reconnect records one Time Out | n/a |
| VIS-33 | Network loss at Submit | Same as VIS-32 at Submit | Same; the visit is still awaiting confirmation; retry creates one confirmation | n/a |
| VIS-34 | Retry after an ambiguous response (server saved, response lost) | Auto *proposed*: save, drop the response, retry with the same key | Same stored result; no duplicate; no second attestation | n/a |
| VIS-36 | Signature upload fails | Auto: `signature-recovery.db.test.ts` (pointer) | Existing recovery path unchanged | n/a |

### 2.7 Migration, isolation, privacy
| ID | What to test | How to test | Expected result | Rollback |
|---|---|---|---|---|
| MIG-W1a | Migrations apply on a database at 0049 and on a fresh database | `pnpm --filter @carelik/infra-aws db:migrate`; `db:verify` | Ledger count and max as expected; all verification checks PASS; `01_schema_version.sql` and the ledger-tail tests updated | Down, newest first |
| MIG-W1b | Each `.down.sql` runs and the previous behaviour returns | Auto: extend `readiness-restore.db.test.ts` pattern; run the manual procedure of `docs/releases/2026-10-13-0047-0048-0049/DEPLOYMENT_PLAN.md` section 10 | Previous function definitions restored; ledger back to 0049; old visits readable | n/a |
| MIG-W1c | No existing stored row changes in meaning | Auto *proposed* upgrade test: row counts and a checksum of visits, confirmations, shifts, reservations before and after | Identical except new nullable columns | Down |
| VIS-37 | Caregiver screens show no unnecessary identifiers | Harness: all four screens plus My shifts and Open shifts at 390 px | Client code only; no date of birth, UCI, Medicaid or payer ID; no real names (EVV-05) | Stop; web rollback |
| VIS-38 | No "EVV compliant" claim | Search of the built web bundle (EVV-04) | Absent | Fix before GO |
| VIS-39 | No personal data in logs or URLs | Pilot: search API logs for the window | No signature payloads, notes, reasons or client names in logs or URLs | Stop; API rollback |

### 2.8 Mobile (caregiver screens, 390 px)
| ID | What to test | How to test | Expected result | Rollback |
|---|---|---|---|---|
| VIS-40 | Layout at 390 px | Harness at 390 px for screens 1 to 4, Open shifts | No horizontal page scroll; primary button visible without hunting; tap targets at least 44 px; long service names wrap | Web rollback |
| VIS-41 | On a real phone | Pilot, Phase D Caregiver validator on their own phone | Keyboard does not hide the button; signature box takes a finger; the timer is legible; safe-area insets respected | Web rollback |
| VIS-42 | Contrast and focus | Auto: `apps/web/src/aws/contrast.test.ts` (pointer); manual tab order | Tests pass; every control reachable and labeled | Web rollback |

## 3. Failure-first checklist
☑ Invalid input: VIS-23, VIS-35, SCH-20. ☑ Stale data: SCH-20 (shift already filled), SCH-19. ☑ Two people at once: SCH-19, and two schedulers/pickup in SCH-25. ☑ Retried or duplicated request: VIS-30, VIS-34, SCH-22. ☑ Wrong role: VIS-29, SCH-23. ☑ Other agency: VIS-29, SCH-23, SCH-13 (pointer). ☑ Network failure at submit: VIS-32, VIS-33 (pilot). ☑ Database failure mid-way: not applicable because each new function runs in one transaction; proven by a case that forces an error after the first write and asserts nothing was saved (add to SCH-18 and VIS-24 tests). ☑ Old data and old signed or locked records: VIS-21b, VIS-27, MIG-W1c. ☑ Correction after the fact: `approved-visit-correction.db.test.ts` and `correction-unchanged-times.db.test.ts` re-run (pointers, VIS-08). ☐ Daylight-saving and month-boundary dates: add one pickup case on the DST day and one visit ending after midnight on the last day of a month (reason codes and remaining minutes must use the agency's month). ☑ Timezone is the agency's: same cases.

## 4. Numbers that must agree
| Figure | Where it appears | Single source | Agreement check |
|---|---|---|---|
| Authorization left after a visit | Screen 4, client page "Balance for month", Home, API confirm result | The existing server balance functions (used from `authorization_month_usage`, reserved from `authorization_reservations`, rule `reservation_counted_as_used`) | VIS-22a and VIS-22d: one fixture, same minutes in all places |
| Reserved minutes after pickup | Schedule, client page, Home | `authorization_reservations` (row unchanged by pickup) | SCH-18, SCH-21, SCH-25: reserved identical before and after |
| Worked, confirmed, billable minutes | Screen 4, visit list, review page, billing review | The visit and confirmation rows set by the confirm function | VIS-22d |
| Unfilled shifts | Home Action needed, Schedule "Needs coverage" filter, My shifts Open shifts | One shift coverage state function (`ogevia.shift_coverage_state`, migration 0026) | SCH-21, SCH-24: three counts equal before and after a pickup |
| Visits to review | Home headline, Action needed list, per-reason groups | The review-reason function (new). Headline counts distinct visits; group counts can overlap and may sum to more | VIS-26: a two-reason visit counted once in the headline and once in each group |

## 5. Evidence plan
| Evidence | Phase | File name |
|---|---|---|
| Failing test before each rule change (unscheduled routing, pickup, reasons) | A | `evidence/A-failing-<ID>.txt` |
| Before and after screenshots, same record: screen 3, screen 4, Action needed with reasons, Open shifts | B | `evidence/VIS-14-screen3-before.png`, `...-after.png`; `VIS-22a-screen4-after.png`; `VIS-26-action-needed-after.png`; `SCH-18-open-shifts-before.png`, `...-after.png` (390 px caregiver, 1280 px office) |
| Pickup race over the real API; real-phone airplane-mode checks; private S3 evidence; log search | C | `evidence/C-pickup-race.txt`, `C-airplane.txt`, `C-logs.txt` |
| UAT scripts and sign-offs | D | Scripts from sections 2.1 to 2.6; Owner, Scheduler, Caregiver (phone) and Authorization sign-offs |

## 6. Rollback plan (whole change)
| Layer | Action | What it cannot undo | Who | Time |
|---|---|---|---|---|
| Web | Redeploy the previous bundle | Visits submitted through the new screens stay as submitted | Operator | minutes |
| API | Redeploy the previous template/commit. The new pickup route disappears; old clients do not call it | Pickups already made stay | Operator | minutes |
| Database | `.down.sql` for each migration of this release, newest first, then re-verify with `db:verify`. Restore a snapshot only to a NEW instance, only by separate approval | Reason and attestation values written after deploy are lost if the additive columns are dropped (data-loss-on-rollback, owner approval first). Unscheduled visits already sent to review stay in review unless decided | Operator + owner | 15 to 30 min (estimate, not measured) |
| Data created during the release | Never deleted by hand; corrected through the product (review decision, correction, call-out, assignment) | n/a | Manager/Owner | n/a |

## 7. Exit criteria
Phase A: every row in section 2 has a test or a named manual step; the failing-before evidence exists; `pnpm lint`, `pnpm typecheck`, `OGEVIA_TEST_DATABASE_URL=<local> pnpm test:all` pass with 0 skipped. Phase B: every harness row done by persona at 390 px and 1280 px with screenshots. Phase C: rows marked pilot pass, including the pickup race with two real test caregivers. Phase D: Caregiver validator completes screens 1 to 4 for each confirmation choice on their own phone. Phase E: owner GO for that SHA. No deployment is proposed until the checklist is complete.
