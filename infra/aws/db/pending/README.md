# Pending migrations

Written and tested, but **not part of any release**. They are not in `migrations/`, so `db:migrate`, the release packages (which pin the exact `0001-0085` set by hash and count) and `createTestDb()` do not see them.

| Pending | What | Rollback class | Tests |
|---|---|---|---|
| `migrations/0086_staff_management.sql` | Staff types, staff profiles, supported-role assignment, staff invitations (`staff.read`, `staff.manage`) | BACKUP REQUIRED (`rollback/0086_staff_management.down.sql` drops two tables with their rows) | `db/test/staff-management.db.test.ts`, `apps/sv-api/test/staff.db.test.ts`, `apps/sv-api/test/tenant-isolation-sweep.db.test.ts` (use `createTestDbWithPending()`) |
| `migrations/0087_staff_invitation_acceptance.sql` | Invitation acceptance: existing sign-ins get `invited` membership until they accept (M-1); L-1/L-2/L-3 fixes; routes `GET /v1/me` pending list and `POST /v1/me/staff-invitations/{organizationId}/accept` | ADDITIVE (functions only; `rollback/0087_staff_invitation_acceptance.down.sql` restores the 0086/0048 function text, removes no data). Apply after 0086, same transaction in production | `db/test/staff-management.db.test.ts`, `apps/sv-api/test/staff.db.test.ts` |

## To release one (an owner-approved release step, not part of development)
1. `git mv` the file into `db/migrations/` and its down script into `db/rollback/` (numbering stays contiguous).
2. Re-pin the release package for the new set: migration-set and rollback-set hashes, counts (`n|latest`), the `db/verification` files (`01_schema_version.sql`, `08_release_objects.sql`), the operator document and tarball pins.
3. Take an RDS snapshot first; run the release through the TEST environment before Production.
4. Delete the moved entries from this table.
