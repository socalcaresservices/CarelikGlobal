# Database audit (migration 0108 and production migration state)

STATUS: COMPLETE for everything derivable from the repository. **NEEDS HUMAN INPUT** for the two facts only the live production database can give (the read-only capture in section 6). Sources: `docs/releases/2026-11-15-db-fixes-migration/README.md`, `docs/releases/2026-11-15-signin-override-production/PRODUCTION_DB_CHANGES_2026-11-14.md`, `infra/aws/db/pending/production-alignment/`, `production-office-assignments-release.py` (the exact production ledger), and the migration directories.

## 1. Why 0108 exists
On 2026-11-14 (Pacific) two fixes were made **by hand** in `ogevia_prd` because, after the UX release, `GET /v1/notifications` and `GET /v1/attention` returned 500 (SQLSTATE 42501, permission denied) and the scheduled compliance sweep failed with `permission denied for table business_documents` in `ogevia_api.system_compliance_orgs()`.
Cause (from the record): migration 0093, applied under the migration admin login, left `ogevia.business_documents` owned by `ogevia_admin` with row-level security on, no policy and no grants; migration 0100 then made two functions that run as `ogevia_owner` read it.
The two manual changes:
1. `grant select on ogevia.business_documents to ogevia_owner` plus policy `owner_definer_select` (SELECT, `ogevia_owner` only, `USING (true)`).
2. `grant execute on function ogevia.action_issue_rows(uuid, boolean, boolean, boolean, boolean, boolean, integer) to ogevia_owner` (function still owned by `ogevia_admin`).
0108 is the proposal that writes the same end state into a migration: it never overwrites (it checks the end state and refuses to run over a differing policy of the same name), is a no-op on production if the manual changes are as recorded, and creates the policy for parity on a repository-built database.

## 2. Does production data depend on it?
**No data depends on it; production behavior does.** Without the two privileges the three functions above fail with permission denied (reproduced in the 0108 test: "production-shaped database before the fixes reproduces the production errors"). The privileges are therefore a **runtime dependency of production**, held only in the live database.

## 3. Manual production changes not represented in migrations (found)
| # | Change | Evidence | In any migration? |
|---|---|---|---|
| 1 | SELECT on `business_documents` + `owner_definer_select` policy (2026-11-14) | owner pasted the closing `COMMIT`; opening statements/output not pasted | **No.** 0108 is only a proposal (not applied, not in the ledger, not loaded by the runner) |
| 2 | EXECUTE on `action_issue_rows(...)` (2026-11-14) | owner states it committed; output not pasted | **No** (same) |
| 3 | Ownership drift: `ogevia_admin` owns 4 tables and 17 functions in production (the capture lists them) | 0108 README section 5.4 | **No.** Larger change with its own risk (touches `start_service_visit` and `client_qr_checkin`); needs its own proposal |
| 4 | Roles, logins and passwords (`ogevia_owner`, `ogevia_app`, `ogevia_admin`, `ogevia_prd_app`), RDS settings | created by the production initializer/operator tools, not by migrations | by design outside migrations |
Unknown without the live database: whether any other hand change exists. The capture in section 6 is the instrument for that.

## 4. Is migration sequencing correct?
Computed from the exact production ledger the release helper guards (`ledger_after()`): **111 rows, `0001` to `0112`; the only version missing between them is `0108`.** `0089` to `0102` are present (they are the TEST-accepted "live-test" set).
- The gap is intentional: 0108 was proposed *after* 0107 and kept out of the runner so the 107-row ledger and its tests stayed intact; `0109` to `0112` were then released without it.
- Consequence: every production release script guards the **exact** ledger array. Applying 0108 later inserts a row between 0107 and 0109 and changes the expected array from 111 to 112 rows: the guards in `production-0109-release.py`, `production-offices-release.py` and `production-office-assignments-release.py`, the ledger tests and `migrations.ts` must change in the same reviewed commit (0108 README section 5.3).
- Order by version is unaffected: 0108 only grants and creates a policy; nothing in 0109 to 0112 depends on it or conflicts with it (computed: 0109 to 0112 contain no statement on `business_documents` or `action_issue_rows`).
- A **numbering collision** exists on another branch: `claude/magical-rubin-d40thi` (not production) adds `0086_open_shifts_board_and_sms.sql` while production's 0086 is `0086_staff_management.sql`. It must be renumbered to 0113 or later before it can be considered (see `executive-summary.md`).

## 5. Can production be recreated from migrations alone?
**Not completely, today.** From migrations alone you get the schema and logic of 0001 to 0107 and 0109 to 0112, and a fresh database owned by `ogevia_owner` (where the two privileges hold through ownership). You do **not** get: (a) the two manual privilege grants and policy (0108 not applied), in a database where `ogevia_admin` owns the objects; (b) the ownership drift of item 3; (c) roles and logins (initializer, by design). Items (a) and (b) are exactly why production differs from a rebuilt database. The 0108 tests show that on a repository-built database the grants are redundant (nothing is missing), so a rebuild works; on production-shaped ownership it **fails** without them.
To prove equivalence rather than argue it, compare schema fingerprints (the repository's existing `db/scripts/fingerprint.ts`, md5 per column, constraint, index, trigger, policy, function with its ACL, and table ACL/RLS flags; no row content): `docs/stabilization/schema-fingerprint-from-migrations.json` (3,017 keys, built from a scratch database with migrations 0001–0107 via the test-only runner plus 0109–0112) against the same fingerprint of `ogevia_prd`. Differences are the complete list of untracked production state. Owners (item 3) are not in the fingerprint; the existing capture query covers them.

## 6. What only the owner can supply (read-only, same private path as the earlier production steps)
1. The 0108 capture: `psql -X -d ogevia_prd -f docs/releases/2026-11-15-db-fixes-migration/CAPTURE_LIVE_DB_FIXES.sql` (prints policies, ACLs, owners, role attributes and a last line `CAPTURE VERDICT: MATCHES` or `DIFFERS`).
2. A schema fingerprint of production: `OGEVIA_DATABASE_URL=<read-only url to ogevia_prd> bash docs/stabilization/compare-production-schema.sh` (read-only connection, no data read) prints the differing keys or `IDENTICAL`.
Both are read-only; neither changes production. I cannot run them (no AWS access from this environment).

## 7. Recommendation (no migration was generated or applied)
- Do **not** apply 0108 yet. Run the capture first. If `MATCHES`: either (a) apply 0108 as a verified no-op with its ledger row in one guarded transaction (and update the three ledger guards to 112 rows in the same reviewed commit), or (b) keep it documented as a known drift. If `DIFFERS`: correct the migration or the live state first.
- Separately propose (not generated here, needs the capture): aligning object ownership in production (item 3).
- No replacement migration script is generated: the existing 0108 pair is complete, tested (13 tests) and correct as a proposal; generating another would create a competing version.
