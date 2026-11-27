# Release Candidate 1 and TEST end-to-end validation (2026-11-27)

**Release Candidate = branch `feature-completion-phase-2` (PR #124, draft) at the commit recorded in section 1.** It contains everything approved since go-live that is coded: RT2 (0113–0120), 0121 one-email, 0122/0123 readiness, the compact caregiver profile, the Caregiver holds menu entry, the exceptions export, and the HTML email fix. Production is not touched. Nothing here is "tested" until the owner verifies it in TEST (I have no AWS access).

## 1. Assemble the candidate in TEST (owner runs; order matters)
| Step | What | Where it is already |
|---|---|---|
| 1 | Migrations 0113–0123 | **Already applied in TEST** (owner-reported ledger through 0123) |
| 2 | API Handler + email function with `readinessOverrides` ON | Deployed at stage 7 (a74d2ca5) — the HTML line-break fix needs one API redeploy |
| 3 | Web | a74d2ca5 live; menu entry + exports need one web publish of the RC commit |
| 4 | One combined stage-8 TEST publish (API + web) of the RC commit | Prepared after the re-pin commit; use the existing N7-style script with `OGEVIA_APP_BASE` set to the RC commit if only tests/docs differ |
| 5 | In TEST only: set up CPR and TB document types, then activate enforcement (**one-way**; owner must say "activate") | Not done |
Rollback: RDS snapshot taken before each stage; `rollback-plan.md` lists the per-stage order; migrations 0121–0123 have `.down` files.

## 2. Validation runbook (synthetic data only; record pass/fail per line)
**A. Caregiver lifecycle**
1. Invite a new caregiver with a fresh email → accepted. Invite a second person with the same email → refused ("already used by someone else").
2. Profile opens on Overview; tabs Readiness / Assignments & availability / Documents; one compact row each; Edit/Manage open editors.
3. CPR/TB with no type set up: row shows "Setup needed"; an approved caregiver is **not** blocked by that alone (0122).
4. Upload CPR (expired date) → "Expired Doc", Blocked, Approve button. Document status stays expired after approval.
5. Revoke the override → block returns.

**B. Scheduling (enforcement ON)**
1. Eligible caregiver can be assigned.
2. Expired CPR, no override → refused with the reason.
3. Admin approves override (reason required) → assignment succeeds; row shows Expired Doc + Admin Approved + Details.
4. Caregiver never approved for work: admin records work approval and override → schedulable.
5. Second, different expired document or later expiry date still blocks; overlapping shift, hours limit and client authorization still enforced.
6. Manager/scheduler (no compliance permission) cannot approve or revoke.

**C. Operations**
1. Operations → Caregiver holds opens with the action queue empty; "Admin-approved exceptions" lists active and revoked overrides.
2. Follow-up queue shows "Expired Doc · Admin Approved" for the approved caregiver.
3. Open-shift alert: caregiver gets in-app alert; View shift lands on that shift; request/withdraw; office sees requests in time order.
4. Email alert (stage 6 recipient): arrives, line breaks preserved, link opens the exact shift **for the right caregiver**; no client detail in the text.

**D. Reporting and exports**
1. Admin-approved exceptions: Export CSV, Export Excel, Print or save as PDF — same rows as the screen; a reason starting with `=` is exported with a leading `'`.
2. Existing CSV exports (calendar, incidents, candidates, billing, authorizations) match on-screen order (R39).
3. Bulk-import template downloads as CSV and XLSX.

**E. Compliance**
1. Audit: each approval, revocation, one-email refusal, shift change has an audit row with actor and time (`CHECK_READINESS_OVERRIDE.sql`, read-only).
2. Tenant isolation: CI `tenant-isolation-sweep` green; in TEST, a user of another agency cannot read the override list.
3. HIPAA: no PHI in logs/alert text (spot check CloudWatch for the test shift).
4. Retention: record the owner's retention period decision (not decided; gap C-3).

## 3. Pass criteria
All of A–E pass with enforcement on; email arrival confirmed by the owner; no failing CI check on the RC commit.
