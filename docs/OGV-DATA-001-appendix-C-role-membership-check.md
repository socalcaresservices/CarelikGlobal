# OGV-DATA-001 Appendix C: Who holds `ogevia_owner`, `ogevia_app` and `ogevia_readonly`

Part of [OGV-DATA-001](OGV-DATA-001-database-and-data-dictionary.md) (draft v0.1). Prepared 2026-10-11 at commit `11ac120`.

## C.1 Status

| Question | Status |
|---|---|
| Who actually holds each role in the **PILOT / TEST** database (`prod`, `ogevia_sv_test`)? | **NOT DETERMINED.** Needs a live query. |
| Who actually holds each role in the **PRODUCTION / PRD** database (`prd`, `ogevia_prd`)? | **NOT DETERMINED.** Needs a live query. |
| Who is *meant* to hold each role, according to the repository? | **Determined** (C.3), with two unknowns. |
| Is there a repository script that gives `ogevia_readonly` to any login? | **No** (C.3). |

Why it could not be determined in this session:

* Role membership lives in the PostgreSQL system catalogs (`pg_auth_members`, `pg_roles`). It cannot be read from the repository, from CloudFormation, or from any AWS API.
* The RDS instance is private. The documented path is an SSM port-forward through the temporary admin host to the instance, authenticated with the RDS master secret (`docs/releases/caregiver-readiness/RELEASE_HANDOFF.md` section 4). That uses an administrator credential and is a YELLOW-class operation under `CLAUDE.md` §13; it was not attempted.
* This container has no AWS CLI and no SSO session. AWS key variables exist in its environment, but their owner and permissions are unknown, so they were not used. They could not answer the question in any case, because AWS APIs do not expose database role membership.

## C.2 How to determine it (read-only)

Run the queries in C.5 against **both** databases, from an operator shell that already has the approved private tunnel. Roles are cluster-wide, so Q1 to Q4 return the same role facts in either database; Q4 shows connect rights per database; Q5 to Q7 differ per database.

```bash
# with the tunnel open and OGEVIA_DATABASE_URL set exactly as in RELEASE_HANDOFF.md section 4,
# but pointing at the database to check (ogevia_prd, then ogevia_sv_test):
PGOPTIONS='-c default_transaction_read_only=on'   psql "$OGEVIA_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f ogevia-role-membership.sql
```

Do not print the master secret or the connection string. All queries are `SELECT` only; the read-only session option makes that enforced rather than assumed. They do not read `pg_authid` and so never touch password hashes.

Also record, from the IAM side, who can *reach* the database as the administrator (this decides who can effectively become any Ogevia role, whatever `pg_auth_members` shows). All read-only; not run here:

* Who may read the RDS-managed master secret (`secretsmanager:GetSecretValue`) and who may start an SSM session to the host tagged `ogevia-db-admin-temp`: review the policies of the IAM Identity Center permission sets assigned to the account (`aws sso-admin list-account-assignments`, `aws iam list-attached-role-policies` on the `AWSReservedSSO_*` roles).
* Whether `rds-db:connect` (IAM database authentication) is granted to anyone; the database side is Q3 column `uses_iam_auth`.

## C.3 What the repository establishes (RV)

The designed state, from the files that create and grant these roles:

| Role | Designed holders | Source |
|---|---|---|
| `ogevia_owner` | `NOLOGIN`. A member: **the RDS master user** (migration `0001` executes `grant ogevia_owner to current_user` when the migrating administrator is not already a member). No other grant of this role to any role exists in any migration, deploy SQL or script. Because the master user is also a member of `rds_superuser`, it can act as any role regardless. | `infra/aws/db/migrations/0001_roles_schemas_extensions.sql`; runner `db/scripts/migrations.ts` (`set local role ogevia_owner` for files after 0001) |
| `ogevia_app` | `NOLOGIN` in the migrations. Designed members: (a) the **production login `ogevia_prd_app`** (`LOGIN NOINHERIT`, created by `db/deploy/11_prd_app_login.sql`, which refuses any other name; it must `SET LOCAL ROLE ogevia_app` per request); (b) the **test-slice login** from secret `ogevia/database/app` via `db/deploy/01_app_login_role.sql`. The login name in that secret is **not recorded in the repository**. The script allows it to be `ogevia_app` itself, in which case `ogevia_app` would be altered to `LOGIN` with a password and would have no members. | `db/deploy/01_app_login_role.sql`, `db/deploy/11_prd_app_login.sql`; `apps/sv-api/src/db.ts` and `config.ts` (`DB_SET_ROLE=ogevia_app`) |
| `ogevia_readonly` | `NOLOGIN`, and by the author's stated design it stays that way "until an owner approves an individual, audited support login" (`0008_grants.sql` lines 6 to 7; `docs/aws/PHASE_2_POSTGRES_ARCHITECTURE.md` line 27: "Verification scripts and approved, audited support"). So the designed holder set is **empty**, and any holder needs a recorded owner approval. **No script grants it to any role or login.** The migration runner grants it `USAGE` on schema `ogevia_meta` and `SELECT` on the ledger, and migration `0008` grants it `SELECT` on tables. `db:verify` connects as whatever login is in `OGEVIA_DATABASE_URL` (the master user in the documented procedure) and does **not** switch to `ogevia_readonly`; only the automated tests do (`SET ROLE`). So the repository gives no operational use for the role, and any holder would have been added by hand. | `db/scripts/verify.ts`, `db/scripts/migrations.ts:123`, `db/test/verification.db.test.ts` |
| `rds_superuser` (not an Ogevia role, but the real power) | The master user. `14_prd_verify_access.sql` treats `rds_superuser` members and superusers as legitimate administrators when it checks who can connect to `ogevia_prd`. | `db/deploy/14_prd_verify_access.sql` |

What the one verification script that exists for production access checks, and what it does not:

* `14_prd_verify_access.sql` checks that `PUBLIC` has no `CONNECT` on `ogevia_prd`, that the only non-administrator login able to connect is `ogevia_prd_app`, and that `ogevia_prd_app` is unprivileged (not superuser, `CREATEROLE`, `CREATEDB`, `BYPASSRLS`, and not `INHERIT`).
* It does **not** list members of `ogevia_owner`, `ogevia_app` or `ogevia_readonly`, so it cannot detect a login that was added to `ogevia_readonly` or `ogevia_owner`. It is also not recorded as having been run (checklist item 8 in `docs/aws/URL_REGISTRY_AND_LAUNCH_CHECKLIST.md` is open).
* Its "no unexpected login can connect" test would catch an extra login only if that login can reach `ogevia_prd`.

Unknowns the repository cannot resolve: the test-slice login name; any role created by hand outside the scripts; whether `ogevia_app` carries `LOGIN`; additional `rds_superuser` members; whether anyone connects as the master user routinely (the temporary admin host remained attached on 2026-10-11 per the owner's output).

## C.4 How to read the results

| Result | Meaning | Action |
|---|---|---|
| Q2: `ogevia_owner` has exactly one member (the master user) | Designed state | None |
| Q2: `ogevia_owner` has any other member | Another login can act as the table owner (bypasses RLS, owns all data) | **Finding.** Identify who, why; remove after owner approval |
| Q2/Q3: `ogevia_app` members are only `ogevia_prd_app` and the test-slice login; none has `rolinherit` true; none has `rolsuper`, `rolcreaterole`, `rolcreatedb` or `rolbypassrls` | Designed state | None |
| Q1: `ogevia_app` shows `rolcanlogin = true` | The test slice used `ogevia_app` itself as the login. Allowed by script, but the shared role then has a password and exists for both databases | Record; confirm Q4 shows it **cannot** connect to `ogevia_prd` |
| Q2: `ogevia_readonly` has **no** members (and Q3 shows no login with `is_readonly_member` other than superusers) | Designed state; the finding F1 in the master document is then limited to the master user and superusers | Record "no holders" |
| Q2/Q3: any login holds `ogevia_readonly` and there is no recorded owner approval for that individual | That login can read **every agency's** rows on 59 tables, including client legal names, in whichever database it can connect to | **Finding.** Identify and decide; consider the policy change in finding F1 |
| Q3: a login other than the master user and RDS internal roles is `rds_superuser` or superuser | Can become any role | **Finding** |
| Q4: any login other than `ogevia_prd_app` and administrators can connect to `ogevia_prd` | Breaks the production access model | **Finding** (this is what `14_prd_verify_access.sql` guards) |
| Q4: the test-slice login can connect to `ogevia_prd` | Same | **Finding** |
| Q5: grants other than `ogevia_owner` (all privileges) and `ogevia_readonly` (SELECT on 59 tables) | A direct table grant bypasses the function layer | **Finding** |
| Q6: EXECUTE on `ogevia_api` held by anyone other than `ogevia_owner` and `ogevia_app` (175); on `ogevia` by anyone other than `ogevia_owner` (123) | Unexpected function access | **Finding** |
| Q7: sessions with an unfamiliar `usename` or `application_name` (the API uses `ogevia-sv-api`) | Unknown client | Investigate |

Expected output of Q5 and Q6 in the designed state (verified on the local build): `ogevia_owner` all seven table privileges on 62 tables; `ogevia_readonly` `SELECT` on 59; `ogevia_api` `EXECUTE` for 175 functions to both `ogevia_owner` and `ogevia_app`; `ogevia` `EXECUTE` for 123 functions to `ogevia_owner` only. If production is still at migration 46: `ogevia_api` shows 171 functions (0048 adds four), `ogevia` shows 120 (0047 adds two internal functions and 0048 adds one), and the table counts are unchanged.

## C.5 The queries (`ogevia-role-membership.sql`)

Q3 calls `pg_has_role` on `rds_superuser` and `rds_iam`, which exist on RDS; on a plain PostgreSQL they must be created first, as the local test did. Tested without error on PostgreSQL 16.15 against a local build of the 48 migrations plus invented stand-in roles (an `ogevia_prd_app`-style login, an `rds_superuser`-style group and a master-user-style login). The invented roles are not real data. `pg_auth_members.inherit_option` and `.set_option` require PostgreSQL 16 or later; production is 18.3, which has them. Not run on PostgreSQL 18.

```sql
-- Q1 attributes of the Ogevia roles and the roles that can act as anyone
select rolname, rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolbypassrls, rolvaliduntil
from pg_roles
where rolname ~ '^ogevia' or rolname in ('rds_superuser', 'rds_iam')
order by rolname;

-- Q2 direct members of the three roles
select r.rolname as role, m.rolname as member, g.rolname as granted_by,
       am.admin_option, am.inherit_option, am.set_option
from pg_auth_members am
join pg_roles r on r.oid = am.roleid
join pg_roles m on m.oid = am.member
left join pg_roles g on g.oid = am.grantor
where r.rolname in ('ogevia_owner', 'ogevia_app', 'ogevia_readonly')
order by r.rolname, m.rolname;

-- Q3 every role that can log in or is superuser, and what it can become (direct or indirect)
select u.rolname, u.rolcanlogin, u.rolsuper,
       pg_has_role(u.oid, 'ogevia_owner',    'MEMBER') as is_owner_member,
       pg_has_role(u.oid, 'ogevia_app',      'MEMBER') as is_app_member,
       pg_has_role(u.oid, 'ogevia_readonly', 'MEMBER') as is_readonly_member,
       pg_has_role(u.oid, 'rds_superuser',   'MEMBER') as is_rds_superuser_member,
       pg_has_role(u.oid, 'rds_iam',         'MEMBER') as uses_iam_auth
from pg_roles u
where u.rolcanlogin or u.rolsuper
order by u.rolsuper desc, u.rolname;

-- Q4 which login roles can connect to each Ogevia database (roles are cluster-wide; databases are not)
select u.rolname, d.datname, has_database_privilege(u.oid, d.oid, 'CONNECT') as can_connect
from pg_roles u
cross join pg_database d
where u.rolcanlogin and d.datname in ('ogevia_prd', 'ogevia_sv_test')
order by d.datname, u.rolname;

-- Q5 (run connected to EACH Ogevia database) table privileges on schema ogevia, by grantee
select grantee, privilege_type, count(distinct table_name) as tables
from information_schema.role_table_grants
where table_schema = 'ogevia'
group by 1, 2
order by 1, 2;

-- Q6 (run connected to EACH Ogevia database) EXECUTE on Ogevia functions, by grantee
select r.grantee, r.specific_schema as schema, count(distinct r.specific_name) as functions
from information_schema.routine_privileges r
where r.specific_schema in ('ogevia', 'ogevia_api') and r.privilege_type = 'EXECUTE'
group by 1, 2
order by 2, 1;

-- Q7 who is connected right now (needs rds_superuser or pg_monitor to see other sessions)
select datname, usename, application_name, count(*) as sessions
from pg_stat_activity
where datname in ('ogevia_prd', 'ogevia_sv_test')
group by 1, 2, 3
order by 1, 2;
```

## C.6 Results record (to be filled in by whoever runs it)

Record the date, the person, the database, the engine version, and attach the output (it contains role names, not secrets). Do not paste it into chat or issues if it contains anything beyond role names and counts.

| Database | Run by | Date | `ogevia_owner` members | `ogevia_app` members | `ogevia_readonly` members | Other logins that can connect | Finding? |
|---|---|---|---|---|---|---|---|
| `ogevia_prd` (PRODUCTION / PRD) | | | | | | | |
| `ogevia_sv_test` (PILOT / TEST) | | | | | | | |
