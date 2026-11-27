# TEST rollout: admin override of a CPR/TB readiness block (migration 0123, switch readinessOverrides)

Status: **DEPLOYED TO TEST 2026-11-27 (owner-reported script output, not independently observed): migrations 0121 and 0122 applied, then stage 7 (0123, readinessOverrides ON, 299 routes, web at a74d2ca5). TEST VERIFICATION OF THE FIVE CASES: NOT YET DONE. Production NOT touched and pending the owner's approval.** TEST only (`Ogevia-prod-*`, `ogevia_sv_test`). Production (`Ogevia-prd-*`, `ogevia_prd`) is not part of this rollout and every script named here refuses a production target. Production deployment needs the owner's separate approval.

## What it does (owner request 2026-11-27)
An authorized administrator (existing permission `caregivers.compliance.manage`) can explicitly lift ONE caregiver-readiness block for ONE caregiver: a required CPR or TB document that is **missing, waiting for review, rejected or expired** (a missing-doc case includes a caregiver who was never approved for work; the work approval remains its own step).
* Row on the profile: `CPR | Expired Doc | Blocked | Approve`, and after approval `CPR | Expired Doc | Admin Approved | Details`. **Approve** opens a confirmation that names the specific block and requires a reason. **Details** shows the expiration date, approving admin, approval time, the reason and **Revoke** (administrators).
* Scope: the caregiver, the requirement and the exact issue (document version and expiry). A different document or a later expiry is a different issue and needs a new decision. The server recomputes the issue and refuses a stale one.
* The document is never marked current or verified: it stays Expired / Missing / Rejected / Pending. "Expired Doc" stays visible on the profile, in the compliance report (new section "Admin-approved exceptions") and in the follow-up queue (Action needed, Documents & compliance) until the document is fixed or the override is revoked.
* Revoking restores the block if the issue is still active. The original work approval and every override and revocation are kept (append-only history plus the audit trail).
* Unchanged: overlapping shifts, hour limits, availability, client authorization, the background check (not overridable), an unset document type for an approved caregiver (0122) and an unset document rule (still blocks).

## Commits (see the final report for the exact SHAs and CI)
Migration `infra/aws/db/pending/migrations/0123_readiness_override.sql` (rollback `rollback/0123_readiness_override.down.sql`; 0121 and 0122 are taken, the NFC/QR migration of PR #125 must be renumbered to 0124 or later), API routes in `apps/sv-api/src/routes.ts`, the release switch in `infra/aws/lib`, the web row, dialog, details and report in `apps/web`. Deploy script `TEST_RT2_N7_READINESS_OVERRIDE.sh`, gate stage `stage7` in `diff_gate_rt2.py`.

## Deployment order (TEST), one script
Prerequisites: CI green on the release commit; the owner's GO and a TEST authorization reference `<ref>`; migrations 0121 and 0122 already applied (0121 is independent; 0122 and 0103 are required: `probe 0123` stops otherwise); the email stage 6 live (the assemblies must carry the email configuration, which needs the caregiver test address as `OGEVIA_EXTRA_RECIPIENT`; it is not stored in Git).
From `docs/releases/2026-11-20-test-plan/toolchain`, in CloudShell with the usual fresh credentials and the `~/.cdk` link to `/tmp/cdk-home`:
`OGEVIA_EXTRA_RECIPIENT=<caregiver test address> REPO=<checkout> OGEVIA_RELEASE_COMMIT=<full sha> WORK=<work dir> OGEVIA_DEPLOY_APPROVAL=<ref> bash TEST_RT2_N7_READINESS_OVERRIDE.sh`
It stops at the first failure: guards, a read-only capture (the rollback reference), the 0122 check and the 0123 absent check, two assemblies gated before anything changes, **typed confirmation `DEPLOY-TEST-READINESS-OVERRIDE`**, a fresh RDS snapshot, migration 0123 applied and verified, the API stack deployed (3 routes answer 401 without a token), then the web publish and its verification.

## Enforcement-on verification in TEST (owner, synthetic caregivers only)
Read this first: readiness enforcement cannot be switched on until CPR and TB are set up, and there is **no in-app way to switch it off** (see `test-rollout-profile-0121-0122.md`). If TEST enforcement is not yet on: set up CPR and TB (Care Team page, readiness card), then activate it (Operations readiness). Read back with `bash TEST_DB_SESSION.sh psql -X -A -F ' | ' -v cg=<code> -f CHECK_READINESS_OVERRIDE.sql`.
1. **A previously approved caregiver's CPR expires.** Use a synthetic caregiver who is approved for work with a current CPR and TB, then let the CPR expire (upload a CPR whose expiry date is in the past and have an administrator verify it, or use a caregiver whose CPR expires today). Profile, Readiness: the row reads **CPR | Expired Doc | Blocked | Approve**; try to schedule a shift in Admin, Schedule: it is **refused**, naming the CPR.
2. **Approve.** Click Approve, read the confirmation (it names CPR, Expired Doc and the expiry date), try to submit without a reason (refused), enter a reason and approve. The row reads **CPR | Expired Doc | Admin Approved | Details**. Schedule the shift again: it **succeeds** if nothing else blocks. Details shows the expiration date, you as approving admin, the time and the reason.
3. **Never approved.** A synthetic caregiver with the background check approved, training done and a first sign-in (or the sign-in override) but **no work approval**, and no CPR on file, hired more than 30 days ago. Record the work approval (Work approval row, Approve) and confirm scheduling is still refused for CPR; then Approve the Missing Doc override with a reason and schedule: it succeeds. Both the work approval and the override are recorded.
4. **Revoke, another issue, permissions.** Details, Revoke with a reason: the row returns to **Blocked** and scheduling is refused again. Make a second issue (for example let the TB expire or reject it): approving the CPR override does not lift the TB block. Sign in as a manager or scheduler: no Approve, no Revoke (Details is visible). Overlap two shifts for the same caregiver: the second is still refused.
5. **Reports and phone.** Menu **Operations, Caregiver holds** (always listed for people who may read compliance; before the commit that added this entry, the page was reachable only through links that appear when a hold exists), section "Admin-approved exceptions" lists the exception with who, why and when; Action needed, queue "Documents & compliance", lists the "Expired Doc · Admin Approved" follow-up (routine priority, so it can be below the urgent rows). Open the profile on a phone: the row, the confirmation and Details are readable and tappable.
Send me the `CHECK_READINESS_OVERRIDE.sql` output after each step and a screenshot of the row before and after approval; I will record them.

## Rollback (reverse order; each step stands alone)
1. `... TEST_RT2_N7_READINESS_OVERRIDE.sh rollback-web` (typed `ROLLBACK-TEST-WEB`): restores the captured web files.
2. `... rollback-routes` (typed `ROLLBACK-TEST-ROUTES`): redeploys the saved switch-OFF assembly; the 3 routes answer 404 again.
3. `... rollback-api` (typed `ROLLBACK-TEST-API`): puts the captured Handler code back.
4. `... rollback-db` (typed `ROLLBACK-TEST-0123`): removes 0123 with its ledger row in one transaction. **The override history table is dropped** (the audit events stay; the snapshot is the restore point). The 0122 rules return: an approved caregiver with an expired document is blocked again.
5. Enforcement is not undone by any step (one-way in the app). Last resort: restore the snapshot into a NEW instance.
Use the same `WORK` directory for the rollbacks so the captured references are found.

## Evidence so far (local PostgreSQL 16 and the local harness, synthetic data; NOT TEST)
* `infra/aws/db/test/readiness-override-0123.db.test.ts`: 16 tests with enforcement activated through the real workflow and shifts created through `create_shift`, with and without the live-test layer.
* `apps/sv-api/test/readiness-override.db.test.ts`: 4 tests through the real Lambda handler.
* `apps/web/src/aws/readiness-override-ui.test.tsx`: 8 tests; `infra/aws/test/readiness-overrides-switch.test.ts`: 3 tests; `infra/aws/test/test-rt2-n7-readiness-override.test.ts`: 5 tests of the deploy script with stand-in tools.
* Browser run on the local harness (`local-harness/run-readiness-override-pass.sh`), enforcement on, desktop and phone, with before and after screenshots in `docs/ux/readiness-override-evidence/`.
* Not verified: any TEST result.

## Deployment record (owner-reported output; the end-of-run lines were pasted, earlier lines were not)
* 0121 and 0122 were NOT in TEST when this stage was first run (ledger 119/0120): the stage stopped at its own guard with nothing changed. They were then applied one at a time under the snapshot `ogevia-test-pre-0121-0122-0123-20261127t210550z` (each recorded with its checksum and verified; ledger 121/0122).
* Stage 7 then completed: "RT2 STAGE 7 COMPLETE (TEST): migration 0123 applied (ledger recorded), readinessOverrides ON (299 routes), web serves a74d2ca5f389d960ebbf2ca4ca53ad318872ce9c. Snapshot ogevia-test-rt2-n7-20261127t211457z." Rollback reference: `/tmp/rt2n7/work/rt2n7-20261127T211315Z` (outside durable storage: copy it out of /tmp).
