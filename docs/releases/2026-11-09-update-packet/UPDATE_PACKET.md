# Ogevia update packet: combined detail list (before cleanup starts)

Prepared 2026-11-09 for the owner. Status words follow CLAUDE.md section 0: **proposed**, **implemented**, **tested**, **deployed**. Implemented never means deployed.

Evidence labels: **VERIFIED** (seen in code, the running demo, or the owner's live screenshots), **INFERRED** (reasoned from evidence, not observed), **UNKNOWN** (not checked).

## 0. Baseline and how this list was produced

| Fact | Evidence |
|---|---|
| The live app (app.ogevia.com) does not run `main`. Owner screenshots show readiness item "App sign-in", Staff / Staff Types, Scheduling, Operations, Business Compliance. These exist on branch `claude/practical-tesla-r07odb` (186 commits ahead of `main`, migrations through 0088), not on `main` (migrations through 0085). | VERIFIED (screenshots vs branches) |
| The exact deployed commit is not known. | UNKNOWN. Needed first (R1). |
| The live site could not be opened from the working environment (ogevia.com was blocked, then allowed; sign-in needs an account). Two sources were used: (a) the repo's local demo harness (synthetic data, repo build, not production), and (b) five owner screenshots of the live app. | VERIFIED |
| Demo walk covered: owner and manager desktop, caregiver at phone width through Start, End, Confirm. Not covered: manager screens on a phone, signature drawing and submit, the "unable to confirm" path, a live click-through. | VERIFIED |

Sources outside the repo: [CalEVV alternate EVV guide](https://dhcs.ca.gov/provgovpart/Documents/CalEVV-User-Guide-for-Alternate-EVV-Providers.pdf), [EVV Phase II webinar](https://www.dhcs.ca.gov/provgovpart/Documents/EVV-Phase2-webinar.pdf), [DDS EVV page](https://www.dds.ca.gov/services/evv/), [DDS EVV RC service codes guidance (2022)](https://www.dds.ca.gov/wp-content/uploads/2022/07/EVV_RC_Service_Codes_Guidance.pdf). The service-code lists are from 2022 and must be confirmed with the regional center.

## 1. Already built this session (not deployed)

| ID | Update | Status | Detail |
|---|---|---|---|
| U-01 | App sign-in no longer blocks approval, assignment to clients, or scheduling | **Implemented and tested locally; not applied to any database** | Pending migration `infra/aws/db/pending/migrations/0089_signin_followup_not_hard_requirement.sql` (sign-in row becomes kind `followup`; background check and required training stay hard; CPR/TB stay flexible; sign-in stays visible as outstanding). Rollback in `pending/rollback/`. New test `db/test/signin-followup-0089.db.test.ts`. Web type and fixtures updated. Full infra DB suite 102 files / 1,127 tests pass; web 130 files / 1,266 tests pass; typecheck and lint clean. Commit `84bdc78` on `claude/compassionate-thompson-jk5ozb`. **Until the migration is released, caregivers like Ariel Woollard stay blocked.** Release is an owner-approved step: checklist, snapshot, TEST before Production, re-pin the migration set; extra test updates are listed in `pending/README.md`. |

## 2. Decisions needed from the owner

| ID | Decision | Recommendation |
|---|---|---|
| D0 | Which branch and commit is deployed to app.ogevia.com and to TEST? | Confirm before any other work (R1). |
| D1 | Direction: schedule-first agency suite, or keep the verification, reconciliation and billing-readiness core? | Schedule-first only for what the current subscriber uses daily. |
| D2 | Billing status of a manager-entered past visit. | Always route to review; never auto Billing Ready; flag as staff-entered, distinct from a client signature. |
| D3 | Release U-01 (migration 0089): when, and through TEST first. | Release with the next TEST cycle. |
| D4 | Excel import: approve a new library, or CSV only? | CSV first. CLAUDE.md requires approval for new tools. |
| D5 | Where the visit-review queue lives (brief puts it under Reports). | Reach it from Dashboard Action Needed and keep it next to Billing. |
| D6 | CalEVV: pursue Alternate EVV certification, import from CalEVV, or keep two logins with a shorter Ogevia step? | Ask Sandata and DDS first (see K); decide after their answer. |
| D7 | Caregiver-facing client label (initials or nickname) in place of the CL-xxxx code. | Owner-chosen label, privacy-reviewed. |

## 3. Release baseline and verification (do first)

| ID | Item | Status |
|---|---|---|
| R1 | Match the live release to a branch, commit, migrations, and role permissions. | Proposed. Blocks everything. |
| R2 | Dashboard shows "The list of items that need action could not be loaded" with Needs attention at 0, and the Notifications button shows "?" instead of a count. The failed-load message is correct (it says it is not shown as empty). The cause, the endpoint failing, is not known. | VERIFIED symptom from screenshots; cause UNKNOWN. Check Lambda logs for the actions and notifications endpoints. Likely one shared cause (INFERRED). |
| R3 | Dashboard charts "Hours available to schedule" and "Billing and potential value" render as solid dark-blue blocks, not charts. | VERIFIED in screenshots; cause UNKNOWN. Reproduce on the matching build. |
| R4 | Confirm live access for Reconcile shifts ("No service was delivered") and Outage records for manager and admin. Both exist in code. | Proposed. |
| R5 | A second Business Compliance count: "6 need review" on the dashboard. | VERIFIED in screenshots; unexplained. Review what the six items are. |

## 4. Fix-first blockers

| ID | Item | Evidence | Size |
|---|---|---|---|
| B-01 | Help overlay blocks Care Request fields and sometimes needs a second click to close. Root cause: `InfoTip` (`apps/web/src/aws/ui/info-tip.tsx`) shows its panel from click state **and** CSS hover and focus-within. Closing by click leaves the button focused, so the panel stays visible. It also floats over the form. Fix: click state only, close on outside-click and Escape, render Care Request help inline above the fields. | VERIFIED in code (`main`; re-check on the live branch) | S |
| B-02 | Care Request "Send link" access while help is open, tested on desktop, touch, keyboard, narrow screens. | Proposed | S |

## 5. Caregiver app (phone)

| ID | Item | Evidence | Size |
|---|---|---|---|
| C-01 | Simplify Start: show scheduled visits first; hide clients with "0 active services"; remove the three authorization numbers and the "Reserved" paragraph (office concern). | VERIFIED in demo | S-M |
| C-02 | Caregiver-facing client label in place of CL-xxxx (see D7). | VERIFIED in demo | S |
| C-03 | Alert the office the same day for a missed Time Out. | Not in current plan | M |
| C-04 | Keep what works: 3-step bar in English and Spanish, no sideways scroll, server time stamps, refresh keeps the open visit, minimum one minute before End, required reason for an unscheduled visit, "Unable to obtain confirmation" fallback. | VERIFIED in demo | n/a |
| C-05 | About 8 taps for an unscheduled visit (client, reason, Start, End, signer, sign, attest, Confirm). Fewer for a scheduled visit. Keep unscheduled visits rare. | VERIFIED in demo | n/a |

## 6. Manager and owner interface

| ID | Item | Evidence | Size |
|---|---|---|---|
| M-01 | Navigation: the brief proposes Dashboard, Schedule, Clients, Care Team, Reports, Billing, Settings. The live app shows Dashboard, Clients, Staff (Caregivers, Staff, Staff Types), Scheduling, Operations (Reports, Billing), Settings (Roles & Permissions, Agency Settings, Business Compliance). The repo demo (main) has about 17 entries. Reconcile against the live branch, then choose the final structure. Test direct URLs and bookmarks. | VERIFIED (screenshots, demo) | M |
| M-02 | Too many overlapping badges and counts in the demo (Needs attention, Notifications, Schedule, Approvals, Visits to review, Visit review). One definition per number. | VERIFIED in demo (`main` build) | M |
| M-03 | "Verify visit" is in the manager menu in the demo (`main` build). Confirm on live; move or remove. | VERIFIED in demo | S |
| M-04 | Reports: eight reports in one dropdown, including Visit records and Action needed. Open Visit records directly; keep aggregate reports under Reports. Date range as one dropdown. | VERIFIED in demo; matches the Oct 3 UX change list | M |
| M-05 | Billing review: one Approve button per visit, no select-all. Add "Approve all clean visits", keeping the authenticated human approval. The Amount column showed a dash for every row even for the owner while Home showed a billable value: check whether amounts appear only after approval. | VERIFIED in demo | M |
| M-06 | Visit list per the Oct 3 UX list: status beside client and date, no horizontal scroll on phones, short visit ID, Used this month, Hours left, Actions dropdown, Show replaced records, printable client service calendar. | Proposed (from `docs/product/OGEVIA_UX_CHANGE_LIST.md`; status of each item on live unknown) | L |
| M-07 | Manager screens on a phone were not tested. | UNKNOWN | S |
| M-08 | Keep what works: MANAGER VIEW / OWNER VIEW label with the person's name, Needs action first with a plain next step per row, TEST banner, one-line Today. | VERIFIED | n/a |

## 7. Scheduling workspace

| ID | Item | Status |
|---|---|---|
| S-01 | Roster as the main scheduling surface. Pick a caregiver once, select several exact shifts across clients, open a right-side Assign panel (client, service, date, times, current caregiver), explicit recurring option. | Proposed. Largest item. Checks before save: agency scope, authorization, readiness, service, availability, duplicates, overlap; per-shift result; safe retries; no stray ongoing assignment if a shift fails. |
| S-02 | A client can have several caregivers; reuse an existing assignment; one-time coverage applies only to the selected shift. | Proposed |
| S-03 | Coverage report: rolling Next 30 days (agency time zone), Calendar month, Open shifts only. | Proposed |
| S-04 | Action Needed counts uncovered shifts in the rolling 30 days; the month picker never changes that count; farther shifts show in Coverage planning as Upcoming. | Proposed. Tests: month and year boundaries, just inside and outside the window, a since-filled shift, a failed load. |
| S-05 | "Where we need staff": open shifts versus eligible caregiver supply by location and service. **Count only approved or active, ready caregivers** (today "Current" means "not inactive", so it includes applicants and people still onboarding). Show unknown location or availability as unknown. | Proposed. Not built. |
| S-06 | Active-caregiver default in staffing views, reports, and assignment pickers; Include inactive option; keep history. | Proposed |

## 8. Care Team

| ID | Item | Status |
|---|---|---|
| T-01 | One Care Team list (name, work status, next shift, missing requirements, Assign) with a side panel: Onboarding, Documents, Scheduling. One source for readiness and document status. | Proposed. The live page already shows a readiness checklist (Background check, Required training, App sign-in, CPR, TB, Approve) and Clients assigned. |
| T-02 | Intake form layout: identity and contact first, start-of-care or hire date in the opening section; question beside its action on wide screens, stacked on narrow. | Proposed |
| T-03 | Admin exception for first sign-in. | **Superseded by U-01** (the owner chose to remove the requirement instead). |

## 9. Care requests and visit recovery

| ID | Item | Status |
|---|---|---|
| V-01 | Expired shift with no care delivered: "No service was delivered" with a note, releases reserved authorization. | Exists in code (R4: verify access and reporting live). |
| V-02 | Care happened but no visit record: manager records a past visit from an expired shift or an impromptu visit. Capture client, caregiver, service, actual date and times, reason, evidence, who entered it; link the original shift; handle overnight; block duplicates if a clock-in or paper form later appears; paper signature evidence or a reason plus a later signature request; staff exception distinguishable from client signature. | **Gap.** No manager "record a past visit" path found; the only unscheduled start is caregiver real-time. Depends on D2. Reuse existing signature-recovery and audit machinery. |
| V-03 | Paper outage records: numbered forms enter review with zero billable minutes. Verify the live feature matches the agency's paper workflow, and whether a missed clock-in can be entered without a numbered form. | Exists in code; verify (R4). |
| V-04 | Dashboard shows 10.5 h reserved on shifts with no visit record ("Reconcile shifts" link, screenshot 2). Confirm these are real expired shifts and clear them with V-01 or V-02. | VERIFIED in screenshots |

## 10. Bulk imports (demand-gated)

| ID | Item | Status |
|---|---|---|
| I-01 | Import clients and Import caregivers: templates, sheet selection, header mapping, preview, validation, possible duplicates, row results, safe retry (batch idempotency key), tenant-scoped, no personal data in logs, synthetic test files. Caregivers default to Onboarding. Same business rules as manual entry. | Proposed. Do when a second agency is about to onboard. The only existing CSV code is a parser inside the candidates page. |
| I-02 | Excel (.xlsx) support needs a new library. | Needs D4. |

## 11. CalEVV track (separate from cleanup)

| ID | Item | Status |
|---|---|---|
| K-01 | Confirm which services and exemptions apply to SoCal Care Services with the regional center (service codes in the DDS guidance are from 2022). | Proposed |
| K-02 | Ask Sandata Alternate EVV support and DDS: certification requirements, timeline, cost, and whether CalEVV or the Aggregator can export visits for import. Contacts from the guides (confirm first): CAAltEVV@sandata.com, 1-855-943-6069, EVV@dds.ca.gov. | Proposed. No build until answered. |
| K-03 | There is no way to share a login between Ogevia and CalEVV. Options: A (Ogevia becomes an Alternate EVV vendor, one login, needs certification and location capture; PRD currently says no GPS), B (caregivers use CalEVV only, Ogevia imports), C (keep both, shorten the Ogevia step). | Decision D6. |

## 12. Process

| ID | Item |
|---|---|
| P-01 | Add a note to CLAUDE.md or the release record stating which branch is the deployed line, so work stops being based on a stale `main`. |
| P-02 | Every change follows `docs/TESTING_AND_RELEASE_PROCESS.md`: lint, typecheck, test, local harness, pilot validation, owner GO. |

## 13. Recommended order

1. **Baseline:** D0 and R1, then R2 and R3 on the matching build.
2. **Fix first:** B-01, B-02, and the release decision for U-01 (D3).
3. **Cleanup that is cheap and visible:** M-01 to M-05, C-01 and C-03, S-06.
4. **Scheduling workspace:** S-01 to S-05 and T-01, T-02.
5. **Manual past visit:** V-02 after D2.
6. **Imports:** I-01 when a second agency is close.
7. **CalEVV:** K-01 and K-02 run in parallel from now; K-03 after the answer.

## 14. Limits of this packet
- Not a click-through of the live app. No production data or accounts were touched. Nothing here is deployed.
- Several M and C items were seen in the repo demo (`main` build). The live build differs, so each needs re-checking on the matching build (R1).
- Effort sizes are rough (S/M/L) and have not been estimated with the team.
