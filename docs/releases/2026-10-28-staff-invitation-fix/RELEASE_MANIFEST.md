# Release Manifest: staff management release with the invitation fixes (candidate `fb491a5`)

**Status: FOR THE OWNER'S REVIEW. NOT APPROVED. NOT DEPLOYED. No GO has been requested.** Written 2026-10-28. Words used exactly: *implemented*, *tested (where)*, *deployed (where)*, *accepted (by whom)*. Nothing in this manifest was observed on AWS by the development session.

| | |
|---|---|
| Candidate code commit | `fb491a554c0fdc484102025179c9c993f694b4e0` (`fb491a5`), parent `773b762`; branch `claude/magical-lovelace-9y5ras`; lineage and nothing-dropped proof: `NOTHING_DROPPED.md` |
| Documents head at the time of writing | 215b7c6 plus the commit that adds these documents (the package folders are taken from the working tree when a tarball is built, so the tarball hash depends on this head as well as on the code commit) |
| Environments touched by the development session | **none.** Not TEST, not production, not `main`, not `ogevia_prd`, not any production stack or database, not AWS. Only this branch of the GitHub repository was written. |
| Migration status, order, ledger, rollback sequence | `MIGRATION_STATUS_MATRIX.md` |
| V4 / V5-V7 | `V4_READINESS.md`, `V5_V7_PREPARATION.md` (prepared, not run); `SECURITY_REVIEW_0087.md` (author-prepared, unsigned) |
| Open risks and assumptions | `OPEN_RISKS_AND_ASSUMPTIONS.md` |

## 1. Production now versus the candidate
Production figures are from the Owner's read-only capture of 2026-10-26 (`docs/aws/PRODUCTION_AS_FOUND_2026-10-26.md`); TEST figures are from `DEPLOYED_RECORD_TEST.md`. Neither was re-read today.

| Area | Production now | TEST now | Candidate `fb491a5` |
|---|---|---|---|
| Web | bundle labelled `e80b770`, environment production (source tree NOT VERIFIED) | `7870a04` | `fb491a5` (built with the environment's own values) |
| API Lambda (Handler) | asset `debd1d43…` (unmapped to a commit) | `94b73574c5a6…` | `2871b03d6be4…` |
| API routes | 228 | 241 | **242** (13 staff routes since 7870a04, plus the accept route) |
| Staff management (Staff, Staff Types, Roles & Permissions) | **absent** | present | present, **with the invitation fixes** |
| Navigation redesign, Reports filter bar, sign-in environment label | absent | present (7870a04; the label since 24fd8b1 is not yet published) | present |
| Database ledger | 85 applied, latest `0085` | the same | the same (**unchanged**) |
| Migration 0086 (staff tables, outside the ledger) | not applied (INFERRED; Step 6 reads it) | applied | applied (production: in the same transaction as 0087) |
| Migration 0087 (invitation acceptance) | not applied | not applied | applied (both environments) |
| Auth stack URLs / CORS origins / hostnames | as found | as 7870a04 left them | as in PR 106 (production gate allows the `app.`/`admin.` URLs and the two CORS origins and nothing else) |

## 2. Every change in plain English
**What this work (the delta over `24fd8b1`) does**
1. **Inviting someone who already has an Ogevia sign-in no longer gives them access.** They get a pending invitation. They see it when they sign in ("You have been invited to an organization… as Manager") and must press **Accept invitation**. Until then they can read nothing of that organization. (M-1)
2. **The invitation screen no longer tells the Owner whether the e-mail already had a sign-in or was disabled.** The success message is the same for every e-mail, and the staff list and the Accounts list show such a person as **Invited**, never **Disabled**. (L-1)
3. **An invitation can never overwrite someone who is already in the organization**, whatever their status, including a person with a pending invitation. (L-2)
4. **Setting a staff member "Inactive" now also stops their access to that organization.** Making them Active again does not restore it; the Owner uses Accounts > Enable. The form says so. (L-3)
5. **Supporting changes needed so 1 cannot be bypassed or mislead:** Accounts > Disable refuses a person who has not accepted yet (otherwise Disable then Enable would have switched the access on); a pending invitation is not counted as "signed in"; the staff list shows **Invited** until the person accepts.
6. **A brand-new sign-in (an e-mail that has no account yet) behaves as before**: Ogevia sends the invitation e-mail and the membership is active at once.
7. **One new API route** (`POST /v1/me/staff-invitations/{organizationId}/accept`), and `GET /v1/me` now also lists pending invitations. The staff invitation reply no longer includes `existingAccount`.
8. **Operator packages:** the production package now applies 0086 then 0087 in one transaction (rolls back 0087 then 0086), with 14 staff routes (242 in all), the new Handler asset and a 24-check verification; the TEST package is now an **upgrade** package (apply 0087 only, one new route, no CORS allowance).

**What the rest of the release (already in PR 106, unchanged by this work) does, as described in PR 106:** staff management screens and API (13 routes behind the `staffManagement` switch, enabled in production by the Owner's approval of 2026-10-25), the redesigned navigation and Reports filter bar, the environment label on the sign-in screens, the permanent hostnames and Cognito callback/CORS configuration for production, CI time limits, and the production operator package and records.

## 3. Findings M-1, L-1, L-2, L-3: implementation summary and scope confirmation
| Finding | Approved behaviour | Implemented | Proof (local, PostgreSQL 16; CI on 18 is the arbiter) |
|---|---|---|---|
| **M-1** | an existing user receives *invited* status and gains no access until acceptance | `complete_staff_invitation` creates the membership `invited` unless the sign-in is brand new; `accept_staff_invitation` (the invitee's own action) activates it; `get_my_context`/every permission check already requires `active` | DB tests "M-1: inviting a sign-in that already belongs to another agency grants NOTHING…", "nobody else can accept it…", "an inactive profile cannot be accepted…", "Disable refuses a pending invitation…"; API test through the real handler; web test of the accept panel; mutation check (forcing `active` fails 6 tests) |
| **L-1** | responses do not reveal account existence or disabled status | reply is `{profileId}` only; the "disabled" refusal is gone; staff and Accounts lists show Invited before Disabled; web message identical for all e-mails | tests "L-1: the reply says nothing about the account…" (+ list assertions), API test `toEqual({ profileId })`; mutation check on the list order fails 1 test |
| **L-2** | a pending invitation cannot be silently overwritten, audit history preserved | any existing membership (invited, suspended, revoked, active) is refused with nothing written (not even an audit row); audit of a real invitation now records `access` | test "L-2: an invitation never overwrites a membership of any status…" (status, role, profile link and audit count unchanged); mutation check fails 1 test |
| **L-3** | setting a staff profile inactive suspends agency membership access | `update_staff` suspends the person's **active** staff-role membership (audit `staff.access_suspended`, with the reason); not for the Owner roles, caregivers, the caller, or a pending invitation | tests "setting a staff profile inactive suspends the membership at once…", "does not touch the Owner roles…"; mutation check fails 1 test |

**Are these the only behaviour changes?** The four findings plus the supporting changes in section 2 (items 5-7) and nothing else. Specifically: no change to caregiver invitations (`complete_caregiver_invitation` untouched), authorizations, scheduling, visits, billing, reports, documents or any migration 0001-0085; the product-code diff against `24fd8b1` is 8 modified and 2 added files (`NOTHING_DROPPED.md` section 3). Observable differences a user could notice beyond the four findings: the pending-invitation panel, the staff form warning, the invite success wording, **Disable refused for a pending invitation**, an *Invited* label where *Disabled* or *Active* might have shown, and a disabled sign-in now being recorded as an invitation instead of refused (that last one is L-1 by design).

## 4. Files changed
Against `24fd8b1` (code) and `644d6e2` (everything), from `git diff --stat`:
- **Product code (10 files):** `apps/sv-api/src/routes.ts`; `apps/web/src/aws/aws-shell.tsx`, `aws-workspace.ts`, `pending-invitations.tsx` (new), `staff-pages.tsx`; `apps/web/src/lib/sv-backend-aws.ts`; `infra/aws/lib/service-verification-api-stack.ts` (one route). Tests for each (`staff.db.test.ts`, `staff-pages.test.tsx`, `pending-invitations.test.tsx`).
- **Database (pending, outside the ledger):** `infra/aws/db/pending/migrations/0087_staff_invitation_acceptance.sql` (sha256 `f9d75d8c…`) and `rollback/0087_…down.sql` (sha256 `1789131e…`). `0086` untouched.
- **Operator packages:** production (`docs/releases/2026-10-26-redesign-prd-operator/`, 15 files) and TEST upgrade (`docs/releases/2026-10-26-redesign-operator/`, 16 files); verification SQL `verify-0087.sql`; test fixtures.
- **Tests in `infra/aws`:** 27 files in `infra/aws/test` and 6 in `infra/aws/db`.
- **New release folder:** this folder (`docs/releases/2026-10-28-staff-invitation-fix/`) with the checker script and its test.
- Total vs PR 106's head: 76 files changed, 2651 insertions(+), 782 deletions(-) against 644d6e2; 82 files, 3004 insertions, 786 deletions against 24fd8b1 (before these documents).

## 5. Database changes
0087 only, on top of 0086, outside the ledger, one transaction, **no table, trigger, policy, permission or row change**: 2 functions added (`list_my_staff_invitations`, `accept_staff_invitation`); 6 replaced (`complete_staff_invitation`, `note_my_sign_in`, `list_staff`, `update_staff`, `disable_account`, `list_accounts`). Rollback restores the earlier text of all six (0086's four, 0048's two) and drops the two new functions; it removes no data. Class: **ADDITIVE**. Verification: `verify-0086.sql` (110, still all pass) and `verify-0087.sql` (24; each broken on purpose and caught).

## 6. API changes
`POST /v1/me/staff-invitations/{organizationId}/accept` (JWT, behind `staffManagement`; acts only on the signed-in person's own invitation; one generic 404 for anything else). `GET /v1/me` gains `pendingInvitations` (read only when the database has the function). `POST /v1/staff/{profileId}/invitation` returns `{ invitation: { profileId } }`.

## 7. UI changes
A panel "You have been invited to an organization" (agency name, role, **Accept invitation**) on the no-organization screen and as a banner for people who already belong to an organization; a warning in the Edit staff form when setting a person with a sign-in inactive; the invite success wording. Nothing else visual.

## 8. Route count changes
Production 228 → **242** (13 staff + 1 accept). TEST 241 → **242**. Counts are pinned in the assembly check (242), the gates, the route smoke (production 14 routes × 2 calls + 2 preflights; TEST 1 route × 2 + 1 preflight) and the tarball builder.

## 9. Migration plan, rollback plan
`MIGRATION_STATUS_MATRIX.md` sections 3 and 6.

## 10. Packages and artifacts (rebuilt; deterministic)
Both packages were rebuilt from the pinned candidate and self-verified; two builds of the same inputs are byte-identical (tested). These are **candidate builds** with a placeholder approval reference and a fixed build time; the shippable tarballs are built after the Owner's GO and **will have different hashes**.

| Package | Builder | Candidate-build tarball (placeholder reference, `OGEVIA_BUILD_TIME=2026-10-28T00:00:00Z`, package at documents head 215b7c6 plus the commit that adds these documents) |
|---|---|---|
| Production | `build-prd-tarball.sh --code-commit fb491a554c0fdc484102025179c9c993f694b4e0` | `ce25f891…` (placeholder build; the shippable tarball is built only after the Owner supplies an approval reference, and its hash will differ) |
| TEST upgrade | `build-operator-tarball.sh --code-commit fb491a554c0fdc484102025179c9c993f694b4e0` | `8488a95c…` (placeholder build; same rule) |

Recomputed Handler asset `2871b03d6be42b0b8c85bac6feea12de75b3d05ca4636610259b6a18e1d00ed7.zip` (IdentityHandler `7c5f8eb6…` unchanged), 242 routes; TEST API-stack fingerprint `c2c489ae…` (the other four stack fingerprints unchanged).

## 11. Evidence: what was run
- **Local (PostgreSQL 16, development container):** `pnpm lint`, `typecheck`, `build` rc=0. Unit: shared 118, auth 150, sv-api 96, ui 73, web 1270, infra-aws static 1025, all passed. sv-api DB suite 153/153. infra-aws DB suite 1226 passed, 28 failed in 4 files that fail identically on baseline `644d6e2` (see `NOTHING_DROPPED.md` section 5). **So `pnpm test:all` exits 1 locally; the gate is NOT PASSED locally** and is not claimed.
- **CI (PostgreSQL 18): BLOCKED, not run.** Draft CI-only PR https://github.com/socalcaresservices/CarelikGlobal/pull/107 (needed because CI only triggers on pull requests and pushes to main). Run 385 on head `215b7c6`: `validate`, `postgres`, `harness` each failed after **3 seconds with no steps and no logs**, and one re-run of the failed jobs did the same. No test code ran, so this says nothing about the code; the cause is INFERRED to be the Actions runner/account (for example billing or quota), which I cannot see or change. Earlier runs on PR 106 (run 384, head `644d6e2`) succeeded, so the workflow file itself was fine. **Owner action: check Settings > Actions / billing, then ask me to re-run, or re-run in the GitHub UI.**
- **Not touched:** TEST, production, `main`, `ogevia_prd`, any stack. 0086/0087 applied nowhere.

## 12. Nothing-dropped verification
`NOTHING_DROPPED.md`: the candidate contains every earlier reference (`7870a04`, `f8cd7df`, `24fd8b1`, `644d6e2` are ancestors); against `24fd8b1` the product code differs by exactly this work; no product file and no migration was deleted; the removed/renamed items are packaging and test files and are listed and explained.

## 13. Open risks and assumptions
`OPEN_RISKS_AND_ASSUMPTIONS.md`. The ones that decide the GO: nothing runs on AWS yet; no human has reviewed the SQL; the same-agency Caregiver check (V4) and the live invitation flow (V5) are not run; production's absence of 0086 is inferred, to be read at Step 6.

## 14. What happens next (nothing happens until the Owner reviews)
1. Owner reviews this manifest. 2. If satisfied, the Owner gives a GO for **TEST only** (operator, window, approval reference); the shippable TEST tarball is built. 3. TEST upgrade, V4, V5, V6, V7 with the Owner. 4. Only then a production package, window and a separate signed GO.
