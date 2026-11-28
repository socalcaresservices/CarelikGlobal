# Release Train 2 — Rollback plan

## TEST rollouts as deployed: exact rollback commands (one place; keep this file)
Every TEST stage was deployed by one script that saved its own rollback capture in `/tmp/rt2n2/work/rt2nN-<timestamp>` (`/tmp` is cleared when CloudShell resets). **After every deployment run `SAVE_ROLLBACK_REFS.sh`** (below): it copies the captures to `~/ogevia-rollback-refs/` and writes `INDEX.md` there.

Run each rollback from a checkout of the SAME release commit, from `docs/releases/2026-11-20-test-plan/toolchain`, with the same variables as the deploy: `REPO=<checkout> OGEVIA_RELEASE_COMMIT=<sha> WORK=/tmp/rt2n2/work OGEVIA_DEPLOY_APPROVAL=<reference> bash <script> <mode>`. If `/tmp` was cleared, copy the saved folder back first: `cp -r ~/ogevia-rollback-refs/<folder> /tmp/rt2n2/work/`. Each mode asks you to type its word. All refuse any AWS account other than 300094796789. None touches sign-in or production.

| Stage | Deployed commit | Script | Modes in order (typed word) | Capture folder | Snapshot |
|---|---|---|---|---|---|
| 1 notifications (in-app) | b0848ede | `TEST_RT2_N1_NOTIFICATIONS.sh` | `rollback-web` (ROLLBACK-TEST-WEB), `rollback-routes` (ROLLBACK-TEST-ROUTES), `rollback-api` (ROLLBACK-TEST-API); database separately: `TEST_PENDING_LEDGER.sh rollback 0116 … 0113`, reverse order | `/tmp/rt2/work/rt2n1-20261123T201506Z` | `ogevia-test-rt2-pre-0113` |
| 2 open-shift texting (mock) + service location | 9b2fdef8 (app code = 88c104b2) | `TEST_RT2_N2_SMS_LOCATION.sh` | `rollback-web`, `rollback-routes` (ROLLBACK-TEST-ROUTES), `rollback-api`, `rollback-db` (ROLLBACK-TEST-0118-0117). Also 0119: `TEST_PENDING_LEDGER.sh rollback 0119` first | `~/rt2n2-20261124T031440Z` (also `/tmp/rt2n2/work/rt2n2-20261124T031440Z`) | `ogevia-test-rt2-n2-20261124t030750z` |
| 3 alert card, exact-shift link, migration 0120 | 620ccf35 | `TEST_RT2_N3_ALERT_CARD.sh` | `rollback-web` (ROLLBACK-TEST-WEB), `rollback-api` (ROLLBACK-TEST-API), `rollback-db` (ROLLBACK-TEST-0120). No routes rollback: no route changed | `/tmp/rt2n2/work/rt2n3-20261125T195943Z` | `ogevia-test-rt2-n3-20261125t200140z` |
| 4 email function (SES) | 0c85c5fe | `TEST_RT2_N4_EMAIL.sh` | `rollback` (ROLLBACK-TEST-EMAIL). Turn email OFF in the app first | `/tmp/rt2n2/work/rt2n4-20261126T120746Z` | none (no database change) |
| 5 SES sandbox fix: one recipient identity added to the email function's send permission | (this commit chain) | `TEST_RT2_N5_EMAIL_RECIPIENT_IDENTITY.sh` | `rollback` (ROLLBACK-TEST-EMAIL-IDENTITY): redeploys the stage-4 assembly to the API stack only | `/tmp/rt2n2/work/rt2n5-<timestamp>` (copy it with `SAVE_ROLLBACK_REFS.sh`: `rt2n[1-4]` only, extend if needed) | none |
| 6 second approved recipient (caregiver address, passed at run time, not stored in Git) | (this commit chain) | `TEST_RT2_N6_EMAIL_EXTRA_RECIPIENT.sh` | `rollback` (ROLLBACK-TEST-EMAIL-RECIPIENT): redeploys the stage-5 assembly to the API stack only | `/tmp/rt2n2/work/rt2n6-<timestamp>` | none |

**Known gaps (2026-11-26):** the stage 3 capture folder (`rt2n3-20261125T195943Z`) was cleared from `/tmp` before it was copied, so stage 3 `rollback-web` and `rollback-api` cannot run from it. The previous state is commit `9b2fdef8` (rebuild and republish it if ever needed). The stage 3 database rollback does not need the capture: `OGEVIA_TEST_SNAPSHOT=ogevia-test-rt2-n3-20261125t200140z bash TEST_DB_SESSION.sh bash TEST_PENDING_LEDGER.sh rollback 0120`. The stage 1 and stage 4 captures are saved in `~/ogevia-rollback-refs`; the stage 2 capture is in `~/rt2n2-20261124T031440Z` (the copy to `ogevia-rollback-refs` failed: the CloudShell home folder was full).

**Order for everything on TEST:** stage 6, then 5, then 4, then 3, then 2, then 1. Within a stage the order is the order in the table (web, routes, api, db).

**What each one reverts and what it cannot:** web restores the captured site files (nothing deleted); routes redeploys the saved assembly without that stage's routes; api puts the captured Handler code back (code only: the stack template then differs from the live function until the next deploy); db removes that stage's migration(s) in one transaction (texting tables are dropped by 0117's rollback: the snapshot is the restore point); email removes the function, role, policy, log group, the API invoke permission and variables, and the one endpoint-policy entry (the SES identities stay). Emails already sent and audit events cannot be undone.

**Verified:** each script's rollback modes are exercised by stand-in tests (`infra/aws/test/test-rt2-n*.test.ts`) and the database rollbacks by database tests. **Not verified:** no rollback has been run against real AWS.

### Keep the captures (so they cannot be lost)
```bash
bash SAVE_ROLLBACK_REFS.sh        # from the toolchain folder; no AWS; copies to ~/ogevia-rollback-refs and writes INDEX.md
```
CloudShell's home folder survives a session reset but is limited (about 1 GB) and is deleted after a long period of inactivity. Also download `~/ogevia-rollback-refs` to your own computer (CloudShell, Actions, Download file; zip it first with `cd ~ && zip -r ogevia-rollback-refs.zip ogevia-rollback-refs`). The captures hold live site files, Lambda code, CloudFormation templates and ids; they hold no passwords. Do not commit them to Git.

## Earlier plan (layer by layer)

Principle: every capability is behind a switch, so the **first rollback is always to turn the switch off** (a routes-only change set; the routes disappear and the web hides the controls). Data rollback is separate, needs a snapshot and the owner's approval, and is rarely needed.

| Layer | Rollback | Data effect |
|---|---|---|
| Branch deployed with switches OFF (API code, web) | Re-apply the previous API Lambda bundle (change set with the earlier code asset) and restore the captured web files (the web release script prints the recovery path); invalidate CloudFront | None (no migration in this step) |
| `notifications` | (0113 also adds `shifts.coordinating_office_id`; the down script drops it, and the shifts keep working without it.) Turn the switch off (schedule and routes go; the email Lambda is removed only if `notificationEmail` is also removed). In-app notifications and history stay in the database. **Pause sending immediately without a deploy:** in the app, Notifications → Office → untick "Notify caregivers about shifts that need cover" (stops new notifications; due emails already queued still send unless `notificationEmail` is removed) | Down script `0113_notifications.down.sql` drops the tables (history lost; audit events stay). Use only with a snapshot |
| `invitationBranding` / `auth.invitationEmail` | Remove `auth.invitationEmail` and redeploy the Auth stack: the pool returns to Cognito's default message (in-place update, no replacement). The trigger **fails open**, so a broken trigger never blocks sign-in | `0114_office_branding.down.sql` drops office looks (audit events stay) |
| `importRollback` | Switch off. Individual imports are undone **inside the app** with Roll back (records become Inactive; nothing deleted) | `0115_import_history_rollback.down.sql` restores the 0105 function and drops the records of which import created what (no rollback possible afterwards for existing imports) |
| `staffDuplicates` (merge hardening) | Switch off. A merge is undone in the app with Undo (only while unchanged) | `0116_staff_merge_hardening.down.sql` **refuses** if any profile has more than one merge link (a merge was reversed and repeated); resolve by hand first. Restores the 0106 functions and unique rule |
| `operationsReadiness` | Switch off | none |
| Dependencies | Revert `package.json`/`pnpm-lock.yaml` to `main`'s and redeploy web/API | none |

## Database rollback procedure (only if a migration must be removed)
1. RDS snapshot exists (taken before the migration). 2. Owner approval naming the migration. 3. Run the matching `db/pending/rollback/011x_*.down.sql` in one transaction with the ledger row removed in the same transaction (the existing per-release `ROLLBACK-PRODUCTION-…` scripts are the model). 4. Verify with the schema fingerprint comparison (`docs/stabilization/compare-production-schema.sh`) that the schema equals the pre-release capture. All four down scripts were exercised in the database tests (`*-0113/0114/0115/0116.db.test.ts`).

## What cannot be rolled back
Emails already sent; invitation emails already delivered; audit events (append-only by design); notification/merge/import history once a down script has dropped its tables.
