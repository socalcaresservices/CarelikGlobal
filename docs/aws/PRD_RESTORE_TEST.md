# Production restore test for `ogevia_prd` (gate A3, check E3)

Status: **PREPARED FOR REVIEW. NOT RUN. Nothing in AWS was changed to write it.** Script: `infra/aws/slice/prd-restore-test.sh`. YELLOW action (CLAUDE.md s.13): it creates, then deletes, one temporary RDS instance, and needs the owner's approval reference.

Gate (owner, 2026-10-08): **no real client data goes into `ogevia_prd` until this test has passed and its record is saved.**

## When to run it

After the production `database` step has created and migrated `ogevia_prd`, at least 15 minutes after the last migration (the restore point has to include the database), and **before** any real client data is entered. The script stops by itself if `ogevia_prd` does not exist yet or the last migration is too recent.

## What it does

| # | Step | Changes AWS? |
|---|---|---|
| 1 | Checks the signed-in account and the approval reference (`OGEVIA_RESTORE_TEST_APPROVAL`), that no other restore copy or saved state exists, and prints the plan. You type `RESTORE` to continue. | No |
| 2 | Reads `ogevia-prod-postgres`: must be available, encrypted, private, deletion protection on, backups of at least 7 days. | No |
| 3 | Finds the admin host and confirms its groups are the verified original (`sg-00e01e2ca80442c1f`). | No |
| 4 | Adds security group `sg-064ffce3bcbe8eb3b` to the admin host, opens a Session Manager tunnel to the source, and checks that `ogevia_prd` exists, its migration ledger is contiguous from 0001 with at least 38 migrations, and the last migration is at least 15 minutes old. Then closes the tunnel and restores the admin host's groups. | Admin host groups (temporary) |
| 5 | Restores the latest restorable time of `ogevia-prod-postgres` to a new instance `ogevia-restore-drill-<UTC minute>` (db.t4g.micro, single-AZ, private, same subnet group, security groups and KMS key, tagged `purpose=restore-drill`). | **Creates one RDS instance** |
| 6 | Waits for it. If AWS stops answering (expired CloudShell credentials) it pauses with exit code 3 and keeps the copy; `resume` continues without creating a second copy. Records the time to restore. | No |
| 7 | Attaches the app group again, opens tunnels to the copy and the source, and compares them read-only: database present, migration ledger (versions and checksums), table and function counts, row counts up to the restore point, production access model (PUBLIC cannot connect, `ogevia_prd_app` unprivileged), and a login as `ogevia_prd_app` using the production secret. Then closes tunnels and restores the admin host's groups. | Admin host groups (temporary) |
| 8 | If every check passed: deletes only the temporary instance (name pattern, tag and "not the source" checked first), with no final snapshot and no retained backups. If any check failed: keeps it and prints the delete command. | **Deletes the temporary instance** |
| 9 | Verifies the cleanup and writes the record `~/ogevia-phase7/prd-restore-test-<UTC>.txt`. | No |

Nothing prints a password or a client record. The output holds counts only.

## AWS resources

| Action | Resource |
|---|---|
| Creates | One RDS instance `ogevia-restore-drill-<UTC minute>` and its storage and automated backup |
| Modifies (temporarily; restored each time and again by the exit handler) | The security-group list of the admin host `i-0ce8db2d7e5839dd5` (adds `sg-064ffce3bcbe8eb3b`) |
| Reads | RDS instance details and events; Secrets Manager: the RDS master secret and `ogevia/prd/database/app` (values held in memory only); EC2 describe; Session Manager tunnels |
| Deletes | Only the temporary instance and its automated backups |
| Never touches | `ogevia-prod-postgres` (never modified, snapshotted or deleted), Cognito, S3, IAM, KMS, CloudFormation stacks, Netlify, Supabase |
| Local files in CloudShell | `~/ogevia-phase7/prd-restore-state.env` (instance name, start time, original groups; deleted on success), a log, and the record. No secrets. |

## Cleanup

Automatic on success. If it stops or you close the window:
1. `bash prd-restore-test.sh resume` finishes the checks and the cleanup.
2. To look by hand: `aws rds describe-db-instances --query "DBInstances[?starts_with(DBInstanceIdentifier,'ogevia-restore-drill-')].[DBInstanceIdentifier,DBInstanceStatus]" --output text`.
3. The admin host's groups must be only `sg-00e01e2ca80442c1f`: `aws ec2 describe-instances --instance-ids i-0ce8db2d7e5839dd5 --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text`. If the app group is still there, set the groups back in the EC2 console.
4. Delete a leftover copy only after reading why the test failed. The script prints the exact command.

## Pass and fail

The test passes only if all of these pass. The record ends with `RESULT: PASS` or `RESULT: FAIL`.

1. Source instance available, encrypted, private, deletion protection on, backups of at least 7 days.
2. `ogevia_prd` exists on the source with a contiguous ledger from 0001 (at least 38 migrations), last migration at least 15 minutes old.
3. The copy is available, private, encrypted with the source's KMS key, and is a different instance from the source.
4. The time to restore is recorded. **No time limit is set** (the owner has not defined one); decide a recovery-time target when you read the result.
5. The restore point is read from the RDS event.
6. `ogevia_prd` is present on the copy.
7. Migration ledger: versions and checksums identical to the source.
8. Table and function counts, and row counts up to the restore point, identical to the source.
9. Production access model is `ok` on both.
10. `ogevia_prd_app` connects to the restored `ogevia_prd` with the production secret. (Do not rotate that password between the restore point and the check.)
11. Cleanup: copy gone, no retained backups, admin host groups original, source untouched, no other restore-drill instance.

A failed check keeps the copy for diagnosis and exits 1.

## Cost (INFERRED; AWS pricing pages were not reachable from the environment that prepared this)

About 10 cents for a run of roughly an hour: db.t4g.micro compute at about $0.016 an hour plus gp3 storage for the allocated size, which was not read. Left running by mistake: about $0.40 to $1 a day. Session Manager and the secret reads cost effectively nothing.

## How it was checked

`bash -n` passes. It was rehearsed against a simulated AWS (stand-in `aws`, `psql` and Session Manager) covering: the full pass; a count mismatch, a missing database on the copy, a public copy and a failed application login (each keeps the copy, restores the admin host's groups and exits 1); expired credentials while waiting (pause, then `resume` completes without creating a second copy); and the refusals (no approval reference, `ogevia_prd` missing on the source, last migration too recent, an existing restore copy, saved state from an earlier run). **It has not run against real AWS.** The first real run is the real test of the script, so run it with the owner watching.
