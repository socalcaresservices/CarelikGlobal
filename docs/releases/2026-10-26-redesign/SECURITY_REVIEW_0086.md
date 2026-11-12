# Security review checklist: migration 0086 (staff management), prepared 2026-10-25 (Pacific)

**Status: PREPARED by the development session from reading the SQL. REVIEWER SIGNATURE PENDING.** This is not an independent review: the same session wrote the migration. It answers each box of `docs/security-review-checklist.md` with evidence a reviewer can check, and lists residual notes. The checklist's wording predates this stack (Supabase, `auth.uid()`, `anon`); the mapping is in section 4.

Reviewed file: `infra/aws/db/pending/migrations/0086_staff_management.sql` (sha256 `8eb7b4a353300ba78156bd58a0df6cbc9857b677cec0e8ec51233fcda5a16a4f`, the file applied to TEST). 15 `SECURITY DEFINER` API functions in `ogevia_api`, 6 internal functions in `ogevia` (invoker), 1 replaced function (`note_my_sign_in`), 1 trigger, 2 tables.

## 1. Every new or modified SECURITY DEFINER function
| Box | Answer | Evidence |
|---|---|---|
| Validates that the target row belongs to the organization the caller claims | **Yes, in all 15.** Each function opens with `ogevia.staff_guard(p_organization_id, …)` (active membership of that organization, then the permission), and every row it reads or writes is selected with `organization_id = p_organization_id` (staff types, staff profiles, memberships, audit events). The database also prevents a cross-agency link structurally: `staff_profiles` has a composite foreign key `(staff_type_id, organization_id)` to `staff_types (id, organization_id)` | `staff_guard` lines 107-121; for example `rename_staff_type` 202-225, `update_staff` 388-428, `complete_staff_invitation` 456-509, `set_staff_role` 552-584, `list_staff_audit` 608-638; composite FK line 65; permissions lines 23-30 |
| Requires the specific relationship the function implies, not only membership | **Yes.** `staff.read`/`staff.manage` are held by the Owner only (verified on TEST). A role change needs the person to be an active or invited member of the same organization; it refuses the caller's own account, the Owner and platform-owner roles and caregivers; granting or removing the Admin role is allowed only to the Owner (`staff_role_change_allowed`); only the six staff roles are assignable (`assignable_staff_role`). An invitation needs a profile of that organization that is active and has no sign-in yet | lines 124-154, 552-584, 430-454 |
| `search_path` pinned | **Yes, 21 of 21** (`ogevia, pg_temp`: the temporary schema last, `pg_catalog` implicit first). `verify-0086.sql` checks each function; 110 of 110 passed on TEST | verify run `20261026T045739Z` |
| Granted to whom, and why | `revoke all … from public` on all 21, then `grant execute … to ogevia_app` on the 15 API functions only. The 6 internal functions have no grant to the application role: the API functions call them with the definer's rights. There is no `anon` role in this schema | lines 655-690; `verify-0086.sql` checks no PUBLIC and app-execute for each function |
| Trusts a client-supplied organization or user id for anything other than a row to re-validate | **No, with one noted exception (R-1).** The caller's identity is always `ogevia.require_actor()`; `p_organization_id` is re-validated by `staff_guard`; every `p_user_id` or id parameter is looked up inside that organization | lines 107-121; exception: `p_cognito_sub` in `complete_staff_invitation` |

## 2. Row level security
| Box | Answer | Evidence |
|---|---|---|
| Policies reference the row's own `organization_id` | **Not applicable: 0086 creates no RLS policy.** RLS is enabled on both new tables with no policy, so any role other than the table owner sees nothing. The application role has **no table privileges** on either table (verified by `verify-0086.sql`, including that `login_email` is not exposed to it). The `SECURITY DEFINER` functions run as the owner and bypass RLS; access control for them is `staff_guard` and the `organization_id` filters in section 1 | lines 45 and 72; verify checks `table_no_app_privilege_*` |
| A second permissive policy for the same role and action | Not applicable (no policy) | |

## 3. Evidence outside the SQL
- `verify-0086.sql`: 110 read-only checks, 0 failing on TEST after the apply (and 15 sabotage cases in a real PostgreSQL in the development container, each turning a check red).
- Tests that passed in the full G3 run on `bfb851c`: `infra/aws/db/test/staff-management.db.test.ts` and `apps/sv-api/test/tenant-isolation-sweep.db.test.ts` (other tenant, wrong role, invitation and role-change rules).
- Not run on TEST: the Caregiver and other-tenant negative checks against the deployed environment (V4 in `RELEASE_COMPLETION_TEST.md`).

## 4. Mapping of the checklist's wording to this stack
`auth.uid()` is `ogevia.require_actor()`; `organization_memberships` is `ogevia.organization_memberships`; `has_permission(org, 'x')` is `ogevia.has_permission`; `PUBLIC` is the same; `anon` has no equivalent.

## 5. Residual notes for the reviewer (none is a blocking finding)
- **R-1 `complete_staff_invitation` trusts the Cognito `sub` it is given.** The database cannot verify that the identifier belongs to the invited e-mail; it checks the format, the caller's permission, and that the sign-in is not already linked or disabled. The caller is the API tier only (the application role). This is the same trust boundary as the existing caregiver invitation (`complete_caregiver_invitation`). A defect or compromise in the API tier could therefore link the wrong sign-in to a profile, but only inside an organization where the caller is the Owner.
- **R-2 RLS without policies and without `FORCE`.** The real boundary for the owner-run functions is the absence of table grants for the application role plus the in-function organization filters, not RLS. This matches the rest of the schema (90 `enable row level security` statements, no `force` anywhere), so it is consistent, not new. If the Owner role is later granted more, revisit.
- **R-3 The pending decision about the Administrator role.** `staff.manage` is Owner-only today. If it is later given to administrators, the existing guards (own-role change blocked, Admin grant/removal Owner-only, Owner and platform-owner protected) must be re-reviewed against that change; a new migration would carry that review.
- **R-4 Reviewer independence.** This review was prepared by the author of the migration. A second person reading sections 1 and 2 against the SQL would meet the checklist's intent better.

## 6. Sign-off (a person)
Reviewer name ____________ date ____________ ☐ every box in sections 1 and 2 checked against the SQL ☐ residual notes R-1 to R-4 accepted (or a written justification)

**Owner exception recorded 2026-10-25 23:10 PDT (2026-10-26 06:10 UTC):** no reviewer has signed this review. The Owner excepted the reviewer signature (V7) in `RELEASE_COMPLETION_TEST.md` section 8 when closing the TEST release. The review stays as prepared (author only, not independent); the exception does not make it a signed review.
