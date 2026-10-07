# Ogevia PostgreSQL — Service Verification data layer

Portable PostgreSQL (RDS-compatible) schema and logic for Service Verification. **Nothing here has been applied to any AWS database.** See `docs/aws/PHASE_2_POSTGRES_ARCHITECTURE.md`.

```text
migrations/     0001–0011, applied in order; each in one transaction; SHA-256 recorded
rollback/       NNNN_*.down.sql, each classified (SAFE AUTOMATED / BACKUP REQUIRED /
                FORWARD FIX PREFERRED / IRREVERSIBLE WITHOUT DATA LOSS)
verification/   READ-ONLY checks (check_name, ok, detail) for any approved target
scripts/        migrations.ts (runner library), migrate.ts, verify.ts
test/           *.db.test.ts (PostgreSQL integration), *.static.test.ts (no DB)
```

## Commands

```bash
# Static checks (no database): part of the normal `pnpm test`
pnpm --filter @carelik/infra-aws test

# PostgreSQL integration suite: needs a LOCAL admin connection; creates and drops its own databases
OGEVIA_TEST_DATABASE_URL=postgres://<admin>@127.0.0.1:5432/postgres pnpm --filter @carelik/infra-aws test:db

# Migrate / verify (local only, unless OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner)
OGEVIA_DATABASE_URL=postgres://... pnpm --filter @carelik/infra-aws db:migrate
OGEVIA_DATABASE_URL=postgres://... pnpm --filter @carelik/infra-aws db:verify     # READ ONLY transaction
```

Rules: never put credentials in Git. Migrations never contain BEGIN/COMMIT, passwords or LOGIN grants. Fixtures are synthetic (ORG_A, CAREGIVER_A1, …). Applying migrations to RDS is a YELLOW action that needs written owner approval.
