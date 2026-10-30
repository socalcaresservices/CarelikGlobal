# Second read of migration 0086 by an AI reviewer (V7 evidence). NOT a human review

**This is AI output. It is not a human review, it carries no signature, and it does not satisfy the checklist's reviewer signature. Nobody has accepted it as an exception.** The Owner decides what weight it has. Recorded 2026-10-27 from the reviewer's final report (a sub-agent hand-back in the development session of 2026-10-26, 21:00 to 21:07 UTC), summarised faithfully; where the report is long, the findings are quoted in substance with their locations.

## Who and what
| Item | Value |
|---|---|
| Reviewer | A separate AI agent started by the development session ("general-purpose" agent, description "Independent security review of migration 0086"); it states: "an AI review by an independent agent, not a human". Model recorded for the run: `claude-opus-5-5` (the session log). The author of the migration and of `SECURITY_REVIEW_0086.md` is the development session (a different model run, same vendor) |
| Independence | It was instructed to review read-only, to write its own findings from the code **before** reading `SECURITY_REVIEW_0086.md`, and then to compare. It was not independent in the human sense: the brief and the scope came from the author session |
| Commit reviewed | `f8cd7dff2d4cf871b6e5ff6b62c7ec679a317f45`. The checkout was `ea7281d`; the reviewer confirmed that the files it reviewed (`infra/aws/db`, `apps/sv-api/src`, `infra/aws/lib`) differ from `f8cd7df` only by two test files. **The candidate `24fd8b1` differs from `f8cd7df` in web files, a CI file, test files and one comment in `config.ts`; 0086, `apps/sv-api/src` and the CDK stacks are byte-identical (checked 2026-10-27 with `git diff f8cd7df 24fd8b1`)** |
| 0086 hash | `8eb7b4a353300ba78156bd58a0df6cbc9857b677cec0e8ec51233fcda5a16a4f` (the pinned file) |
| What it opened | the whole of 0086 and its rollback; `docs/security-review-checklist.md`; migrations 0001, 0002, 0005, 0008, 0025, 0048 and the permission inserts of 0011, 0020, 0021, 0023, 0024, 0026, 0042, 0069; `routes.ts`, `handler.ts`, `errors.ts`, `validate.ts`, `http.ts`, `db.ts`, `identity.ts`, `identity-handler.ts`; `packages/auth/src/server/db-bridge.ts`; parts of `service-verification-api-stack.ts` and `config.ts` |
| What it did **not** do | run any test or SQL, inspect TEST or production, review the web screens |

## Findings (no Critical or High)
| Id | Severity | Where | What | Status in this release |
|---|---|---|---|---|
| **M-1** | Medium | `routes.ts:1176-1178`, `identity-handler.ts:73-86`, 0086 `:482-501` | Inviting an e-mail that already has a confirmed sign-in links that account at once as an **active** member with the chosen role. There is no acceptance step and nobody is told. If the Owner of agency A types the e-mail of someone who signs in to agency B, that person can read A's data with the chosen role (for example Manager) at next sign-in. Recommended fix: create the membership as invited and activate on acceptance, or notify, or show the Owner a confirmation naming the existing account | **OPEN: needs the Owner's decision** (section "M-1 options") |
| L-1 | Low | `routes.ts:1179`, 0086 `:486` | The invitation response reveals whether an e-mail already has a sign-in and whether it is disabled (cross-agency enumeration by the Owner) | open, not fixed |
| L-2 | Low | 0086 `:488-501` | If the person's membership in the agency is in status `invited`, the invitation overwrites its role and activates it without the protections of `set_staff_role`, and the audit row omits the old role. The reviewer found no code that creates `invited` memberships today; **whether any migrated production row has that status is unverified** | open; NOT VERIFIED for production data |
| L-3 | Low | 0086 `:403, 421`, `list_staff` `:273-276` | Setting a profile **inactive** does not remove access; the sign-in stays active until Accounts > Disable | open, not fixed |
| L-4 | Low | rollback `:3, 36-37` | The rollback drops `staff_profiles` but leaves the memberships and roles it granted | open; documented in the rollback file |
| I-1 | Info | 0086 `:422-423, 349` | The audit stores changed field names, not old and new display names; `staff.invited` does not store the linked user | open |
| I-2 | Info | 0086 `:89-100` | The trigger is not SECURITY DEFINER; creating an organization as a role other than `ogevia_owner` fails closed | none required |
| I-3 | Info | `config.ts:100` vs `282` | A comment said staffManagement was "off in production" | **fixed** in the candidate (comment only) |
| I-4 | Info | 0086 `:45, 72` | The new tables have no read-only role grant | none required |
| I-5 | Info | 0086 `:630` | `LIKE 'staff_type.%'`: the `_` is a wildcard; harmless today | none required |
| I-6 | Info (existing) | 0002 `begin_request` | The application role is fully trusted for identity; the sub comes from the identity function, not the browser | existing design |

Its verdict: **"No blocking finding"**, with the advice that M-1 "should get an owner decision before wider use, because staff roles such as manager carry PHI-level permissions".

## What it found sound (list of what it checked)
Cross-tenant filtering in all 15 functions; the role allow-list and the protections for the Owner and platform-owner roles; invitation idempotency and races (row lock plus advisory lock); SECURITY DEFINER hygiene (pinned `search_path` on 21 of 21, PUBLIC revoked, execute only for the application role); table and RLS exposure; audit immutability; PII in responses, errors and logs; parameter binding; the 13 routes behind the JWT authorizer; the replaced `note_my_sign_in`; the trigger; the rollback; the "additive only" claim line by line. It agrees with the checklist answers and R-1 to R-4 of `SECURITY_REVIEW_0086.md` and says that document missed M-1, L-1 to L-4.

## Still unresolved (the reviewer's list)
Whether any production or migrated membership has status `invited`; how the app picks the active agency when a person is linked to a second agency; the Cognito pool's username/alias configuration; the web screens; test and TEST/production state not examined.

## Does this satisfy the written review requirement? **No.**
`docs/security-review-checklist.md` is a checklist for human reviewers, and `SECURITY_REVIEW_0086.md` ends with a signature block ("Reviewer name ____ date ____") and note R-4 ("A second person reading sections 1 and 2 against the SQL would meet the checklist's intent better"). No named person has read the SQL or signed. This AI second read is additional evidence, stronger than the author's own review because it was formed before reading it and found items the author missed. It is not a substitute for a signature. The Owner may (a) name a human reviewer, (b) accept the AI read plus an exception in writing, or (c) hold the release. **None of these has been chosen.** The record `RELEASE_COMPLETION_TEST.md` section 8 (an exception for the TEST release) does not carry to production.

## M-1 options (the Owner decides; the migration is not changed by this document)
- **A. Accept for this release, with a written condition:** the Owner invites only people she intends to give access to this agency, and does not invite an e-mail known to sign in elsewhere; a follow-up migration adds the acceptance step. Exposure: a mistyped e-mail of an existing user links without notice. The production procedure itself creates no invitation, so the exposure starts when the Owner first uses Invite after the release.
- **B. Fix before the release:** change 0086 and the invitation function so the membership is created as invited and activated on acceptance; this changes the pinned 0086 hash, the candidate commit, the tarball, and requires a TEST re-run of the whole set.
- **C. Hold the release.**
Recommendation: A, recorded as a dated, written Owner decision, with B scheduled as the next change. This is a recommendation, not a decision.

## Disposition added 2026-10-28
M-1, L-1, L-2 and L-3 are addressed by pending migration 0087 (0086 unchanged). Implemented and locally tested only; **not deployed, not verified on TEST**. See `docs/releases/2026-10-28-staff-invitation-fix/` (`SECURITY_REVIEW_0087.md`).
