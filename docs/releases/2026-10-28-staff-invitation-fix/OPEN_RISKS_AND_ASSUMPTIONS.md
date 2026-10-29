# Open risks and assumptions

Written 2026-10-28 for candidate `fb491a5`. Each line is either **not directly verified** or an assumption someone else must confirm. Nothing here is an approval or an exception.

## 1. Not directly verified (by anyone, as of now)
| # | Item | Why it matters | What would verify it |
|---|---|---|---|
| U1 | **Nothing in the 0087 fix has run on AWS.** All evidence is local (PostgreSQL 16 in the development container) plus CI (PostgreSQL 18). | RDS is PostgreSQL 18.3; CI is the arbiter for that version. | The TEST upgrade, then V4/V5 (`V4_READINESS.md`, `V5_V7_PREPARATION.md`) |
| U2 | **The live accept flow in a browser with a real Cognito sign-in.** The API tests call the real handler with an identity, not a real token; the JWT authorizer is exercised for refusals (401) only. | The invitee's real session is what carries the identity. | V5 steps 5.4-5.6 |
| U3 | **No human has reviewed the SQL** (V7). The AI second read of 0086 found M-1/L-1..L-4; 0087 has only the author's checklist (`SECURITY_REVIEW_0087.md`). | The checklist asks for a second person. | A named reviewer signs section 6 |
| U4 | **The same-agency Caregiver check (V4) has not been run**; the account does not exist yet. | It is the one open V4 item since 2026-10-26. | `V4_READINESS.md` C1-C3 |
| U5 | **Whether the lost commit `5de9ee2` contained anything not in this candidate.** | A possible silent omission. | The Owner or the old session's transcript; the candidate matches the Owner's written scope (Option B) and `24fd8b1` exactly apart from this work (`NOTHING_DROPPED.md`) |
| U6 | **The CI `postgres` job is nondeterministic on identical code and its failing test is unidentified.** Green on `cd57ffb`, red on `cea8b47` (a documentation-only difference). One cause of earlier red runs was found and fixed (a date-dependent DST test). The job log cannot be read from the development sandbox. | A flaky or time-dependent database test could also hide a real regression in the 0087 or package tests. | The `FAIL` lines from the failed job (link in `RELEASE_MANIFEST.md` section 11). **Status 2026-10-28: the Owner accepted the green `1b27f82` run for the TEST request and keeps this risk OPEN as a known flaky-test risk.** If `postgres` goes red again on a head with no relevant change, treat it as a new signal and stop |
| U6 | **Resend for a pending existing-account invitation** is expected to show a 409 "already set up… Forgot password" (read from the code). Not observed. | A confusing message for the Owner. | V5 step 5.13 |

## 2. AWS assumptions
- The Operator's CloudShell reproduces the Handler asset key `2871b03d6be4…` (the development container does; the earlier key reproduced on CloudShell at the 7870a04 deployment). Step 4 of each procedure decides; a different key is a STOP.
- `ogevia_owner` can create and replace functions in schema `ogevia_api` (it did for 0086 on TEST). Production: the same role is used by the earlier production migration windows; whether `ogevia_prd` grants are identical to TEST's is **NOT VERIFIED** (the apply script's `verify-0086/0087` checks catch a wrong grant before anything is deployed).
- RDS `ogevia-prod-postgres` is shared by TEST and production; the snapshot covers both databases and is never restored in place.
- The temporary `/32` security-group rule method works as it did on 2026-10-26.
- No AWS credential was available to the development session; every AWS verb in the scripts was exercised against fakes only.

## 3. TEST assumptions
- TEST is in the state `DEPLOYED_RECORD_TEST.md` left it (7870a04; 0086 present; ledger 85 / 0085); **not re-read since 2026-10-26.** Procedure Steps 5, 6 and 8 prove it before anything changes, and stop on any difference.
- The two other-agency accounts (D, E) are enabled in Cognito and the Owner can reach their inboxes: **NOT VERIFIED** (see `V5_V7_PREPARATION.md`; V5's M-1 step may be BLOCKED).
- The TEST web has not been republished since 7870a04 (the verification steps T3-T5 for `24fd8b1` were never run). The upgrade publishes `fb491a5`, which includes the `24fd8b1` band changes.

## 4. Production assumptions
- **0086 is absent from `ogevia_prd`.** INFERRED, never read (the ledger cannot show it). Step 6 reads it before any change; a different answer stops the release.
- Production holds synthetic data only (the Owner's statement of 2026-10-20; not verified by counting).
- The production web, Auth, API and WebHosting stacks are as the 2026-10-26 capture found them (the gates compare the live templates with the release and stop on any other difference). The unknown commit mappings of the current production code (`PRODUCTION_AS_FOUND_2026-10-26.md`) remain NOT VERIFIED.
- DNS for `app.ogevia.com` and `admin.ogevia.com`, and the certificate: NOT VERIFIED.
- No production invitation has been made or is made by the release; the exposure of M-1 in production is therefore nil until the first use of **Invite**, and with 0087 it is closed before that.

## 5. Deployment assumptions
- **Order: database first, then Auth, API, web** (production); database, API, web (TEST). The guards enforce it (the production API deploy is refused without the `db-0086.ok` marker; a `GET /v1/me` against a database without 0087 still works, but the accept route would return a server error until 0087 is applied).
- Rolling back the database after invitations have been made leaves `invited` memberships in place (they grant nothing under 0086) and, until 0087 is applied again, an existing sign-in invited by the Owner becomes active at once (finding M-1). **Do not invite anyone after a 0087-only rollback.**
- A production rollback of the database drops `staff_types` and `staff_profiles` with their rows (snapshot required).
- Existing-account invitees get no e-mail from Ogevia; the Owner must tell them (N-3 in `SECURITY_REVIEW_0087.md`). Adding an e-mail is a new capability and was not added.
- The tarballs named in the Release Manifest carry a placeholder approval reference and a fixed build time; the shippable tarballs are built after the Owner's GO with the real reference, and **their hashes will differ**.

## 6. Release-record assumptions
- No deployed record exists for this candidate. `DEPLOYED_RECORD_TEST.md` (7870a04) and `PRODUCTION_AS_FOUND_2026-10-26.md` are unchanged and still the latest records of those environments.
- The release checklist (`RELEASE_CHECKLIST_TEMPLATE.md`) for this candidate is **not completed**; phases C (pilot/TEST), D (acceptance) and E (production GO) are open, and no signature exists.
- PR 106 (`claude/redesign-review-nav-ui`, head `644d6e2`) is **not updated** and not merged; this work is on `claude/magical-lovelace-9y5ras`. Merging either does not deploy anything.
- The Owner's decisions D-P2 (0086 outside the ledger; now 0086 + 0087), D-P4 (V3-V7 for production) and the window are still open; the "M-1 decision" is recorded here as **Option B, instructed by the Owner on 2026-10-28**.
