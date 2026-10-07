# Phase 2 — Rollback Plan

Rollback scripts: `infra/aws/db/rollback/NNNN_*.down.sql`, applied in reverse order. Destructive scripts **refuse to run** while data exists. Tested in `db/test/rollback.db.test.ts`:

- an empty database goes all the way down to zero and back up from zero;
- on a populated database, `0005` refuses.

| Migration                              | Rollback class                      | What it removes                                                         | Data risk                       | Notes                                                                                                                                           |
| -------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 0008 grants                            | **SAFE AUTOMATED**                  | Grants and readonly policies                                            | None                            | Leaves the runtime without access (the service stops)                                                                                           |
| 0007 reporting / billing review        | **SAFE AUTOMATED**                  | 3 read-only functions                                                   | None                            |                                                                                                                                                 |
| 0006 API                               | **SAFE AUTOMATED** (functions only) | 10 API functions + idempotency helpers                                  | None                            | **Prefer a FORWARD FIX** (`create or replace` in a new migration): removing the API is an outage                                                |
| 0005 visits/evidence/corrections/audit | **IRREVERSIBLE WITHOUT DATA LOSS**  | Visit, confirmation, evidence, correction, audit and idempotency tables | **Total loss of visit records** | Guard refuses while any visit or audit row exists. Only valid on a fresh/empty database. Otherwise: RDS snapshot + owner approval + forward fix |
| 0004 authorizations                    | **BACKUP REQUIRED**                 | Versioned authorizations                                                | Loss of authorization history   | Guard refuses while rows exist                                                                                                                  |
| 0003 care directory                    | **BACKUP REQUIRED**                 | Caregivers, clients, services, assignments, shifts                      | Directory loss                  | Guard refuses while rows exist                                                                                                                  |
| 0002 identity/tenancy                  | **BACKUP REQUIRED**                 | Users, orgs, memberships, RBAC, context functions                       | Identity loss                   | Guard refuses while rows exist                                                                                                                  |
| 0001 roles/schemas/extension           | **FORWARD FIX PREFERRED**           | Empty schemas only                                                      | None                            | Roles and `btree_gist` are left in place on purpose (cluster/database-wide)                                                                     |

## Operating rules

1. Any rollback on an AWS database is a YELLOW action needing owner approval and a fresh RDS snapshot.
2. A behavior bug is fixed **forward**: a new migration `000N_*.sql` with `create or replace function`. Never edit an applied migration; the runner's checksum check refuses drift.
3. Point-in-time recovery (RDS automated backups, 7 days, VERIFIED in Phase 1) is the recovery path for data mistakes, not down-migrations.
4. Before cutover, Supabase stays the system of record, so rolling the RDS schema back has no production impact.
