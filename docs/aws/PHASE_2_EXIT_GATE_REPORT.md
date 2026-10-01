# PHASE 2 EXIT GATE REPORT — PostgreSQL Service Verification Build

**Verdict: PHASE 2: PASS**

- **Branch:** `claude/phase2-postgres-service-verification`
- **Current-main base:** `de30bd804e01570851b9c61f058e22341a3c5903`; `git merge-base HEAD origin/main` = that SHA (VERIFIED)
- **Code baseline for this report:** `44b6f4a` (the final SHA is the commit that adds this file)
- **Production changes: NONE.** Nothing was applied to RDS. Supabase was not modified (only read-only catalog metadata was queried). No secret values read, no PHI read, no deploy/bootstrap/import, no IAM/SG/RDS/S3/KMS/Cognito/budget/DNS/Netlify change.

## Pass criteria

| #   | Criterion                                 | Result | Evidence                                                                                                                                                                |
| --- | ----------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Based on current main                     | PASS   | merge-base = `origin/main` `de30bd8`                                                                                                                                    |
| 2   | Phase 1 infra reconciled safely           | PASS   | `infra/aws` + `docs/aws/PHASE_1_*` from `304fba3`, Phase 0 AWS docs from `449b04f`; no PR #43 history; lockfile only adds the infra importer; 53 CDK tests + synth pass |
| 3   | Current SV schema/behavior mapped         | PASS   | `PHASE_2_SCHEMA_MAPPING.md`, `PHASE_2_RPC_PARITY_MATRIX.md`; live SV metadata parity VERIFIED                                                                           |
| 4   | Portable RDS migrations exist             | PASS   | `infra/aws/db/migrations/0001–0008`                                                                                                                                     |
| 5   | Clean DB migrates from zero               | PASS   | Every test file + `db:migrate` (`applied 8`) + second-DB identity test                                                                                                  |
| 6   | Supabase dependencies identified/replaced | PASS   | Mapping classes; static test forbids `auth.*`/`storage.*`/`authenticated`/`anon`                                                                                        |
| 7   | Tenant isolation                          | PASS   | 8 tenant tests + `05_tenant_boundaries.sql`; composite org FKs                                                                                                          |
| 8   | Assignment enforcement                    | PASS   | 5 assignment tests                                                                                                                                                      |
| 9   | Server-authoritative time                 | PASS   | 4 time tests; no time parameters; guard trigger                                                                                                                         |
| 10  | One open visit under concurrency          | PASS   | Partial unique indexes + advisory lock; 12 parallel starts → 1                                                                                                          |
| 11  | Idempotency                               | PASS   | Keys on start/evidence/confirm/correct/amend; 4 tests incl. ×5 and ×4 parallel retries                                                                                  |
| 12  | Authoritative authorization consumption   | PASS   | Integer minutes, lineage lock, 2- and 3-way concurrent confirmations ≤ cap                                                                                              |
| 13  | Obsolete authorization version bug fixed  | PASS   | Current-only resolution, lineage usage, exclusion constraint, rebinding; 10 versioning tests; negative control: 11/16 fail on the old logic                             |
| 14  | Signed-visit immutability                 | PASS   | Guard + append-only triggers (owner included); tests                                                                                                                    |
| 15  | Correction audit history                  | PASS   | Before/after/actor/time/reason/request ID; original retained; one per row                                                                                               |
| 16  | No-signer / admin review                  | PASS   | `unable_to_confirm`/typed/verbal → `administrator_review`, 0 verified/billable; correction keeps it in review                                                           |
| 17  | S3 evidence metadata contract             | PASS   | `visit_evidence` + `register_visit_evidence`; UUID-only key CHECK; no bytes                                                                                             |
| 18  | RPC parity matrix                         | PASS   | `PHASE_2_RPC_PARITY_MATRIX.md`                                                                                                                                          |
| 19  | Read-only verification scripts            | PASS   | 7 scripts, 94 checks, READ ONLY; run as `ogevia_readonly`                                                                                                               |
| 20  | Rollback plan                             | PASS   | `PHASE_2_ROLLBACK_PLAN.md` + classified scripts + round-trip test                                                                                                       |
| 21  | Data migration plan                       | PASS   | `PHASE_2_DATA_MIGRATION_PLAN.md` (not executed)                                                                                                                         |
| 22  | No PHI/secrets committed                  | PASS   | Static checks + scan of 77 files: 0 hits; synthetic fixtures                                                                                                            |
| 23  | Repository quality gate                   | PASS   | lint, typecheck, test (768), build                                                                                                                                      |
| 24  | DB suite passes on local PostgreSQL       | PASS   | 93/93 on PG 16.13 (two clean runs)                                                                                                                                      |
| 25  | Nothing applied to production             | PASS   | Migration runner refuses non-local hosts                                                                                                                                |

## Recorded limitations (not Phase 2 failures)

1. **PostgreSQL version:** tests ran on PG **16.13**; production is **18.3**. The `postgres:18` CI job is defined but has not executed yet (it runs on the next PR or push to `main`).
2. **Live schema parity** is VERIFIED at catalog-metadata level for the SV slice. A full `pg_dump --schema-only` diff remains a pre-cutover gate.
3. **Production database name:** not established (RDS `DBName` is null); it's a deployment-time configuration gate.
4. **Semantic changes against current main**, all deliberate and documented: the platform-owner membership bypass was removed; `client_legal_name` was dropped from `list_service_visits`; billing review exposes data only (no rates or approval); `confirmationVersion` is 4; caps are in minutes.

## Phase 3 handoff (not started)

1. Create or link Cognito users so that every migrating `auth.users.id` gets a `sub`, and populate `ogevia.app_users.cognito_sub` (the migration plan, transform rules).
2. Phase 4 Lambda contract: one transaction per request → `ogevia_api.begin_request(sub, request_id)` → one API function. Map SQLSTATE `OGA01/OGA03/OGN04/OGC09/OGV22/OGI09` to HTTP. Send an idempotency key on every mutating action.
3. Resolve the Phase 1 gates before deployment: Cognito callback (D-P1-2), Lambda egress (D-P1-1), concurrency quota (D-P1-3).
4. Run the CI `postgres:18` job (PR or push), and get approval for applying `0001–0008` to `ogevia-prod-postgres` (YELLOW) with a pre-apply snapshot and `db:verify` afterwards.
