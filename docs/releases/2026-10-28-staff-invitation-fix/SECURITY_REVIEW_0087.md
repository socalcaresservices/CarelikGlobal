# Security review checklist: migration 0087 (staff invitation acceptance), prepared 2026-10-28

**Status: PREPARED by the development session from reading the SQL. REVIEWER SIGNATURE PENDING. NOT an independent review** (the same session wrote the migration). It answers each box of `docs/security-review-checklist.md` with evidence a reviewer can check, and lists residual notes. It satisfies nothing until a named person has read the SQL and signed section 6.

Reviewed file: `infra/aws/db/pending/migrations/0087_staff_invitation_acceptance.sql` (sha256 `f9d75d8c776005873b6019ca2d76353d182772144b9946cadd3291cdbad4cf88`; rollback `…/rollback/0087_staff_invitation_acceptance.down.sql` sha256 `1789131e12e54317eda1690d8f34f4a396f4d46fa234ba157c1e62caf3c10354`). Eight `SECURITY DEFINER` functions in `ogevia_api`: 2 new (`list_my_staff_invitations`, `accept_staff_invitation`) and 6 replaced (`complete_staff_invitation`, `note_my_sign_in`, `list_staff`, `update_staff` from 0086; `disable_account`, `list_accounts` from 0048). It creates no table, trigger, policy or permission and changes no row. Code commit `fb491a554c0fdc484102025179c9c993f694b4e0`.

## 1. Every new or modified SECURITY DEFINER function
| Box | Answer | Evidence |
|---|---|---|
| Validates that the target row belongs to the organization the caller claims | **Yes in all 8.** `complete_staff_invitation`, `update_staff`, `list_staff`: open with `ogevia.staff_guard(p_organization_id, …)` (active membership, then `staff.read`/`staff.manage`) and select every row by `organization_id`. `disable_account`, `list_accounts`: `accounts_manage_guard(p_organization_id)` (unchanged) and org-filtered. `list_my_staff_invitations` and `accept_staff_invitation` take **no row id from the caller**: every row is selected by `user_id = ogevia.require_actor()`; `p_organization_id` of `accept` is only the key within the actor's own memberships. `note_my_sign_in`: the actor's own rows only. | `staff-management.db.test.ts` ("M-1: nobody else can accept it…", cross-agency calls); `staff.db.test.ts` (the handler path); `tenant-isolation-sweep.db.test.ts` (unchanged, still passing in CI) |
| Requires the specific relationship the function implies, not only membership | **Yes.** `accept` requires: an `invited` membership of the actor in that organization, a linked **active** staff profile, an active organization; otherwise one generic refusal (`Invitation not found`, SQLSTATE OGN04) that does not say which part failed. `complete_staff_invitation` requires `staff.manage` and refuses an existing membership of **any** status. `update_staff`'s suspension runs only for `staff.manage`, only for the six staff roles, never for the caller's own account, never for `organization_owner`/`platform_owner`/`caregiver`. | tests "inactive profile cannot be accepted", "does not touch the Owner roles, the person making the change, or a pending invitation" |
| `search_path` pinned | **Yes, 8 of 8** (`set search_path = ogevia, pg_temp` appears 8 times in the file). `verify-0087.sql` checks the two new functions and the recreated `complete_staff_invitation` and `update_staff`; the other four are checked here by reading (grep count) and by sabotage-free equality with their previous text apart from the changes listed in section 3. | `grep -c "set search_path = ogevia, pg_temp"` = 8 |
| Granted to whom, and why | The new functions and the recreated `complete_staff_invitation` have an explicit `revoke all … from public` and `grant execute … to ogevia_app`. The five other replaced functions use `create or replace`, which **keeps their existing grants** (PUBLIC revoked, `ogevia_app` execute). There is no `anon` role in this schema. | `verify-0087.sql` rows `function_no_public_execute_*`, `function_app_execute_*`, `…_search_path_and_grants`, `update_staff_keeps_0086_hardening` (24 of 24 pass in the local database; each broken on purpose and caught) |
| Trusts a client-supplied organization or user id for anything other than a row to re-validate | **No new trust.** `complete_staff_invitation` still receives the Cognito `sub` from the API tier (note R-1 of `SECURITY_REVIEW_0086.md`, unchanged): the database cannot check that the sub belongs to the e-mail; the caller is the application role through the API only. The new functions trust nothing from the client except `p_organization_id` as a key. | code read |

## 2. Row level security
Not applicable: 0087 creates no table and no policy. The application role still has **no** table privileges on `staff_types`/`staff_profiles` (`verify-0087.sql` row `no_application_role_table_privilege_on_staff_tables`).

## 3. What each replaced function changed (so the reviewer can diff it)
| Function | Change | Finding |
|---|---|---|
| `complete_staff_invitation` | Dropped and recreated (return type narrowed to `profile_id` only). An existing sign-in gets an `invited` membership; a brand-new sign-in (created by this invitation, which e-mails its owner) is active at once; a disabled sign-in is recorded without refusal; any existing membership of any status is refused; the audit row records `access: pending_acceptance|active`. | M-1, L-1, L-2 |
| `note_my_sign_in` | The staff-profile marker is set only where the membership is `active`. | M-1 |
| `list_staff` | A membership `invited` reads `invitation_pending`, tested **before** the disabled test. | M-1, L-1 |
| `update_staff` | Setting a profile `inactive` suspends the person's **active** staff-role membership in this organization (audit `staff.access_suspended`). | L-3 |
| `disable_account` | Refuses a membership that is `invited`. | M-1 (closes a Disable-then-Enable path) |
| `list_accounts` | The `invited` test comes before the disabled test. | L-1 |

## 4. Evidence outside the SQL
- `staff-management.db.test.ts` 33 tests, `staff.db.test.ts` 6, `operator-prd-sql.db.test.ts` and `operator-0087-sql.db.test.ts` (24-check verification, 14+2 sabotage cases) on a real PostgreSQL 16 locally; CI on PostgreSQL 18 is the arbiter (result in the Release Manifest).
- Mutation checks run locally: removing the M-1 branch fails 6 tests; removing the L-3 block fails 1; allowing an `invited` overwrite fails 1; removing the Disable guard fails 1; moving the Disabled test back before Invited fails 1.
- Not run on TEST: everything in `V4_READINESS.md` and `V5_V7_PREPARATION.md`.

## 5. Residual notes for the reviewer (none blocking)
- **N-1 role at acceptance.** The Owner can change a pending person's role (`set_staff_role` accepts an `invited` membership) between the moment the invitee sees the panel and the click; the person accepts the role in force at that moment. The panel shows the role it was loaded with. Low; an Owner who can change roles can also change them after acceptance.
- **N-2 withdrawing an invitation.** There is no "cancel invitation". Setting the staff profile inactive makes acceptance impossible (`Invitation not found`); the `invited` membership row stays. Accounts > Disable is refused for it by design.
- **N-3 resend for an existing account.** `Resend invitation` calls Cognito's RESEND, which Cognito refuses for a confirmed user; the person sees a 409 "already set up… Forgot password" (expected from the code; not observed on TEST). The invited person still sees the panel when they sign in. The Owner must tell the person; Ogevia sends no e-mail for an existing sign-in (a new capability, not added).
- **N-4 inactive does not touch Cognito.** L-3 suspends the membership only; the sign-in itself stays usable for other agencies. Reactivating the profile does not restore access; Accounts > Enable does.
- **N-5 audit keeps `existing_account`.** The audit event of an invitation still records whether the identity function reported an existing account (internal; not shown to the Owner screens).
- **N-6 what an invitee learns.** A pending invitation shows the invitee the agency name and the role. That is the consent information; it carries no e-mail, no person name, no client data.
- **N-7 reviewer independence.** Prepared by the author. A second person reading sections 1 and 3 against the SQL would meet the checklist's intent.

## 6. Sign-off (a person)
Reviewer name ____________ date ____________ ☐ every box in sections 1 and 2 checked against the SQL ☐ residual notes N-1 to N-7 accepted (or a written justification)

**No reviewer has signed this review. Nothing has been excepted.**
