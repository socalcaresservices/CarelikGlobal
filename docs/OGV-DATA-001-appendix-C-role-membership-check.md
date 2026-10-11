# OGV-DATA-001 Appendix C: Who holds `ogevia_owner`, `ogevia_app` and `ogevia_readonly`

Part of [OGV-DATA-001](OGV-DATA-001-database-and-data-dictionary.md) (draft v0.1). Prepared 2026-10-11 at commit `11ac120`.

## C.1 Status

| Question | Status |
|---|---|
| Who holds `ogevia_owner`, `ogevia_app`, `ogevia_readonly` on the shared instance (covers **PILOT / TEST** `ogevia_sv_test` and **PRODUCTION / PRD** `ogevia_prd`; role membership is cluster-wide)? | **DETERMINED for direct membership** from the raw output of one membership query pasted by the owner (C.7.1), engine PostgreSQL 18.3 on `ogevia-prod-postgres`. Not a saved output file; the author did not run it. |
| Everything else the query set covers: role attributes, indirect membership, who can connect to each database, table and function grants, live sessions (Q1, Q3 to Q7)? | **NOT REPORTED.** Open (C.7.3). |
| Who is *meant* to hold each role, according to the repository? | **Determined** (C.3), with two unknowns. |
| Is there a repository script that gives `ogevia_readonly` to any login? | **No** (C.3). |

Why the author could not run it (the owner then ran it; results in C.7):

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
| `ogevia_prd` (PRODUCTION / PRD) | Owner, connected as `ogevia_admin` through the approved SSM tunnel (raw output of one query pasted) | 2026-10-11 reported; run time not stated | `ogevia_admin` | `ogevia_prd_app` | none | not reported (Q4 not run) | No unexpected direct holder. Open items C.7.3 |
| `ogevia_sv_test` (PILOT / TEST) | same query; database connected to not stated | same | `ogevia_admin` (cluster-wide) | `ogevia_prd_app` (cluster-wide) | none | not reported | Membership same as above; pilot login not visible among `ogevia_app` members (C.7.2) |

## C.7 Live result (owner-provided, reported 2026-10-11)

### C.7.1 What was reported

Evidence class: **DV, owner-provided**. The author did not run anything. The owner ran this query interactively (so no output file was saved) and pasted the query and its output:

```sql
SELECT member.rolname AS member_role, parent.rolname AS granted_role
FROM pg_auth_members m
JOIN pg_roles parent ON parent.oid = m.roleid
JOIN pg_roles member ON member.oid = m.member
WHERE parent.rolname IN ('ogevia_owner', 'ogevia_app', 'ogevia_readonly')
ORDER BY parent.rolname, member.rolname;
```

```text
 member_role    | granted_role
----------------+--------------
 ogevia_prd_app | ogevia_app
 ogevia_admin   | ogevia_owner
(2 rows)
```

| Reported observation | Value |
|---|---|
| Server | PostgreSQL **18.3**, RDS instance `ogevia-prod-postgres`, through the approved SSM tunnel |
| Connected as | `ogevia_admin` |
| `ogevia_readonly` | no rows returned, so **no members** |

Review of the query (author): it is correct for *direct* membership of the three roles in the cluster-wide catalog `pg_auth_members`, and 2 rows with no `ogevia_readonly` row is a valid "no direct members" result. It does not show who granted the membership, `ADMIN`/`INHERIT`/`SET` options, role attributes, indirect membership, or connect rights. It is not the repository's Q2 to Q7. The run time and which database was connected to were not stated; the answer is the same for both databases because the catalog is cluster-wide.

### C.7.2 What it means against the designed state (C.3, C.4)

| Check | Result | Reading |
|---|---|---|
| `ogevia_readonly` holders | None | **Matches the design** (empty until the owner approves an individual audited support login). No login can currently read every agency's rows through this role. |
| `ogevia_owner` holders | Exactly one: `ogevia_admin`, and the owner was connected as `ogevia_admin` | **Matches the design.** The owner has confirmed that `ogevia_admin` is the RDS master user (owner-stated, 2026-10-11; method not stated), which is the member migration `0001` creates. |
| `ogevia_app` holders | Only `ogevia_prd_app` | `ogevia_prd_app` is the designed production login. The design also expects the **pilot login** (secret `ogevia/database/app`) to hold `ogevia_app`, unless that login *is* `ogevia_app` itself (`01_app_login_role.sql` allows this). No separate pilot login appears among the members. The author's inference, not verified: the pilot API connects as `ogevia_app` itself, which would mean `ogevia_app` has `LOGIN` and a password. That needs Q1 (`rolcanlogin`) to confirm, and Q4 to confirm that it **cannot connect to `ogevia_prd`**. |
| Unexpected holders of any of the three roles | None reported | Direct membership only. Indirect paths are not covered. |

The reported result does not change that `ogevia_admin`, any `rds_superuser` member and any superuser can act as every Ogevia role, including `ogevia_readonly`, without being a member of it.

### C.7.3 Still open (not in the reported result)

1. ~~Is `ogevia_admin` the RDS master user?~~ **Resolved:** owner-confirmed 2026-10-11.
2. **Q1:** does `ogevia_app` have `rolcanlogin = true`? Do `ogevia_prd_app` and `ogevia_admin` have the expected attributes (`ogevia_prd_app`: not superuser, not `CREATEROLE`/`CREATEDB`/`BYPASSRLS`, not inherit)?
3. **Q2 full columns:** `granted_by`, `admin_option`, `inherit_option`, `set_option` for the two memberships (for example, whether anyone holds `ADMIN OPTION` and so can grant these roles onward).
4. **Q3:** every login or superuser and what it can become indirectly, including all `rds_superuser` members.
5. **Q4:** every login that can `CONNECT` to `ogevia_prd` and to `ogevia_sv_test`. This is the check behind `14_prd_verify_access.sql` (checklist item 8).
6. **Q5 and Q6** per database: table and function grants by grantee (expected counts in C.4; at migration level 46 the `ogevia_api` count is 171 and `ogevia` is 120).
7. **Q7:** connected application names (the API uses `ogevia-sv-api`).

### C.7.4 Optional further queries (read-only; both tested on a local build, not on the live instance). Not required; see C.8

Run **A once** (cluster-wide facts plus who can connect to each database) and **B once in `ogevia_prd` and once in `ogevia_sv_test`**. Each starts with `set default_transaction_read_only = on;`, so the session refuses writes. They return role names, privilege counts and application names only. A covers items 2 to 5 of C.7.3, B covers items 6 and 7, and the AWS CLI command covers item 1.

**A**

```sql
set default_transaction_read_only = on;
select 'connected_as' as section, current_user as name, 'session_user=' || session_user || ' version=' || current_setting('server_version') as detail
union all
select 'role', rolname,
       concat_ws(' ', 'login=' || rolcanlogin, 'super=' || rolsuper, 'inherit=' || rolinherit,
                 'createrole=' || rolcreaterole, 'createdb=' || rolcreatedb, 'bypassrls=' || rolbypassrls)
from pg_roles
where rolname ~ '^ogevia' or rolname in ('rds_superuser', 'rds_iam')
union all
select 'membership', r.rolname || ' <- ' || m.rolname,
       concat_ws(' ', 'granted_by=' || coalesce(g.rolname, '?'), 'admin_option=' || am.admin_option,
                 'inherit_option=' || am.inherit_option, 'set_option=' || am.set_option)
from pg_auth_members am
join pg_roles r on r.oid = am.roleid
join pg_roles m on m.oid = am.member
left join pg_roles g on g.oid = am.grantor
where r.rolname in ('ogevia_owner', 'ogevia_app', 'ogevia_readonly', 'rds_superuser', 'rds_iam')
union all
select 'login_can_become', u.rolname,
       concat_ws(' ', 'super=' || u.rolsuper, 'owner=' || pg_has_role(u.oid, 'ogevia_owner', 'MEMBER'),
                 'app=' || pg_has_role(u.oid, 'ogevia_app', 'MEMBER'),
                 'readonly=' || pg_has_role(u.oid, 'ogevia_readonly', 'MEMBER'),
                 'rds_superuser=' || pg_has_role(u.oid, 'rds_superuser', 'MEMBER'))
from pg_roles u
where u.rolcanlogin or u.rolsuper
union all
select 'can_connect', u.rolname || ' -> ' || d.datname, 'connect=' || has_database_privilege(u.oid, d.oid, 'CONNECT')
from pg_roles u
cross join pg_database d
where u.rolcanlogin and d.datname in ('ogevia_prd', 'ogevia_sv_test')
order by 1, 2;
```

**B**

```sql
set default_transaction_read_only = on;
select 'table_grant' as section, grantee || ' ' || privilege_type as name, count(distinct table_name)::text as detail
from information_schema.role_table_grants
where table_schema = 'ogevia'
group by grantee, privilege_type
union all
select 'execute_grant', grantee || ' on ' || specific_schema, count(distinct specific_name)::text
from information_schema.routine_privileges
where specific_schema in ('ogevia', 'ogevia_api') and privilege_type = 'EXECUTE'
group by grantee, specific_schema
union all
select 'session', coalesce(datname, '-') || ' ' || coalesce(usename, '-'),
       'app=' || coalesce(nullif(application_name, ''), '-') || ' sessions=' || count(*)
from pg_stat_activity
where datname in ('ogevia_prd', 'ogevia_sv_test')
group by datname, usename, application_name
order by 1, 2;
```

## C.8 Owner decision and residual items (2026-10-11)

**Decision (owner):** the role review is complete. `ogevia_admin` is the RDS master user; `ogevia_readonly` has no members; `ogevia_app` is held by `ogevia_prd_app`; `ogevia_owner` is held by `ogevia_admin`. Finding F1 is accepted as a **documented latent risk**, not an active finding. No further privilege enumeration will be run unless a specific production risk requires it.

**What this record does and does not mean.** Verified (owner-provided, DV): direct membership of the three roles, the master-user identity, engine 18.3. Accepted without verification: the items below. Accepting a risk is not evidence that it is absent.

| Not checked | Why it could matter | Status |
|---|---|---|
| Role attributes (Q1), including whether `ogevia_app` has `LOGIN` | If the pilot connects as `ogevia_app` itself, the shared role has a login and password | Accepted, unverified |
| Indirect holders: other superusers or `rds_superuser` members (Q3) | They can act as every Ogevia role without being listed | Accepted, unverified |
| Who can `CONNECT` to `ogevia_prd` and `ogevia_sv_test` (Q4) | Production access model; the pilot login must not reach `ogevia_prd` | Accepted, unverified. Covered by the repository's own gate `14_prd_verify_access.sql` (launch checklist item 8, open) |
| Table and function grants per database (Q5, Q6) | A direct grant would bypass the function layer | Accepted, unverified |
| Live sessions and application names (Q7) | Unknown clients | Accepted, unverified |
| Which IAM principals can read the master secret or open an SSM session to the admin host | The master login bypasses every database safeguard by design, so this is the real control over data access | **Not examined by anyone**; outside the role review |

**Conditions that should re-open this review** (recommendation; the owner decides):

1. Before the first real client data enters `ogevia_prd`: run `db/deploy/14_prd_verify_access.sql` (launch checklist item 8) and record the result. It checks the connect rights that the accepted items above leave open.
2. Any new login role, any grant of `ogevia_owner`, `ogevia_app` or `ogevia_readonly`, a change of master credential or of who can read it, or a change to the temporary admin host.
3. An owner-approved support login for `ogevia_readonly` (the design permits one individual, audited login). Record the approval.
4. At the documentation review cycle proposed in OGV-GOV-001 (quarterly), repeat the one-line membership query recorded in C.7.1.

The optional queries A and B in C.7.4 remain available and are the cheapest way to close the unchecked rows if any of these conditions occurs.
