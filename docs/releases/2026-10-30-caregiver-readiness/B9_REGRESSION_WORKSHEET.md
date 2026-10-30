# B9 worksheet: regression spot-check (checklist B9, release 2026-10-30-caregiver-readiness)

**Status: BLANK. NOT RUN.** Every result cell below is empty on purpose; nothing has been pre-filled. A person fills this in on the **local harness only** (owner decision D1: no shared environment until a target is designated). Catalog IDs refer to `docs/release-process/ACCEPTANCE_TEST_CATALOG.md`; rows marked "new" are the release's own RDY rows.

## Header (fill in before starting)
| Field | Entry |
|---|---|
| Tester (full name) | |
| Date and start time | |
| Commit SHA under test (full 40 characters; `git rev-parse HEAD`) | |
| Browser and version | |
| Harness reset and seeded just before this run (setup, seed-extra, seed-scenario, build, serve)? | ☐ yes |
| DevTools Console and Network open for the whole run? | ☐ yes |
| Evidence folder created: `docs/releases/2026-10-30-caregiver-readiness/evidence/b9/` | ☐ yes |

## Setup commands
```bash
pnpm install --frozen-lockfile
export HARNESS_ADMIN_URL=postgres://<superuser>@127.0.0.1:5432/postgres     # a local PostgreSQL 16+, never a shared database
pnpm --filter @carelik/infra-aws harness:setup
pnpm --filter @carelik/infra-aws harness:seed-extra
pnpm --filter @carelik/infra-aws harness:seed-scenario
pnpm --filter @carelik/infra-aws harness:build
pnpm --filter @carelik/infra-aws harness:serve      # https://localhost (port 443; accept the certificate warning)
```

## Rules for filling this in
- Result is **PASS** or **FAIL**. No other word. "N/A" needs a written reason in Notes and the owner's agreement.
- Screenshot file name: `<step>-<persona>.png` in the evidence folder. Every FAIL needs one.
- A **console error, page error, or 4xx/5xx response that is not a deliberate refusal is a FAIL** for that step (this also covers B7 for the session).
- **Any FAIL stops the run.** Do not continue past it. Record it in the defect log, then fix forward with a new commit and restart at Phase A.
- Do not edit data by hand (no SQL). Use the screens only.
- Do not use `browser-scenario.mjs` or `workflows.mjs` as evidence (the first fails identically on the code before 0086; the second is stale).

## 1. Olivia Owner (administrator), desktop 1280 px
| Step | Catalog ID | Action | Expected | Result | Screenshot | Notes |
|---|---|---|---|---|---|---|
| O1 | SMK-01 | Sign in as Olivia | Lands on her home; no error screen | | | |
| O2 | SMK-02, DSH-02 | Open Home | Hours cards and Action needed render, no "Unable to check"; the Action needed badge and the Home banner show the same total | | | |
| O3 | RDY-09 (new) | Open Care Team, set the status filter to All | Every caregiver shows one of Not ready, Approved, Active, Inactive; the word "Pending documents" appears nowhere; people who are not ready show "n of 5 done" | | | |
| O4 | RDY-09 (new) | Open Accounts | The same caregivers show the **same status words**; a second line reads "Sign-in account: …"; people who have not signed in show Add email or Send sign-in link | | | |
| O5 | USR-01 | Open every menu item visible to Olivia, one by one | No error screen on any; each page loads | | | |
| O6 | CMP-15 | Open Readiness | Report lists who would be held and why; the schedule and Start visit still work (enforcement is seeded as shown on the report; read it and note it in Notes) | | | |
| O7 | CMP-15 | Open Caregiver Holds (from Action needed) | Holds list shows reasons and fix links; nothing is ended or cancelled | | | |
| O8 | SCH-01 | Schedule a one-time 4 h shift for Demo Vega with Alex | Saved; reserved minutes 240; remaining hours drop by 240 | | | |
| O9 | SCH-02 | Try a shift larger than the hours Demo Vega has left | Refused with a message that states the hours available and the hours needed | | | |
| O10 | RDY (new) | Open Dana Overdue's page | CPR and TB read "overdue since …"; each says whether it blocks new shifts or is flagged only (matches the Readiness report's enforcement state) | | | |
| O11 | RDY (new) | Open Quinn WaitingOnSignIn | Approve for work is **disabled** and shows "Waiting on: App sign-in"; no control opens a form that then errors | | | |

## 2. Morgan Manager, desktop 1280 px
| Step | Catalog ID | Action | Expected | Result | Screenshot | Notes |
|---|---|---|---|---|---|---|
| M1 | SMK-01 | Sign in as Morgan | Lands on his home; no error screen | | | |
| M2 | USR-01 | Open Dana Overdue's page | **No Extend button** (administrator only) | | | |
| M3 | USR-01 | Open Reese ReadyToApprove | Approve for work is enabled; click it once | Status becomes Approved, "Approved … by Morgan Manager" shown, no Approve button remains | | | |
| M4 | USR-01 | Open Care Team | Add caregiver offers only Applicant and Onboarding as starting statuses | | | |

## 3. Sam Scheduler, desktop 1280 px
| Step | Catalog ID | Action | Expected | Result | Screenshot | Notes |
|---|---|---|---|---|---|---|
| S1 | SMK-01, SMK-03 | Sign in as Sam; open Schedule | Week view loads | | | |
| S2 | SCH-01 | Schedule a 4 h shift for Demo Vega | Saved; reserved minutes 240 | | | |
| S3 | REC-01 | Preview a recurring series, Mon to Thu, 2 h, Demo Vega | Each date shown with ok or the reason; the month table shows already reserved, this series, available after | | | |
| S4 | USR-01 | Try to open Care Team readiness actions | Sam sees no readiness page content he is not permitted to see (a refusal or no menu item); nothing changes | | | |

## 4. Alex Caregiver, phone 390 x 844
| Step | Catalog ID | Action | Expected | Result | Screenshot | Notes |
|---|---|---|---|---|---|---|
| A1 | SMK-01 | Sign in as Alex | Lands on the caregiver home | | | |
| A2 | SMK-04 | Open Verify visit | Only assigned clients, client codes only; no names or payer IDs | | | |
| A3 | SMK-05, VIS-01 | Start a visit, then end it, then confirm with a drawn signature | Time In and Time Out are server times; end cannot precede start; the visit is locked after confirmation | | | |
| A4 | RDY-14 (new) | Open `/care-team` | Refused: "You do not have access to the Care Team." | | | |
| A5 | — | On every screen visited | No sideways scroll; buttons easy to press | | | |

## 5. Blair Caregiver, phone 390 x 844
| Step | Catalog ID | Action | Expected | Result | Screenshot | Notes |
|---|---|---|---|---|---|---|
| B1 | SMK-01 | Sign in as Blair | Lands on the caregiver home | | | |
| B2 | VIS | Open the unclosed visit from yesterday | It shows and can be ended | | | |

## 6. Legacy people stay working
| Step | Action | Expected | Result | Screenshot | Notes |
|---|---|---|---|---|---|
| L1 | In Care Team, find Alex and Blair | Both show **Active** (backfilled as approved); neither lost their schedule or assignments | | | |
| L2 | In the Schedule, open a shift already assigned to Alex | It still shows Alex; nothing was cancelled or reassigned | | | |

## 7. Session-wide checks
| Check | Result | Notes |
|---|---|---|
| No unexpected console errors, page errors or 4xx/5xx in any session (B7) | | |
| No real client, caregiver or payer data seen (all data synthetic) | | |

## Defect log
| # | Step | Class (Blocker / Major / Minor) | What happened (steps, screen) | Status |
|---|---|---|---|---|
| | | | | |

## Outcome and sign-off
| Field | Entry |
|---|---|
| Steps run / PASS / FAIL | ___ / ___ / ___ |
| B9 outcome | ☐ **PASS** (every step PASS, no open Blocker or Major) ☐ **FAIL** |
| Tester signature | |
| Date and time finished | |
| Reviewed by (owner or Operator Stella Okereke) and date | |

When B9 is PASS, the owner or Operator copies the outcome into `CHECKLIST.md` (row B9, and the release status table). Until then B9 stays **OPEN** and the release stays **NOT RELEASABLE**.
