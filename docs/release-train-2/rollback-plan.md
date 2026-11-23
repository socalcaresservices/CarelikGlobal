# Release Train 2 — Rollback plan (PROPOSED)

Principle: every capability is behind a switch, so the **first rollback is always to turn the switch off** (a routes-only change set; the routes disappear and the web hides the controls). Data rollback is separate, needs a snapshot and the owner's approval, and is rarely needed.

| Layer | Rollback | Data effect |
|---|---|---|
| Branch deployed with switches OFF (API code, web) | Re-apply the previous API Lambda bundle (change set with the earlier code asset) and restore the captured web files (the web release script prints the recovery path); invalidate CloudFront | None (no migration in this step) |
| `notifications` | Turn the switch off (schedule and routes go; the email Lambda is removed only if `notificationEmail` is also removed). In-app notifications and history stay in the database. **Pause sending immediately without a deploy:** in the app, Notifications → Office → untick "Notify caregivers about shifts that need cover" (stops new notifications; due emails already queued still send unless `notificationEmail` is removed) | Down script `0113_notifications.down.sql` drops the tables (history lost; audit events stay). Use only with a snapshot |
| `invitationBranding` / `auth.invitationEmail` | Remove `auth.invitationEmail` and redeploy the Auth stack: the pool returns to Cognito's default message (in-place update, no replacement). The trigger **fails open**, so a broken trigger never blocks sign-in | `0114_office_branding.down.sql` drops office looks (audit events stay) |
| `importRollback` | Switch off. Individual imports are undone **inside the app** with Roll back (records become Inactive; nothing deleted) | `0115_import_history_rollback.down.sql` restores the 0105 function and drops the records of which import created what (no rollback possible afterwards for existing imports) |
| `staffDuplicates` (merge hardening) | Switch off. A merge is undone in the app with Undo (only while unchanged) | `0116_staff_merge_hardening.down.sql` **refuses** if any profile has more than one merge link (a merge was reversed and repeated); resolve by hand first. Restores the 0106 functions and unique rule |
| `operationsReadiness` | Switch off | none |
| Dependencies | Revert `package.json`/`pnpm-lock.yaml` to `main`'s and redeploy web/API | none |

## Database rollback procedure (only if a migration must be removed)
1. RDS snapshot exists (taken before the migration). 2. Owner approval naming the migration. 3. Run the matching `db/pending/rollback/011x_*.down.sql` in one transaction with the ledger row removed in the same transaction (the existing per-release `ROLLBACK-PRODUCTION-…` scripts are the model). 4. Verify with the schema fingerprint comparison (`docs/stabilization/compare-production-schema.sh`) that the schema equals the pre-release capture. All four down scripts were exercised in the database tests (`*-0113/0114/0115/0116.db.test.ts`).

## What cannot be rolled back
Emails already sent; invitation emails already delivered; audit events (append-only by design); notification/merge/import history once a down script has dropped its tables.
