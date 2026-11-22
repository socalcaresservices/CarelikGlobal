# Admin procedure: correct a caregiver's invitation email before their first sign-in (reusable)

## Why
The app's "Resend sign-in link" goes to the address the invitation was ORIGINALLY sent to (`begin_invitation_resend` returns `caregiver_invitations.email`). Changing the contact email does not change that, and "Forgot password" is refused for an account that has never signed in. So an invitation sent to a mistyped address cannot be fixed in the app.

## What it does (one caregiver at a time)
`CORRECT_INVITATION_EMAIL.sh` (+ `.sql`), run in an open database session with AWS access:
1. Read-only checks: exactly one invited caregiver has that code; the invitation is for a NEW account, never signed in; the sign-in account (Cognito) is FORCE_CHANGE_PASSWORD, enabled, and is the account linked to this caregiver; the corrected address is free in Cognito and not used by another caregiver.
2. Typed confirmation `CORRECT-INVITATION-EMAIL`.
3. Cognito: set the account's email to the corrected address (marked verified). Same account, same identity.
4. ONE database transaction: invitation email replaced (send count +1), contact email set through the app's own `set_caregiver_contact`, audit event `caregiver_invitation.email_corrected` with old and new address and the reason. If it fails, step 3 is reversed automatically.
5. Fresh invitation (Cognito RESEND) to the corrected address: new temporary password valid 7 days; the old one stops working. If only this step fails, the account and Ogevia stay corrected and the operator presses "Resend sign-in link" in the app (now correct).
Output shows addresses masked only; no password is read or printed.

## Wrappers
`TEST_CORRECT_INVITATION_EMAIL.sh` (isolated TEST database via `TEST_DB_SESSION.sh`, TEST pool; refuses the production pool) and `PRD_CORRECT_INVITATION_EMAIL.sh` (production; needs `OGEVIA_DEPLOY_APPROVAL=owner-production-invitation-email-go`; temporary admin-host security-group attach restored on exit).

## Tests (local; real PostgreSQL with a stand-in sign-in service)
`infra/aws/db/test/correct-invitation-email.db.test.ts` (5): refusals leave everything unchanged; the correction changes account, invitation, contact and audit together and prints no full address; a database failure reverses the account change; a failed resend leaves it corrected with guidance. `infra/aws/test/invitation-email-fix-guards.test.ts` (5): wrapper guards and the commands the procedure may not use.

## Status
Built and tested locally 2026-11-22. NOT yet run on TEST. NOT run on production. Open question until the TEST run: how the real sign-in service treats an email change on an account that has not signed in (the TEST run answers it).
