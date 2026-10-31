# Phase D user acceptance scripts: release 2026-10-30-caregiver-readiness (migration 0086)

**Status: DRAFT. NOT RUN. NOT AUTHORIZED TO RUN.** Phase D runs on the **TEST/pilot slice** (owner decision D1; designation in `DECISION_RECORD.md` A1) **after Phase C is complete**. Phase C has not started: the window is not set and no GO has been given. Nothing in this file may be run against any shared environment until the owner's written GO and the Operator (Stella Okereke) confirms the environment. Template: `docs/release-process/RELEASE_CHECKLIST_TEMPLATE.md` section D. Test IDs: `FEATURE_TEST_PLAN.md` (RDY-01 to RDY-17) and `docs/release-process/ACCEPTANCE_TEST_CATALOG.md`.

## 0. Rules for every validator
- **Synthetic data only.** No real caregiver, client or payer, no real PHI. The sign-in pool may be **shared with production**: never disable, change or invite a real person's account. Use only the synthetic people created in section 1.
- Use **your own sign-in**. Do not share passwords. Never write a password, token or invitation code into this document.
- A step is **PASS** or **FAIL**. A step you cannot perform is **BLOCKED** with the reason (never "N/A" without the owner's agreement).
- Take a screenshot for every FAIL and for the steps marked 📷. Name it `<step>-<validator>.png`; store under `docs/releases/2026-10-30-caregiver-readiness/evidence/uat/`. No passwords or tokens in screenshots.
- **Stop at the first Blocker** (a wrong balance, a cross-agency view, a caregiver who can reach office data, a step that changes data it should not). Tell the Operator at once. Do not continue.
- Defect classes: **Blocker** (wrong money/hours/access/data, security), **Major** (a workflow fails or misleads; needs a written owner exception to ship), **Minor** (wording, layout). Acceptance requires **no open Blocker** and **no open Major without a written owner exception**.
- The Operator and a second person are available to answer "is this expected?"; do not guess.

## 1. Data preparation (Operator and Owner, through the screens; before any validator starts)
Record the actual names/codes you create in the table; validators use these. **Designated test inbox for P1 "UAT Ready" (owner's message 2026-10-31; the address is deliberately not stored in this repository).** It must be confirmed before use: (a) the owner controls the mailbox, (b) the address has no existing Ogevia or Cognito account in the shared pool (a collision could attach the invitation to a real identity), (c) it is used for one synthetic caregiver only. Created in the UAT data-prep step through the screens (Care Team, Add caregiver), in the organization that holds the synthetic Owner, not before Phase C is complete. General rule: Mailbox: a test inbox the Operator controls (for example `uat.<name>@<domain you control>`); **it must receive real Cognito email** (that is part of the test).

| Ref | Person (synthetic) | How to create it (screens) | Expected state afterwards |
|---|---|---|---|
| P1 | **UAT Ready** | Care Team, Add caregiver (Onboarding). Open the record: set the hire date to 3 days ago with a reason. As the administrator, Verify the background check (Approved, evidence note). Mark required training done. Add the test inbox as email and **Send sign-in link**; the person signs in once from the email (P1 is also the Caregiver validator's login, see 4) | Not ready, 3 of 5 done; CPR and TB "Not uploaded · due <hire+30>"; Approve for work **enabled** |
| P2 | **UAT NoEmail** | Add caregiver (Onboarding). Hire date 10 days ago. Verify background check, mark training done. **Do not** add an email | Not ready, 2 of 5; "No email on file"; Approve **disabled**, "Waiting on: App sign-in" |
| P3 | **UAT Overdue** | Add caregiver. Hire date **40 days ago** (agency rule 30 days; check the agency value first: section 3, RDY-08). Verify background check, training done, sign in once (own test inbox) | CPR and TB "overdue since <date>"; each says whether it blocks new shifts or is flagged only |
| P4 | **UAT Legacy** (only if the TEST database already has a caregiver who was Ready or Active before 0086) | Do not create: use an existing synthetic one | Shows **Active** or **Approved** (backfilled as legacy), not "Not ready" |
| P5 | A synthetic client with an authorization that is **low use**, one **near limit**, one **recently amended** | Clients, Authorizations (Add, Amend) | For the Authorization validator, section 5 |
| P6 | Accounts for the validators | Owner = an administrator; Scheduler = a scheduler; Caregiver = P1 | Each can sign in |

Record before starting (read-only, Operator): the migration ledger (`max = 0086`), the count of caregivers whose stored status is Ready/Active, and the count of `legacy_status` approvals (they must be equal).

| Ledger | Ready/Active count | Legacy approvals | Equal? | Recorded by / time |
|---|---|---|---|---|
| | | | ☐ | |

## 2. Owner (Administrator), desktop 1280 px
| Step | Test ID | Action | Expected | Result | Evidence / notes |
|---|---|---|---|---|---|
| O1 | RDY-09, RDY-16 | Open Care Team, Status filter = All | Every caregiver shows Not ready, Approved, Active or Inactive. The words "Pending documents" and "Compliance clearance" appear nowhere. People not ready show "n of 5 done" 📷 | | |
| O2 | RDY-09 | Open Accounts | The same people show the **same status**; second line "Sign-in account: …"; people not signed in show Add email / Send sign-in link | | |
| O3 | RDY-16 | Open P1's page | One checklist: Background check, Required training, App sign-in, CPR certificate, TB clearance, then Approve for work. **No** Compliance, Onboarding, Status or second Name section. Documents is a plain file list | | |
| O4 | RDY-11 | On P2's page open Background check | One record: Verified by whom and on what date. There is no second, conflicting "Recorded" date | | |
| O5 | RDY-01 | Create **UAT NoBg**: Add caregiver, hire date, training done, add email, sign in, but **no background verification**. Try Approve | Approve disabled: "Waiting on: Background check". Via **any** route the server refuses (do not try to force it; the Operator checks the API: 409 "Cannot approve yet. Waiting on: Background check") | | |
| O6 | RDY-01 | As Owner, mark the background check "Completed" only (process status), then "Not approved" with a note | Approve stays disabled both times. Only Approved + verified opens it | | |
| O7 | RDY-02 | On P2 (no email, never signed in): try Approve | Disabled, "Waiting on: App sign-in". Add email, send link, **do not** sign in: still disabled ("Invited, has not signed in yet"). After the person signs in: enabled | | |
| O8 | RDY-03 | On a caregiver with background and sign-in but **no training**: look at Approve | Disabled: "Waiting on: Required training". Mark done: enabled | | |
| O9 | RDY-04 | On P1: **double-click Approve** quickly | Status becomes **Approved**; "Approved <time> by <you>"; the Approve button is gone. Open the page again: one approval only. 📷 | | |
| O10 | RDY-05 | On P1 (hired 3 days ago, no CPR/TB) before approving | CPR and TB: "Not uploaded · due <hire + agency days>" as warnings; **they do not block Approve** | | |
| O11 | RDY-07 | On P3: Extend CPR to a date 14 days ahead. First leave the reason empty, then fill it | Without a reason: the form says so, nothing saved. With a reason: CPR shows the new due date and is no longer overdue; **TB is still overdue** | | |
| O12 | RDY-07 | Reopen P3: look at who/when | The extension is recorded (who, when, reason, old and new date) in the history; audit shows it | | |
| O13 | RDY-06 (**optional, state change**) | Only if you, the owner, approve switching enforcement **on** for TEST (read the Readiness screen first: it says whether it can be undone). On P3 try to create a new shift as the Scheduler (see S4) | Enforcement ON: refused "CPR missing / TB missing". Enforcement OFF: allowed and flagged | | |
| O14 | RDY-08 | **No screen exists for the agency CPR/TB due-days setting** (API only). The Operator reads `GET /v1/compliance/settings` with an administrator token | `cprTbDueDays` is the agreed value (default 30). **Gap for the owner to decide:** is an API-only setting acceptable, or does it need a screen? | | |
| O15 | RDY-10 | Compare with the figures recorded in section 1 | Every caregiver who was Ready/Active before the release shows Approved or Active; **none** was deactivated; the schedule still lists their shifts | | |
| O16 | RDY-12 | On P2: Add email (your test inbox), **Save and send sign-in link** | Row reads "Invited, has not signed in yet" and "Last sent <time>". **The address is not shown anywhere on the page.** Press Resend at once: refused ("just sent … wait a minute"). Wait a minute: Resend works | | |
| O17 | RDY-12 | In the test inbox | **One** message from the sign-in service per send. It contains **no client or health information** (read it). 📷 (redact the temporary password) | | |
| O18 | RDY-15 | Repeat O1 and O3 on a **phone** (390 px) | One column, no sideways scroll, every button easy to press | | |
| O19 | SMK-01, SMK-02 | Sign in; open Home | No error screen; hours cards and Action needed render, no "Unable to check"; the Notifications badge and the Home "View all" number are equal | | |
| O20 | USR-01 | Open every menu item | None shows an error screen; **Authorization changes** renders its list (it crashed before the D1 fix) | | |

## 3. Scheduler (office, desktop)
| Step | Test ID | Action | Expected | Result | Evidence / notes |
|---|---|---|---|---|---|
| S1 | SMK-01, SMK-03 | Sign in; open Schedule | Week view loads | | |
| S2 | RDY-14 | Open Care Team and P1's page | Refused, or shows no readiness actions (no Approve, Extend, Add email, Verify, Deactivate) | | |
| S3 | RDY-09 | Look at who the Schedule offers for a new shift | **Approved/Active** caregivers can be scheduled (P1 after O9, P4); a **Not ready** caregiver (P2) is refused with the server's reason (not active) | | |
| S4 | RDY-06 | Create a new one-time shift for P3 (overdue CPR/TB) | If enforcement is **ON**: refused "CPR missing. TB missing." If **OFF**: saved. State which applies. After O11 (CPR extended) TB is still overdue: say what the Schedule does | | |
| S5 | SCH-01 | Schedule a 4 h shift for P1 on a synthetic client with room | Saved; reserved minutes 240; hours left drop by 240 | | |
| S6 | REC-01 | Preview a repeating series (Mon to Thu, 2 h) for the same client | Every date shows ok or the reason; month table shows already reserved, this series, available after; nothing is saved by the preview | | |
| S7 | USR-01 | Try to open Accounts and Settings | Refused or hidden for a scheduler | | |

## 4. Caregiver (phone 390 x 844), signing in as **P1 UAT Ready**
| Step | Test ID | Action | Expected | Result | Evidence / notes |
|---|---|---|---|---|---|
| C1 | RDY-12 | Open the invitation email, sign in with the temporary password, set your own password | Works once. The **old temporary password no longer works** a second time. (Expiry: the Operator reads the pool's validity setting and records it: ____ days. Do not wait to test expiry unless told.) | | |
| C2 | SMK-01 | After sign-in | Lands on the caregiver home; no error screen | | |
| C3 | RDY-02 | Tell the Owner you have signed in | The Owner's page for you shows "Signed in" and Approve becomes enabled | | |
| C4 | RDY-14 | Open `/care-team` | Refused: "You do not have access to the Care Team." No readiness data visible anywhere | | |
| C5 | SMK-04 | After the Owner has approved you and assigned a synthetic client: open Verify visit | Only your assigned clients, **client codes only**, no names, no payer or identifier text | | |
| C6 | SMK-05, VIS-01 | Start a visit, work one minute, end it, confirm with a drawn signature (a synthetic confirmer) | Time In and Time Out are set by the server; end cannot precede start; after confirmation the visit is locked. If your shift is not scheduled today the app asks for a reason and sends the visit to review: that is expected | | |
| C7 | RDY-15 | On every screen you used | No sideways scroll; buttons easy to press; text readable | | |
| C8 | RDY-14 | Before you were approved (ask the Owner to test with P2 if P1 is already approved): can a **Not ready** person start a visit? | Refused with the server's reason | | |

## 5. Authorization validator (three balances recalculated by hand)
Migration 0086 **must not change authorization arithmetic**. This script proves it. Use the three clients from P5. For **each** client, in the **current month**, copy the figures from the screen and recompute by hand. Use whole minutes.

Formula (as the product states it): **Hours left = Authorized − Billable (used) − Pending − Reserved**, where Pending and Reserved are the screen's own figures for that month. Check the client page ("Balance for month"), the monthly service summary report and Home's Hours this month; all three must show the **same** number.

| Case | Client (code) | Authorized (min) | Used / billable (min) | Pending (min) | Reserved (min) | Hours left on screen (min) | Hand result (min) | Equal to the minute? | Client page = report = Home? |
|---|---|---|---|---|---|---|---|---|---|
| Low use | | | | | | | | ☐ | ☐ |
| Near limit | | | | | | | | ☐ | ☐ |
| Amended (lower or higher this month) | | | | | | | | ☐ | ☐ |

| Step | Action | Expected | Result | Notes |
|---|---|---|---|---|
| A1 | Fill the table; compute by hand with a calculator | Every row equal to the minute | | |
| A2 | Schedule a 4 h shift for one client (S5) and re-read | Reserved rises by 240; Hours left falls by 240; all three places agree | | |
| A3 | On the amended client: open Authorization changes | The page lists the amendment with date and who; **no crash** | | |
| A4 | Confirm that a Not ready caregiver's attempt to be scheduled (S3) did **not** reserve any minutes | Reserved unchanged | | |

## 5a. Cross-agency isolation (decision D11; conditional) — organizations named 2026-10-31
Operator's count (Part 2, V6): **4 organizations**, so X1 to X3 apply. Organizations reported by the owner for X1-X3: **`ogevia-test-slice`** (Org 1) and **`scs-pilot-synthetic`** (Org 2). Slugs are as reported; the Operator verifies them in TEST (Part 2 V5 listed both). Synthetic accounts: **to be identified** (do not use real people; the sign-in pool may be shared with production).

| | Organisation 1 | Organisation 2 |
|---|---|---|
| Slug | `ogevia-test-slice` | `scs-pilot-synthetic` |
| Synthetic account | to be identified | to be identified |
| Role as reported | Owner | Caregiver |
| Roles the repository's seed scripts create | caregiver and manager (`02_seed_synthetic_test_slice.sql`) | manager and two caregivers (`04_seed_scs_pilot_synthetic.sql`); **no organization owner in either** |

**Decided 2026-10-31 (owner decision D22, `DECISION_RECORD.md` A15):**
- **X1-X3:** the **Manager** account in `ogevia-test-slice` and the **Manager** account in `scs-pilot-synthetic`; **separate synthetic sign-in accounts, not shared between organizations**.
- **Caregiver-only visibility checks (C-steps):** a **Caregiver** account in `scs-pilot-synthetic`.
- **Owner:** if a synthetic Owner exists in TEST, use it for O11, O12 and the due-days validation (O14). If none exists, those three are covered by the automated tests for this cycle, and **no new TEST user is created** (outside the current GO).
- The Operator confirms by role name (not email) that the two Managers and the Caregiver exist and are separate, and whether a synthetic Owner exists, before UAT starts.

**UPDATE 2026-10-31 (owner statement D24, `DECISION_RECORD.md` A17): a synthetic Owner EXISTS in TEST. Use it for ALL owner-only steps (O2, O5, O6, O9, O11, O12, C3, O14 and the background-verification data prep). The no-Owner fallback below is NOT used. No new user is authorized or needed. The V7 count at S2 is expected to confirm an `organization_owner` row; the Owner's organization has not been stated (the Owner validator must be an owner of the organization where P1-P3 are created).**

**Owner-only workflows (owner decision D23, `DECISION_RECORD.md` A16; superseded by D24 as above, kept for the record).** Check first whether a synthetic Owner exists in TEST: the Phase C S2 probe prints query **V7** (count of active memberships by role in `ogevia-test-slice` and `scs-pilot-synthetic`; an `organization_owner` row means an Owner membership exists; the Operator decides whether that account is synthetic). 
- **If a synthetic Owner exists:** use it for **O2, O5, O6, O9, O11, O12, C3 and the due-days validation (O14)**. No new user creation is authorized.
- **If none exists:** the wider fallback is accepted for this TEST cycle. Mark those steps **"NOT RUN IN UAT: satisfied by automated tests and documented review evidence (D23)"**, together with the related approval-chain preparation (data prep P1-P3 background verification). No new TEST user is authorized or required; **no production account may be used.**
Why these steps depend on an Owner: verifying a background check needs `caregivers.compliance.manage` (organization owner), Approve needs a verified background check, and the Accounts page needs `accounts.manage` (owner only). The automated evidence for the approval chain is RDY-01..04 in `FEATURE_TEST_PLAN.md` (DB `caregiver-readiness.db.test.ts`, 22 tests; HTTP 5 tests) and the security review. What a Manager-only cycle can still show: O1, O3, O4 (view), O7, O8, O16-O20, S1-S7, C1-C8 (as applicable), A1-A4, X1-X3.

| Step | Action | Expected | Result | Notes |
|---|---|---|---|---|
| X1 | Signed in to Org 1 (`ogevia-test-slice`) as its Manager, open Care Team and Accounts | No person from Org 2 appears | | |
| X2 | As Org 1's Manager, open a caregiver page of Org 2 by its address (Operator supplies the ID) | Refused or "not found"; no data shown | | |
| X3 | As Org 2's Manager, repeat X1/X2 against Org 1 | Same | | |

## 6. Defect log (all validators)
| # | Step | Class (Blocker / Major / Minor) | What happened (steps, screen) | Status | Owner exception (Major only) |
|---|---|---|---|---|---|
| | | | | | |

☐ No open Blocker.  ☐ No open Major, or each has a written owner exception.

## 7. Sign-off (matches checklist section D)
| Validator | Name | Scripts run (step IDs) | Result | Open defects | Signature / date |
|---|---|---|---|---|---|
| Owner | | O1 to O20 | ☐ accepted ☐ rejected | | |
| Scheduler | | S1 to S7 | ☐ accepted ☐ rejected | | |
| Caregiver (phone) | | C1 to C8 | ☐ accepted ☐ rejected | | |
| Authorization (three balances by hand) | | A1 to A4 | ☐ accepted ☐ rejected | | |

When all four are accepted and the defect log is clear, the Owner copies the outcome into `CHECKLIST.md` section D. Until then Phase D is **NOT RUN** and the release stays **NOT RELEASABLE**.

## 8. Known gaps in what these scripts can test (author's notes)
- **RDY-08 has no screen by decision D9**: the agency CPR/TB due-days setting is API-only for 0086.
- **RDY-13 (contacts unreadable by any role) and the SECURITY DEFINER checks** are database facts, not screens: they are in `SECURITY_REVIEW.md`, not here.
- **RDY-14 across agencies (decision D11):** step X1 below runs only if TEST has a second organization. If it has none, UAT relies on the automated tests and the reviewer must accept that limitation in `SECURITY_REVIEW.md` before sign-off.
- **A "Request" button for CPR/TB** was not built (no channel to message a caregiver); Upload is on the Documents page.
- **Enforcement stays OFF by decision D10**: O13 is not executed; S4 is replaced by a report-only check. The blocking behaviour (RDY-06 with enforcement ON) is covered only by the automated tests and is NOT shown in UAT.
