# V5, V6 and V7: prepared, NOT executed

Written 2026-10-28 for candidate `fb491a5`. **None of these has been run, and none is passed, failed or excepted by this document.** They are run with the Owner after the TEST upgrade (and V4). Each result is recorded only from the Owner's own words or pasted output as PASS, FAIL, BLOCKED or NOT RUN. A missing e-mail or failed sign-in is a FAIL or BLOCKED, never an exception.

## 1. V5 - staff invitations on TEST (new accounts, existing accounts, M-1 / L-1 / L-2 / L-3)

Use inboxes you control (plus-addresses of the TEST Owner's Gmail). Signed in as the TEST Owner (`https://demo.ogevia.com`, amber TEST band visible). Run the read-only checker (`invitation_checks_v4.py`, V4 section 5 for the setup lines) where marked **[CHECK]**. `INVITEE` is the sub of account X (see V4 section 2).

**Getting an invitee X that already belongs to another agency (the M-1 situation).** X must be an existing TEST sign-in with a membership in an agency other than the Owner's, whose inbox you control. Try, in this order:
1. Account D or E (the other-agency accounts of V4), if you can sign in as one (use "Forgot password" on the sign-in page; the sign-in e-mail address of a sub is read with `aws cognito-idp list-users --user-pool-id us-west-2_849AYz5J7 --region us-west-2 --filter "sub = \"<sub>\"" --query 'Users[0].Attributes[?Name==\`email\`].Value' --output text` in your own CloudShell; do not paste the address anywhere).
2. If you can sign in as an Owner of another synthetic agency (D or E), invite `admin.ogevia+m1@gmail.com` there as Staff; under 0087 a brand-new sign-in is active at once. X is then that new account (it belongs to the other agency only).
3. If neither works: the live M-1 check is **BLOCKED** (no suitable account). The Owner then decides whether the database and API tests of the same behaviour (`staff-management.db.test.ts`, `staff.db.test.ts`, run in CI on PostgreSQL 18) are enough for TEST, or asks for a second synthetic agency to be created. This document does not decide that.

| Step | Do (browser) | Expect | Record |
|---|---|---|---|
| 5.1 | Staff > **Add staff**: name "V5 Existing Person", type Scheduler, contact e-mail = X's inbox, Save | listed with **No sign-in**, no duplicate | |
| 5.2 | On that row **Invite**: sign-in e-mail = X's e-mail, role **Read-only** | success message: "Invitation recorded. If this email already has an Ogevia sign-in, the person is asked to accept when they next sign in; until then they have no access." The text is the **same** for a new e-mail, an existing one and a disabled one (L-1). The row shows **Invited**. | |
| 5.3 **[CHECK]** | `python3 invitation_checks_v4.py --client-id $CLIENT --owner-sub $OWNER --invitee-sub $INVITEE --phase before --expect-role read_only` | `INVITATION CHECKS PASSED`: the invitee has **no** membership in the Owner's agency (M-1), the Owner's agency is a **pending invitation** with role read_only and nothing else, the four staff routes refuse the invitee, the Owner's list shows an Invited person | |
| 5.4 | Sign in as X (their own password). | A panel "You have been invited to an organization": the agency name and "as Read-only", an **Accept invitation** button. X's own agency still works. **No** access to the Owner's agency data yet. | |
| 5.5 | X presses **Accept invitation**. | The panel disappears; the agency switcher now lists both agencies; X can open the Owner's agency with the Read-only menu (no Staff, no Billing). | |
| 5.6 **[CHECK]** | `... --phase after --expect-role read_only` | `INVITATION CHECKS PASSED`: membership present, nothing pending, own agency unchanged, a member without staff permission is refused (403) | |
| 5.7 (L-2) | As the Owner invite the same e-mail again on **another** staff row. | Refused ("That email is already used by someone else in this agency"; if the second row has no other use of the e-mail, "…already has access to this agency or a pending invitation"). Nothing changes: X's role and status stay as they were. | |
| 5.8 (L-3) | As the Owner open X's row > **Edit** > Status **Inactive**. The form warns: "Setting this person inactive also stops their access to this organization. Making them active again does not give the access back; use Accounts > Enable." Save. | The row reads **Inactive**. X reloads: the Owner's agency is gone from their list (their own agency stays). | |
| 5.9 **[CHECK]** | `... --phase inactive` | `INVITATION CHECKS PASSED`: no membership in the Owner's agency, the four staff routes refuse | |
| 5.10 | Set the person **Active** again; X still has no access; Accounts > **Enable** X. | access returns only through Enable | |
| 5.11 (Disable of a pending invitation) | Needs a **second** existing account Y that belongs to another agency; if none is available this step is **NOT RUN** (the behaviour is covered by the database test "M-1: Accounts > Disable refuses a pending invitation…"). Invite Y; before Y accepts, try Accounts > **Disable** on the pending person. | Refused: "This person has not accepted the invitation yet…". Then Enable: nothing changes; the person is still Invited. | |
| 5.12 (new account) | Add staff "V5 New Person"; Invite `admin.ogevia+v5new@gmail.com`, role Scheduler. | An invitation e-mail arrives; the row shows **Invited**; after the person sets a password and signs in, **Active**; **no** accept panel is needed for a brand-new sign-in. | |
| 5.13 (resend) | Resend the invitation for the pending existing account. | Expected from the code, not previously observed on TEST: an error "This person has already set up their sign-in; they can use Forgot password" (no e-mail is sent to an existing account); the person still sees the panel when they sign in. Record what actually happens. | |

Cleanup: nothing is deleted by hand. Disable or set inactive through the product.

## 2. V6 - role validators (people-run)
`RELEASE_COMPLETION_TEST.md` defines V6 as validators **other than the Owner**: Scheduler, Caregiver on a phone, Authorization. If you perform them yourself with the test accounts above, record that fact; whether that satisfies V6 is the Owner's decision. Scripts are unchanged from `DEPLOY_PLAN_TEST.md` section 9 / `TEST_CANDIDATE_VERIFICATION.md`; this release adds only:
- **Scheduler** (an account invited in 5.12): menu shows Schedule and Reports but not Billing, Staff Types or Roles & Permissions; Staff and Roles pages refuse; schedule a shift, repeat it, change it; open the Requests tab. **New:** no "invitations" panel appears for this account (it was a new sign-in).
- **Caregiver (phone)** (account C of V4): My Schedule and Verify Visit; Availability and My documents as tabs; the drawer closes after choosing a page; start, end and confirm a visit on a synthetic client; Appearance in the footer; no Administrator data visible. **New:** the caregiver flow is untouched by this release (verify only that nothing changed); no invitations panel.
- **Authorization:** pick three TEST authorizations (low use, near limit, amended); recalculate each remaining balance by hand; numbers match to the minute. This release does not touch authorizations (the diff has no change under authorizations, scheduling, visits or billing code); this confirms it.
Each is recorded accepted, rejected or NOT RUN by the person who did it.

## 3. V7 - human security review of the SQL
Prepared for a **named person** who is not the author. `SECURITY_REVIEW_0087.md` (this folder) answers `docs/security-review-checklist.md` for 0087's eight functions with evidence to check; `docs/releases/2026-10-26-redesign/SECURITY_REVIEW_0086.md` is the review of the unchanged 0086; `SECURITY_REVIEW_0086_AI_SECOND_READ.md` is the AI read that found M-1, L-1 to L-4 (an AI output; not a human review, not a signature). The reviewer reads, in this order:
```
git diff 24fd8b1 fb491a5 -- infra/aws/db/pending apps/sv-api/src apps/web/src infra/aws/lib      # the whole code difference
sed -n 1,400p infra/aws/db/pending/migrations/0087_staff_invitation_acceptance.sql                 # the migration
```
and checks the boxes in `SECURITY_REVIEW_0087.md` section 1 against the SQL, then signs section 6 (name, date). Status now: **NO HUMAN REVIEW, NO SIGNATURE.** The Owner's TEST exception (V7) of 2026-10-25 does not carry over to this migration, and not to production.

## 4. Results record (to be filled from the Owner's output)
| Check | Result | By / when |
|---|---|---|
| TEST upgrade deployed (procedure Steps 0-16) | NOT RUN | |
| V4 C1-C3 (same-agency Caregiver) | NOT RUN | |
| V4 C4 / V5 steps 5.1-5.13 | NOT RUN | |
| V6 Scheduler / Caregiver (phone) / Authorization | NOT RUN | |
| V7 human review of 0087 | NOT RUN (no reviewer named) | |
