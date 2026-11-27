# Ogevia master release inventory — 2026-11-27

Controlling question: **"If I release to production tomorrow, what exactly am I getting?"** This is a business-level inventory, not a commit report. Commit-level detail is in the [readiness matrix](2026-11-27-production-readiness-matrix.md) and [gap list](2026-11-27-gap-list.md); the 87 original rows are in the [closeout audit](2026-11-26-closeout-audit.md).

Evidence limits (stated once): rebuilt from the conversation (readable from 2026-11-18 07:40), the repository, PR list, CI and the owner's pasted deployment output. No AWS access this session, so TEST and production states are **owner-reported**, and production has **not** been re-read since 2026-11-22. Not recoverable: the Nov 15 go-live document, the Nov 18 checklist email, and everything before 11-18. Columns: Requested = who/where; Impl = exists in code; Merged = in `main`; TEST = deployed to TEST (owner-reported); PRD = live in production now. "TEST verified" is separate and only counted when merged + deployed + verified.

## 1. What production gets if #124 is merged and released
**Today in production:** #113/#114 set, migrations through 0112, switches ON: staffManagement, signInOverride, requestCleanup, offices, officeAssignments, assignmentHistory. OFF: bulkImport, staffDuplicates. Nothing from migrations 0113–0123.

**Release 1 (my recommendation; one set, TEST-verified first), contents:**
| Layer | Goes live immediately on release | Ships dark (switch OFF, enabled one at a time later) |
|---|---|---|
| Database 0113–0123 | 0121 one-email rule; 0122 unset-CPR/TB rule; 0123 override tables/rules (no overrides exist until an admin creates one) | notification, SMS, import-history, merge tables sit unused |
| API/web | Compact caregiver profile; Operations → Caregiver holds menu; sorting completion; exports order | notifications, openShiftSms, serviceLocation, importRollback, readinessOverrides, operationsReadiness, staffDuplicates, bulkImport (production switch-on is a separate decision each) |
| Email | nothing (no email function in production) | cover-shift email needs SES identity + BAA/security gate |
INFERRED: the caregiver-profile redesign has no release switch. Before release, run `CHECK_DUPLICATE_EMAILS.sql` and `CHECK_PRD_PREREQS.sql` read-only on production (the second is unpushed, awaiting your OK).
**Not in this release at all:** NFC/QR (#125), UX redesign branch (#108), live SMS, branded invitation sending, anything with no brief (section 3).

## 2. Master inventory (every discussed item)
Status key: DONE-PRD = live in production; IN-TEST = in #124, deployed to TEST, **not** merged; CODED = in repo/PR only; PARTIAL; MISSING; DECISION = waiting on owner.

### A. Caregiver readiness, holds and approvals
| Item | Requested | Impl | Merged | TEST | PRD | Status |
|---|---|---|---|---|---|---|
| Caregiver Holds page | UX redesign / compliance | Y | Y (page); menu entry N | page Y; menu entry N | page Y | Menu entry: CODED (44e49d4f); exceptions section in TEST unverified |
| Operations → Caregiver holds menu entry | owner 11-27 | Y | N | N | N | CODED |
| Follow-up queue (action issues) with override line "Expired Doc · Admin Approved" | owner 11-27 | Y | N | Y | N | IN-TEST; queue entry unverified |
| Revoke workflow | owner 11-27 | Y | N | Y | N | IN-TEST; revoke-restores-block unverified |
| Readiness checklist / dashboard (per caregiver) | R7, UX | Y | P | Y | P | IN-TEST |
| Operations readiness dashboard (docs/authorizations/open shifts) | feature-completion | Y | N | switch OFF | N | CODED |
| CPR enforcement | 0122/earlier | Y | N | Y (enforcement OFF) | N | IN-TEST; enforcement cases not run |
| TB enforcement | same | Y | N | Y (enforcement OFF) | N | IN-TEST |
| Unconfigured CPR/TB type does not block approved caregiver (0122) | owner decision 11-27 | Y | N | Y | N | IN-TEST; 3 cases not run |
| Readiness overrides (scoped, reason, revoke, history, no status change) | owner 11-27 | Y | N | Y | N | IN-TEST; 5 cases not run |
| Never-approved caregiver: admin records work approval + overrides | owner 11-27 | Y | N | Y | N | IN-TEST; case 3 not run |
| Work approval separate from holds ("Work approval: Approved") | owner 11-27 | Y | N | Y | N | IN-TEST (smoke passed) |
| Scheduling restrictions (readiness, overlaps, hours, authorization) | core | Y | Y (base) | Y | Y (base) | base DONE-PRD; readiness/override parts IN-TEST |
| Document expiry handling (statuses expired / expires_during / missing / rejected) | owner 11-27 | Y | P | Y | P | IN-TEST |
| **Expiry reminders to caregiver/admin** | recommendation | **N** | | | | **MISSING** (notifications support `cover_shift` only) |
| Admin exception handling (override report) | owner 11-27 | Y | N | Y | N | IN-TEST |
| Approvals workflow (work approval, sign-in override, override approval) | various | Y | P | Y | sign-in override Y | partly DONE-PRD |
| Audit logging (overrides, approvals, merges, imports, notifications) | compliance | Y | P | Y | base Y | IN-TEST for new tables |
| Caregiver profile redesign (4 tabs, compact rows) | owner 11-27 | Y | N | Y | N | IN-TEST; screenshot sign-off pending |

### B. Email, identity, onboarding
| Item | Requested | Impl | Merged | TEST | PRD | Status |
|---|---|---|---|---|---|---|
| One email = one person | owner 11-27 | Y | N | Y | N | IN-TEST; production duplicates check first |
| Correct wrong invitation email | owner 11-22 | Y | Y | Y | Y | DONE-PRD |
| Sign-in override for caregivers | owner 11-15 | Y | Y | Y | Y | DONE-PRD |
| Branded invitation emails (company) | owner 11-23 | Y | N | partial | N | CODED; **sending not wired** |
| Per-office branding of invitations | owner 11-23 | N (needs Cognito trigger wiring) | | | | MISSING/DECISION |
| Bulk import CSV/XLSX, dry run, history, rollback | R11 | Y | N | partial | N | CODED/IN-TEST |
| Staff duplicate merge | R6 | Y | N | switch OFF | N | CODED |
| Separate bulk "send sign-in links" | R25 | Y | P | ? | N | CODED |
| Resend sign-in link / password reset guidance | owner 11-22 | answers only | n/a | | | no in-app "resend" confirmed |

### C. Scheduling, open shifts, notifications
| Item | Requested | Impl | Merged | TEST | PRD | Status |
|---|---|---|---|---|---|---|
| Offices, multi-office, counties, history, filters | owner 11-21/22 | Y | Y | Y | Y | DONE-PRD |
| Schedule clear (Nov + Dec 1+) | owner 11-21 | Y | Y | n/a | Y (executed) | DONE-PRD; on-screen confirmation pending |
| Cover-shift in-app notifications, centre, preferences | owner 11-23 | Y | N | Y | N | IN-TEST |
| Alert opens the exact shift; request/withdraw; office list by time | owner 11-25 | Y | N | Y | N | IN-TEST |
| Short alert copy; service city in subject | owner 11-23/25 | Y | N | Y | N | IN-TEST |
| Cover-shift email | owner 11-23/26 | Y | N | Y | N | IN-TEST; **arrival unverified**; production function absent |
| HTML email line breaks | owner 11-27 | Y | N | N | N | CODED (this program) |
| Call-out/cancel/reservation integrity, two-approval race | owner 11-23 | Y | N | Y | N | IN-TEST |
| SMS (mock) incl. opt-in/STOP, quiet hours | owner 11-23 | Y | N | Y mock | N | CODED; live SMS DECISION |
| Service address + county + office on client profile | owner 11-24 | Y | N | Y | N | IN-TEST |
| County dataset | owner 11-24 | N | | | | DEFERRED by owner |

### D. Reporting and exports
| Item | Requested | Impl | Merged | TEST | PRD | Status |
|---|---|---|---|---|---|---|
| Export order = screen order (all CSV/report/audit/billing/auth/client/caregiver/candidate/incident) | owner 11-20 | Y | Y (#114) | Y | Y | DONE-PRD for the #114 set |
| Sorting on every list table, phone sort | owner 11-17/20 | Y | P (#114, #123) | P | P | PARTIAL; completion in #124 |
| Calendar lists every active client; zero-hour caregiver | owner 11-17 | Y | Y | Y | Y | DONE-PRD |
| Exceptions report **CSV / Excel / PDF(print)** | owner 11-27 | Y | N | N | N | CODED |
| **CSV/Excel/PDF for the other compliance reports** (holds, documents, readiness) | owner 11-27 | **N** | | | | **MISSING** |
| **Server-side PDF report service** | owner 11-27 | N | | | | MISSING (needs new-tool approval) |
| Month hours by source, billing review filters, office filter | owner 11-20/21 | Y | Y | Y | Y | DONE-PRD |
| Authorization worklist, Patriot payroll/billing handoff, Sandata reconciliation | owner briefs | **N** | | | | **MISSING: no brief** |

### E. UX, mobile, other open work
| Item | Requested | Impl | Merged | TEST | PRD | Status |
|---|---|---|---|---|---|---|
| UX redesign R1–R5, R8, R12–R14, R18–R20, R24, R27–R28, R31–R32 | owner/UX audit | Y | N (#108) | N | N | CODED; lineage reconciliation pending |
| Dashboard palettes (incl. primary colors) | owner 11-17/21 | Y | P | Y | P | PARTIAL; "not applied anywhere" (A12) unresolved |
| Requests/alerts cleanup, retire doc type, cancel doc request | owner 11-17 | Y | Y | Y | Y | DONE-PRD |
| Caregiver mobile 4-tab, today-only visits | owner 11-17 | Y | N | N | N | CODED; real-phone test not done |
| Save-to-phone for family care request | UX checklist | Y | N (#110) | N | N | CODED |
| Public homepage content | UX checklist | ? | ? | | | UNKNOWN |
| One end-to-end demo | UX checklist | N | | | | MISSING |
| Care Match review, finance reconciliation | UX checklist | ? | | | | UNKNOWN |
| NFC/QR visits, stickers, signatures | owner brief | Y (local) | N (#125) | N | N | CODED; 0120 conflict |
| Second-agency access | owner | N | | | | MISSING: no brief |

## 3. Missing items report (discussed, does not exist)
1. Document-expiry **reminders** (notifications are `cover_shift` only).
2. CSV/Excel/PDF for holds, documents and readiness reports (only the exceptions report has them).
3. Server-side Excel/PDF report service (new tool → your approval).
4. Per-office branded invitations and any actual branded send (Cognito trigger/sender not wired).
5. Live SMS (provider, number, registration undecided).
6. Sandata reconciliation, authorization worklist, Patriot handoff, second-agency access: **no briefs, nothing built**.
7. One end-to-end demo; family-link reopen test.
8. Written retention period for audit/override history.
9. County dataset (you deferred it).
10. Production cover-shift email function (SES identity + BAA/security gate).
UNKNOWN scope (need your word): public homepage, Care Match review, finance reconciliation.

## 4. Deployment mapping (TEST)
| Feature | Commit | PR | In TEST? |
|---|---|---|---|
| 0113 notifications, stage 1 | b0848ede | #124 | Y (in-app) |
| 0117/0118 open-shift SMS (mock) + service location | 9b2fdef8 | #124 | Y |
| 0119/0120 duplicate cleanup, exact-shift link, stage 3 | 620ccf35 | #124 | Y |
| Email Lambda, recipients (stages 4–6) | 0c85c5fe, b2fe3944 | #124 | Y (arrival unverified) |
| 0121 one email, 0122 unset type | 479fdf26, 428cfaea | #124 | Y |
| Caregiver profile redesign | 6a1f813e | #124 | Y (web a74d2ca5) |
| 0123 override + API routes + web | 72a51c0a, a74d2ca5 | #124 | Y (switch ON, 299 routes) |
| Caregiver holds menu entry | fcaf67c2 (pinned 44e49d4f) | #124 | **N** (web-only publish waiting for your go) |
| Exceptions export + HTML email fix | d9cc1aff (pinned 6b094d49) | #124 | **N** |
| Migrations 0114–0116 (branding, import history, merge hardening) | #124 | #124 | ledger only; switches OFF |
| NFC/QR | #125 head | #125 | **N** |
| UX redesign | #108 head | #108 | **N** |

## 5. Recommendation audit (made during development, not yet implemented or decided)
| Recommendation | Status |
|---|---|
| Release 1 as one readiness set (0121–0123 + API/web, switches off) | not executed; needs #124 merge |
| Clear queued TEST emails before the acceptance email (`CLEANUP_QUEUED_EMAIL.sql`) | owner action, unrecorded |
| Reply-To first, then SES sender; no-reply branded sender | TEST sender done; branded send not wired |
| Apply 0108 as verified no-op (production DB drift capture first) | **not done** (database-audit.md) |
| Align production object ownership | **not done** |
| Enable `staffDuplicates` in TEST, review groups, one merge + reversal | not done |
| XLSX import decision (API refuses XLSX by design vs requirement R11) | **unresolved** (feature-readiness.md) |
| Per-office branding via Cognito CustomMessage trigger | not built |
| Merge `stabilization/main-reconciliation` to `main` | superseded by #123 (merged) |
| Real-phone test of caregiver flow and new profile | not done |
| Close/archive stale PRs #53–#73, #98–#110 | not done |
| Close #121/#122 duplicates | not decided |
| Save rollback refs outside `/tmp` (INDEX.md) | partial; stage 2–3 lost |
| "Caregivers blocked now" operational report | not built |
| Written retention policy; BAA/security gate before production email | not done |

## 6. Corrections to earlier records
- Production **requestCleanup is ON** (deployment-status.md, repo config). The first matrix draft said OFF; fixed in the matrix (rows 6–7).
- Earlier I called the exceptions section "reachable from the menu"; it is not until 44e49d4f is published.

## 7. What you decide to unlock production
1. Merge #124. 2. TEST: publish the RC (API+web), activate enforcement, run runbook A–E, confirm the email. 3. Approve read-only production checks. 4. Name the production switches for Release 1. 5. Answer the section 3 items you want in or out.
