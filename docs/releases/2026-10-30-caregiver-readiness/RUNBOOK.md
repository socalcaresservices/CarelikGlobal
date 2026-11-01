# Operator runbook: caregiver readiness (migration 0088) integrated onto the TEST line — DRAFT, NOT RUN

**This replaces the first runbook (migration then numbered 0086, commit `54894411…`), which is void: Phase C stopped at its gate and nothing was deployed.** Commands are in `PHASE_C_COMMANDS.md`; this file is the reference for what each part means. Owner decision 2026-10-31: the TEST line (`fb491a5`) is the base of record; see `INTEGRATION_RECORD.md`.

## A. What is in the package
| Artifact | Where | Pin |
|---|---|---|
| Code | commit **`464dea64cb939c49fbca624b652f34b2863db2f2`** on `claude/practical-tesla-r07odb` (readiness merged onto the TEST line `fb491a5`) | the only approved deployment commit |
| Migration (new) | `infra/aws/db/migrations/0088_caregiver_readiness_approve_for_work.sql` | in `PINS.md` |
| Rollback (BACKUP REQUIRED) | `infra/aws/db/rollback/0088_caregiver_readiness_approve_for_work.down.sql` | in `PINS.md` |
| Staff migrations (already on TEST, applied outside the ledger on 2026-10-29) | `0086_staff_management.sql` sha256 `8eb7b4a353300ba78156bd58a0df6cbc9857b677cec0e8ec51233fcda5a16a4f`; `0087_staff_invitation_acceptance.sql` sha256 `f9d75d8c776005873b6019ca2d76353d182772144b9946cadd3291cdbad4cf88` | equal to the bytes pinned in the TEST-line procedure |
| Migrations 0001-0085 | `infra/aws/db/migrations/` | set sha256 `de0c8abbe12023ba6b7291661f592c7636ef0912827fb5ca57ccf12dac5608ef` (unchanged) |
| Sets 0001-0087, all 88, rollback set 0088 | same | in `PINS.md` |
| Scripts and gate | `STELLA_PHASE_C_DB.sh`, `STELLA_PHASE_C_DEPLOY.sh`, `diff_gate_0086.py`, `STELLA_READONLY_VERIFICATION.sql` | in `PINS.md` (filled once the owner gives the window and GO) |

## B. Confirm the target (read-only; the `probe` mode does this)
`current_database()` must be `ogevia_sv_test` (the same RDS instance also holds production's `ogevia_prd`). Expected: ledger 85/`0085`; **staff objects present**; readiness table absent; 5 of 6 caregivers Ready/Active; enforcement empty in all organizations; the Lambda serves `ogevia_sv_test`.

## C. Pre-flight
Owner names the window and the GO reference. A manual encrypted RDS snapshot of `ogevia-prod-postgres` (mandatory: 0088 changes data, and `adopt` writes the ledger). `capture` saves the rollback material (live API template, Lambda code reference, web bucket copy). `check` is the real `cdk diff` and must show only the 8 routes and the Handler asset.

## D. What the release changes
| Layer | Change |
|---|---|
| Database | **`adopt`**: two ledger rows for the staff migrations already on TEST (no object changes). **0088**: new tables `organization_compliance_settings`, `caregiver_cpr_tb_extensions`, `caregiver_work_approvals`, `caregiver_contacts`; new and replaced functions (including `list_accounts`, merged with 0087's invitation logic); **data written:** one `legacy_status` approval per caregiver who is Ready/Active today (expected 5); three onboarding requirement categories set inactive (nothing deleted) |
| API | 8 new routes (`GET .../readiness`, `POST .../approve`, `POST .../cpr-tb/extend`, `GET .../cpr-tb/extensions`, `GET` and `POST /v1/compliance/settings`, `POST .../contact`, `POST .../signin-link`) and the `withClientNames` fix; the 14 staff routes are unchanged |
| Web | rebuilt caregiver page, Caregivers list, Staff-accounts list and Recruiting link; the staff screens are untouched |
| Behaviour change the owner asked for | the 14-day CPR/TB rule becomes an agency setting, default 30; a missing CPR/TB no longer blocks work inside its due date (reverses the 2026-10-19 rule); Approved/Active can no longer be set by the status picker |
Order: database (`adopt`, then `migrate`), API, web, deployed as one unit. A new database with the **old** API or web is safe for reads; the new API on the old database is not supported.

## E. Apply
`probe` -> `capture` + `check` -> `snapshot` -> `adopt` -> `migrate` -> `deploy-api` -> `web` -> checks (F) -> `final`, exactly as `PHASE_C_COMMANDS.md` section 1. Each mode refuses outside the window and stops on any difference.

## F. Checks only the real environment can prove (checklist B10 carried to C6)
Synthetic caregivers only; the sign-in pool may be shared, so never disable or change a real person.
1. **Cognito invitation:** add an email to a synthetic caregiver and press Send sign-in link: Cognito sends one message; the page shows "Invited, has not signed in yet" and "Last sent". Resend within a minute is refused; after the first sign-in the control disappears.
2. **Message content:** read the received email: it must contain no client or health information.
3. **Temporary password:** it works once and expires after the pool's configured validity (read the pool setting; record the days). This was NOT verified by Claude.
4. **Routes:** each of the 8 routes answers (200/409 as expected) for the right role and 401 without a token, 403 for a caregiver, 404 across agencies.
5. **CloudFront:** the new bundle is served; open the caregiver page on a phone: no sideways scroll, buttons easy to press.
6. **Migration on populated data:** counts from the probe match (ledger 88/0088 after); `select count(*) from ogevia.caregiver_work_approvals where source = 'legacy_status'` equals the pre-release `ready_or_active` (5); no caregiver lost scheduling (open the Schedule as the Scheduler).
7. **Task 8:** run `TASK8_ACTIVE_CAREGIVER_GAPS.sql` (read-only) and send the output to the owner **before** enforcement is switched on.
8. Regression set R and smoke set S from the catalog.
9. **Staff regression (new, from the integration):** the staff screens and routes of the TEST line still work: Staff and Staff types lists load, the Accounts list loads and an invited person reads "Invitation pending", the 14 staff routes answer 401 without a token. These are the routes the first candidate would have removed.

## G. Rollback
| Order | Action | What it cannot undo |
|---|---|---|
| 1. Web | `rollback-web`: restore the captured files (assets first, `index.html` last; nothing deleted) | nothing is lost |
| 2. API | `rollback-api`: put the previous Lambda code back (the captured asset still exists) | CloudFormation is then out of step with the stack; sign-in links already sent stay sent |
| 3. Database | `rollback`: runs the 0088 down script (BACKUP REQUIRED) | **drops** `caregiver_work_approvals`, `caregiver_cpr_tb_extensions`, `caregiver_contacts`, `organization_compliance_settings` with their rows; restores the earlier functions and the 14-day rule and `list_accounts` as 0087 left it; re-activates the retired onboarding requirements. **Staff objects and their two ledger rows are NOT touched.** |
Restoring the snapshot creates a NEW instance and is not authorized. Call a rollback when a gate fails, a caregiver Ready/Active before cannot be scheduled, any cross-agency read is seen, or a staff screen or route regresses.

## H. Enforcement
This release does not switch enforcement on, and the application cannot switch it off again. After the Task 8 report is reviewed, the owner activates it on the Readiness screen. With enforcement on, a caregiver past the CPR/TB due date cannot get a new shift; Active caregivers are never deactivated automatically.
