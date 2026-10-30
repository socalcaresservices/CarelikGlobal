# Caregiver readiness simplification: discovery (Task 1)

**Status: DISCOVERY ONLY. Nothing implemented, nothing changed in any database, nothing deployed.**
Checkout: `claude/practical-tesla-r07odb` at `466f8ac`, equal to `origin/main` (fetched 2026-10-30). Source: repository read only. No live database, AWS or demo.ogevia.com access was used.

## 1. Which backend backs the page you saw
| Finding | Status |
|---|---|
| The strings "Compliance clearance", "comes last", "Not eligible under the rules" and "Pending documents" exist **only** in the AWS build (`apps/web/src/aws/*`, `infra/aws/db/migrations/0054`, `0055`). The Supabase build has none of them. So the page you observed is the **AWS / Cognito / RDS build**. | INFERRED (strong) |
| The Supabase tables in the brief (`caregiver_record_credentials`, `candidate_onboarding`, `candidate_credentials`) are the legacy path and do **not** feed this page. `caregiver_records` and `document_requests` exist on both sides but the readiness logic lives in the `ogevia` schema (migrations 0001 to 0085). | VERIFIED (code) |
| What `demo.ogevia.com` serves, and from which stack, is **not** in the repo. `docs/aws/INVENTORY_RECONCILIATION_2026-10-21.md` states no domain or certificate for it existed in the AWS account on 2026-10-21. | UNKNOWN |

## 2. Canonical source per requirement (AWS schema)
| Requirement | Where it lives today | Notes |
|---|---|---|
| **Background check** | **Two unrelated tables.** (a) `ogevia.caregiver_onboarding_items` row for requirement `background_check` (0054): `completed_on`, `recorded_by`, `note`. Written by `record_onboarding_item`. (b) `ogevia.caregiver_background_checks` (0055): `status`, `result`, `verified_by`, `verified_at`. Written by `set_background_check_status` / `verify_background_check`. History in `caregiver_background_check_events` (0064). | **This is the conflict.** The **Onboarding** card ("Recorded 10/16") reads (a). The **Compliance** card ("Verified by ogeviamanager on 10/30") and the actual assignment gate (`compliance_blockers` → `background_clearance_state`) read (b). Only (b) requires `result = 'approved'`, a verifier, and blocks the self-verify case. (a) is advisory for the checklist only. Nothing links them. |
| **CPR / TB** | `ogevia.document_requirement_check()` (0041) over real document records and `document_requirement_policies`. Appears in the checklist (0054), in `compliance_blockers` (0055/0064), in the Documents section, and the header. | One function decides "ok"; four screens label it differently. |
| **Required training** | `caregiver_onboarding_items`, requirement `training` (0054). | Single source already. |
| **Sign-in state** | `caregiver_records.linked_user_id`, `organization_memberships.status`, `caregiver_invitations.first_signed_in_at` (0025). `list_caregivers` returns `first_signed_in_at`. | `first_signed_in_at` is only set when an **invitation row** exists. A caregiver who never had an invitation has no sign-in record. |
| **Contact (email / phone)** | Email only, and only inside `caregiver_invitations.email`. **No email or phone column on `caregiver_records` or anywhere else.** | This is why "Add contact" has nowhere to save today, and why "Resend invitation" cannot deliver. |
| **Hire date** | `caregiver_records.hire_date` (0055). Editing rules in `set_caregiver_hire_date`. | Single source. |
| **Grace days** | `ogevia.compliance_grace_days()` hard-coded to **14** (0055). | Needs to become an agency setting (default 30). |
| **Status** | `caregiver_records.status`, set by hand through `set_caregiver_status` (0054). Values: applicant, interview, offer, onboarding, pending_documents, ready ("Approved"), active, inactive. The gate on `ready`/`active` checks only the **0054 checklist** (including its own "Compliance clearance" item), **not** the 0055 background verification or sign-in. | Status is not calculated from the checks. |
| **Enforcement setting** | `organization_readiness_settings.enforcement_active_from` (0042). | Keep as is. |
| **"4 need attention"** | Counted in `get_compliance_summary` / readiness report (0055, `readiness-card.tsx`), which counts caregivers who *would be held*, not "not Active". | Different definition from the Caregivers list status. |
| **Staff "Invited" vs Caregivers "Pending documents"** | Staff list label comes from `account-status.ts` (account/invitation state). Caregivers list label comes from `care-team-admin.ts` (manual `status`). Two vocabularies, no shared function. | |

## 3. Why the compliance clearance errors "comes last"
`record_onboarding_item` (0054 line ~636) rejects the `clearance` item until all other required items are done, but the UI still opens the form. That is the "form then error" you described. It is removed by replacing the item with **Approve for work**.

## 4. Proposed canonical choices (for your confirmation; not applied)
1. **Background check: `caregiver_background_checks` is canonical.** It already carries `result`, verifier and time, has history (0064), and is what the gate enforces. The `background_check` onboarding item is retired as a read path (rows kept, nothing deleted).
2. **Sign-in:** "has signed in" = `caregiver_invitations.first_signed_in_at is not null`, or a linked account with no pending invitation. To be confirmed against live data before enforcement.
3. **One readiness function** in the `ogevia` schema returning one row per requirement (state, due date, blocking, next action). `list_caregivers`, the detail page, the Staff list, `get_compliance_summary` and `readiness_checks` all call it.
4. **Status** becomes a calculated value from that function plus the approval record and a manual `inactive` flag; the stored `status` column stays for history.

## 5. Decisions and blockers before I build
| # | Item | Why it matters | Recommendation |
|---|---|---|---|
| D1 | **Where the contact lives.** No phone/email column exists. | "Add contact" and "Send sign-in link" need it. Contact is PII. | Add `contact_email` and `contact_phone` to a restricted table (not `caregiver_records` reads used by lists). |
| D2 | **SMS delivery.** No SMS provider is in the stack. SNS/Pinpoint is a new billable AWS service and US SMS needs carrier registration. | CLAUDE.md requires owner approval and a cost note for new services. | **Ship email first** through the existing Cognito invitation path; add SMS only after you approve the service and cost. |
| D3 | **"Single-use expiring link."** Today's invitation is a Cognito temporary password, not a magic link. | The brief's link semantics differ from the current mechanism. Cognito temporary passwords already expire (configured validity) and are single-use at first sign-in. | Reuse Cognito invitation and resend; do not build a custom token system unless you want it. |
| D4 | **Task 8 (existing Active caregivers) needs live data.** I have no database access from this session. | Cannot report real caregivers or dates from the repo. | I will prepare a read-only query that you or I run against the demo database, not run it blind. |
| D5 | Which environment is "demo" (which RDS, which branch). | Migration target and test target. | Confirm before any migration is applied. Nothing will be applied without your GO. |

## 6. Work plan after your go-ahead on section 4 and D1 to D3
Migration `0086` (readiness function, grace-days setting, extensions table with audit, approval record, calculated status, rollback `0086.down.sql`), API routes in `apps/sv-api`, rebuilt detail page and aligned lists in `apps/web/src/aws`, and the tests you listed. I will follow `docs/TESTING_AND_RELEASE_PROCESS.md` and not push or deploy.
