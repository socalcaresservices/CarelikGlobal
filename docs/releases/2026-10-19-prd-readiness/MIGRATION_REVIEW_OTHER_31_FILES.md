# Review of the other 31 migrations in 0047-0085

Read-only static review of the repository files, 2026-10-20. Nothing was executed and there was no production access. Files: 0048-0052, 0056-0070, 0073, 0075, 0077-0085. The other eight (0047, 0053, 0054, 0055, 0071, 0072, 0074, 0076) are in `MIGRATION_REVIEW_EIGHT_FILES.md`. Method: a script that removes comments and `$$ ... $$` function bodies and classifies each top-level statement (so statements inside functions are not counted as migration-time), followed by a manual read of every file it flagged. This does not replace running the migrations on a restored copy of `ogevia_prd`.

## Results
| Question | Result |
|---|---|
| Top-level UPDATE, DELETE or TRUNCATE on existing data | **None** in all 31 files |
| Top-level INSERT (migration-time data written) | 0048 (permission `accounts.manage` + owner grant), 0069 (permission `reports.export` + role grants), 0060 (one policy row, see below). No other. |
| DROP TABLE, DROP COLUMN, DROP INDEX, ALTER COLUMN, SET NOT NULL, RENAME, ADD CONSTRAINT on existing tables | **None** |
| ALTER TABLE on existing tables | 0050 only: nullable `service_visits.unscheduled_reason` and `visit_confirmations.attestation_version`, each with a check that permits NULL (existing rows pass). The other ALTER TABLE statements enable row-level security on tables the same file creates. |
| Constraint that could reject existing rows | One: 0061 creates unique index `shifts_series_start_unique (series_id, starts_at)` on `shifts` (live shifts only). A preceding DO block is a read-only guard: it raises an error if duplicates exist, so the migration stops and rolls back with nothing changed. A fail-safe design; production is unlikely to have recurring shifts but that is unverified. |
| DO blocks | One (0061, the guard above). |
| New tables | 0050 (2), 0056 (2), 0060 (1), 0063 (1), 0064 (1), 0067 (1), 0068 (2), 0069 (1), 0073 (4), 0077 (2): no effect on existing rows. |
| Triggers added to existing tables | See next table. They change how future writes behave; they do not touch existing rows. |
| Non-transactional operations | None in all of 0047-0085 (no CONCURRENTLY, VACUUM, ALTER TYPE ADD VALUE). |

## Triggers on existing tables (behaviour change on future writes)
| Migration | Trigger | Effect |
|---|---|---|
| 0060 | `shifts_work_hours` before insert or update on `shifts` | Enforces the agency work-hour policy on scheduling. The policy lookup is by agency slug. The migration inserts exactly one policy row, for slug `socal-care-services` (8 hours a day, 40 a week, owner directive 2026-10-17). It limits scheduled time only and has no effect on an agency without a policy row. |
| 0063 | `shifts_close_pickups` after update on `shifts` | Closes open pick-up requests when a shift is assigned or changes status. |
| 0064 | history trigger on `caregiver_background_checks`; no-delete and guarded-update triggers on `caregiver_compliance_holds` | Records history; compliance holds can no longer be deleted. |
| 0065 | `shifts_authorization` before update of `caregiver_record_id` on `shifts` | Rechecks authorization when an office user changes the assigned caregiver. |
| 0050, 0067, 0068, 0069, 0073, 0077 and others | no-update and no-delete triggers on tables each file creates | Makes the audit tables append-only. |
Any manual maintenance of `shifts` or `caregiver_compliance_holds` after the upgrade will go through these triggers.

## Function removals (35 DROP FUNCTION statements across 0047-0085)
Every dropped function is recreated by name in the same or a later file, **except** `ogevia_api.record_report_export` in 0072, which is removed on purpose and replaced by three new functions (see the correction in the other review). These changed signatures matter for compatibility with the 2026-10-10 production API:
- **0050 drops `start_ad_hoc_service_visit` and `confirm_service_visit`**, the caregiver start-visit and confirmation functions. During the gap between the migration and the API deploy, the old API cannot start an unscheduled visit or confirm a visit.
- 0057, 0067, 0079, 0081: utilisation overview and monthly summary (several recreations in sequence); 0061: shift-series functions; 0062: billing review list and visit review; 0063: `list_open_shifts`; 0068: `amend_client_authorization`; 0075: `list_shifts`; 0060: `assert_ready_for_work`.
These are the same compatibility window described for the first eight: migrations, then API and web immediately.

## Findings
1. Nothing in the 31 files changes or removes existing data at migration time. Data written: permission rows (0048, 0069) and one policy row (0060). (Static reading.)
2. The only migration that can refuse to run on existing data is 0061, and it refuses cleanly with a message before changing anything.
3. Compatibility, not data safety, remains the main risk: 35 function drops, including the caregiver visit start and confirmation functions in 0050.
4. Behaviour changes are intentional and already accepted on TEST: the SCS 8/40 limit, append-only audit tables, compliance-hold protections.
5. Combined with the first review, all 39 pending migrations have now been statically reviewed (8 + 31). That is a reading, not a rehearsal.

## Still required before a production run
Fresh named snapshot (B10); rehearsal of 0047-0085 on a copy of `ogevia_prd` restored to a new instance (also yields timing and the 0061 guard result on real data); production versions of the TEST gate scripts; the two script fixes; the `approval_ref` answer; a window with no production users; verification that production has no live recurring shifts and no tenant (row counts).
