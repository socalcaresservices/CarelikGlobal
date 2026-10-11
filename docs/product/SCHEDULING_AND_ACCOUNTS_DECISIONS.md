# Scheduling redesign and account management: owner decisions

Recorded 2026-10-11 from the owner's written answers in the Claude session. Status of everything below: **approved design decision. Not implemented. Not deployed.** The audit these answer is in the session record; it found most scheduling and availability logic already exists (migrations 0011-0046, `apps/sv-api`, `apps/web/src/aws`).

## Decisions approved by the owner

| # | Decision | Owner answer |
|---|---|---|
| 1 | Store caregiver **contact email and phone** in a **separate table**. The **login email lives in Cognito only**; it is not copied into the application database. | Yes |
| 2 | Widen the identity Lambda's Cognito permissions by **exactly three capabilities**: update a user's email, disable/enable a user, send a password-reset. Nothing else (no set-password, no delete, no role/group changes). | Yes |
| 3 | The Admin **cannot set or see a temporary password.** Cognito's emailed temporary password and the reset email are the only paths. Passwords are never displayed, stored or logged. | Yes (recommendation approved) |
| 4 | An Availability Match override covers **one shift only.** A second shift needs a second explicit Admin decision. | Yes |

## Requirements carried with these decisions (from the owner's brief)

- Terminology stays **Match / Partial Match / No Match**.
- Admin (organization owner) may override a **No Match**; Manager may not. The override needs a reason and records caregiver, client, shift, original match result, Admin, reason and time, is audit-logged, and is shown on the shift as "assigned with Admin override". It never changes the caregiver's stored availability and never makes similar shifts eligible. Ongoing availability changes go through Edit Availability.
- Contact information and login account are separate things. Do not assume one email serves both. Client contact stays separate from any client login; clients get no Cognito account (token links are unchanged).
- Account actions are server-side permission controlled, Admin-only for now (Manager keeps only the existing caregiver invitation right; Office Assistant gets none). An Admin cannot grant a role above their own authority.
- Changing a login email must update the **same** Cognito user so the `sub` is unchanged and membership, role, caregiver link, assignments, history and audit stay intact. No duplicate identity, no database-only edit. A replacement login re-links the existing caregiver record to the new `sub`; it never creates a second caregiver record.
- Audit: account created, invitation sent/resent, login email changed, enabled, disabled, password reset started, role changed, availability overridden. No passwords and no full email addresses in audit rows.
- Status shown in plain words: Active, Invitation Pending, Password Change Required, Disabled, Account Setup Required.

## What the audit found that these decisions build on (VERIFIED by code read, 2026-10-11, `main` = `24eabe2`)

- An Admin-only availability override already exists (`ogevia_api.authorize_availability_override`, permission `availability.override`, `availability_overrides` table, audit on grant and on use). It is bound to a caregiver and a time range with a 30-minute expiry, not to a shift, and does not store the original match result. Decision 4 repairs this mechanism; it does not add a second one.
- Caregiver invitations exist (`begin_/complete_caregiver_invitation`, identity Lambda with `AdminCreateUser` and `AdminGetUser` only). No route changes a login email, disables a user or starts a password reset; the email change exists only as an operator script for the test pool (`infra/aws/slice/pilot-change-email.sh`).
- The only email stored for a caregiver today is the invitation address in `caregiver_invitations`, which mixes login and contact purposes. Caregiver and client records have no phone or contact email columns.

## Classification of the approvals

| Item | Action class (CLAUDE.md section 13) |
|---|---|
| Widen identity Lambda IAM / Cognito permissions (decision 2) | **YELLOW**: prepare the CDK change and diff; deploy only on separate explicit owner approval |
| New contact table migration (decision 1) | Additive migration; apply to AWS only after approval (YELLOW) |
| Override repair, status display, API and UI code | GREEN to write and test locally; deployment is YELLOW |

## Still open (do not block the override or account work)

1. Which existing role is the **Office Assistant** (recommendation: `scheduler`, with its edit rights reduced only after the owner confirms).
2. Whether to **activate readiness enforcement** for SoCal Care Services (production policy change).
3. Whether authorizations also have a **whole-period cap**, or only a monthly cap.

## Recommended build order (each step separate, tested first, separately deployable)

1. Availability override repair: bind to one shift and client, store the original match result, single use, show on the shift, relabel Match / Partial Match / No Match.
2. Account status in plain words, and enable/disable (adds one Cognito action).
3. Change login email and send password reset (adds the other two Cognito actions).
4. Caregiver contact email and phone table, with the Admin edit screen.
5. Staff invitations (manager and other roles) with role-limit checks.
6. Scheduling work from the audit: minimum shift, commit-time enforcement, client overlap check, recurrence patterns, series summary.
