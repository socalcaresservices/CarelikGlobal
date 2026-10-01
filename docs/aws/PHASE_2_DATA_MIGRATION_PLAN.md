# Phase 2 — Data Migration Plan (BUILD ONLY — NOT EXECUTED)

No production data was read, exported, transformed or loaded in Phase 2. Every step below is a future YELLOW action that needs written owner approval. Production volume (Phase 0, VERIFIED): **0** service visits, signatures, corrections or billing rows; 9 clients; 10 authorizations; 12 caregiver records.

## 1. Preconditions

1. Phase 3 is complete: every migrating user has a Cognito account, and the `sub` ↔ `auth.users.id` mapping exists.
2. The BAA/security gate is satisfied (CLAUDE.md §8). No PHI moves before it.
3. A full `pg_dump --schema-only` of Supabase production is diffed against the repo (live metadata parity for the SV slice is VERIFIED; a full dump is still pending).
4. An RDS snapshot is taken immediately before the load.
5. The target is migrated with `db:migrate` and `db:verify` shows every check passing.
6. **Dual-write is prohibited** unless separately approved. The cutover uses a write freeze.

## 2. Extract

Use a read-only replica-safe export (`COPY (select …) TO STDOUT`) over TLS, selecting **only** the target columns (see `PHASE_2_SCHEMA_MAPPING.md`). Legal names, contact details, addresses, notes and payer member IDs are not extracted for the SV slice. Exports land on encrypted storage inside the AWS account and are deleted after reconciliation.

## 3. Transform rules

| Source                          | Target                                   | Rule                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.users.id`                 | `app_users.id`                           | **Preserve the UUID**. Set `cognito_sub` from the Phase 3 mapping. Users without a mapping are loaded `disabled`                                                                                                                                                                                                                                                                                                     |
| `organizations`                 | same                                     | Preserve IDs; slug → lower-case text                                                                                                                                                                                                                                                                                                                                                                                 |
| `organization_memberships.role` | same                                     | Legacy `organization_admin/coordinator/staff` should already be remapped on main; any still present stay as-is (they carry no SV permissions)                                                                                                                                                                                                                                                                        |
| `caregiver_records`             | same                                     | Preserve IDs and `caregiver_code`; drop contact/address columns                                                                                                                                                                                                                                                                                                                                                      |
| `clients`                       | same                                     | Preserve IDs, `client_code`, `caregiver_display_code`, status                                                                                                                                                                                                                                                                                                                                                        |
| `client_authorizations`         | same                                     | Preserve IDs. `monthly_authorized_minutes = round(max_monthly_hours × 60)`. `lineage_id` = the v1 root found by walking `supersedes_id`. Validate: no overlapping current rows (the exclusion constraint will reject them; resolve overlaps **before** load with the owner), contiguous versions, superseded rows linked                                                                                             |
| `service_visits`                | same                                     | Preserve IDs and **all timestamps verbatim** (`time_in`, `time_out`, `signed_at`, `locked_at`, `created_at`). Backfill `visit_number_snapshot` where NULL (live column is nullable) from `shifts.visit_number`, otherwise a deterministic `LEGACY-<id prefix>`. Load with `session_replication_role = replica` so the lifecycle trigger accepts historical final states. Then run `db:verify`                        |
| `visit_signatures`              | `visit_confirmations` + `visit_evidence` | One confirmation per visit: method, signer role/relationship/name/reason, snapshot → `confirmed_visit_snapshot`, `confirmation_version` from the snapshot (default 2 for legacy rows), `confirmed_at = signed_at`, `confirmed_by` = visit caregiver. When `storage_path` is set: Phase 5 copies the object to S3 (same key shape), computes SHA-256 and size, and writes a `visit_evidence` row with that version ID |
| `visit_corrections`             | same                                     | Preserve IDs and snapshots                                                                                                                                                                                                                                                                                                                                                                                           |
| `audit_logs` (SV entity types)  | `audit_events`                           | Copy action, actor, org, entity, time. **Strip `old_values`/`new_values` columns that contain names or notes**, keeping IDs, statuses, minutes and timestamps                                                                                                                                                                                                                                                        |
| `role_permissions`              | same                                     | Copy all rows; the target seeds only the 6 SV keys                                                                                                                                                                                                                                                                                                                                                                   |

## 4. Load order (foreign keys)

`app_users` → `organizations` → `organization_memberships` → `permissions`/`role_permissions` → `caregiver_records` → `clients` → `services` → `caregiver_assignments` → `shifts` → `shift_coverage_events` → `client_authorizations` (version 1 first, then ascending `version_number`) → `service_visits` (originals first, then correction rows) → `visit_evidence` → `visit_confirmations` → `visit_corrections` → `audit_events`.

## 5. Reconciliation (all must pass before cutover)

1. **Row counts** per table, source vs target (exact).
2. **Checksums:** `md5(string_agg(<canonical column list>::text, '|' order by id))` per table for migrated columns, computed identically on both sides.
3. **Authorization totals:** per lineage and month, the sum of `billable_minutes` matches the source; caps match `round(hours × 60)`.
4. **`db:verify`:** all checks `ok`. Informational over-cap months are reviewed by a human.
5. **Spot checks** of 20 random visits (times, statuses, minutes) by an owner-approved reviewer.

## 6. Cutover window

1. Announce a freeze. Disable Service Verification writes in the Supabase-backed UI (feature flag).
2. Final extract → load → reconcile.
3. Switch the frontend's SV backend flag to AWS (Phase 6).
4. Smoke test with a synthetic org.
5. Keep Supabase read-only and untouched for rollback.

## 7. Rollback

Before the flag flip: drop the target database or restore the pre-load snapshot; Supabase is unchanged. After the flip, any AWS-side writes would be lost by switching back, so post-cutover rollback means exporting AWS-created rows first (forward reconciliation), and needs owner approval. See `PHASE_2_ROLLBACK_PLAN.md`.
