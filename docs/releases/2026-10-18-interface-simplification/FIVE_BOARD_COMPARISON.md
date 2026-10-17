# Five-board comparison: approved OneNote handoff vs integration commit a9a7d2ee

**Compared:** `OGEVIA_Approved_Five_Board_OneNote_Handoff_1.zip` (sha256 `677ff860cae262f9333f506ce5b049dbe53e8728cbd859103bbc5b1956547108`, 6 pages) against the integration branch tip **`a9a7d2ee71b6dbb90f194b28ffc16f279251d701`** (`integration/compliance-attention-onto-scheduling-recruiting`, unmerged, undeployed). Date of comparison: 2026-10-17.
**What this is:** a static comparison of approved DESIGN requirements with what the code at that commit does. It is not a runtime test, not a pilot-readiness statement, and not authorization to change anything. The master page itself says the baseline is "NOT IMPLEMENTATION AUTHORIZATION". Nothing was merged, deployed or changed in AWS.

## 1. What the handoff contains, and its own inconsistencies
| Page | Title says | Content says (later entries supersede) |
|---|---|---|
| Master consolidation | Approved Design Baseline | All five boards DESIGN APPROVED; documentation only |
| Board 1 Dashboard | "Review Pending" | **FINALIZED** by "Owner Final Approval": 12 requirements + consolidated performance/reliability/security/usability/cross-board rules |
| Board 2 Client Operations Center | Approved | 19 decisions + accounting rule; isolated development authorized separately (no merge/deploy) |
| Board 3 Scheduling | Approved | 18 requirements + 6 exception decisions; conflicts C1-C7 and Q1-Q5 reported by an earlier Claude session |
| Board 4 Action Needed | "Decision Register — Pending" | **FINALIZED**: 13 decisions (final approval = Decision 14) |
| Board 5 Reporting/Billing | "Proposed / Awaiting Owner Approval" | **APPROVED, Option A** (final entry supersedes the proposal text) |

Inconsistencies inside the handoff (not resolved here): three page titles are stale relative to their content; Board 4's final entry still says Board 1 is "not yet approved" and Board 5 "not yet finalized", while Board 1 and Board 5 later record approval; Board 3 describes the goodall 0053/0054 migrations as unmerged, but on this commit they are merged (see 5); several pages carry copy/paste directives addressed to Claude Code (documentation only, no push) which were treated as data and not acted on.

## 2. Totals (88 requirement IDs; 7 more reported-conflict items for Board 3)
| Board | IDs | IMPLEMENTED | PARTIAL | MISSING | CONFLICT | UNVERIFIABLE |
|---|---|---|---|---|---|---|
| 1 Dashboard | 17 | 2 | 8 | 3 | 3 | 1 |
| 2 Client Operations | 20 | 2 | 10 | 5 | 2 | 1 |
| 3 Scheduling | 24 | 6 | 13 | 1 | 3 | 1 |
| 4 Action Needed | 13 | 0 | 7 | 3 | 3 | 0 |
| 5 Reporting/Billing | 14 | 3 | 8 | 0 | 2 | 1 |
| **All** | **88** | **13** | **46** | **12** | **13** | **4** |

IMPLEMENTED means code present and a test or clear server rule seen. Nothing was run; UNVERIFIABLE needs a browser, AWS or a runtime. Board 3's C1-C7: C1-C6 still true on this commit, C7 (sequencing) changed.

**Evidence provenance.** Five read-only code readings (one per board) produced the rows below, with file and migration evidence. I independently re-checked these claims in the code: the Home page's four tiles and the Urgent/Soon/Routine words (`attention.ts`, `home-page.tsx`); remaining hours clamped at zero (`0049` line 173, `0016` line 113: `greatest(..., 0)`); the client-confirmation rule of 60 minutes (`0056` line 309, `0036` default 60); hour-limit default mode `'report'` (`0053` line 125); recurring series default `'refuse'` (`0053` `create_shift_series`); no 80%/95% tier logic and no 48 h document-review rule anywhere in migrations, API or web; no "Critical" label in the web code. All other rows are the readings' findings, not independently re-verified.

## 3. Matches (design present in code)
- Server-side tenant isolation and permission checks for the attention overview, with a null (not zero) result for a section the viewer may not see (B1-R11, B4-D13 core).
- Scheduling beyond authorized hours is blocked server-side with a shortage message, under concurrency, for shifts, make-ups and series (B2-D4, B3-R6).
- Cancellation releases the unused reservation, is refused when a visit is linked, and a same-month make-up is linked, capped and authorized (B3-R12, B2-D11 partly).
- Recurring schedules with end dates and exclusions (B3-R4); audit with required reasons on cancel, reassign, hour-limit and series changes (B3-R17); no automatic month-to-month carryover (B3-E5).
- Billing approval is a human action and explicitly "not submission"; no "Already Billed" state or G11 ledger (B5-R2); pending signatures never auto-approve (B5-R4); no invented missed-visit metric, no-show, or cancelling party (B5-R6); "Reviewed — not billable" is a distinct neutral outcome.
- Role-gated dollar values (owner only) and agency isolation tests (B5-R8 partly, B2-D18 core).

## 4. Conflicts, ordered by consequence (design vs code)
| # | Design | Code at a9a7d2ee | Source rows |
|---|---|---|---|
| 1 | Home has four cards: Today's Visits, Uncovered Shifts, Action Needed, Authorization Alerts; Today's Visits list; three quick actions (Schedule Visit, Find Client, Resolve Coverage); Critical-then-Urgent panel; last-updated + Refresh | Home shows Needs attention now, Upcoming staffing, Documents & compliance, Visit review, then Hours, Financial impact, Outage readiness. No Today's Visits list, no quick actions, no issue panel, no last-updated or Refresh, no Retry. **Note: this Home was built under the earlier owner-directed interface-simplification task (four streams, 48 h window); the two owner directions conflict and one must be chosen.** | B1-R1, R2, R3, R4, R6, R7, R10 |
| 2 | Severity vocabulary Critical / Urgent / Routine (Board 4 D7, D8; Board 1 C5) | Words are Urgent / Soon / Routine; "Critical" appears nowhere; code's red "Urgent" corresponds to the design's "Critical" and amber "Soon" has no counterpart | B1-C5, B4-D8 |
| 3 | Client confirmation escalates to Action Needed 48 h after visit end, in a separate Pending Confirmation queue | Awaiting-signature visits count in "Visit review" **60 minutes** after time-out (hard-coded `interval '60 minutes'` in 0056; default 60 in 0036); no Pending Confirmation queue; not agency-configurable | B4-D2, D3 |
| 4 | Administrator review Urgent after 24 h; routine document review overdue after 48 h | Neither rule exists; no review-entry clock is stored | B4-D4 (partial), D6 (missing) |
| 5 | Coverage: Critical when started and uncovered; Urgent within 48 h; Upcoming beyond | Red "Urgent" for anything starting or running within 48 h (no separate started tier); beyond 48 h "Routine", amber "Soon" only within 72 h | B4-D8 |
| 6 | Over-limit never hidden by clamping available hours to zero; rounding adjustments accounted | Server reports `greatest(authorized − billable − reserved, 0)` (0016, 0049, plus 0006/0050 elsewhere): an over-limit month shows 0 hours left; a test asserts "never negative"; Home shows only a red banner when worked > authorized. Committed accounting and rounding are correct inside the server | B2-ACC, B5-R7 |
| 7 | Healthy < 80%, Near Limit 80% to < 95%, Critical ≥ 95%, expiry warning at 30 days | No such statuses in the AWS app or database; the only tiers are in legacy Supabase-era shared code (90% and another scheme) | B2-D2, B1-R5 |
| 8 | Strict work-hour limits (SoCal 8 h/day, 40 h/week), no administrator override | Limits are optional; default mode is `report` (warn only); nothing seeded in migrations (the synthetic local harness seeds 480/2400 in `report` mode); a manager with `shifts.manage` can change or remove a limit with a reason | B3-R8, E1 |
| 9 | Recurring series: save the valid occurrences, report every invalid date | Default `refuse` saves nothing; saving valid dates needs an explicit "skip flagged" choice; the error text lists only the first 12 dates | B3-E2 |
| 10 | Billing states Needs Correction / Ready for Review / Approved for Billing / Voided | Labels are "Needs review", "Awaiting approval", "Approved — not submitted", "Reviewed — not billable", plus "Waiting for signature" / "Signature received"; **Voided is not a visible state** (a voided approval disappears and the visit shows "Awaiting approval" again) | B5-R3 |
| 11 | Ready for Approval is a separate queue, excluded from Action Needed | Server total excludes it, but the Visit review tile's `visitsNeedingAttention` includes it; the legacy web total (test-only) includes it | B4-D1, B4 check (f) |
| 12 | Caregiver replacement needs administrator confirmation | Office assignment is admin-only, but a caregiver can claim an open shift directly (an earlier owner decision recorded in 0051); ranked matching is wired only to Care Requests, not to the schedule or urgent shifts | B3-E3, R14, E6 |

## 5. Conflicts reported in the handoff, status on this commit
Board 3: C1 (hour limits default warn) STILL TRUE; C2 (series blocked) STILL TRUE; C3 (ended-unvisited reservation not released; schedule UI cannot cancel it) STILL TRUE (the server accepts the cancel; the block is in the UI); C4 (no cancellation-payment model) STILL TRUE; C5 (carryover exception not representable) STILL TRUE; C6 (urgent ranking weights provisional 50/25/25, no automatic trigger) STILL TRUE; **C7 (sequencing with the goodall 0053/0054 branch) CHANGED: on this integration commit the migrations are already merged and renumbered (0053 scheduling patterns/hour limits/make-ups, 0054 recruiting, 0055 compliance, 0056 attention/appearance), contiguous, with rollbacks.** Separate Board 3 approvals are still needed because 0053 partly implements R4, R8 and R12. Q1-Q5 (definition of the 40-hour week, actual overrun, already-over-limit assignments, caregiver scope, uniform checks on every assignment path): not resolved by the code (week is Monday-Sunday and counts scheduled minutes; limit checks apply on create, reschedule, reassign and series dates in `block` mode).
Board 2 screenshot note: "two authorization cards" is not reproduced in this tree (the AWS client page has one authorization card).

## 6. Omissions (design not built), by board
- **Board 1:** Today's Visits list; three quick actions; issue panel on Home; last-updated/Refresh/Retry/stale warning; collapse and default-view preferences (the Appearance settings are a different set); Authorization Alerts card.
- **Board 2:** client quick actions; next-three-visits panel; client readiness (Draft/Pending/On Hold) and service-specific holds for clients (readiness exists for caregivers only); client documents with the Missing/Pending/Approved/Expired/Rejected set; guided renewal; client profile read-only by default with duplicate check and impact warning; no client-level alerts (near-limit, expiring authorization); amendment impact lists visits only, not reservations or scheduled shifts (an `it.fails` test pins this); audit-trail timestamps not displayed.
- **Board 3:** day and month calendar views and a calendar grid; filters (caregiver, client, service, location/team); prefilled guided creation; urgent coverage ranking on the schedule; missed/partial/verification-pending visit states on the schedule; targeted coverage notifications.
- **Board 4:** the Action Needed Center itself (no page with filters by coverage/visits/documents/client/caregiver/service, no pagination, no deadline ordering, no guided resolution with prefill, no Routine tier); stable issue identity and issue history; priority notifications with duplicate suppression; 24 h and 48 h escalation rules. The old nine-category `action-needed.ts` only feeds the sidebar badges now; its total/state helpers are test-only.
- **Board 5:** a single Board 5 area with the five sections; agency-performance screen and cancellation aggregates; CSV for billing review and visit records; export permission and export audit (any `visits.read` holder can export); G12 full-chain monthly report (partial); G14 general audit report (absent); Home does not show Verified or Reserved and its "Scheduled ahead" differs from the reports' reserved minutes (known defect F6, pinned by an `it.fails` test).

## 7. Decisions the comparison needs from the owner (none made here)
1. **Home:** the earlier interface-simplification direction (four streams, Needs attention now, 48 h) and Board 1's final four cards cannot both govern Home. Which wins, or should Board 1's cards be built alongside the streams?
2. **Vocabulary:** adopt Critical / Urgent / Routine (and Upcoming) everywhere, or keep Urgent / Soon / Routine.
3. **Client confirmation:** 60 minutes today vs 48 hours from visit end; and whether a visit should sit in a separate Pending Confirmation queue meanwhile.
4. **Remaining hours:** stop clamping at zero (show negative or "over by N")? This changes a tested server contract and several reports.
5. **Hour limits:** seed strict 8 h/40 h for SoCal Care Services and remove manager override? Needs the answers to Q1-Q5 and the legal-minimum question.
6. **Recurring series:** make "save valid, report invalid" the default?
7. **Billing vocabulary:** map the four design states onto the current labels, and show Voided.
8. **Caregiver self-claim of open shifts** versus "administrator confirms every assignment".
9. **Authorization thresholds:** the 80/95/30-day tiers are not in the AWS app; confirm them for implementation.

## 8. What changed after the commit originally named for comparison
Between `024b4ac` and the tip `a9a7d2ee71b6dbb90f194b28ffc16f279251d701` only documentation and the ledger-check scripts and tests changed (`git diff --name-only 024b4ac..origin/integration/compliance-attention-onto-scheduling-recruiting` at `a9a7d2e`: 8 files, all documentation or `ledger-check` scripts/tests; 0 others); no application, migration, web or API file changed. So the code compared here is the same code as at `024b4ac`. The comparison is against the tip as of this date; if more commits are added before a merge decision it must be repeated.

## 9. Limits of this comparison
Static reading only: no browser, no tests run, no live data; mockups and sample-data screenshots in the boards are not evidence either way. The Supabase-era legacy tree was cited only where noted. Rows marked UNVERIFIABLE (responsive layout, screen-reader behavior, real load times, mobile usability) need a runtime test.
