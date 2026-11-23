# Deployment and rollback: Open Shifts and SMS (every step needs the owner's explicit go; nothing here has been run)

Follows `docs/TESTING_AND_RELEASE_PROCESS.md`: complete `RELEASE_CHECKLIST_TEMPLATE.md`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, the database and API suites, local harness, pilot validation, then the owner's GO.

## Deployment sequence
1. **TEST first.** Snapshot the TEST database. Apply migration 0086 with the repository runner (no message can be queued: SMS defaults off, the schedule does not exist yet). Run `infra/aws/db/verification` (01 and 08 must pass).
2. Deploy the API stack with the new routes and the observability stack (3 log metric filters, 3 alarms, `AlarmEmail` per the existing owner decision). The `CoverageSms` rule is created **DISABLED**.
3. Deploy the web build. Verify in TEST with synthetic data: Settings → Open shifts and texts; set cities; post, request, approve, call out, cancel (the same steps as `local-harness/open-shifts-e2e.mjs`).
4. **Rollback rehearsal on TEST** before production: run `0086…down.sql` on a restored copy, then re-apply (the test `open-shifts-rollback.db.test.ts` does this on synthetic data).
5. **Production** (separate approval): backup snapshot, apply 0086, deploy API, observability and web in that order, with the schedule still DISABLED. Confirm nothing is queued: `select count(*) from ogevia.notification_jobs` is 0.
6. **SMS go-live per agency** (separate approval, after external items below): set the agency's `sms_entitled`, `sender_number`, `sender_status = 'verified'` (platform, by SQL); set the function environment (`SMS_TRANSPORT`, `APP_ORIGIN`, optional `SMS_ALLOWLIST` for a first test); approve the AWS SDK package and wire the transport; enable the schedule; the agency owner turns the agency switch on and sets the monthly limit. First live test with an allowlisted number only.

## External items still required (not code)
AWS End User Messaging account/region support and rate confirmation · one registered toll-free number per agency (identity, website, opt-in evidence, message samples, privacy and terms links) and its verification · approval to add the SMS SDK package · alarm recipient address · owner approval of defaults (window, urgent/escalation hours, quiet hours, office hours, monthly limit, wording incl. "Reply STOP") · optional: SES for email alerts, a DLQ for the scheduled run.

## Rollback sequence
1. **Stop sending first**: agency switch off / platform switch / disable the `CoverageSms` rule. Texts already sent cannot be recalled.
2. **Web and API**: redeploy the previous builds (the legacy `/v1/open-shifts` and `/pickup` routes and their database functions are still present until step 3).
3. **Database** (BACKUP REQUIRED; take a snapshot): `infra/aws/db/rollback/0086_open_shifts_board_and_sms.down.sql` as the owner role, then remove the ledger row. It drops only the board's tables and columns, restores the 0063 confirmation and request statuses; shifts, reservations, assignments, visits and legacy pickup requests are untouched (verified in `open-shifts-rollback.db.test.ts`: counts identical, 0063 pickup works again, 0086 re-applies).
4. Remove the observability additions by redeploying the previous template if desired (harmless to leave).
