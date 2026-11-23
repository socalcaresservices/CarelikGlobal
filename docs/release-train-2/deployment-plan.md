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

1. Take a TEST logical backup and its checksum: `pg_dump -Fc ogevia_sv_test > BK && sha256sum BK > BK.sha256`.
2. Connection: set `PGHOST PGPORT PGUSER PGPASSWORD`, `PGDATABASE=ogevia_sv_test` (the script refuses any other name and anything containing "prd").
3. Per migration, in order 0113, 0114, 0115, 0116: `bash TEST_PENDING_LEDGER.sh probe 0113`, then `OGEVIA_DEPLOY_APPROVAL=<ref> OGEVIA_TEST_BACKUP=BK bash TEST_PENDING_LEDGER.sh apply 0113`, then `... verify 0113`. Stop at the first failure (a failed apply rolls back by itself).
4. Rollback (reverse order 0116 -> 0113): `OGEVIA_DEPLOY_APPROVAL=<ref> bash TEST_PENDING_LEDGER.sh rollback 0116`.
5. This only creates tables and functions. The new features stay OFF: no route exists until a separate TEST deploy turns a switch on.
6. Not part of this runbook: the TEST ledger is read, not assumed. If `probe` reports prerequisites missing (0091, 0105, 0106, 0110, 0111), stop and report the line it printed.
