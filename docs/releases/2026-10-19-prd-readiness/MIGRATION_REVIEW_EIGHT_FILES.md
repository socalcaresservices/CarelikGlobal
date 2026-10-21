# Review of the eight flagged migrations (0047, 0053, 0054, 0055, 0071, 0072, 0074, 0076)

Read-only static review of the repository files, 2026-10-20. Nothing was executed, no production access. Purpose: decide whether any of the 39 pending migrations (0047-0085, production is at 0046) can lose or reject existing production data. This is a reading of the SQL text, NOT a rehearsal; it does not replace running the migrations on a restored copy of `ogevia_prd`.

## Correction to the earlier scan
The earlier text scan flagged these files on words such as UPDATE and DELETE. Most of those matches are inside function bodies (`$$ ... $$`), which run only when the application calls the function, not when the migration runs. Migration-time (top-level) statements in the eight files were listed separately.

## Migration-time statements per file
| File | Top-level changes to existing tables | Top-level data statements | Result |
|---|---|---|---|
| 0047 availability override one shift | adds 5 nullable columns to `availability_overrides`; replaces 4 constraints (client FK, original_status, one_shift, consumed_shape) | none | New checks all permit NULL in the new columns, so existing rows pass. Drops and recreates `authorize_availability_override` (5-arg form removed) and `list_shifts`. Existing override rows have no client and are inert (the file's own comment). |
| 0053 patterns, hour limits, make-up | adds nullable `pattern` jsonb and `makeup_for_shift_id` to existing tables; replaces `shift_series_skipped_dates_reason_check` | none | New check `valid_series_pattern(pattern)`: the function begins `if p is null then return true`, so existing rows (NULL pattern) pass (read in the file). Drops and recreates 7 functions. |
| 0054 recruiting/onboarding | replaces `caregiver_records_status_check` (old: onboarding, ready, active, inactive; new adds applicant, interview, offer, pending_documents) and the skipped-dates check; adds `onboarding_required boolean not null default false` | none | Widening only. NOT NULL with a constant default: no table rewrite on PostgreSQL 11+ (instance is 18.3). Drops and recreates `list_caregivers(uuid)`. |
| 0055 compliance hold | adds nullable `hire_date` with a range check; replaces three check constraints | INSERT of one permission key and one owner role grant | Widening only; inserts only into the global permission tables. |
| 0071 authorization decrease review | replaces two check constraints | none | Widening only (adds visit_outside_period, visit_over_cap, delivered_unverified). Drops and recreates `list_authorization_amendment_impacts`. |
| 0072 export request/generation | `alter column row_count drop not null` | none | Relaxation; cannot reject rows. Recreates `list_report_exports`; **removes `record_report_export` for good** (the browser-assembled export path is replaced by `request_report_export`, `complete_report_export`, `fail_report_export`; stated in the file header). |
| 0074 client documents, holds | new tables only; row-level security on new tables | none | No change to existing rows. |
| 0076 agency performance audit report | replaces `report_exports_report_key_check` | none | Widening only (adds audit_report, billing_review). |

## Check-constraint replacements (static parse of the SQL; old set versus new set)
| Constraint | Removed values | Added values |
|---|---|---|
| `shift_series_skipped_dates_reason_check` (0035 to 0055, four steps) | none | availability_not_provided, availability_outside, documents_not_current, service_not_approved, over_hour_limit, onboarding_incomplete, compliance_hold |
| `caregiver_records_status_check` (0003 to 0054) | none | applicant, interview, offer, pending_documents |
| `shift_readiness_flags_kind_check` / `assignment_readiness_flags_kind_check` | none | compliance |
| `authorization_amendment_impacts_impact_kind_check` | none | visit_outside_period, visit_over_cap |
| `shift_reconciliations_outcome_check` | none | delivered_unverified |
| `report_exports_report_key_check` | none | audit_report, billing_review |
Every replacement only widens the allowed set, so existing rows cannot violate it. Limit of this check: for `caregiver_records_status_check` only the original 0003 definition was found; no intermediate redefinition was found by search.

## Findings
1. **No migration-time UPDATE, DELETE, DROP TABLE or DROP COLUMN on existing data in the eight files.** The only data statements are the two permission inserts in 0055. (Static reading, not proven by execution.)
2. **The real risk is the function drops.** 0047, 0053, 0054, 0071 and 0072 drop and recreate functions with changed signatures (for example `list_shifts`, `authorize_availability_override`, `list_caregivers`, `create_shift_series`, `list_authorization_amendment_impacts`, `record_report_export`, `list_report_exports`). The production API is the 2026-10-10 build and still calls the old signatures. **Between the migration run and the API deploy, those API calls will fail.** The plan must run migrations, then deploy the API and web immediately, and be scheduled when no one is using production. Production appears to have no configured agency (0 of 0), which is INFERRED, not verified.
3. **No hazards for running inside one transaction per file:** none of 0047-0085 uses CONCURRENTLY, VACUUM or ALTER TYPE ADD VALUE.
4. **Rollback files exist** in `infra/aws/db/rollback/` for each of the eight (checked by name; their content and a rollback test on production-like data were NOT reviewed). Rolling back a function change does not restore data that the application writes in between.
5. **Not reviewed:** the other 31 files in 0047-0085 (not flagged by the scan, but the scan only looked for destructive words). Row counts in production are unknown, so lock time and index build time cannot be estimated; with the 0 of 0 agencies observation they are probably small.

## What this changes in the plan
B2 stays open, but its risk is reduced from "unknown data risk" to "ordering and compatibility risk plus 31 unreviewed files". Still required before any production run: fresh named snapshot (B10), rehearsal of 0047-0085 on a copy of `ogevia_prd` restored to a NEW instance, a production version of the TEST gates, review of the remaining 31 files, and the fix of the two procedure defects.

## Correction (2026-10-20)
The row for 0072 originally said it drops and recreates two export functions. `record_report_export` is removed by design and replaced by three new functions; only `list_report_exports` is recreated. The 2026-10-10 production web predates the export feature (0069), so it does not call the removed function.
