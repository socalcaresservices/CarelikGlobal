# Release record: caregiver readiness, migration 0088, integrated onto the TEST line (TEST/pilot only)

**Status: DEPLOYED TO TEST. UAT CLOSED WITH OUTSTANDING ITEMS (owner decision D36). 0088 is NOT RELEASABLE (D7). Nothing is deployed to production.**
**Recorded:** 2026-11-01 09:42 UTC. **GO reference:** `GO-0088-TEST-20261101-C` (window 2026-11-01 07:30 UTC to 2026-11-02 02:00 UTC). **Application commit:** `464dea64cb939c49fbca624b652f34b2863db2f2`. **Owner:** the founder. **Operator:** Stella Okereke. Evidence grading: VERIFIED = pasted terminal output or a screenshot; REPORTED = stated by the owner without output.

## 1. What is deployed (TEST slice only)
| Layer | State | Evidence |
|---|---|---|
| Database `ogevia_sv_test` (RDS `ogevia-prod-postgres`, which also holds production `ogevia_prd`, untouched) | Ledger 88/0088. `adopt` wrote ledger rows 0086 and 0087 (no schema change); `migrate` applied 0088 only. Five `legacy_status` approvals. Enforcement off in all four organizations. | VERIFIED: `adopt` (08:09:47Z), `migrate` (08:11:42Z), `final` (09:25:12Z) |
| API stack `Ogevia-prod-ServiceVerificationApi` | `UPDATE_COMPLETE`; Handler code asset `9e5a510e...`; `CodeSha256 Qkm9W6hmnzo21MOwc7RfNGDSsxms9pgaQ4t4ZX9verI=` (was `VFN/cMO3...`); 250 routes (8 added, none removed); Lambda environment unchanged | VERIFIED: `deploy-api` (08:16:41Z) |
| Web (CloudFront `d2xumch5w0izfg.cloudfront.net`, alias `demo.ogevia.com`) | Serves `index.html` sha256 `e0b7cd56dae72cff85ff25dcccb1dd0c024450b8f4d4403d02e748ad1cb1e467`, commit `464dea64...`, built for TEST, `config.json` unchanged | VERIFIED: `web-verify` (08:27:51Z); alias VERIFIED by DNS and hash |
| Rollback material | RDS snapshot `ogevia-prod-postgres-pre-0088-20261101t0752z` (available, encrypted); `~/ogevia-before-0088` (165 web files, previous API asset `2871b03d...`) in the operator's CloudShell home | VERIFIED |

Final database state (S11): `ledger=88/0088  readiness_table=ogevia.caregiver_work_approvals  staff_objects_present=true  ready_or_active/caregivers=5/7  orgs_enforcing=0`. Total caregivers later rose to 11 through UAT data preparation (section 4).

## 2. Amendments made during the window (all approved by the owner; scripts and pins in `PINS.md`)
A22 window `-C`; A23 probe staff-object check uses a catalog query; A24 `vrun` no role switch; A25 expected `verify-0087.sql` rows 22 (not 24); A26 `web-verify` hashes raw bytes; A27 accepted deviation (a caregiver added by mistake). Final script hashes: `STELLA_PHASE_C_DB.sh` `f819a402a0920b1dab14d5234442f650b445c4c516c2cb17159aead3e94ce4de`, `STELLA_PHASE_C_DEPLOY.sh` `8540c3d35f742644609a7879ed8570b9b087297d909074d9ba4ba5832281d54f`. Each stop was caused by a defect in the author's script (none in the application or database) and none changed AWS state. Detail: `INTEGRATION_RECORD.md` sections 17-21.

## 3. Phase C results (S0-S11)
S0, S2 (probe, after A23), S3 (capture, expected-only check), S5 (snapshot), S6a (adopt, after A24, A25), S6b (migrate), S8 (deploy-api), S9 (web, after A26), S10 (functional checks), S11 (final): complete. Details and the withdrawn staff-screen report: `INTEGRATION_RECORD.md` section 21.

## 4. UAT (Phase D) results, 2026-11-01
**Data preparation (synthetic, through the screens):** UAT Ready (hire date 10/29/2026, background verified, training done, sign-in link sent to the one reserved test mailbox, signed in once, then Approved), UAT NoEmail (10/22/2026, 2 of 5, no email), UAT Overdue (09/22/2026, 2 of 5, CPR and TB overdue, flagged only), UAT NoBg (Not approved result recorded; training done; no email). One caregiver was added by mistake (A27). Caregiver total is now 11. One shift (4 hours, today) for UAT Ready on a synthetic client; one visit started, ended, confirmed with a drawn signature by a synthetic confirmer, and locked. One new sign-in identity exists in the user pool for the reserved test mailbox (the address is not stored here).
**Passed (REPORTED unless stated):** O1-O4, O6 (Not approved half), O8, O9 (double click approved once), O10, O15 (VERIFIED by screenshots for this agency), O19, O20, S3 (UAT NoEmail not offered), S5 (Hours left dropped by 4 hours), C2-C6 (caregiver sees only caregiver menus; `/care-team` refused; only the assigned client by code; visit locked), plus F1, F2, F3 (invitation worked once and forced a new password; message generic, no client or health information, link to the TEST site).
**NOT RUN, by owner decision (D35, D36):** O11, O12 (CPR/TB extension and its history), O13 (enforcement on; not recommended), the authorization validator A1-A4, cross-agency isolation X1-X3, O18 (list on a phone), S4, S6.
**BLOCKED:** O5 and O7 sign-in halves, O16, O17, C8 (D25: one mailbox); S1, S2, S7 (no Scheduler login; D24: no new users); O14 (needs the Operator's administrator token); O6 "Completed only" half (no such control in the readiness checklist).
**Defects found:** none Blocker, none Major. Minor/wording: (1) "overdue since the due date" is printed when no hire date is recorded (the code treats a missing hire date as no grace); flag-only while enforcement is off. (2) The UAT script text for O5, O6, O7, O16 still assumes more than one mailbox and a "Completed" control.

## 5. What is outstanding (D7: 0088 NOT RELEASABLE until completed or formally accepted by the owner)
1. O11, O12 (extension), A1-A4 (authorization arithmetic on three clients; static evidence only: 0088 contains no authorization, reservation, billable or balance object), X1-X3 (cross-agency isolation, live), O14, O18, S1, S2, S4, S6, S7.
2. F4 role gating live (403 for a caregiver, 404 across agencies) and the F8 regression and smoke sets: covered by automated tests only.
3. F7 Task 8 (`TASK8_ACTIVE_CAREGIVER_GAPS.sql`) before enforcement is switched on; needs a new database access approval.
4. The temporary-password validity (days) from the pool setting.
5. Owner decisions: is an API-only due-days setting acceptable (O14)? Should "Add staff" with the Caregiver type hand off to Add caregiver (undecided; untested)? Wording for the no-hire-date overdue line?
6. Housekeeping the owner decides: the pre-release RDS snapshot `ogevia-prod-postgres-pre-0088-20261101t0752z` (**owner decision 2026-11-01: delete later; it is retained for now, no date set; small storage cost until deleted; deleting it needs the owner's explicit instruction**); the UAT synthetic caregivers, shift and visit (left in TEST); the extra caregiver from A27; the Cognito identity for the test mailbox (deleting needs pool admin access).

## 6. Not done and not claimed
Production deployment (out of scope; no production resource was touched). Enforcement switch (off; the product treats turning it on as hard to undo). Any claim of EVV, certification, audit-readiness or payer billing readiness. Any statement that the security review of the merge happened (it was waived, `SECURITY_REVIEW_INTEGRATION.md`).
