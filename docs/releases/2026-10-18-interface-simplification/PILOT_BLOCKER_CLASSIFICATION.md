# Pilot-blocker classification of the open matrix rows

**Update 2026-10-18 (release candidate, migrations through 0076): this matrix is superseded as the status record by `RELEASE_CANDIDATE_CLOSURE.md`, which closes all 88 rows against the final code (64 complete with no open item, 18 complete with a stated limit/decision/external step, 2 external checks, 2 deferred pending owner decision, 1 open owner decision, 1 superseded). The row text and "Status now" cells below are as of the earlier HEAD and are kept as history.**

Local, 2026-10-17, updated after batch 7 (migrations through 0072). Source: `FIVE_BOARD_MATRIX_88.md` (88 requirement IDs). **54 rows are not IMPLEMENTED** (38 PARTIAL, 14 MISSING, 2 UNVERIFIABLE; B1-R2 was decided by the owner and is SUPERSEDED). Every one is classified below. Nothing is silently dropped.

**4 are PILOT BLOCKERS. 50 are PROPOSED DEFERRALS.** A deferral is a proposal. **Nothing is deferred until the owner approves it row by row**; until then each deferred row stays an open, approved requirement.

**Phase 1 is synthetic-data only; real-data access needs separate approval.** Blockers below are what must be settled before that approval, plus the Phase C/D validation the release process already requires.

**Closed locally in batch 7 (no longer open, still need TEST validation):** B5-R8 (all four exports server-generated with server-side `reports.export` enforcement and a request/generation ledger, 0072; the owner-role mapping is still a proposal to confirm). Also closed in substance, without changing a row's status: the retroactive-decrease rule for visits (B2-D5 evidence, 0071) and the delivered-but-unverified handling (B2-D11, 0071).

**Closed locally in batch 6 (no longer open, still need TEST validation):** B2-D5 (amendment impact on reserved shifts, 0068), B2-D20 (one accounting basis, F6, agency month), B3-R11 (release on cancel/sign; ended shifts reconciled by a person), B5-R5, B5-R7, B5-R11 (full-chain report, 0070). Their blocker reasons from the earlier version of this file are retired; the tests are listed in README section 17. The earlier blocker B5-R8 (export permission and audit) is reduced to a decision gate (row below).

## How "pilot" and "blocker" are used here

No repository document defines the pilot's scope beyond the core pilot list in the build directive (section 21): schedule within authorization; reservations correct; call-out and replacement without duplicates; simple caregiver visit; client confirmation; clean visit becomes Billing Ready; exceptions routed; a human approves billing; authorization amendments auditable; a monthly report that explains the chain; tenant isolation. I used that list, plus the owner-approved compliance and work-hour rules operating as approved. If the owner draws the pilot differently, the classification changes; that is the owner's call.

A row is a **PILOT BLOCKER** if any of these holds:
1. **Money or authorization accuracy:** a figure or reservation can be wrong, or an amendment's effect on reserved work is not reported. (Every row that was blocked on this ground is closed locally.)
2. **An approved rule is not yet operating as approved** (code complete but needs an owner action or deployment).
3. **Access control or audit with real data** is weaker than the directive requires.
4. **Verification the directive requires** (real-device test of the mobile flow) has not been done.

Otherwise it is a **PROPOSED DEFERRAL**: the correct figure or rule already holds and the gap is display, convenience, analytics, or something the owner has not yet defined. Where a deferral rests on an undefined owner rule it says so, and I did not invent the rule. "Controls for the pilot" are suggestions, not implemented.

## Summary of what closes the blockers

| Work item | Rows it closes | Kind |
|---|---|---|
| Activate compliance enforcement after the read-only preview, and deploy the scheduled run (separate approvals; one-way switch, see the activation checklist sections 6 and 7) | B3-R7, B3-R9 | **Owner action and a release decision, not code** |
| Real-device test of the caregiver and office flows | B1-R8, B3-R18 | Verification |

**Separate from the 88 rows, kept deferred (not reinstated by implication):** gap list G11 "mark submitted / billed" (human-recorded submission with an external reference, who, when, void with reason, and a Billed column) is P0 in `docs/product/BUILD_GAP_LIST_2026-10-12.md` and the directive's billing-approval capture mentions an export/submission state and external reference, but it is not a board row and the owner deferred an 'Already Billed' state (0062). Nothing was added: no state, column, permission, label or report column. Decision for the owner: keep it deferred for Phase 1 (recommended; the month close ends at Approved for Billing and submission is recorded outside Ogevia) or schedule a minimal human-recorded ledger before real data.

## Classification

| ID | Matrix status | Class | Reason | What closes it |
|---|---|---|---|---|
| B1-R1 | PARTIAL | **PROPOSED DEFERRAL** | The hierarchy is delivered by the four streams, compact Today's visits and quick actions (owner decision, B1-R2). What is missing is carried by B1-R6 (issue panel) and B1-C4 (extra cards). | Closes with B1-R6; no separate work. |
| B1-R3 | PARTIAL | **PROPOSED DEFERRAL** | Today's visits shows time, client, caregiver and a status word; a shift blocked by a compliance hold or failed credential is not highlighted there, but is on Needs attention now and Caregiver holds, and a visit in progress for a held caregiver is Critical there (0064). | Add compliance/credential state to the list item. |
| B1-R5 | PARTIAL | **PROPOSED DEFERRAL** | Tier calculation is correct and tested (0057); it is shown as one text line without a link. Authorization is still enforced server-side at scheduling and pickup, so this is an early-warning display gap, not an accounting error. | Alert card with count and link to affected clients. |
| B1-R6 | MISSING | **PROPOSED DEFERRAL** | The list exists one click away (Needs attention now); Home shows the count. No deadline column exists anywhere until B4-D9 defines one. | Compact Critical-then-Urgent panel on Home after B4-D9. |
| B1-R7 | PARTIAL | **PROPOSED DEFERRAL** | Counts refresh every 5 minutes and on Refresh, and show a stale warning after 10 minutes; most actions rely on that or on remount. A stale count can lag a few minutes; it is never shown as zero. | Invalidate the overview after every mutation (small). |
| B1-R8 | PARTIAL | **PILOT BLOCKER** | Verification gap, not a code gap: the caregiver flow is mobile-first and has only been run in Chromium viewport emulation. The directive forbids approving a mobile flow on responsive mode alone. | Run the caregiver and office flows on a real iPhone (Safari) and Android (Chrome); record results. |
| B1-R9 | MISSING | **PROPOSED DEFERRAL** | Appearance preferences (background, layout, text size, density) already exist and persist. Collapsing optional Home sections is convenience, and mandatory alerts are never hidden. | Per-user collapse of optional sections. |
| B1-R10 | PARTIAL | **PROPOSED DEFERRAL** | No count is ever shown as zero on failure (verified). The Hours section prints the server's error text; messages are curated, not raw database errors. | Replace with a fixed message and Retry. |
| B1-R12 | PARTIAL | **PROPOSED DEFERRAL** | Keyboard-only use (37/37), contrast and 44 px targets were checked; screen-reader use was not. BECOMES A BLOCKER if any pilot user relies on a screen reader. | Test with VoiceOver and TalkBack on the main flows. |
| B1-C1 | UNVERIFIABLE | **PROPOSED DEFERRAL** | No performance target has been defined, so none can be verified; load time is measured during the TEST pilot (release process phase C), which cannot be a precondition of itself. | Owner states a target; measure on TEST. |
| B1-C2 | PARTIAL | **PROPOSED DEFERRAL** | Counts never show a failed load as zero; partial-failure handling is verified for Today's list only. | Same test for the other tiles. |
| B1-C4 | PARTIAL | **PROPOSED DEFERRAL** | Hours, Financial impact, Continuity and Outage cards remain below the four streams; they add content, not risk. Owner decision whether they stay. | Owner decision on each card. |
| B1-C5 | PARTIAL | **PROPOSED DEFERRAL** | One server response feeds every count, so views agree today (tested). A shared issue identity depends on B4-D10. | Closes with B4-D10. |
| B2-D3 | PARTIAL | **PROPOSED DEFERRAL** | Ordering of sections on the client page; authorization is on the page and enforced by the server regardless of order. | Pin the order in a test. |
| B2-D6 | PARTIAL | **PROPOSED DEFERRAL** | Tier and expiry badges exist; alert records, resolved history and de-duplication do not. Needs the issue-identity design (B4-D10). | Closes with B4-D10. |
| B2-D7 | MISSING | **PROPOSED DEFERRAL** | The client page and Needs attention are one click from every alert; a direct deep link with context is convenience. | Link each alert to its workflow. |
| B2-D8 | MISSING | **PROPOSED DEFERRAL** | The Schedule, View authorization and Verify actions exist elsewhere; this row asks for them as client quick actions. | Add client quick actions. |
| B2-D9 | PARTIAL | **PROPOSED DEFERRAL** | Assigned caregivers are listed; next visit is on the Schedule. | Add next-visit field. |
| B2-D10 | MISSING | **PROPOSED DEFERRAL** | The Schedule shows each client's visits; a three-visit preview on the client page is convenience. | Add the preview. |
| B2-D11 | PARTIAL | **PROPOSED DEFERRAL** | The blocking part (a reservation stuck forever on an ended shift) is closed locally by 0067 and 0071: it is listed and a person reconciles it (released, held, or recorded as delivered-not-verified, which stays reserved and non-billable); nothing is released automatically. What remains: cancel is refused when a visit is linked, and late-cancellation payment is not modelled (owner rule needed, not invented). | Owner supplies the payment rule; decide how a linked-visit cancellation should work. |
| B2-D12 | PARTIAL | **PROPOSED DEFERRAL** | Authorization versions, who and when are stored and the amendment history is preserved (directive satisfied in data); the on-screen audit timeline is missing. | Show the audit timeline on the client page. |
| B2-D13 | PARTIAL | **PROPOSED DEFERRAL** | Profile editing exists. No duplicate-client check or impact warning. Control for the pilot: the office adds clients under a written procedure and checks for an existing client first. | Duplicate check and impact warning. |
| B2-D14 | MISSING | **PROPOSED DEFERRAL** | Client documents are outside the core chain (service evidence to billing). Caregiver documents are built. | Client document centre. |
| B2-D15 | MISSING | **PROPOSED DEFERRAL** | Client readiness and holds are outside the core chain; client status exists. | Client readiness model. |
| B2-D16 | PARTIAL | **PROPOSED DEFERRAL** | New scheduling outside an active authorization period is already refused by the reservation rule. Already-scheduled shifts and unapproved Billing Ready visits are flagged when an amendment shortens or lowers an authorization (0068, 0071). What remains: no service-specific hold concept and no restoration review. | Hold concept and restoration review (owner rules needed). |
| B2-D17 | MISSING | **PROPOSED DEFERRAL** | A renewal can be entered as a new authorization version today; the guided flow is convenience. | Guided renewal. |
| B2-D19 | PARTIAL | **PROPOSED DEFERRAL** | Alerts exist; actionable links are B2-D7. Real-device testing is tracked once under B1-R8. | Closes with B2-D7 and B1-R8. |
| B3-R1 | PARTIAL | **PROPOSED DEFERRAL** | Week view exists; day/month views and a calendar grid are usability. The pilot is small. | Day and month views. |
| B3-R2 | PARTIAL | **PROPOSED DEFERRAL** | Today, upcoming and uncovered shifts are on Home and the attention pages; a single scheduling overview is a layout choice. | Overview section on Schedule. |
| B3-R3 | PARTIAL | **PROPOSED DEFERRAL** | Creation works with validation; prefill is convenience. | Prefill from the client record. |
| B3-R5 | PARTIAL | **PROPOSED DEFERRAL** | One 'needs coverage' filter exists; with a small pilot roster the unfiltered week is workable. | Filters by caregiver, client, service, status. |
| B3-R7 | PARTIAL | **PILOT BLOCKER** | Code complete, but availability is enforced for scheduling only after the owner activates enforcement; until then only overlap is refused. Activation is an owner action with a prepared checklist and read-only preview. | Owner activates after the preview (`ACTIVATION_CHECKLIST_SOCAL_CARE_SERVICES.md`); no code change. |
| B3-R9 | PARTIAL | **PILOT BLOCKER** | Code complete (0055, 0064, 0066), but credentials and background clearance are enforced only after the owner activates enforcement, and the scheduled run that opens holds is not deployed. Until both, a caregiver with no clearance can be scheduled. | Owner activates; scheduled run deployed under the release process. The rules are owner-defined, not verified legal requirements. |
| B3-R14 | PARTIAL | **PROPOSED DEFERRAL** | Replacement is done by the office, with no duplicate shift or reservation (tested). Ranked suggestions are decision support and need owner-defined ranking weights (handoff conflict C6). | Owner defines weights; then build. |
| B3-R15 | PARTIAL | **PROPOSED DEFERRAL** | The Schedule distinguishes Covered, Needs coverage, Completed, Cancelled and No-show; partial and verification-pending are not. The reservation consequence of a missed shift is the blocker B2-D11. | Add the states to the Schedule. |
| B3-R16 | MISSING | **PROPOSED DEFERRAL** | No scheduling notifications. Sending PHI-bearing messages through a new service needs owner approval and a cost decision. Pilot control: a named person reviews Needs attention now at set times. | Owner chooses channel and content; build. |
| B3-R18 | PARTIAL | **PILOT BLOCKER** | Verification gap, not a code gap: browser-verified at 390 px and 1280 px on reset fixtures (40/40 each) but never on a real device. | Same real-device run as B1-R8. |
| B3-E3 | PARTIAL | **PROPOSED DEFERRAL** | Reassignment works, pickup needs confirmation and keeps history (0063); recommendations are B3-E6. | Closes with B3-E6. |
| B3-E4 | PARTIAL | **PROPOSED DEFERRAL** | The reservation-release component is handled (0067). The cancellation-payment model and recording the cancelling party need owner rules and are not invented. | Owner supplies both rules; then build. |
| B3-E6 | MISSING | **PROPOSED DEFERRAL** | Needs the owner's ranking weights and trigger (C6). The office can already see uncovered shifts by urgency and assign. | Owner defines; then build. |
| B4-D1 | PARTIAL | **PROPOSED DEFERRAL** | Home and the header use one server overview, and counts agree with their lists (tested). The legacy summary used by the exceptions report omits Ready for Approval (`it.fails` F2, a count mismatch, not a money figure). Pagination and filters are absent; the pilot lists are short. | Retire the legacy summary; add pagination. |
| B4-D3 | PARTIAL | **PROPOSED DEFERRAL** | 48-hour default applies and never auto-approves; agency configuration and payer-specific rules are not defined. | Owner supplies the rule; add setting. |
| B4-D6 | PARTIAL | **PROPOSED DEFERRAL** | Same: 48-hour default, blocking and expired items immediate; not configurable. | Same. |
| B4-D7 | PARTIAL | **PROPOSED DEFERRAL** | Ordered Critical-first with workflow links; no filters or deadline field. | Add filters and deadlines with B4-D9. |
| B4-D9 | PARTIAL | **PROPOSED DEFERRAL** | Links land on the right module; no recommended action, prefill, deadline or ranked replacements. | Build with B3-E6 and a deadline definition. |
| B4-D10 | MISSING | **PROPOSED DEFERRAL** | A stable shared issue identity is a larger design. Views agree because they read one response. Risk: no per-issue history. | Design and build; migration needed. |
| B4-D11 | MISSING | **PROPOSED DEFERRAL** | No notifications. Same decision gate as B3-R16. Pilot control: a named person reviews Needs attention now at set times; Critical items carry a red badge in the header. | Owner decision; then build. |
| B4-D12 | PARTIAL | **PROPOSED DEFERRAL** | Rows are lists, not guided action cards; filters absent. | Redesign rows with B4-D9. |
| B4-D13 | PARTIAL | **PROPOSED DEFERRAL** | Tenant isolation, role checks and audit exist and are tested; only the issue-level before/after history is missing, which depends on B4-D10. | Closes with B4-D10. |
| B5-R1 | MISSING | **PROPOSED DEFERRAL** | The five sections exist in scattered pages; a single area is navigation. | Group under one area. |
| B5-R9 | UNVERIFIABLE | **PROPOSED DEFERRAL** | Cannot be verified from the repository: it asks for a mobile Board 5 view; needs the owner's mockup review. | Owner reviews the mockup. |
| B5-R12 | MISSING | **PROPOSED DEFERRAL** | Uncovered shifts, cancellations, missed visits and utilization need owner definitions (R6) before numbers can be trusted. Not in the directive's core pilot list. | Owner defines metrics. |
| B5-R13 | PARTIAL | **PROPOSED DEFERRAL** | The full-chain monthly report (G12) exists with a server-generated, recorded CSV. Remaining: no CSV for the Billing review list (the three older reports are server-generated since 0072). Submitted / billed is excluded by decision. | Billing-review CSV through the same server-side path. |
| B5-R14 | PARTIAL | **PROPOSED DEFERRAL** | Corrections and supporting records are stored and queryable; there is no general audit screen (G14, P1 in the gap list). Until it exists, audit evidence is produced on request by an authorized person with database access. | Audit log screen with role limits. |

## What I could not establish

- Whether the owner treats the pilot as synthetic-data only or with real clients. If real clients, B5-R8 and the real-device test are firmly blockers; if synthetic only, they remain blockers for the first real-data day.
- Real AWS behaviour, deployed triggers, and TEST: nothing here was run there. Every "tested" statement refers to local tests on a disposable PostgreSQL and a local Chromium on synthetic data.
- Legal and payer requirements for work hours, hold rules and notifications were not verified; owner-defined rules are described as owner-defined.



## Remaining accounting, approval and legacy defects: why each is safe to defer (a proposal; nothing is deferred until the owner approves it)

"Safe" is argued for synthetic-data Phase 1 only. Each entry states what stays correct, what the defect costs, and the evidence. VERIFIED = a local test or code reading cited; INFERRED = argued from the rule but not tested.

| Defect | What stays correct (and how I know) | What it costs while open | Status of the argument |
|---|---|---|---|
| Delivered-but-unverified time stays reserved with no deadline | The reservation counts toward committed, so remaining authorization can only be understated, never overstated; nothing becomes billable (`reservation-lifecycle.db.test.ts` "delivered but not verified"); it stays on the Schedule, Home and the chain report until a person decides | The time is unavailable for scheduling until a person acts; no ageing alert | VERIFIED for correctness; the missing alert is an operating risk, controlled by the named reviewer of Needs attention |
| Late-cancellation payment and the cancelling party are not modelled (B2-D11, B3-E4) | Ogevia computes no payment, so no figure is wrong; cancel still releases the unused reservation and keeps delivered hours | Staff decide payment outside Ogevia's calculations; the owner rule is undefined, so I did not invent one | VERIFIED (no such field or calculation exists); the owner rule is UNKNOWN |
| Cancel refused when a visit is linked | The refusal is safe: it never lets a reservation or visit be lost | A person has to correct the visit instead | VERIFIED (`shifts.db.test.ts`) |
| A reconciled past shift still shows its original status on the Schedule | Reservation, ledger and report totals come from the reservation ledger and the reconciliation history, not the shift status (tested to agree across screens) | A reader of the Schedule alone does not see the decision; Home, the chain report and the Schedule's reconcile list do | VERIFIED |
| A period that lapses with no amendment does not flag already-scheduled shifts (B2-D16) | A shift can only be created inside an authorization period (refused otherwise), and the period changes only through an amendment, which flags reserved shifts and visits (0068, 0071) | A shift scheduled before a period ends is not flagged merely because the period ends | VERIFIED for the amendment path; INFERRED for "no other way to move the period end" |
| An approved visit is not reopened when the authorization is lowered | By instruction, approved visits and billable amounts are not changed; the impact is reported on the authorization-changes page with "already approved, not changed"; a person must void the approval to reopen it | An approved amount may exceed the lowered authorization until a person acts; reported, not hidden | VERIFIED (`authorization-decrease-review.db.test.ts`) |
| A decrease never sends an already approved or submitted record back automatically | Same human-in-the-loop rule: history is not rewritten | Same | VERIFIED |
| A refused export is not written to the ledger | A refusal returns nothing, so no data leaves; refusals appear in the API's own request log (status 403) | The audit shows who exported, not who tried and was refused | INFERRED (the API log line is structured and carries the route and status; I did not test its content for refusals) |
| The ledger records generation, not receipt | The server cannot know whether the browser saved the file; the screen says so | The audit cannot prove a download | VERIFIED (by design) |
| Exports are limited to 4 MB per file | Larger files are refused and recorded as failed, never truncated (`unit.test.ts`) | A very large month cannot be exported in one file; no pagination yet | VERIFIED for the limit; real data volume UNKNOWN |
| Export role mapping (owner and manager; scheduler lost it) | Server-enforced; the permission is data-driven; nothing broader than before | A scheduler who exported before cannot now | VERIFIED as implemented; whether it is right is the owner's decision (item 4 of the 2026-10-17 request) |
| Legacy attention-summary defects F2 and F4 (`it.fails`) | They are count mismatches in the exceptions report; Home, the header and the queues read the newer overview, which agrees with its lists | The exceptions report omits Ready for Approval from one count | VERIFIED (pinned by `it.fails`; the pins fail loudly if the defect is fixed or spreads) |
| G11 / Already Billed deferred | Approval is not submission; nothing in Ogevia claims a visit was submitted or paid | Ogevia cannot show whether approved visits were later submitted | By the owner's 2026-10-17 decision, not mine |
| `reservation_bucket` cost at volume not measured | Correctness does not depend on speed | Slow pages on a very large agency | UNKNOWN; measure on TEST |
| Reconcile racing a late-confirmation acceptance | Tested in batch 7 (`reconciliation-races.db.test.ts`): reconcile cannot commit while an active visit exists; the acceptance wins; no double counting or lost evidence | None | VERIFIED |

This is my argument, not an approval. Rows that rest on an owner rule I could not verify are marked UNKNOWN and are not treated as settled.
