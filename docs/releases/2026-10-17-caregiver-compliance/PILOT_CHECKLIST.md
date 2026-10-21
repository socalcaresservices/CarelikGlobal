# Pilot checklist: caregiver compliance (TEST only, synthetic data only)

**Status: NOT RUN. Nothing here has been executed on the TEST environment.** It can start only after the owner approves a deployment of migration 0055, the API and the web build (`docs/TESTING_AND_RELEASE_PROCESS.md`, phases C and D). Rules under test are **owner-defined**, not verified legal requirements. Do not use real caregivers, clients or documents. Tick a box only with a screenshot or output saved in the evidence folder; any line that does not match **stops** the run.

Before you start (read-only): the TEST database migration ledger reads `52|0052`; the live TEST web shows the banner "TEST — synthetic data only" (SMK-07); you have two synthetic caregiver sign-ins (call them **Alex** and **Blair**) that exist only in TEST. The sign-in pool is shared with PROD: never disable or change a real person.

## 0. Apply order (owner-approved, operator-run; not done)
1. Database snapshot (separate approval), then migration 0055 (rollback: `0055_caregiver_compliance_hold.down.sql`, BACKUP REQUIRED).
2. API Lambda, then web. 3. The 15-minute rule is a **separate** approval (a new EventBridge rule); skip it to test the "Check now" path first.

## A. Nothing is stranded (before enforcement is activated for TEST, or on a TEST that has not activated it)
- [ ] CMP-15: Olivia opens **Readiness**: the report lists how many caregivers would be held and why; the schedule and Start visit still work for everyone; no hold exists; Caregiver Holds says "No caregiver is on a compliance hold."
- [ ] SMK-01 to SMK-07 pass for each persona (nothing else changed).

## B. Background clearance (CMP-01, CMP-02)
Owner has activated enforcement for TEST (Readiness, with the reviewed count).
- [ ] Open Alex's profile as Olivia: **Compliance** card reads "Blocked from new work" or "On compliance hold"; background shows "Not cleared".
- [ ] Morgan sets the status to **Completed**: the card still says "Not cleared… completed but no approved result is verified yet". Sam tries to schedule Alex: refused with "Background check…".
- [ ] Morgan cannot see the Verify form; calling the verify route as Morgan returns 403.
- [ ] Olivia records **Not approved** with a note: Alex still cannot be scheduled. Olivia records **Approved** with a note ("Agency clearance record"): the card shows "Approved and verified" with Olivia's name and the time.
- [ ] Olivia cannot verify a record linked to her own sign-in (use a synthetic caregiver record linked to the owner test account).
- [ ] Morgan sets the status back to **Pending**: the approval is withdrawn and Alex cannot be scheduled again.

## C. The 14 days (CMP-03 to CMP-06, CMP-11)
Alex has approved clearance and no CPR/TB uploaded.
- [ ] No hire date: refused "CPR missing. TB missing."; the card says "No hire date is recorded, so the 14-day period cannot be applied." Morgan enters a hire date **14 days ago** with a reason: Alex can be scheduled; CPR and TB show "Pending, due <today>"; the text says a hold starts "12:00 AM on <tomorrow> (America/Los_Angeles)".
- [ ] Olivia changes the hire date to **15 days ago** with a reason: Alex is refused at once. Morgan cannot change a recorded hire date (403); the audit trail shows both changes with who, when and the reasons.
- [ ] Upload and verify **CPR only**: the card and the hold list only TB. Verify TB too: Alex is eligible.
- [ ] Reject a CPR record (reason "Image unreadable") for Blair (hire date yesterday): Blair is blocked immediately; the period does not relax it. Same for an expired record.

## D. Every path refuses a held caregiver (CMP-07)
Hold Alex again (clear documents, hire date 40 days ago).
- [ ] Sam: create a shift for Alex; assign Alex to an existing shift; create a standing assignment; create a recurring series. Each refused with the reason.
- [ ] Alex: pick up an open shift; start a visit. Each refused.
- [ ] Verify the shifts and assignments counts are unchanged afterwards.

## E. The deadline passes with nobody watching (CMP-08, CMP-09, CMP-12), only after the rule is approved and deployed
Give Blair a shift, a recurring series and a standing assignment while inside the period, start a visit, then move Blair's hire date back (as Olivia, with a reason) so the period ended. Do not open Blair's profile.
- [ ] Within 15 minutes: **Caregiver Holds** appears in Action needed (badge and Home) with the number of shifts to cover plus the visit in progress; it shows an urgent line for the visit.
- [ ] Caregiver Holds lists Blair's reason, every future occurrence of the series (marked recurring), the standing assignment, and a link to fix each item.
- [ ] Blair's visit in progress is **not** ended; Blair can still End visit; completed visits are unchanged.
- [ ] Cancel one shift and reassign another from the schedule: their flags disappear; nothing else changes.
- [ ] The audit shows "hold opened" with **no person** as the actor, once.

## F. Release (CMP-10)
- [ ] Verify Blair's CPR only: Blair stays held; the page lists only TB. Verify TB: the hold lifts by itself, the flags clear, Olivia's name is the releasing actor.
- [ ] The shift that was cancelled stays cancelled; the reassigned shift stays with the other caregiver; Blair can be scheduled for **new** work.

## G. Phone and accessibility (390 px wide)
- [ ] Compliance card, Caregiver Holds and the Action needed line: no horizontal scrolling; every button at least 44 px high; the Verify form's radio buttons and fields are reachable with the keyboard open.
- [ ] Screen reader or keyboard check: headings in order, form fields labelled, the hold alert is announced.

## H. Isolation and permissions (CMP-16)
- [ ] A caregiver signed in as Alex sees none of the compliance screens (the menu has no entry; opening `/compliance` shows "You do not have access").
- [ ] An administrator of another agency cannot read or change this agency's compliance (404).

## I. After
- [ ] Rollback rehearsed on the harness or a restored copy, **not** on TEST data that others use. Record results in `docs/releases/2026-10-13-wave1/CHECKLIST.md` Phase C.
