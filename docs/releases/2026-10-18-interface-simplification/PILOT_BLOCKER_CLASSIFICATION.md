# Pilot-blocker classification of the open matrix rows

Local, 2026-10-17. Source: `FIVE_BOARD_MATRIX_88.md` (88 requirement IDs). **61 rows are not IMPLEMENTED** (45 PARTIAL, 14 MISSING, 2 UNVERIFIABLE; the one CONFLICT row, B1-R2, was decided by the owner and is SUPERSEDED, see README section 16.1). Every one of the 61 is classified below. Nothing is silently dropped.

**14 are PILOT BLOCKERS. 47 are PROPOSED DEFERRALS.** A deferral is a proposal. **Nothing is deferred until the owner approves it row by row**; until then each deferred row stays an open, approved requirement.

## How "pilot" and "blocker" are used here

No repository document defines the pilot's scope beyond the core pilot list in the build directive (section 21): schedule within authorization; reservations correct; call-out and replacement without duplicates; simple caregiver visit; client confirmation; clean visit becomes Billing Ready; exceptions routed; a human approves billing; authorization amendments auditable; a monthly report that explains the chain; tenant isolation. I used that list, plus the owner-approved compliance and work-hour rules operating as approved. If the owner draws the pilot differently, the classification changes; that is the owner's call.

A row is a **PILOT BLOCKER** if any of these holds:
1. **Money or authorization accuracy:** a figure or reservation can be wrong, or an amendment's effect on reserved work is not reported.
2. **An approved rule is not yet operating as approved** (code complete but needs an owner action or deployment).
3. **Access control or audit with real data** is weaker than the directive requires.
4. **Verification the directive requires** (real-device test of the mobile flow) has not been done.

Otherwise it is a **PROPOSED DEFERRAL**: the correct figure or rule already holds and the gap is display, convenience, analytics, or something the owner has not yet defined. Where a deferral rests on an undefined owner rule it says so, and I did not invent the rule. "Controls for the pilot" are suggestions, not implemented.

## Summary of what closes the blockers

| Work item | Rows it closes | Kind |
|---|---|---|
| Fix authorization accounting: F6, ended-unvisited reservation release, agency month on Home | B2-D20, B2-D11, B3-R11, B3-E4 (release component), B5-R5, B5-R7, B5-R11 | Code and migration |
| Report and persist amendment impact on reserved shifts (G10) | B2-D5 (also B2-D16) | Code and migration |
| Full-chain monthly report (G12) | B5-R13 (B5-R7) | Code |
| Export permission and export audit | B5-R8 | Code and migration |
| Activate compliance enforcement after the preview; deploy the scheduled run | B3-R7, B3-R9 | **Owner action and a release decision, not code** |
| Real-device test of caregiver and office flows | B1-R8, B3-R18 | Verification |

Outside the 88 rows: gap list G11 (mark submitted/billed) is P0 in `docs/product/BUILD_GAP_LIST_2026-10-12.md` but is not a board row, and the owner deferred an 'Already Billed' state in 0062. The two need the owner's reconciliation; I record it here rather than decide it.

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
| B2-D5 | PARTIAL | **PILOT BLOCKER** | Directive section 8: an amendment must identify affected visits and create review impact. A decrease below what is already reserved is not reported for the shifts concerned (pinned by `it.fails` in `authorization-accounting-risks.db.test.ts`, 'lowering 600 -> 300 with 480 reserved reports the affected shifts'); gap list G10 also records that flags are not persisted. Since 0063/0065 the system refuses to assign or confirm such a shift, but the office is not told which reserved shifts are over the new cap. | Report reserved shifts over a lowered cap, persist the impact, add Acknowledge (G10). |
| B2-D6 | PARTIAL | **PROPOSED DEFERRAL** | Tier and expiry badges exist; alert records, resolved history and de-duplication do not. Needs the issue-identity design (B4-D10). | Closes with B4-D10. |
| B2-D7 | MISSING | **PROPOSED DEFERRAL** | The client page and Needs attention are one click from every alert; a direct deep link with context is convenience. | Link each alert to its workflow. |
| B2-D8 | MISSING | **PROPOSED DEFERRAL** | The Schedule, View authorization and Verify actions exist elsewhere; this row asks for them as client quick actions. | Add client quick actions. |
| B2-D9 | PARTIAL | **PROPOSED DEFERRAL** | Assigned caregivers are listed; next visit is on the Schedule. | Add next-visit field. |
| B2-D10 | MISSING | **PROPOSED DEFERRAL** | The Schedule shows each client's visits; a three-visit preview on the client page is convenience. | Add the preview. |
| B2-D11 | PARTIAL | **PILOT BLOCKER** | Money and authorization: a shift that ended with no visit keeps its reservation, the schedule screen cannot cancel it, and cancel is refused when a visit is linked (handoff conflict C3). That reduces available authorization and can block legitimate scheduling or hide leakage. Late-cancellation payment is not modelled and is not invented. | Release unused reservations for ended-unvisited shifts and allow cancellation from the schedule; owner defines any late-cancellation payment rule separately. |
| B2-D12 | PARTIAL | **PROPOSED DEFERRAL** | Authorization versions, who and when are stored and the amendment history is preserved (directive satisfied in data); the on-screen audit timeline is missing. | Show the audit timeline on the client page. |
| B2-D13 | PARTIAL | **PROPOSED DEFERRAL** | Profile editing exists. No duplicate-client check or impact warning. Control for the pilot: the office adds clients under a written procedure and checks for an existing client first. | Duplicate check and impact warning. |
| B2-D14 | MISSING | **PROPOSED DEFERRAL** | Client documents are outside the core chain (service evidence to billing). Caregiver documents are built. | Client document centre. |
| B2-D15 | MISSING | **PROPOSED DEFERRAL** | Client readiness and holds are outside the core chain; client status exists. | Client readiness model. |
| B2-D16 | PARTIAL | **PROPOSED DEFERRAL** | New scheduling outside an active authorization period is already refused by the reservation rule. Flagging already-scheduled shifts when an authorization is shortened or lapses is the same impact report as B2-D5 and closes with it. | Closes with B2-D5; then restoration review. |
| B2-D17 | MISSING | **PROPOSED DEFERRAL** | A renewal can be entered as a new authorization version today; the guided flow is convenience. | Guided renewal. |
| B2-D19 | PARTIAL | **PROPOSED DEFERRAL** | Alerts exist; actionable links are B2-D7. Real-device testing is tracked once under B1-R8. | Closes with B2-D7 and B1-R8. |
| B2-D20 | PARTIAL | **PILOT BLOCKER** | Money and authorization: `it.fails` F6 (a started, unvisited reservation is missing from 'Scheduled ahead', so authorized, billable, scheduled and remaining do not add up), the ended-unvisited reservation that is never released (C3), and a browser-month versus agency-month difference on Home. The directive requires the authorization position to be right. | Fix F6, release ended-unvisited reservations, use the agency month on Home; convert the `it.fails` tests to passing tests. |
| B3-R1 | PARTIAL | **PROPOSED DEFERRAL** | Week view exists; day/month views and a calendar grid are usability. The pilot is small. | Day and month views. |
| B3-R2 | PARTIAL | **PROPOSED DEFERRAL** | Today, upcoming and uncovered shifts are on Home and the attention pages; a single scheduling overview is a layout choice. | Overview section on Schedule. |
| B3-R3 | PARTIAL | **PROPOSED DEFERRAL** | Creation works with validation; prefill is convenience. | Prefill from the client record. |
| B3-R5 | PARTIAL | **PROPOSED DEFERRAL** | One 'needs coverage' filter exists; with a small pilot roster the unfiltered week is workable. | Filters by caregiver, client, service, status. |
| B3-R7 | PARTIAL | **PILOT BLOCKER** | Code complete, but availability is enforced for scheduling only after the owner activates enforcement; until then only overlap is refused. Activation is an owner action with a prepared checklist and read-only preview. | Owner activates after the preview (`ACTIVATION_CHECKLIST_SOCAL_CARE_SERVICES.md`); no code change. |
| B3-R9 | PARTIAL | **PILOT BLOCKER** | Code complete (0055, 0064, 0066), but credentials and background clearance are enforced only after the owner activates enforcement, and the scheduled run that opens holds is not deployed. Until both, a caregiver with no clearance can be scheduled. | Owner activates; scheduled run deployed under the release process. The rules are owner-defined, not verified legal requirements. |
| B3-R11 | PARTIAL | **PILOT BLOCKER** | Same defect as B2-D11 (C3): an ended-unvisited shift keeps its reservation. Delivered hours are preserved. | Same fix as B2-D11. |
| B3-R14 | PARTIAL | **PROPOSED DEFERRAL** | Replacement is done by the office, with no duplicate shift or reservation (tested). Ranked suggestions are decision support and need owner-defined ranking weights (handoff conflict C6). | Owner defines weights; then build. |
| B3-R15 | PARTIAL | **PROPOSED DEFERRAL** | The Schedule distinguishes Covered, Needs coverage, Completed, Cancelled and No-show; partial and verification-pending are not. The reservation consequence of a missed shift is the blocker B2-D11. | Add the states to the Schedule. |
| B3-R16 | MISSING | **PROPOSED DEFERRAL** | No scheduling notifications. Sending PHI-bearing messages through a new service needs owner approval and a cost decision. Pilot control: a named person reviews Needs attention now at set times. | Owner chooses channel and content; build. |
| B3-R18 | PARTIAL | **PILOT BLOCKER** | Verification gap, not a code gap: browser-verified at 390 px and 1280 px on reset fixtures (40/40 each) but never on a real device. | Same real-device run as B1-R8. |
| B3-E3 | PARTIAL | **PROPOSED DEFERRAL** | Reassignment works, pickup needs confirmation and keeps history (0063); recommendations are B3-E6. | Closes with B3-E6. |
| B3-E4 | PARTIAL | **PILOT BLOCKER** | The reservation-release component is the C3 defect (B2-D11) and is a blocker. The cancellation-payment model and recording the cancelling party are not defined by the owner and are not invented: these two components are PROPOSED DEFERRAL pending an owner rule. | Same fix as B2-D11; owner supplies the payment and cancelling-party rules. |
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
| B5-R5 | PARTIAL | **PILOT BLOCKER** | Same F6 defect as B2-D20: a started, unvisited reservation is missing from 'Scheduled ahead'; the page has no column named Verified or Reserved. A billing-facing figure must reconcile. | Same fix as B2-D20, then label columns. |
| B5-R7 | PARTIAL | **PILOT BLOCKER** | The known inaccuracy (F6) is not flagged on screen, and the full-chain report (B5-R13) is incomplete. Unresolved balances must not be presented as verified. | Fix F6 or flag it on screen; finish B5-R13. |
| B5-R8 | PARTIAL | **PILOT BLOCKER** | Least privilege with real data: any holder of `visits.read` can export a CSV, built in the browser, with no export permission and no export audit event (`service-verification-reports-page.tsx`). Findings about this gap were recorded earlier and are unchanged. | Add an export permission and an audit event; build exports server-side. |
| B5-R9 | UNVERIFIABLE | **PROPOSED DEFERRAL** | Cannot be verified from the repository: it asks for a mobile Board 5 view; needs the owner's mockup review. | Owner reviews the mockup. |
| B5-R11 | PARTIAL | **PILOT BLOCKER** | Same F6 defect as B2-D20. | Same fix. |
| B5-R12 | MISSING | **PROPOSED DEFERRAL** | Uncovered shifts, cancellations, missed visits and utilization need owner definitions (R6) before numbers can be trusted. Not in the directive's core pilot list. | Owner defines metrics. |
| B5-R13 | PARTIAL | **PILOT BLOCKER** | The directive requires an audit-ready monthly report that explains the chain (authorized, scheduled, worked, confirmed, Billing Ready, approved, submitted). Gap list G12: no scheduled, worked, confirmed or Billing Ready columns and no balance check in one report; export concerns as B5-R8. | Build the full-chain monthly report (G12), after F6. |
| B5-R14 | PARTIAL | **PROPOSED DEFERRAL** | Corrections and supporting records are stored and queryable; there is no general audit screen (G14, P1 in the gap list). Until it exists, audit evidence is produced on request by an authorized person with database access. | Audit log screen with role limits. |

## What I could not establish

- Whether the owner treats the pilot as synthetic-data only or with real clients. If real clients, B5-R8 and the real-device test are firmly blockers; if synthetic only, they remain blockers for the first real-data day.
- Real AWS behaviour, deployed triggers, and TEST: nothing here was run there. Every "tested" statement refers to local tests on a disposable PostgreSQL and a local Chromium on synthetic data.
- Legal and payer requirements for work hours, hold rules and notifications were not verified; owner-defined rules are described as owner-defined.

