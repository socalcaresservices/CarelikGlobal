# Unfinished UAT checklist and synthetic account plan: release 2026-10-30-caregiver-readiness (migration 0088, TEST slice)

**Status: PREPARED, NOT RUN.** Prepared 2026-11-01 09:49 UTC at the owner's instruction (2026-11-01: "start with the complete unfinished-test checklist and prepare the necessary synthetic test accounts; bring only the specific decisions or access requests it cannot resolve itself"). Nothing in this file creates an account, sends an email or changes AWS. Source of the outstanding list: `DEPLOYED_RECORD_0088_TEST.md` section 5 and the UAT scripts (`PHASE_D_UAT_SCRIPTS.md`). TEST/pilot slice only; synthetic data only; no production account; 0088 stays NOT RELEASABLE (D7).

**Reinstated by this instruction:** O11, O12 and the other steps recorded "NOT RUN, by owner decision" (D35, D36), because the owner asked for the complete unfinished list. If the owner prefers them left skipped, say so; nothing else depends on this.

## A. Can run now with the logins already in use (Owner, UAT Ready); no new account, no new access
| ID | What | Account | Notes |
|---|---|---|---|
| O11, O12 | Extend CPR on UAT Overdue (refused without a reason; TB stays overdue); history shows who, when, reason, old and new date | Owner | state change on a synthetic caregiver |
| A1-A4 | Authorization arithmetic: three clients, five figures each, Hours left equal on the client page, the monthly service report and Home; reserved rises by 240 after a 4 h shift; a refused Not ready attempt reserves nothing | Owner | the Owner copies the figures; Claude computes; A3 needs an amended authorization (Owner adds an amendment to a synthetic client) |
| S4, S6 | New one-time shift for UAT Overdue (enforcement OFF: saved and flagged); preview a repeating series (nothing saved by the preview) | Owner | S1, S2, S7 need a Scheduler (section B) |
| O18, C7 | Caregivers list and caregiver screens on a phone (390 px) | Owner, UAT Ready | |
| C1 (second half) | The old temporary password no longer works a second time | UAT Ready (needs the old temporary password from the email) | |
| X1-X3 (partial) | If the Owner can switch agency (agency name at the top left lists more than one), X2 and X3 can be run by switching | Owner | owner to check; section B otherwise |

## B. Needs new synthetic accounts (decision and mailboxes required)
| Need | Account (synthetic) | Agency | Used by | Creation path |
|---|---|---|---|---|
| B1 | **UAT Manager 2** | `scs-pilot-synthetic` (Org 2) | X1-X3, F8 | Owner, in the app: Staff > Add staff (type Manager), invite, role Manager (routes `/v1/staff`, `/v1/staff/{id}/invitation`, `/v1/staff-roles/{userId}`; VERIFIED from the route list, not exercised) |
| B2 | **UAT Scheduler** | `scs-pilot-synthetic` | S1, S2, S7, F8 | the same way (type Scheduler). The existing invited scheduler has an unknown address and never signed in: its link could be resent only if the owner knows that mailbox |
| B3 | **UAT Manager 1** | `ogevia-test-slice` (Org 1) | X1-X3 | needs an Owner in Org 1 or the Operator; Org 1 has a manager and a caregiver (V7) with unknown credentials. **Cannot be created from Org 2's Owner.** Options: the owner finds the existing Org 1 Manager's sign-in; the Owner is also a member of Org 1 and can switch; or the Operator creates it (access request) |
| B4 | **A caregiver who is Not ready and can sign in** | `scs-pilot-synthetic` | C8, O5, O7, O16, O17 (sign-in halves) | give UAT NoEmail or UAT NoBg a mailbox and send the sign-in link (Owner, in the app) |
| B5 | Second caregiver (optional) | `scs-pilot-synthetic` | F8 persona "Blair" | optional; skip unless F8 is run in full |
Mailboxes: B1, B2, B3, B4 need **four distinct mailboxes** the owner controls, each with no existing Ogevia or Cognito account in the shared pool (a collision could attach an invitation to a real identity). B5 would be a fifth. Decision A18 reserved the first test mailbox for UAT Ready only and excluded plus-address variants of it; new addresses need the owner's confirmation.

## C. Needs Operator (Stella) access that no authorization covers yet
| ID | What | Access |
|---|---|---|
| O14 | Read `GET /v1/compliance/settings` as an administrator (`cprTbDueDays`); the screens already show 30 days | an administrator token held by the Operator, used in CloudShell; never pasted into chat or files |
| F7 | Task 8: run `TASK8_ACTIVE_CAREGIVER_GAPS.sql` (read-only) before enforcement | new database access (G1 covered S2, S6, S7, S11 only) |
| F3 | Record the temporary-password validity (days) | read-only `DescribeUserPool` on the Cognito pool |
| F4, F8 | Role gating live (403 for a caregiver, 404 across agencies) and the regression/smoke sets | tokens for several roles, which need the accounts in section B |
| B3 (if created by the Operator) | Org 1 Manager | Cognito and database writes |
The deployment window (to 2026-11-02 02:00 UTC) covers the GO's named actions only; any of these is a new access request.

## D. Owner decisions only the owner can make
1. **O13** (switch enforcement ON in TEST): irreversible in the product; Claude recommends skipping, or running it last with the owner's written approval.
2. **Authorization to create new synthetic TEST users** (supersedes D24 "no new user" and D25 "one mailbox"): how many (4 to 5), which agencies, who creates them (Owner in the app for Org 2; Operator for Org 1).
3. **The mailboxes** (section B) and the statement that none has an existing account in the pool.
4. Whether to run **X4** (a spoofed agency ID replayed from the browser's DevTools; stronger than X2) and who runs it.
5. The three product questions in `DEPLOYED_RECORD_0088_TEST.md` section 5 item 5.

## E. Order of work
1. Section A (no dependency): O11/O12, A1-A4, S4, S6, O18, C7, C1 second half. About 45 to 60 minutes.
2. The owner checks whether the Owner login can switch agency (settles part of B3 and X2/X3).
3. After decisions D2 and D3: create B1, B2, B4 (Org 2, by the Owner, in the app), then B3.
4. X1-X3 (and X4 if chosen), S1, S2, S7, C8, O5, O7, O16, O17, F4, F8.
5. After enforcement is decided: F7 Task 8.
Stop rules unchanged (`PHASE_D_UAT_SCRIPTS.md` section 0): stop at the first Blocker; any sight of another agency's data is a P0 cross-tenant exposure.
