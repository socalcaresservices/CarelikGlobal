# SCS pilot: real-phone acceptance test (AWS TEST, synthetic data)

**When:** after `pilot-deploy.sh` prints **OGEVIA PILOT BUILD DEPLOYED TO AWS TEST**.
**Who:**

| Role | Device | Account |
| --- | --- | --- |
| Manager | Laptop or phone | The pilot manager email |
| Caregiver A | Their own phone | Caregiver A's email |
| Caregiver B | A second phone, or the same phone after signing out | Caregiver B's email |

**Time:** about 75 minutes of hands-on testing. Section F has to wait until Caregiver B's scheduled shift has ended, about 3.5 hours after B3; Requests are at least 3 hours long. Do F later the same day.
**Data:** synthetic clients only (`P-QAUF7`, `P-AAXRX`, `P-AHXN7`). Do not enter real client names or details anywhere.

**Record for every step:**
- PASS or FAIL;
- a phone screenshot;
- the time;
- for a FAIL, the exact message shown.

Send the filled-in table to Claude.

## A. Sign-in with MFA (each person, once)

| # | Do | Expected |
| --- | --- | --- |
| A1 | Open the invitation email ("Your temporary password") on the phone, then open the Web URL that pilot-deploy.sh printed | Ogevia sign-in page (Cognito) |
| A2 | Enter the email and the temporary password, then choose a new password | The MFA setup screen shows a QR code |
| A3 | In an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…), scan the QR code and enter the 6-digit code | Lands in Ogevia |
| A4 | Caregiver: confirm the landing page | **Today's visits**. Only the caregiver's own clients appear, and no billing or records menus. |
| A5 | Sign out, then sign in again | Password **and** a 6-digit code are required |

## B. Scheduling (manager), with the authorization limit

| # | Do | Expected |
| --- | --- | --- |
| B1 | **Care requests:** for **P-QAUF7**, create a client link, open it, and request **RSP**. Start: about 15 minutes from now. Length: 3 hours. | Request accepted (flagged short notice) |
| B2 | Offer it to Caregiver A, answer **I'm available** on A's offer link, then **Assign** | Status **Assigned**, one shift |
| B3 | For **P-AHXN7**, request **PCS** (Personal care). Start: about 20 minutes from now. Length: 3 hours. Offer to Caregiver B, available, assign. | Assigned |
| B4 | **Limit:** for **P-AAXRX** (3 h/month), request 4 hours on another day, offer, available, assign | **Refused**, with the authorized-time message. Nothing is scheduled. |

## C. Complete visit (Caregiver A's phone)

| # | Do | Expected |
| --- | --- | --- |
| C1 | Open **Verify visit** | **P-QAUF7** is under *Scheduled today* with an AM/PM time window |
| C2 | Tap it | Visit details: client P-QAUF7, service RSP, today's date, the scheduled times |
| C3 | Tap **Start visit** | *Visit in progress*, Time In, a running timer |
| C4 | Pull down to refresh, or close and reopen the browser | Still in progress with the same Time In; no second visit |
| C5 | Wait at least 3 minutes, then tap **End visit** | The confirmation screen shows the actual times |
| C6 | Have someone sign with a finger, then tap **Confirm visit** | Submitted: Worked, Billable, **Billing ready — does not mean billed** |

## D. Service selection (Caregiver B's phone)

| # | Do | Expected |
| --- | --- | --- |
| D1 | Open **Verify visit**, tap **P-AHXN7** | The service is **preselected as PCS · Personal care**, with "Scheduled today: PCS…" |
| D2 | Change the service to RSP | Warning: *This is not the scheduled service…* |
| D3 | Change it back to PCS, then tap **Start visit** | In progress, with service PCS |
| D4 | Leave this visit **open** (do not end it) | Used for the missed clock-out in F |

## E. Correction (manager)

| # | Do | Expected |
| --- | --- | --- |
| E1 | **Visit records → Visit details**, find A's P-QAUF7 visit, tap **Correct** | Corrected Time In/Out are pre-filled with the original times as Pacific date, hour, minute and AM/PM |
| E2 | Set Corrected Time Out to the wrong AM/PM | A specific message naming both times; nothing is saved |
| E3 | Fix the AM/PM and move Time Out **15 minutes later**. Leave Time In unchanged. Reason: "Pilot test". Save. | Summary shows Original → Corrected. The record shows the revision; History shows the reason. |
| E4 | Open History | The original is preserved. **Time In is identical to the original, including seconds.** |

## F. Missed clock-out (manager, then Caregiver B)

| # | Do | Expected |
| --- | --- | --- |
| F1 | After B's scheduled shift end has passed (about 3.5 h after B3), go to **Report Center → Exceptions needing attention** | B's visit is listed: **Missing Time Out** |
| F2 | **Close visit**, enter an actual Time Out with explicit AM/PM, add a reason, save | The duration is shown before saving, then the visit leaves the list |
| F3 | On B's phone, open **Verify visit** | The confirmation screen says the Time Out was **entered by your agency**. Sign it and it is Submitted. |

## G. Review outcomes and isolation

| # | Do | Expected |
| --- | --- | --- |
| G1 | Caregiver A: start an unscheduled visit for **P-AAXRX**, end it, choose **Unable to obtain confirmation**, give a reason, submit | Saved for manager review: Billable 0 min, Needs manager review |
| G2 | Manager: **Billing review** | Signed visits show Billing ready and "not approved, billed or submitted". The unconfirmed one is not ready. |
| G3 | Manager: monthly reconciliation for this month | P-QAUF7 remaining = authorized − billable − scheduled |
| G4 | Every screen | No horizontal scrolling. Tap targets are easy to hit. No EVV/GPS wording. No client names. |
| G5 | Sign in as the existing test-slice manager | No `P-` clients or pilot visits visible |

## Result

The pilot build is **accepted on AWS TEST** only when **every row is PASS**.

**Real clients still require all of these:**
1. The AWS BAA confirmed in AWS Artifact.
2. The Phase 7 security sign-off.
3. A separately approved production cutover.
