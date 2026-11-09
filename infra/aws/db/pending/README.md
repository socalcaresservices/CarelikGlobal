# Pending migrations

Written and tested, but **not part of any release**. They are not in `migrations/`, so `db:migrate`, the release packages (which pin the exact `0001-0085` set by hash and count) and `createTestDb()` do not see them.

| Pending | What | Rollback class | Tests |
|---|---|---|---|
| `migrations/0086_staff_management.sql` | Staff types, staff profiles, supported-role assignment, staff invitations (`staff.read`, `staff.manage`) | BACKUP REQUIRED (`rollback/0086_staff_management.down.sql` drops two tables with their rows) | `db/test/staff-management.db.test.ts`, `apps/sv-api/test/staff.db.test.ts`, `apps/sv-api/test/tenant-isolation-sweep.db.test.ts` (use `createTestDbWithPending()`) |
| `pending/migrations/0089_signin_followup_not_hard_requirement.sql` | App sign-in becomes a follow-up (kind `followup`), not a hard requirement for Approve for work, so a caregiver can be approved, assigned to clients and scheduled before the first sign-in (owner instruction 2026-11-09; replaces that part of the 0088 rule) | SAFE (`pending/rollback/0089_...down.sql` restores the 0088 function; no row changes) | `db/test/signin-followup-0089.db.test.ts` (applies the pending file on top of 0001-0088) |

## To release one (an owner-approved release step, not part of development)
1. `git mv` the file into `db/migrations/` and its down script into `db/rollback/` (numbering stays contiguous).
2. Re-pin the release package for the new set: migration-set and rollback-set hashes, counts (`n|latest`), the `db/verification` files (`01_schema_version.sql`, `08_release_objects.sql`), the operator document and tarball pins.
3. Take an RDS snapshot first; run the release through the TEST environment before Production.
4. Delete the moved entries from this table.

### Extra step when integrating 0089
Update the assertions that name "App sign-in" as a waiting item, which are correct for 0001-0088 and wrong after 0089: `db/test/caregiver-readiness.db.test.ts` (the "approval is blocked until the caregiver has signed in" test), `db/test/onboarding.db.test.ts` (two messages), `db/test/caregiver-gate-no-service.db.test.ts`, `apps/sv-api/test/caregiver-readiness-http.db.test.ts` (waitingOn and refusal message) and `apps/sv-api/test/scheduling-onboarding.db.test.ts`. The new messages read "Waiting on: Background check, Required training". Also re-pin the ledger counts (`n|latest` 89|0089) in the rollback-range, integration, upgrade and verification tests.
