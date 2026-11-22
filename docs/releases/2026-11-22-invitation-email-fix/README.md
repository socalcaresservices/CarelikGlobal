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

## TEST run (owner, CloudShell, 2026-11-22) - procedure completed
Release commit `798f37262e3d69a48ae3ce98463e98b880279991`, caregiver `CG-D86216F3` ("sign in test caregiver", a new account, never signed in, invited to a real inbox). Operator output: sign-in account email changed; database transaction "CORRECTED: the invitation and the contact email for caregiver CG-D86216F3 now use the corrected address; one audit event written."; "invitation sent"; read-back: sign-in account status FORCE_CHANGE_PASSWORD, email verified true, same account: yes; Ogevia invitation email and contact email both the corrected address, invitations sent 2.
This answers the open question: the real sign-in service accepts an email change on an account that has not signed in, and a RESEND then goes to the corrected address.
NOT yet verified by the owner: that the fresh invitation email arrived, that its temporary password signs in on TEST (and that the old password no longer works), and that "Resend sign-in link" in the app now targets the corrected address. Cosmetic: the output shows a stray `pg_advisory_xact_lock` table (a psql display detail). Production: NOT run.

## TEST run 2 (owner, CloudShell, 2026-11-22): full end-to-end on a NEW dummy caregiver - PASSED
Release commit `7fca778457589aa213cd85e44f17b5cfbcc2f49c`. Caregiver `CG-5EAC30D3` ("wrong email", invited to a deliberately wrong address, never signed in). `PROCEDURE=lookup` found it (still pending: YES); `PROCEDURE=check` stopped correctly when the first corrected address belonged to another TEST account ("another sign-in account already uses the corrected address"), then PASSED with an unused plus-address; `PROCEDURE=correct` read back: sign-in account email changed, FORCE_CHANGE_PASSWORD, email verified, same account: yes; Ogevia invitation and contact email both corrected, invitations sent 2.
Owner result ("passed"): fresh invitation reached the corrected inbox; the original temporary password is rejected; Resend sign-in link (after the one-minute limit) reached the corrected inbox; the newest password signs in and Ogevia asks for a permanent password; the audit entry `caregiver_invitation.email_corrected` is present. The owner did not itemize each step in chat; recorded as passed as reported.
Resend "blocked" diagnosis: the app refuses a resend only when the caregiver has already signed in, had a prior account, within 60 seconds of the previous send (the correction itself counts as a send), or after 5 resends in 24 hours. None is a defect; no code change was needed. The `lookup` and `check` modes were added in this work (read-only).
