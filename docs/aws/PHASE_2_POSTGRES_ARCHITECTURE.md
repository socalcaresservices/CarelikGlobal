# Phase 2 — PostgreSQL Service Verification Architecture

**Date:** 2026-10-01 · **Branch:** `claude/phase2-postgres-service-verification` (based on `origin/main` `de30bd8`)
**Production changes:** NONE. Nothing was applied to RDS or Supabase.
**Code:** `infra/aws/db/` (migrations, rollback, verification, tests, scripts)

## 1. Layering

```text
Phase 4 Lambda (verified Cognito JWT → sub)
   │  BEGIN
   │  SELECT ogevia_api.begin_request(<sub>, <request uuid>)   -- actor context, transaction-local
   │  SELECT ogevia_api.<operation>(...)                       -- SECURITY DEFINER, runs as ogevia_owner
   │  COMMIT
   ▼
schema ogevia_api   14 functions; the ONLY thing ogevia_app may execute
schema ogevia       18 tables, enums, internal helpers, triggers (owned by ogevia_owner)
schema ogevia_meta  schema_migrations ledger (version + SHA-256)
```

## 2. Roles (least privilege)

| Role              | Login                                                                                       | Privileges                                                                                 | Purpose                                                             |
| ----------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `ogevia_owner`    | NOLOGIN                                                                                     | Owns every object                                                                          | `SECURITY DEFINER` functions run as it. Migrations `SET ROLE` to it |
| `ogevia_app`      | NOLOGIN in Git (LOGIN plus a credential or IAM auth is granted at deploy time, outside Git) | `USAGE` on `ogevia_api` and `ogevia`; `EXECUTE` on `ogevia_api.*`; **no table privileges** | Lambda runtime                                                      |
| `ogevia_readonly` | NOLOGIN                                                                                     | `SELECT` on `ogevia.*` and `ogevia_meta.schema_migrations` (RLS `SELECT` policies)         | Verification scripts and approved, audited support                  |
| RDS master        | (existing)                                                                                  | Runs 0001 (roles, extension, schemas) and the migration runner                             | Administration only                                                 |

Tests prove the runtime role gets `42501 permission denied` on direct `SELECT`/`UPDATE`/`INSERT`/`DELETE`. No function is `PUBLIC`-executable, every function pins `search_path = ogevia, pg_temp`, and RLS is enabled with no app policies, as defense in depth.

## 3. Identity contract (replaces `auth.uid()`; Phase 3/4 populate it)

```text
Cognito access token (verified by API Gateway JWT authorizer)
  → Lambda reads claim `sub`
  → ogevia_api.begin_request(sub)        app_users.cognito_sub (unique, UUID format) → app_users.id
  → set_config('ogevia.actor_user_id', id, is_local => true)
  → ogevia.current_user_id()             every API function's actor
  → organization_memberships (status active, organization active) → role
  → role_permissions → has_permission(org, key)
  → caregiver_assignments (active, org-local date window) → client/service scope
```

- An unknown, disabled or empty `sub` raises `OGA01`. The context ends with the transaction, so a pooled connection can't leak identity (tested).
- `organization_id` passed by the caller is only a _selector_. Every function re-checks membership in that organization. For row-targeted calls (end, confirm, void, correct, amend, evidence) the organization comes from the row itself.
- There is **no platform-owner bypass**, unlike current main. Cross-tenant support access needs a later, explicitly audited design.

## 4. Data model

| Table                                                                                                  | Key invariants                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_users`                                                                                            | `cognito_sub` unique, UUID-shaped                                                                                                                                                        |
| `organizations`, `organization_memberships`, `permissions`, `role_permissions`                         | Final current-main grants for the SV permissions                                                                                                                                         |
| `caregiver_records`, `clients`, `services`, `caregiver_assignments`, `shifts`, `shift_coverage_events` | Composite `(id, organization_id)` foreign keys make cross-tenant references impossible. Client codes are 40 random bits (fixes M-3). There are no legal names, DOB, address or payer IDs |
| `client_authorizations`                                                                                | `lineage_id`; exclusion constraint: **at most one current version covers any date**; integer `monthly_authorized_minutes`; immutable except the supersede transition; never deleted      |
| `service_visits`                                                                                       | Server timestamps; one open visit per caregiver (partial unique indexes); a guard trigger enforces legal transitions `draft→awaiting_signature                                           | voided`, `awaiting_signature→signed | administrator_review | voided`, `signed | administrator_review→corrected` only; identity and time columns immutable; never deleted |
| `visit_evidence`                                                                                       | S3 metadata only: key `{org}/{visit}/client-signature.png` (CHECK), version ID, `image/png`, size 1 B–1 MiB, SHA-256. Append-only                                                        |
| `visit_confirmations`                                                                                  | One per visit; method/evidence/name/reason CHECKs; snapshot with `confirmationVersion` 4. Append-only                                                                                    |
| `visit_corrections`                                                                                    | One per original row; before/after snapshots; actor; reason. Append-only                                                                                                                 |
| `audit_events`                                                                                         | Every state change: actor, organization, action, entity, request ID, reason, before/after (IDs, statuses, minutes and times only; no names or notes). Append-only                        |
| `idempotency_records`                                                                                  | `(actor, operation, key)` → request fingerprint + stored response                                                                                                                        |

## 5. Authorization accounting (M-1 fix)

- **Resolution:** `resolve_current_authorization` returns only an `is_current`, non-deleted row covering the date. The exclusion constraint guarantees there is at most one.
- **Usage:** `authorization_month_usage(lineage, date)` sums `billable_minutes` of signed and administrator_review visits across **every version of the lineage** for the calendar month.
- **Cap:** at confirmation, the cap comes from the lineage's current version covering the service date, and the visit is rebound to that version. If no current version covers the date any more, billable = 0 and the visit goes to `administrator_review`.
- **Concurrency:** confirm, correct and amend take a transaction advisory lock per lineage. Concurrent confirmations serialize, and the total never exceeds the cap (tested with 2 and 3 parallel confirmations).
- **Exactness:** integer minutes throughout. Hours exist only in migration (`round(hours × 60)`) and display.

## 6. Idempotency contract (Phase 4 must follow)

| Operation                                  | Retry behavior                                                                                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| start                                      | With `p_idempotency_key`, returns the same visit ID; parallel retries collapse to one (tested ×5). Without a key, the one-open-visit rule rejects the duplicate                    |
| end                                        | Naturally idempotent: returns the original server timestamps, writes no second audit event                                                                                         |
| register evidence, confirm, correct, amend | With a key, returns the stored result. The same key with different parameters raises `OGI09`. Without a key, a second confirm/correct fails on the locked state (no double effect) |

The Phase 4 API must generate one UUID per user action, send it on every retry of that action, and treat `OGI09` as a client bug.

## 7. Error contract

| SQLSTATE                    | Meaning                                                                           | Suggested HTTP  |
| --------------------------- | --------------------------------------------------------------------------------- | --------------- |
| `OGA01`                     | Not authenticated / unknown identity                                              | 401             |
| `OGA03`                     | Forbidden (role, assignment, other caregiver's visit, inactive org)               | 403             |
| `OGN04`                     | Not found, **including another organization's rows**, so existence isn't revealed | 404             |
| `OGC09`                     | State conflict (locked, already ended, open visit exists, overlap, immutable)     | 409             |
| `OGV22`                     | Validation                                                                        | 422             |
| `OGI09`                     | Idempotency key reused with a different request                                   | 422             |
| `23514` / `22P02` / `23P01` | Constraint / bad enum / exclusion violation                                       | 422 / 422 / 409 |

Messages contain no PHI.

## 8. Configuration

- **Database name:** never hard-coded. Tests create `ogevia_test_<random>`. Production's name is a deployment-time setting, because RDS `DBName` is null (Phase 1, VERIFIED).
- **Connection string:** comes only from the environment (`OGEVIA_DATABASE_URL`). `scripts/migrate.ts` refuses any non-local host unless `OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner`.
- **Extensions:** `btree_gist` only (supported on RDS PostgreSQL). `pgcrypto` was deliberately removed.

## 9. PostgreSQL version

- **Local test runtime:** PostgreSQL **16.13**. The Docker daemon was unavailable, so a disposable cluster was used.
- **Production:** RDS PostgreSQL **18.3**. No PG 17/18-only syntax is used.
- `.github/workflows/ci.yml` has a new `postgres` job that runs the full DB suite on `postgres:18`. It has **not executed yet**: it runs on the next PR or push to `main`.
