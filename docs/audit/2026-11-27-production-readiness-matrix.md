# Ogevia production readiness matrix — 2026-11-27

Owner directive (2026-11-27): treat everything requested since go-live as one release program; conversational requests count the same as written tickets.
Companion files: [gap list](2026-11-27-gap-list.md), [release candidate and TEST validation runbook](2026-11-27-release-candidate.md), [closeout audit with the 87 original rows (IDs A1–H2)](2026-11-26-closeout-audit.md), [UX tracker (R1–R48)](../ux/REQUIREMENTS-TRACKER.md).

## How to read it
- **Merged** = in `main`. PR #124 (`feature-completion-phase-2`, head at the commit shown in the release candidate file) is **a draft and not merged**; merging it is the owner's decision.
- **Deployed to TEST** and **Tested in TEST** come from the owner's pasted deployment output and replies (I have no AWS access). **Tested in TEST = YES only when the item is merged AND deployed to TEST AND verified working** (the owner's rule). A verified TEST item that is not merged is shown as `NO (in test)`.
- **Production ready = YES** only for items already live in production and accepted. Production state after 2026-11-22 08:53 has **not** been re-read.
- Commit column: the last commit that changed the behaviour where known; otherwise the PR that carries it. Audit IDs refer to the closeout audit.

Legend: Y = yes, N = no, P = partial, ? = unknown/not verified.

| # | Area | Requirement (source) | Impl | Commit(s) / PR | Merged | In TEST | Tested in TEST | Prod ready | Action required |
|---|---|---|---|---|---|---|---|---|---|
| **Go-live and release process** |
| 1 | Release | Production go-live of #113 with request-cleanup OFF (A13) | Y | #113 | Y | Y | Y | Y (live) | Re-read production state read-only |
| 2 | Release | 0109–0114 completion set: calendar CSV sort, report sorting, export ordering, shift drawer, refresh, caregiver picker, mobile (A2/A6, R38–R45) | Y | #114 | Y | Y | Y | P | Items in #114 are in production; sorting completion (#123/#124) is not |
| 3 | Release | Local harness, Staff header overflow at 390 px (A10, R13) | Y | #115 | Y | Y | Y | Y | — |
| 4 | Release | TEST/production deployment tooling with guards, backups, rollback (A11, E23) | Y | `docs/releases/*/toolchain` | P | Y | Y | P | Rollback refs for stages 2–3 lost (home disk full); INDEX.md missing |
| 5 | Release | Release pin guard and expected-only diff gates | Y | `release_pins.py`, PINS_0109/0110 | P (#124) | Y | Y | P | Re-pin after every code commit (done each time) |
| **Requests, documents, offices** |
| 6 | Requests | Cancelled/closed requests not counted; unresolved filter; alerts pill (R34, R35, A14) | Y | #113 | Y | Y | Y | N | Request-cleanup switch is **OFF in production**; owner decides the switch-on release |
| 7 | Documents | Cancel a document request; retire a duplicate type (R37, A14) | Y | #113, 0109 | Y | Y | Y | N | Same switch (OFF in production) |
| 8 | Offices | Create/rename/retire offices; responsible office; filters (R46, A15/A16) | Y | 0110, #114 | Y | Y | Y | Y (live) | — |
| 9 | Offices | Multiple offices per client/caregiver, one primary, counties, filters (B5) | Y | 0111, f91ea1c1 | Y | Y | Y | Y (live) | — |
| 10 | Offices | Assignment history (B5) | Y | 0112, 7fca7785 | Y | Y | Y | Y (live) | — |
| 11 | Schedule | Clear November and Dec 1+ unworked shifts; series adjusted; history kept (A17) | Y | `2026-11-21-schedule-clear` | Y | n/a | n/a | P | Run in production 11-21; owner to confirm result on screen |
| 12 | Colors | Caregiver colors red/yellow/blue; dashboard palettes incl. primary colors (B6, R33, A12) | Y | 0111, UX branch | P | Y | P | P | Palette "applied everywhere" (A12) not confirmed; UX branch PR #108 not merged |
| **Sign-in and invitations** |
| 13 | Access | Resend sign-in link, reset codes, un-onboarded staff (B2) | Y | answers + B3 | n/a | n/a | n/a | Y | — |
| 14 | Access | Correct a wrong invitation email before first sign-in (B3, B7) | Y | `2026-11-22-invitation-email-fix` | Y | Y | Y | Y (used once in production) | — |
| 15 | Access | **One email = one person** (owner 2026-11-27) | Y | 0121, 479fdf26 | N | Y | N (in test) | N | Merge #124; production check for existing shared emails (CHECK_DUPLICATE_EMAILS.sql) before 0121 |
| 16 | Access | Sign-in override for production (R10, PR #109) | Y | #109 | P | Y | Y | Y (live per #109) | — |
| 17 | Access | Branded invitation emails + Cognito custom message (D3, F16) | P | 0114, #124 | N | P (0114 only) | N | N | Cognito trigger/sender not wired; owner decision on 50-email/day limit |
| **Notifications and open shifts (Release Train 2)** |
| 18 | Notify | In-app cover-shift alerts, centre, preferences, audit (D1, E4) | Y | 0113, b0848ede | N | Y | N (in test) | N | Merge #124, then production plan |
| 19 | Notify | Alert opens the exact shift; request/withdraw; office sees requests by time (E5, E17, E18) | Y | 0120, 620ccf35 | N | Y | N (in test) | N | same |
| 20 | Notify | Short alert copy, one unread dot, View shift primary (E19) | Y | #124 | N | Y | N (in test) | N | same |
| 21 | Notify | Cover-shift **email** via SES (D2, E22) | Y | email Lambda, stage 4/5 | N | Y | **N — not verified** | N | Stage 6 to footietree recipient complete; owner must confirm arrival, DKIM/DMARC and exact-shift link opens for the right caregiver |
| 22 | Notify | HTML alert email keeps line breaks (conversation 11-27) | Y | this program | N | N | N | N | Ships with the next TEST API deploy |
| 23 | Open shifts | Call-outs, cancellations, reservations, two-approval race (E6) | Y | 0117 | N | Y | N (in test) | N | Browser acceptance not recorded |
| 24 | SMS | Mock SMS: windows, quiet hours, opt-in/STOP, escalation (E7) | P | 0117, mock sender | N | Y (mock) | N | N | Live texting **needs owner decision** (provider, number, registration) |
| 25 | Client | Service address + county + coordinating office in one edit (E11, E2) | Y | 0118 | N | Y | N (in test) | N | Profile line/edit form acceptance not recorded |
| 26 | Notify | Duplicate alerts after 0117 upgrade (E13) | Y | 0119 | N | Y | N (in test) | N | — |
| **Caregiver readiness (this week)** |
| 27 | Readiness | Compact caregiver profile: four tabs, one row per question, Edit/Manage (R47) | Y | 6a1f813e | N | Y (a74d2ca5) | P (owner smoke: Readiness passed) | N | Owner sign-off of screenshots |
| 28 | Readiness | Unconfigured CPR/TB type does not block an approved caregiver; enforcement stays on (0122) | Y | 0122, 204079c3 | N | Y | N (enforcement still OFF in TEST) | N | Activate enforcement in TEST (one-way) and run the 3 cases |
| 29 | Readiness | Admin override of a readiness block, scoped, revocable, audited (R48, 0123) | Y | 72a51c0a | N | Y | **N — five enforcement-on cases not run** | N | Owner runs the cases (runbook section 3) |
| 30 | Readiness | Override visible in profile, holds report, follow-up queue (R48) | Y | a74d2ca5, fcaf67c2 | N | Y (menu fix not yet) | N | N | Publish 44e49d4f web-only; verify menu path |
| 31 | Readiness | **Export of the admin-approved exceptions (CSV, Excel, print/PDF)** (conversation: exports) | Y | this program | N | N | N | N | Ships in the release candidate |
| 32 | Readiness | Caregiver holds always reachable from the menu (owner 11-27) | Y | fcaf67c2 | N | N | N | N | Web-only TEST publish |
| 33 | Compliance | CPR/TB document types set up in one action (R7) | Y | UX branch/#124 | P | Y | P | N | Verify in TEST with enforcement activation |
| **Onboarding, staff, import** |
| 34 | Staff | Bulk import CSV/XLSX, dry run, history, rollback (R11, D4) | Y | 0115 | N | P | N | N | Browser acceptance not recorded |
| 35 | Staff | Duplicate staff merge wizard (R6, D5) | Y | 0116 | N | P (switch OFF) | N | N | Enable in TEST and accept |
| 36 | Staff | Separate bulk sign-in-link action (R25) | Y | UX branch | P | ? | N | N | Confirm in TEST |
| 37 | Ops | Operations readiness dashboard (D7) | Y | #124 | N | N (switch OFF) | N | N | Enable in TEST |
| **UX redesign (PR #108, draft)** |
| 38 | UX | R1–R5, R8, R12–R14, R18–R20, R24, R27–R28, R31–R32 (F1–F3, F5, F12) | Y | #108 | N | N | N | N | Reconcile #108 with #124 lineage; deploy to TEST |
| 39 | UX | Care requests/alerts, reports calendar, documents, sorting (R34–R45) | Y | #108/#113/#114/#123 | P | P | P | P | See rows 2, 6, 7 |
| **Operations and compliance** |
| 40 | Audit | Append-only audit for overrides, merges, imports, notifications | Y | 0113–0123 | N | Y | P | N | Retention statement to be written (gap C-3) |
| 41 | Security | Tenant isolation sweep covers every new endpoint | Y | tenant-isolation-sweep | N | n/a | CI only | N | CI green |
| **Not built / briefs missing** |
| 42 | NFC/QR | NFC/QR visit verification, stickers, signatures (G1–G3) | Y (local) | #125 | N | N | N | N | Renumber 0120 → 0124+; TEST deploy; real-device test |
| 43 | Briefs | Sandata reconciliation, authorization worklist, Patriot payroll/billing, second-agency access (G4–G7) | N | — | N | N | N | N | Owner must supply the briefs |
| 44 | Homepage | Public homepage, ranges instead of $29 (F14) | ? | — | ? | ? | N | N | Owner confirms scope |
| 45 | Demo | One end-to-end demo (F17) | N | — | N | N | N | N | Decide |
| 46 | Open shifts | Parallel PRs #121 and #122 duplicate #124 (H2) | n/a | #121, #122 | N | N | N | N | Close or keep: owner decision |
| 47 | Open items | Care Match, finance reconciliation (F7, F11) | ? | — | ? | ? | N | N | Owner confirms scope |
| 48 | Reliability | Home-disk / CloudShell capture loss (E23) | P | SAVE_ROLLBACK_REFS.sh | P | n/a | n/a | N | Re-capture stage 2/3 rollback refs |

Open PRs not part of this program (older stacked drafts, mostly superseded or docs): #53–#73, #98–#110 (see gap list category "Operational").
