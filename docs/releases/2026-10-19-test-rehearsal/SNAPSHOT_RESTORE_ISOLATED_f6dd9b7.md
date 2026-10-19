# Isolated snapshot restore of `ogevia_sv_test` (TEST rehearsal f6dd9b7, TEST only)

> **ADAPTED COPY** of `SNAPSHOT_RESTORE_ISOLATED_3159e52.md` (2026-10-18; kept in the operator package `_backup`, not tracked). Only the ledger numbers (52 / 0052 became 77 / 0077, the state a snapshot taken before this rehearsal holds) and names changed. The local rehearsal `snapshot-restore-local-rehearsal.sh` it cites was **NOT re-run for this release** and is not in this package; the statements marked LOCAL REHEARSED below are the earlier release's evidence. Nothing here was run on AWS.

**Status: DOCUMENTED. NOT a proven recovery procedure.**

| Part | State |
|---|---|
| SQL steps E-H (dump one database, swap, retain the damaged copy, protect the other database) | **LOCAL REHEARSED**: `snapshot-restore-local-rehearsal.sh`, PostgreSQL 16, two throwaway clusters, 21 checks pass. See section 10 |
| Every AWS step (A-D, I; the real RDS restore, security group, tunnel, rename privilege) | **NOT RUN, NOT VERIFIED.** Each is YELLOW and needs the owner's explicit GO at run time |
| A reviewed window script for the swap (like `rehearsal-migrate-test.sh`) | **NOT WRITTEN.** The steps below are typed by an operator. The migration wrapper has no restore mode and is unchanged |
| Rehearsal of this procedure against real RDS | **NOT DONE** |

Use it only after **Tier 1** (`rehearsal-migrate-test.sh rollback`, rehearsed) has failed or cannot apply, and only on the owner's instruction. If any step does not behave as written: **stop and report; do not improvise.**

## 0. The hazard this procedure is built around (VERIFIED from the procedure and wrapper, not from AWS)
`ogevia-prod-postgres` holds two databases under one master credential: `ogevia_sv_test` (the TEST slice) and `ogevia_prd` (production). A snapshot contains both as of the snapshot time. Restoring a snapshot **in place** (or repointing anything at a restored instance) would roll `ogevia_prd` back and lose every production write since the snapshot. The local rehearsal demonstrates exactly that difference: after the swap `ogevia_prd` kept its 1,500 rows while the restored copy held the old 1,000.

## 1. Invariants (any violation = STOP)
1. The snapshot is restored only to a **new** instance named `ogevia-recovery-<UTC yyyymmddHHMM>`. `ogevia-prod-postgres` is never restored, replaced, renamed, stopped, rebooted or modified except by the SQL in step G, which names only `ogevia_sv_test`.
2. The new instance has its **own** security group. It never carries the RDS security group `sg-00530a1f4f7648e65` or the application security group `sg-064ffce3bcbe8eb3b`, so no application can reach it. Its only inbound rule is 5432 from **one /32: the admin host's private IP**.
3. Not publicly accessible, encrypted with the same KMS key as the source, no Multi-AZ.
4. Nothing ever connects to `ogevia_prd`, on either instance, in any step. Allowed connections: the `postgres` maintenance database and `ogevia_sv_test` (and the renamed damaged copy). Every `psql`, `pg_dump` and `pg_restore` command names its database with `-d`. `pg_dumpall`, `pg_restore --create`, `--clean` and `DROP DATABASE` against anything except a database created in step G are forbidden.
5. The restored instance holds a copy of `ogevia_prd`. It is treated as production data: private, encrypted, deleted after use (step I), never used by the TEST application.
6. Only the owner's GO starts each YELLOW action. Deleting the recovery instance, the dump or the damaged database copy needs the owner's GO as well.

## 2. Preconditions (read-only; all must hold)
- The named snapshot validates exactly as the wrapper validates it: `available`, manual, `DBInstanceIdentifier = ogevia-prod-postgres`, created inside the release window. Its ledger state is therefore **77 / 0077** (it was taken before the migration).
- Read the live instance's `EngineVersion`, `DBInstanceClass`, `AllocatedStorage`, `DBSubnetGroup`, `KmsKeyId`, `MasterUserSecret`. The operator's `pg_dump` and `pg_restore` major version must be **at least** the instance's major version (the earlier rehearsal hit a client 16 vs server 18 mismatch; check `pg_dump --version` on the admin host).
- `aws rds restore-db-instance-from-db-snapshot help` lists `--manage-master-user-password`. UNKNOWN until checked: if it does not, STOP (the restored instance would otherwise keep the snapshot-time master password, which may no longer match the current secret).
- Agreed with the owner: TEST users are told the TEST site is unavailable during step G. Production (`ogevia_prd`) is not stopped and is not expected to notice.
- Record before anything changes, from the `postgres` database only (catalog, no `ogevia_prd` connection):
  `select oid, datname, datdba, datacl, datallowconn, datconnlimit, encoding, datcollate, datctype from pg_database order by datname;` and `select rolname, rolsuper, rolcanlogin from pg_roles where rolname !~ '^pg_' order by 1;`. Save both to `~/ogevia-before/recovery-catalog-before.txt`.

## 3. Step A [YELLOW] - fresh safety snapshot of the live instance
Taken **now**, after the failure and before anything else, so both the damaged state and the current `ogevia_prd` are retained.
```
export AWS_REGION=us-west-2 AWS_DEFAULT_REGION=us-west-2 AWS_PAGER=""
STAMP=$(date -u +%Y%m%d%H%M)
aws rds create-db-snapshot --db-instance-identifier ogevia-prod-postgres --db-snapshot-identifier ogevia-prod-postgres-pre-recovery-$STAMP
aws rds wait db-snapshot-available --db-snapshot-identifier ogevia-prod-postgres-pre-recovery-$STAMP
```
STOP if it does not become `available`.

## 4. Step B [YELLOW] - dedicated security group
```
VPC=vpc-0ee9df0c38297cbc1
RSG=$(aws ec2 create-security-group --group-name ogevia-recovery-sg-$STAMP --description "Temporary: restored copy, admin host only" --vpc-id $VPC --query GroupId --output text)
```
Inbound stays **empty** until step D (a new group has no inbound rules; confirm with `describe-security-groups`). Default outbound is left as created.

## 5. Step C [YELLOW] - restore to a new, private instance
```
SUBNET_GROUP=<DBSubnetGroupName of the live instance>
aws rds restore-db-instance-from-db-snapshot \
  --db-snapshot-identifier "$OGEVIA_PREDEPLOY_SNAPSHOT_ID" \
  --db-instance-identifier ogevia-recovery-$STAMP \
  --db-instance-class <the live instance's class, or larger> \
  --db-subnet-group-name "$SUBNET_GROUP" --vpc-security-group-ids "$RSG" \
  --no-publicly-accessible --no-multi-az --manage-master-user-password \
  --tags Key=purpose,Value=snapshot-restore Key=contains,Value=copy-of-ogevia_prd Key=delete-after-use,Value=true
aws rds wait db-instance-available --db-instance-identifier ogevia-recovery-$STAMP
```
Verify (STOP if any line differs): `describe-db-instances` for the new instance shows `StorageEncrypted: true`, `KmsKeyId` equal to the live instance's, `PubliclyAccessible: false`, exactly one `VpcSecurityGroups` entry = `$RSG`, an endpoint different from the live endpoint, and a `MasterUserSecret` of its own. The recovery time is whatever this step took; record it (it is the real RTO for this path).
Cost driver: instance hours plus storage while it exists. The restore-drill estimate in `phase7-remediate.sh` ("about 10 cents for roughly an hour on db.t4g.micro") is the repository's own figure for a micro instance, not verified here.

## 6. Step D [YELLOW] - read-only access to the recovery instance
Add the one /32 rule for the admin host's private IP to `$RSG` (5432, description beginning `TEMP-recovery-`), open the SSM tunnel on **local port 15433**, so a command aimed at 5432 can never reach the wrong server. Read the recovery instance's own master secret; do not print it. Read-only checks on the restored copy:
```
psql -h 127.0.0.1 -p 15433 -d ogevia_sv_test -c "select count(*), max(version) from schema_migrations"   # expect 77 | 0077
```
STOP if the ledger is not 77 / 0077. (Use the real ledger table name from the wrapper's precondition query; this is the rehearsal's name.) Close the /32 rule when done with each phase; confirm the group's rule set is empty again at the end (step I).

## 7. Step E - extract `ogevia_sv_test` only
```
pg_dump -h 127.0.0.1 -p 15433 -d ogevia_sv_test -Fc -f ~/ogevia-before/sv_test-from-snapshot.dump
pg_restore -l ~/ogevia-before/sv_test-from-snapshot.dump | grep "dbname: ogevia_sv_test"      # must match
pg_restore -l ~/ogevia-before/sv_test-from-snapshot.dump | grep -c <a table that exists only in ogevia_prd>   # must be 0
sha256sum ~/ogevia-before/sv_test-from-snapshot.dump | tee ~/ogevia-before/sv_test-from-snapshot.sha256
```
Owners and grants are kept (not `--no-owner`): the live cluster already has the roles. UNKNOWN until checked on RDS: that every role named in the dump exists on the live instance (`pg_restore -l` plus the role list recorded in section 2). If a role is missing, STOP.
Optionally (recommended) take a forensic dump of the damaged live `ogevia_sv_test` with the same command through the reviewed window (step F) before the swap.

## 8. Steps F-H [YELLOW] - the swap on the live instance
Open access to the live instance only through the reviewed method (`ledger-check-temp-access.sh test --host-ip`, v3, sha256 `f96c06f2...5f6`): a single /32 for the admin host, hash-verified at close, OPEN marker, exit 3 on non-restoration. Connect to the **`postgres`** database as the master user (never `ogevia_prd`).
```
-- 1. no new connections, then clear the existing ones (scoped by database name)
alter database ogevia_sv_test allow_connections false;
select count(pg_terminate_backend(pid)) from pg_stat_activity where datname = 'ogevia_sv_test' and pid <> pg_backend_pid();
-- 2. keep the damaged copy; the stamp is lower-case digits (an upper-case letter would be folded and the name would not match)
alter database ogevia_sv_test rename to ogevia_sv_test_damaged_<yyyymmddHHMM>;
-- 3. new database with the same owner (copy encoding/locale from the recorded pg_database row)
create database ogevia_sv_test owner ogevia_owner template template0;     -- add the recorded encoding / lc_collate / lc_ctype
```
Each statement is a separate command (CREATE DATABASE cannot run inside a transaction block). Then:
```
pg_restore -h 127.0.0.1 -p <live tunnel port> -d ogevia_sv_test --exit-on-error --single-transaction ~/ogevia-before/sv_test-from-snapshot.dump
```
**If the rename or the create fails, or the restore fails: put the original back** (rehearsed locally):
```
drop database ogevia_sv_test;                                             -- only the new, partially restored database
alter database ogevia_sv_test_damaged_<yyyymmddHHMM> rename to ogevia_sv_test;
alter database ogevia_sv_test allow_connections true;
```
Then STOP and report. If the rename itself is refused (UNKNOWN: RDS master-user privilege on a database owned by `ogevia_owner`; needs membership in the owning role), STOP: nothing was changed, re-enable connections and report.

Step H, verification before closing the window:
- `ogevia_sv_test` ledger is exactly **77 / 0077**; the renamed damaged copy exists with `datallowconn = false`; it is **not** dropped (dropping needs the owner's GO).
- From the `postgres` database: the `pg_database` row for `ogevia_prd` (oid, owner, ACL, allow-connections, limit, encoding, collation) and the role list are **identical** to `recovery-catalog-before.txt`. This shows only that the `ogevia_prd` database entry and the cluster roles were not altered by the swap statements. It is **not** evidence about `ogevia_prd`'s data, tables, grants or sessions, and it is not proof that production was unaffected; this procedure never connects to `ogevia_prd`, so it contains no check of that data. It needs no connection to `ogevia_prd`.
- Close the window; the script verifies the security group is identical to the original. Then re-enable the TEST site and re-run the migration from the start through the wrapper, with a **new** pre-deployment snapshot and a **new** release window. The old window and snapshot are not reused.

## 9. Step I [YELLOW; deletions need the owner's GO] - clean up
1. Remove the /32 rule from `$RSG`; confirm no rules remain.
2. Delete the recovery instance `ogevia-recovery-$STAMP` (it is a copy of `ogevia_prd`; skip a final snapshot; keep `ogevia-prod-postgres-pre-recovery-$STAMP`), then `$RSG`.
3. Securely delete `~/ogevia-before/sv_test-from-snapshot.dump` (TEST data only, but handled as sensitive) after the owner accepts the result.
4. Keep the renamed damaged database and both snapshots until the owner decides; their removal is a separate GO.
5. Write the timeline (start, restore duration, swap, verification, deletion) into the release record.

## 10. What is and is not verified
**LOCAL REHEARSED (PostgreSQL 16, throwaway clusters; `snapshot-restore-local-rehearsal.sh`)**: the restored copy shows ledger 77; the dump names only `ogevia_sv_test` and contains no `ogevia_prd` table; a failing restore puts the original back with connections re-enabled and no leftover databases; the real swap leaves ledger 77 / 0077, the table, owner and grant restored, the damaged copy retained with connections disabled; `ogevia_prd` catalog row, cluster roles and post-snapshot rows are unchanged; the restored copy holds the old `ogevia_prd`, which is why an in-place restore is forbidden. A rehearsal run found one defect in the draft (an upper-case stamp is folded to lower case by `ALTER DATABASE ... RENAME TO`, so the name would not match); the stamp is now digits only.

**NOT VERIFIED (needs the real account, owner GO):** the RDS restore itself and its duration; `--manage-master-user-password` on restore; rename/create/terminate privileges for the RDS master user; role presence on the live instance; security-group behaviour; tunnel on port 15433; engine-version match of the client tools; Multi-AZ/class/storage of the live instance; deletion of the recovery instance.

**Residual risks:** the swap interrupts TEST for its duration; rows written to `ogevia_sv_test` after the snapshot are lost by design (the forensic dump is the only record of them); data in the restored copy of `ogevia_prd` exists until step I.
