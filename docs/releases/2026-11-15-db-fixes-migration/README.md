# Proposal: migration 0108, preserve the two manual production database fixes

**Status: PROPOSED and TESTED locally. NOT applied to any database. NOT in any ledger. NOT loaded by the migration runner.** For the owner's review.
Nothing here changes production: no migration was run, no AWS call was made, no deployment was prepared for execution.

## 1. What is being preserved, and what is verified
On 2026-11-14 two fixes were made by hand in `ogevia_prd` (record: `docs/releases/2026-11-15-signin-override-production/PRODUCTION_DB_CHANGES_2026-11-14.md`):
1. `ogevia_owner` may SELECT `ogevia.business_documents`: a `GRANT SELECT` plus the policy `owner_definer_select` (SELECT, `ogevia_owner` only, `USING (true)`).
2. `ogevia_owner` may EXECUTE `ogevia.action_issue_rows(uuid, boolean, boolean, boolean, boolean, boolean, integer)`: a `GRANT EXECUTE`. Ownership of the function did not change.

| Item | Status |
|---|---|
| The two statements as recorded above | **OWNER-REPORTED.** The owner pasted the closing `COMMIT` of the first and said the second committed; the opening statements and their output were not pasted. |
| The exact live definitions (policy name, command, roles, expressions, permissive or restrictive; the ACLs; who owns what; the role attributes) | **NOT VERIFIED.** This environment has no AWS access, so I cannot read production. I did not assume them. |
| What the migration does about that | It never overwrites: it states an end state, checks it, and **refuses to run over a policy of the same name that differs in any way** (section 3). The exact live definitions are captured by the read-only script below, which must be run before this is approved. |

**Step to verify (read-only, owner, same private path as before: temporary window, tunnel, `psql`, close the window):**
```bash
psql -X -d ogevia_prd -f docs/releases/2026-11-15-db-fixes-migration/CAPTURE_LIVE_DB_FIXES.sql | tee /tmp/capture-live-db-fixes.txt
```
It prints the table's owner, ACL and RLS flags; every policy with its exact definition; the function's owners, ACLs and settings; ogevia_owner's effective privileges; the attributes and memberships of the roles involved (this tells us which role may run the migration); the other `ogevia_admin`-owned objects; and a last line `CAPTURE VERDICT: MATCHES (migration 0108 would change nothing)` or `DIFFERS (…)`. It writes nothing and prints no client or caregiver data. Paste the whole output back for review.

| Capture verdict | What it means | Then |
|---|---|---|
| `MATCHES` | The live state is exactly what 0108 states. The migration is a **no-op** in production. | Only a ledger row is needed (section 6), or the owner may decide to keep it as documented drift. |
| `DIFFERS (policy absent or defined differently)` | The live policy is not what was recorded. | Compare section 3 of the output with the migration. Either correct the migration to the live definition or decide which definition is right. **Do not apply.** |
| `DIFFERS (select/execute not effective)` | A grant was not committed or was lost. | The migration would grant it, if run by a role that may. |

## 2. What the migration does, per environment (all tested)
| Environment | Effect of 0108 |
|---|---|
| A database built from the repository (`ogevia_owner` owns the table and the function) | The privileges already hold through ownership, so nothing is granted. The policy is created for parity with production (redundant for an owner, harmless). ACLs unchanged. |
| Production after the manual fixes (`ogevia_admin` owns both) | **No change at all**, even run twice (the catalog snapshots before and after are identical). It needs no privilege, because nothing is missing. |
| Production before the fixes (or if a fix is lost) | Run as the owner of the objects (or a role with GRANT OPTION) it grants SELECT and EXECUTE and creates the policy, and adds nothing else; ownership untouched. Run by a role that may not grant it, it **fails closed**: PostgreSQL's own permission error or the migration's end-state check stops it and the whole transaction rolls back. |
| A different policy named `owner_definer_select` exists (other command, roles, restrictive, or USING / WITH CHECK) | **Refuses to overwrite**: raises an error naming the difference and changes nothing. |

The file is `infra/aws/db/pending/production-alignment/0108_production_database_alignment.sql`. It is outside `pending/migrations/` on purpose: the runner's pending set and the ledger tests (107 rows, the five production migrations 0103 to 0107) are untouched. It contains no data statement and no `drop`.

## 3. Tests: `infra/aws/db/test/production-alignment-0108.db.test.ts` (13, local PostgreSQL 16, all passing)
**Full gate on this state** (`pnpm test:all`, commit `2daa7eee`, local PostgreSQL 16): PASS, "all suites ran, none skipped, all passed". Unit: shared 118, auth 150, sv-api 107, ui 73, web 1,314, infra-aws 784 (44 files). Database: 113 files / 1,197 tests (these 13 included). API: 29 files / 183 tests. `pnpm lint` and `pnpm typecheck` exit 0. CI on `2daa7eee`: `harness`, `validate`, `postgres` all green.
| Test | What it proves |
|---|---|
| Fresh database (migrations 0001 to 0107): apply as `ogevia_owner`, twice | No privilege or ACL change; only the policy is added; second run changes nothing |
| Fresh: capture before and after | Capture says `DIFFERS (policy absent…)` before and `MATCHES` after, and writes nothing |
| Fresh: rollback | Policy removed; the owner's own privileges are **never** revoked |
| Production-shaped database (live baseline, the real production upgrade SQL, then the production ownership drift: `ogevia_admin` owns the four tables and the 16 distinct functions production lists) **with the fixes applied exactly as recorded** | The 2026-11-14 errors are gone; migration run as `ogevia_owner`, twice, changes nothing (identical catalog snapshots); capture says `MATCHES` |
| Same, then rollback as the owner of the objects, then apply again | Rollback brings back the permission-denied errors (so the test is real); applying fixes them again |
| Production-shaped database **before** the fixes | **Reproduces the production errors**: `system_compliance_orgs()`, `list_my_notifications` and `get_attention_counts` fail with SQLSTATE 42501 |
| Same: run as the production runner role (`ogevia_owner`, which may not grant) | Fails closed, message shown, snapshot unchanged |
| Same: run as the owner of the objects | Exactly SELECT, EXECUTE and the policy are added; ownership unchanged; the three functions work; second run changes nothing |
| Same with an existing `owner_definer_select` that is FOR ALL, narrower USING, for another role, or restrictive (4 cases) | Refused with an explicit error; snapshot unchanged; capture says `DIFFERS` |
| The files | Not loaded by the runner, rollback present with its warning, no data statements |

**Mutation check:** with the "refuse a different policy" branch replaced by "drop and recreate", 6 of the 13 tests fail (the four refusals, the production no-op, and the static check). The restored file passes all 13.
**What the test cannot prove:** that the live `ogevia_admin` behaves like the test role (a `NOLOGIN`, `BYPASSRLS` role that is a member of `ogevia_owner`). The capture's section 7 shows the live attributes. PostgreSQL 16 locally versus 18 on RDS.

## 4. Rollback plan
`infra/aws/db/pending/production-alignment/0108_production_database_alignment.down.sql`:
- Drops the policy `owner_definer_select`, if present.
- Revokes `ogevia_owner`'s SELECT and EXECUTE **only where `ogevia_owner` does not own the object**. In a repository-built database the owner keeps its privileges (tested).
- Idempotent. Must run as the owner of the objects or as the role that granted the privileges (a role that did not grant a privilege cannot revoke it).
- **In production it re-creates the 2026-11-14 defect** (permission-denied in the compliance sweep, notifications and attention). It exists to return to the pre-fix state on purpose, for example in a rehearsal. The normal response to any problem is to fix forward. No data is touched, so no backup is needed for the migration itself; the ledger row, if one was added, is removed in the same transaction.

## 5. Risks and open questions
1. **The live definitions are unverified until the capture is run** (section 1). This is the one gate before approval.
2. **Which role runs it in production.** The existing release runner wraps each migration in `set local role ogevia_owner`. That is enough when the capture says `MATCHES` (nothing to grant). If it says `DIFFERS`, the run needs the owner of the objects (`ogevia_admin` or a login that is a member of it), and the capture's section 7 says whether the migration login qualifies.
3. **Ledger.** 0108 is deliberately not in the runner's pending set, to keep the 107-row ledger and its tests intact. Adding it later means updating `migrations.ts`, `production-ux-release.py`'s pins and the ledger tests (107 to 108) in one reviewed change.
4. **The wider ownership drift is not addressed**: `ogevia_admin` owns 4 tables and 17 functions in production (the capture's section 9 lists them). Aligning ownership is a larger change with its own risk (it touches `start_service_visit` and `client_qr_checkin`) and needs its own proposal.
5. **TEST** may have the same defect or not (its ownership is unknown); the capture script works there too.

## 6. How it would be applied later (not now; needs the owner's explicit approval and a release checklist)
1. Capture on production (section 1). Review the output together.
2. If `MATCHES`: decide between (a) one transaction that guards the ledger count (exactly 107 rows) and inserts the 0108 ledger row with its checksum, running 0108 as `ogevia_owner` as a verified no-op, or (b) leaving it as documented drift. If `DIFFERS`: correct the migration or the live state first.
3. The procedure would follow the same guarded pattern as the sign-in override release (plan, guard, apply, verify, rollback). That operator script is **not written** and will not be until the owner approves this proposal.

## 7. Files
- `infra/aws/db/pending/production-alignment/0108_production_database_alignment.sql` and `.down.sql`
- `infra/aws/db/test/production-alignment-0108.db.test.ts`
- `docs/releases/2026-11-15-db-fixes-migration/CAPTURE_LIVE_DB_FIXES.sql` (read-only) and this README
