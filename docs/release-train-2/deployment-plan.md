# Release Train 2 — Deployment plan (PROPOSED; nothing here has been run or approved)

Branch `feature-completion-phase-2` (from `main` 698ae23b). Governing documents: `CLAUDE.md` §0/§13, `docs/TESTING_AND_RELEASE_PROCESS.md`, `docs/release-process/RELEASE_CHECKLIST_TEMPLATE.md`. I have no AWS access: every AWS command is run by the owner in CloudShell, one block at a time, only when CI is green on the exact commit. **Every new feature is OFF by default; deploying this branch changes no behavior until a switch is turned on.**

## 1. What deploying the branch changes with every switch OFF (INFERRED from tests and synth)
| Item | Effect |
|---|---|
| API Lambda bundle | New code (new routes are not in API Gateway while their switches are off, so unreachable). New bundle hash → a **code-only API change set** is needed. Verify with `cdk diff` / the existing production template drift capture (`production-template-drift.py`) |
| Routes | **No change**: all new routes are behind switches OFF in TEST and production (`config.ts`; tests assert the exact route sets) |
| Database | **No migration is part of the deploy.** `db/pending/migrations/0113`–`0116` are NOT applied |
| Cognito pool, EventBridge, new Lambdas | **Not created** (they exist only when `auth.invitationEmail`, `notificationEmail`, `features.notifications` are set; none is) |
| Web bundle | New pages/controls render only when their route answers; with routes absent nothing new is visible. Sorting on remaining legacy tables is visible immediately |

## 2. Release switches and what each needs (turn on one at a time, TEST first)
| Switch (config) | Needs first | Turns on |
|---|---|---|
| `features.operationsReadiness` | nothing (no migration; composes existing functions) | Operations readiness page |
| `features.notifications` | migration **0113** applied; for email also `notificationEmail` (SES verified identity; owner decision) | notification centre, preferences, cover-shift notify, 5-minute schedule (+ email Lambda when `notificationEmail` is set) |
| `features.invitationBranding` + `auth.invitationEmail` | migration **0114**; a hand test of the template on the TEST pool (the TEST pool is not CDK-managed) | office look editor and the Cognito custom-message trigger (branded invitation and password reset) |
| `features.importRollback` | migration **0115** (and 0105, already in the production ledger) | import history and rollback |
| `features.bulkImport` (existing) | already applied (0105) | CSV and now XLSX import (the XLSX reader ships in the API code) |
| `features.staffDuplicates` (existing) | migration **0116** (with 0106, already in the production ledger) | merge wizard, conflict choices, undo, history |

### Added 2026-11-23
- Migration **0113** now also adds `shifts.coordinating_office_id` (nullable column + FK) and needs 0110/0111 and the service-ZIP table (0091) in the target database: all three are in the production ledger; the TEST check is the ledger guard in the TEST toolchain. Down script drops the column.
- `features.notifications` also turns on `COVER_ALERT_ADDRESS_RULES` for the API: from that moment creating or editing a client needs city and ZIP. Tell staff first; clients with no ZIP are blocked from alerts (not from anything else).
- Sender/Reply-To: `email-sender.md` (owner console step for TEST; config for production).

## 3. Order (each step: owner GO, evidence recorded, stop on any failure)
1. **Merge** the PR (human). CI green on the merge commit. Complete `RELEASE_CHECKLIST_TEMPLATE.md`; re-pin to the release commit.
2. **TEST, branch deployed with all switches OFF** (web + API code-only): verify nothing changed except sorting (checklist §5).
3. **TEST, per switch** in the order of the table in §2, applying that migration to TEST first with the existing TEST toolchain pattern (`TEST_H*` scripts: ledger guard, apply, verify, rollback tested). Owner acceptance of each feature on TEST.
4. **Production, branch deployed with all switches OFF**: API code-only change set + web publish (existing method; capture of live files and a rollback script first). No migration.
5. **Production, per switch**, only after step 3 acceptance for that switch: RDS snapshot → migration (transaction with the ledger guard, as 0111/0112) → routes-only change set → smoke test. One switch per release.

## 4. Required decisions before the matching switch (owner)
Cover-shift notifications: who is told (eligible, assigned caregivers: built), email first, limits (window 48 h, 25 recipients, both configurable per agency in the app), SES sender address and verified identity (`notificationEmail`). Invitations: company name, logo URL, accent colour, support address (`auth.invitationEmail`), optional SES sender. Import and merge: nothing further.

## 5. Smoke checklist after step 2 / 4 (switches OFF)
- [ ] Sign in with MFA, sign out; Dashboard loads; no new menu items (Notifications, Operations readiness) appear.
- [ ] Sorting: Care Team (legacy), Organizations, Billing tables, Settings, Platform plans (platform owner), plus the earlier eight screens.
- [ ] Offices page shows **no** "Invitation email look" section; Staff page shows **no** merge wizard / recent merges; import drawer accepts .csv and .xlsx text but a real upload is refused as "not available" while the route is off.
- [ ] Browser console: only the intentional blocked requests for switched-off routes.

## 6. Per-switch verification (TEST then production)
- **notifications**: owner turns on in Notifications → Office; "Notify caregivers" on a shift needing cover notifies only eligible assigned caregivers (never the caller-out); a caregiver sees it in Notifications, can mark read/archive; preferences honored; with email on and a sender, the message arrives with no client name; a forced failure retries (5, 15, 45 min, 2 h 15 min) then shows Failed in the history; audit events exist (`cover_notification.created`, `notification.delivery_failed`).
- **invitationBranding**: Offices → look saved; invite a TEST caregiver of that office: branded email with the office name/colour; resend branded; "Forgot password" email branded; with the trigger deliberately broken Cognito still sends its own message.
- **importRollback / bulkImport**: CSV and XLSX dry run shows counts and problem rows; confirm creates; same file again creates nothing; History lists it; Roll back succeeds for an unused import and refuses with the reason after a record is used.
- **staffDuplicates**: report → wizard shows both records, conflicts need a choice, merge, Recent merges → Undo works only while unchanged; refusal text is plain.
- **operationsReadiness**: figures equal Dashboard / Documents / Schedule / Compliance; a role without a permission sees "Not available to your role", never zeros.

## 7. Monitoring (first 24 h per switch)
CloudWatch: API errors/5xx, the NotifySweep invocations (every 5 min) and errors, email Lambda errors and throttles, the custom-message Lambda (outcome counts only: `branded` / `default_message`), RDS CPU/connections. SES: bounces and complaints (configuration set recommended). Cost: EventBridge rule and Lambdas are far below any charge; SES about $0.10 per 1,000 emails (confirm on the AWS pricing page).


## TEST migration runbook (0113-0116) - owner-run, approved 2026-11-23

Approved by the owner for TEST only. Claude cannot run it: the build container has no AWS CLI and no route to the TEST database, so the owner (or an operator) runs it from the usual TEST shell/tunnel. Script: `docs/releases/2026-11-20-test-plan/toolchain/TEST_PENDING_LEDGER.sh` (checks in `VERIFY_PENDING.sql`). Rehearsed locally on a copy of the TEST baseline (ledger 111/0112): probe, apply, verify, and reverse rollback for all four passed.

1. Backup (owner decision 2026-11-23: RDS snapshot, because CloudShell has only a PostgreSQL 15/16 client and the server is 18.3): `aws rds create-db-snapshot --region us-west-2 --db-instance-identifier ogevia-postgres --db-snapshot-identifier ogevia-test-rt2-pre-0113`, then wait until `aws rds describe-db-snapshots --region us-west-2 --db-snapshot-identifier ogevia-test-rt2-pre-0113 --query 'DBSnapshots[0].Status'` says `available`. Pass it as `OGEVIA_TEST_SNAPSHOT=<id>`; `apply` refuses a snapshot that is not of `ogevia-postgres`, not `available`, or older than 24 hours. A logical dump (`OGEVIA_TEST_BACKUP`) still works if taken with a PostgreSQL 18 client; an empty, under-100 kB or unreadable file is refused. Run all commands through `bash TEST_DB_SESSION.sh bash TEST_PENDING_LEDGER.sh <mode> <migration>`.
2. Connection: set `PGHOST PGPORT PGUSER PGPASSWORD`, `PGDATABASE=ogevia_sv_test` (the script refuses any other name and anything containing "prd").
3. Per migration, in order 0113, 0114, 0115, 0116: `bash TEST_PENDING_LEDGER.sh probe 0113`, then `OGEVIA_DEPLOY_APPROVAL=<ref> OGEVIA_TEST_BACKUP=BK bash TEST_PENDING_LEDGER.sh apply 0113`, then `... verify 0113`. Stop at the first failure (a failed apply rolls back by itself).
4. Rollback (reverse order 0116 -> 0113): `OGEVIA_DEPLOY_APPROVAL=<ref> bash TEST_PENDING_LEDGER.sh rollback 0116`.
5. This only creates tables and functions. The new features stay OFF: no route exists until a separate TEST deploy turns a switch on.
6. Not part of this runbook: the TEST ledger is read, not assumed. If `probe` reports prerequisites missing (0091, 0105, 0106, 0110, 0111), stop and report the line it printed.

### TEST migration status (2026-11-23)
Owner ran `TEST_PENDING_LEDGER.sh` in TEST through `TEST_DB_SESSION.sh`, one migration at a time, with RDS snapshot `ogevia-test-rt2-pre-0113` as the backup gate. Reported by the owner (output pasted in chat, not independently observed by Claude): 0113 applied and verified (60/60 checks), 0114 (14/14), 0115 (11/11), 0116 (19/19); TEST ledger 111/0112 -> 115/0116. Scope of the check: objects, grants, definer/search_path and ledger rows only. Not yet verified in TEST: any behaviour of the new functions, the API routes, the web screens, SES sending, the Cognito trigger. All feature switches remain OFF; no TEST deploy has happened. Keep the snapshot until TEST acceptance; it is the TEST rollback point (the `down` scripts are the other).

## TEST stage 1 - cover-shift notifications, in-app only (PREPARED, NOT RUN)
Script: `docs/releases/2026-11-20-test-plan/toolchain/TEST_RT2_N1_NOTIFICATIONS.sh`; gate: `diff_gate_rt2.py --stage notifications`. Owner-run, TEST only (`Ogevia-prod-*`, `ogevia_sv_test`).
What turns on: `features.notifications` only. Exact delta allowed by the gate (everything else must be identical to the live TEST stack): 10 routes, one `rate(5 minutes)` rule + its invoke permission, Handler env `COVER_ALERT_ADDRESS_RULES=on`, new code assets of the `Handler*` and `IdentityHandler*` functions. No email function, SES permission or sender (email stays off until the sender decision; in-app notifications and history work, queued emails are simply not sent).
Order inside the script: guards -> read-only capture -> verify migrations 0113-0116 (read-only) -> synthesize and gate the OFF and ON assemblies -> typed confirmation `DEPLOY-TEST-NOTIFICATIONS` -> `cdk deploy` of the one API stack -> post-deploy checks (all 10 routes answer 401 without a token, schedule exists, template == assembly, Handler still points at `ogevia_sv_test`) -> web publish and checks. Stops at the first failure. Rollback modes, in this order: `rollback-web`, `rollback-routes` (redeploys the saved OFF assembly; routes answer 404 again), `rollback-api` (restores the captured Handler ZIP). The database is not changed by this stage; its restore point is snapshot `ogevia-test-rt2-pre-0113` and its rollback is `TEST_PENDING_LEDGER.sh rollback` in reverse order.
Verified by Claude: the gate against real synthesized templates (`test/diff-gate-rt2.test.ts`, 7 tests: accepts exactly the delta, refuses an extra resource, a missing route, a policy change, a wrong or extra env var, a foreign code bucket, a changed Identity setting, an Outputs change); the script against stand-in AWS tools (`test/test-rt2-n1-notifications.test.ts`, 4 tests: guards, stop-before-change cases, happy-path order, rollbacks). NOT verified: any run against the real TEST account.
Needs from the operator: Node 22, pnpm 9.15.4, aws CLI v2, jq, python3, curl, the Session Manager plugin, and a work directory with several GB free (the script installs dependencies and builds under `$WORK`). CloudShell's roughly 1 GB home folder is not enough; use a machine or volume with space.
After the run: browser checks in TEST (notification centre and bell, Winchester shift coordinated by Temecula, office chooser when no office is assigned, address block for a client without city/ZIP, sender exclusion). Email, branded invitations, import rollback and duplicate-merge switches are later stages.


## TEST stage 2 - migration 0117 and the open-shift texting switch (PREPARED, NOT RUN; needs owner approval)
* **Migration 0117** (`db/pending/migrations/0117_open_shift_sms.sql`, rollback `rollback/0117_open_shift_sms.down.sql`, which drops the texting tables and the office-category notifications: BACKUP REQUIRED). `TEST_PENDING_LEDGER.sh` now accepts 0117 (needs 0063, 0104 and 0113 in the ledger). Rehearsed locally on a copy of the TEST baseline: probe, apply, verify, rollback for 0113 to 0117. Not applied to TEST.
* **Switch** `features.openShiftSms` (needs `features.notifications`; OFF in TEST and production; adds 7 JWT routes and `SMS_MODE=mock` on the API function; nothing else). Mock sender only: no network call is possible. Stage 1 (`TEST_RT2_N1_NOTIFICATIONS.sh`) is unchanged and does not include texting; its expected-only gate allows only the stage 1 delta. A stage 2 script and gate are **not yet written**: write them after stage 1 is accepted in TEST, reusing `diff_gate_rt2.py` with a stage entry for the 7 routes and `SMS_MODE`.
* **New behavior that arrives with the 0117 migration even before any switch is turned on** (these are changes to existing functions, so they apply once the migration is applied): the board and office queue columns, the call-out hook, the cancel and filled triggers (they only act on shifts that have alerts or requests), and the alert round key. With notifications and texting off, they create no notifications.

### TEST stage 1 status (2026-11-23, reported by the owner)
Owner ran `TEST_RT2_N1_NOTIFICATIONS.sh` from a `/tmp` checkout of commit `b0848ede21d6c7f868ae6093ea513dda3f5dd653` and typed the confirmation. The script reported: `RT2 STAGE 1 COMPLETE (TEST): notifications ON in-app only (287 routes), 5-minute schedule live, web serves b0848ede...`; production not touched. Rollback reference: `/tmp/rt2/work/rt2n1-20261123T201506Z` (owner copies it to the home folder). Route count 277 -> 287 is the expected +10. The script's own post-deploy checks (all ten routes answer 401 without a token, schedule rule exists, template equals the assembly, Handler still targets `ogevia_sv_test`, web build carries the commit) are reported as passed by its COMPLETE line; Claude has not seen the full output and has no access to TEST. **Not yet verified:** the browser checks below. Email and live texting are OFF.

#### Browser acceptance in TEST (synthetic data only; owner or operator, on https://d2xumch5w0izfg.cloudfront.net)
1. As the agency owner: Notifications > open-shift settings: turn on, email OFF, audience "office", subject keeps `{city}`; save.
2. Two offices exist (Temecula, another). A synthetic client with service city Winchester and ZIP, coordinated by Temecula; a synthetic open shift for it.
3. As a manager: Send open-shift alert on that shift. Expect the subject `Open shift in Winchester | <date> | <time>`, body `Coordinating office: Temecula`, and only Temecula's caregivers (not the sender) notified; a second send creates no second copy.
4. Shift with no assigned office and several offices: the alert asks for an office first. A client with no city or ZIP: the alert is blocked with a link to the client record.
5. As a caregiver in Temecula: the notification appears in Notifications (unread count, mark read, archive); the shift is on My shifts > Open shifts with the city and office; request and withdraw.
6. Cross-agency: a caregiver of another agency sees nothing.
Texting, "Filled" notices, the office queue preselection and the round/cancel fixes arrive with migration 0117 (stage 2) and are not testable in TEST yet.


## Client service location (migration 0118) - PREPARED, NOT RUN
See `docs/release-train-2/client-service-location.md`. Migration 0118 (`db/pending/migrations/0118_client_service_location.sql`, rollback `rollback/0118_client_service_location.down.sql`) and switch `features.serviceLocation` (OFF in TEST and production; 2 JWT routes; `SERVICE_LOCATION=on`). `TEST_PENDING_LEDGER.sh` accepts 0118 (needs 0111, 0113, 0117); rehearsed locally (apply, verify, rollback). The TEST stage that carries migrations 0117 and 0118 and the switches `openShiftSms` and `serviceLocation` is scripted as `TEST_RT2_N2_SMS_LOCATION.sh` (see the next section).


## TEST stage 2 - 0117 + 0118 + openShiftSms (MOCK) + serviceLocation (owner GO 2026-11-24: AWS TEST only; PREPARED, NOT YET RUN)
Script `docs/releases/2026-11-20-test-plan/toolchain/TEST_RT2_N2_SMS_LOCATION.sh`; gate `diff_gate_rt2.py --stage stage2`; evidence query `CHECK_STAGE2.sql`. Application code is the audited commit `88c104b2296f732d29406911d3f872d5475b0655`; the release commit may add only tooling, tests and documents on top, and the script refuses to run if any file under `apps`, `packages`, `infra/aws/lib`, `infra/aws/bin`, the lock file or the pending migrations differs from it.
Order: guards -> read-only capture -> 0113-0116 verified and 0117/0118 absent -> OFF and ON assemblies gated (ON = exactly 9 routes and the Handler variables `SMS_MODE=mock`, `SERVICE_LOCATION=on`, plus new code; nothing else) -> typed confirmation `DEPLOY-TEST-STAGE2` -> fresh RDS snapshot (waited until available) -> 0117, verify, 0118, verify -> `cdk deploy` of the one API stack -> checks (9 routes answer 401 without a token; Handler variables; **no email function exists**) -> web publish and checks. Rollback modes in this order: `rollback-web`, `rollback-routes`, `rollback-api`, `rollback-db` (0118 then 0117; drops the texting tables; the snapshot id is in the capture folder).
Verified by Claude: the gate against real templates (`diff-gate-rt2.test.ts`, 9 tests), the script against stand-in AWS tools (`test-rt2-n2-sms-location.test.ts`, 4 tests), the ledger script for 0117/0118. NOT verified: any run against the real TEST account, the browser checks below.
Data steps in the TEST app (owner, after deploy; not done by the script): (1) Notifications > open-shift settings: **turn email OFF** (it is ON in TEST today although no sender exists) and save; (2) Text messages panel: turn on, test sender, set quiet hours off for the check (00:00 to 00:00), add a synthetic on-call number; (3) the eligible caregiver (TEST-CG-01) opts in with a synthetic number.
Browser checks (synthetic data, https://d2xumch5w0izfg.cloudfront.net or https://demo.ogevia.com): 
1. **Demo Today A** profile: one Service location section reading `Winchester, CA 92596 · Riverside County · Temecula office`; Details has no City field and does not say "No city"; one Edit service location form (city, ZIP, county, coordinating office). The county, if suggested from other clients, is labelled "Suggested ... (from other clients with this ZIP)" and stays editable.
2. A client with no ZIP or no city: the section says exactly what is missing; the open-shift alert's block on the Schedule links straight to the form (`?edit=location#service-location`).
3. Create a new open shift for Demo Today A two or more days ahead (leave the shift's office blank; the Nov 24 shift has started). Send the alert or wait up to 5 minutes. Expect: subject `Open shift in Winchester | ...`, body `Coordinating office: Temecula`, no office chooser. The eligible caregiver sees the shift on My Schedule > Open shifts ("Winchester", "Coordinated by Temecula") and the notification in Notifications; requests it; the office queue preselects the earliest eligible request; confirming gives the chosen caregiver "You are confirmed" and others "Filled".
4. Texts: run `CHECK_STAGE2.sql` (read-only): `sms_live_provider_rows` is 0, every sent text has a `mock-` id, the recruitment/confirmation rows for Demo Today A show provider mock; email deliveries show no `sent`.

### TEST stage 2 status (2026-11-24, reported by the owner)
Owner ran `TEST_RT2_N2_SMS_LOCATION.sh` from a `/tmp` checkout of release commit `9b2fdef80a4d60b68b2303006a47da646069c129` (application code identical to the audited `88c104b2296f732d29406911d3f872d5475b0655`), reusing snapshot `ogevia-test-rt2-n2-20261124t030750z`, and typed `DEPLOY-TEST-STAGE2`. The script reported: `RT2 STAGE 2 COMPLETE (TEST): migrations 0117 and 0118 applied (ledger 117/0118), openShiftSms (MOCK sender only) and serviceLocation ON (296 routes), web serves 9b2fdef8...`; email and live texting off; production not touched. Route count 287 -> 296 is the expected +9. Rollback reference: `/tmp/rt2n2/work/rt2n2-20261124T031440Z` (snapshot id inside). Earlier attempts stopped before changing anything: a pre-check bug (0118 probed before 0117) and a snapshot wait that exceeded the AWS wrapper's 5-minute call limit; both fixed and tested before this run. Claude has not seen the full output of this run and has no access to TEST. **Not yet verified:** the data steps and browser checks above, and `CHECK_STAGE2.sql`.
