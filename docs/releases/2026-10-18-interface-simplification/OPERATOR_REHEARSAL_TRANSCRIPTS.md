# Rehearsal transcripts of slice/candidate-migrate-test.sh (FAKE AWS, FAKE psql, throwaway git clone)

**These are rehearsals, not AWS runs.** They are produced by `infra/aws/test/candidate-migrate-test.test.ts` (42 tests) against test doubles that keep the RDS security group's rules in a file, so adding and removing the rule changes state the test compares. They show the script's own control flow and its messages; they cannot show what real AWS, the real tunnel or the real runner print. Commit SHAs, hashes, timestamps and the host IP in these transcripts are synthetic. Nothing was run against any AWS account or database.

## A. Success (migrate): one /32 rule, 25 migrations, verification, cleanup

```
================================================================
MODE                   : migrate  (TEST only, database ogevia_sv_test)
UTC time              : 2026-10-18T03:38:00Z
================================================================
account 300094796789, region us-west-2: OK

== 0. The checkout is exactly the approved candidate (read-only)
commit e8b1882e952774761c0068c02895e0a935f883a1 (clean); migration set sha256 69b1e29837cecad9...: OK

== 1. Environment (read-only): TEST; expected database ogevia_sv_test
stack Ogevia-prod-ServiceVerificationApi: UPDATE_COMPLETE
Lambda fn-handler: DB_NAME=ogevia_sv_test  OGEVIA_ENV=test
Environment identified: TEST.

== 2. ORIGINAL CONFIGURATION (recorded before any change)
admin host i-0ce8db2d7e5839dd5: security groups [sg-00e01e2ca80442c1f]  (NOT modified by this script)
group sg-00e01e2ca80442c1f is used by 1 network interface(s) (not granted anything: the rule below names the admin host's own IP only)
admin host IP (live): 10.20.132.179 on eni-099616641dd91bcaf, the only interface and the only address; it maps to no other interface in vpc-0ee9df0c38297cbc1
RDS security group sg-00530a1f4f7648e65, ORIGINAL inbound rules:
   tcp 5432-5432  from sg-064ffce3bcbe8eb3b
ORIGINAL rule-set sha256: 76e9c75367c204f02dfcc52ff9d9dcc068e448b33fd2b3b664622ba8b514f175   (full copy: <tmp>/out/rds-sg-before.json)

== 3. PROPOSED CHANGES
  1. ADD to sg-00530a1f4f7648e65 :  inbound tcp 5432 from 10.20.132.179/32  (the admin host's own IP only; description 'TEMP-migrate-20261018T033800Z')
  2. Through that window, against ogevia_sv_test ONLY: check the ledger is exactly 52 / 0052, apply migrations 0053 to 0077 with the pinned runner, re-read the ledger, run the read-only verification set.
  3. REMOVE the rule again, then verify the complete rule set equals the original hash above.
  Reaches: RDS instance ogevia-prod-postgres on 5432 from the admin host only. That instance ALSO holds ogevia_prd: this script never names, connects to or queries it.

== 4. Window
window open: exactly one rule was added (verified: the group minus that rule equals the original).

== 5. Database and ledger precondition (read-only)
connected: ogevia_sv_test | read_only=on
ledger before: 52 migrations applied, latest 0052
enforcement activated for 0 of 2 agencies before (this run never changes it)

== 6. Migrations (the pinned runner, one transaction per file, against ogevia_sv_test only)
applying 0053_x.sql
   ... (23 more lines) ...
applying 0077_x.sql
applied 25, already applied 52
ledger after: 77 migrations applied, latest 0077

== 7. Verification set (read-only transactions; the runner's own db:verify)
verification: 369 PASS, 0 FAIL (exit 0); full output: <tmp>/out/verify.txt
enforcement state unchanged: 0 of 2 agencies activated

== CLEANUP: removing the temporary rule (tcp 5432 from 10.20.132.179/32 on sg-00530a1f4f7648e65) and verifying
RESTORED (verified): the temporary rule is gone and the RDS security group's complete rule set is identical to the recorded original (sha256 76e9c75367c204f0...).

================ SUMMARY ================
Environment : TEST (ogevia_sv_test)   commit e8b1882e952774761c0068c02895e0a935f883a1
RESULT: migrations 0053 to 0077 applied; ledger 77 / 0077; verification 369 PASS, 0 FAIL.
SECURITY GROUP: restored and verified identical to the original
```

## B. A migration fails (0060): stop, ledger position, cleanup, exit 1

```
================================================================
MODE                   : migrate  (TEST only, database ogevia_sv_test)
UTC time              : 2026-10-18T03:38:16Z
================================================================
account 300094796789, region us-west-2: OK

== 0. The checkout is exactly the approved candidate (read-only)
commit e1ade4ac2f6639dcdae44b55b917f37bd00953cd (clean); migration set sha256 69b1e29837cecad9...: OK

== 1. Environment (read-only): TEST; expected database ogevia_sv_test
stack Ogevia-prod-ServiceVerificationApi: UPDATE_COMPLETE
Lambda fn-handler: DB_NAME=ogevia_sv_test  OGEVIA_ENV=test
Environment identified: TEST.

== 2. ORIGINAL CONFIGURATION (recorded before any change)
admin host i-0ce8db2d7e5839dd5: security groups [sg-00e01e2ca80442c1f]  (NOT modified by this script)
group sg-00e01e2ca80442c1f is used by 1 network interface(s) (not granted anything: the rule below names the admin host's own IP only)
admin host IP (live): 10.20.132.179 on eni-099616641dd91bcaf, the only interface and the only address; it maps to no other interface in vpc-0ee9df0c38297cbc1
RDS security group sg-00530a1f4f7648e65, ORIGINAL inbound rules:
   tcp 5432-5432  from sg-064ffce3bcbe8eb3b
ORIGINAL rule-set sha256: 76e9c75367c204f02dfcc52ff9d9dcc068e448b33fd2b3b664622ba8b514f175   (full copy: <tmp>/out/rds-sg-before.json)

== 3. PROPOSED CHANGES
  1. ADD to sg-00530a1f4f7648e65 :  inbound tcp 5432 from 10.20.132.179/32  (the admin host's own IP only; description 'TEMP-migrate-20261018T033816Z')
  2. Through that window, against ogevia_sv_test ONLY: check the ledger is exactly 52 / 0052, apply migrations 0053 to 0077 with the pinned runner, re-read the ledger, run the read-only verification set.
  3. REMOVE the rule again, then verify the complete rule set equals the original hash above.
  Reaches: RDS instance ogevia-prod-postgres on 5432 from the admin host only. That instance ALSO holds ogevia_prd: this script never names, connects to or queries it.

== 4. Window
window open: exactly one rule was added (verified: the group minus that rule equals the original).

== 5. Database and ledger precondition (read-only)
connected: ogevia_sv_test | read_only=on
ledger before: 52 migrations applied, latest 0052
enforcement activated for 0 of 2 agencies before (this run never changes it)

== 6. Migrations (the pinned runner, one transaction per file, against ogevia_sv_test only)
applying 0053_x.sql
   ... (6 more lines) ...
applying 0060_x.sql
error: syntax error in 0060_x.sql
MIGRATION FAILED (runner exit 1). The runner applies one file per transaction and stops at the first failure: that file was rolled back and earlier files remain applied. DO NOT continue.
Ledger now: 59 migrations applied, latest 0059

STOPPED: the migration did not complete. Follow section 'Recovery' of the procedure (stop; do not deploy the API or web).
Before the window opened nothing is different; after it opened, the cleanup above has restored and verified the security group. The database may be partly migrated: see the ledger line above and the recovery section of the procedure.

== LEDGER at the moment of closing (best effort): 59 migrations applied, latest 0059

== CLEANUP: removing the temporary rule (tcp 5432 from 10.20.132.179/32 on sg-00530a1f4f7648e65) and verifying
RESTORED (verified): the temporary rule is gone and the RDS security group's complete rule set is identical to the recorded original (sha256 76e9c75367c204f0...).
```

## C. Interrupted in the middle of a migration (SIGTERM): ledger position, cleanup, exit 130

```
================================================================
MODE                   : migrate  (TEST only, database ogevia_sv_test)
UTC time              : 2026-10-18T03:38:20Z
================================================================
account 300094796789, region us-west-2: OK

== 0. The checkout is exactly the approved candidate (read-only)
commit 91c68e55a9a431ec999173187e97c40ffa1d96a4 (clean); migration set sha256 69b1e29837cecad9...: OK

== 1. Environment (read-only): TEST; expected database ogevia_sv_test
stack Ogevia-prod-ServiceVerificationApi: UPDATE_COMPLETE
Lambda fn-handler: DB_NAME=ogevia_sv_test  OGEVIA_ENV=test
Environment identified: TEST.

== 2. ORIGINAL CONFIGURATION (recorded before any change)
admin host i-0ce8db2d7e5839dd5: security groups [sg-00e01e2ca80442c1f]  (NOT modified by this script)
group sg-00e01e2ca80442c1f is used by 1 network interface(s) (not granted anything: the rule below names the admin host's own IP only)
admin host IP (live): 10.20.132.179 on eni-099616641dd91bcaf, the only interface and the only address; it maps to no other interface in vpc-0ee9df0c38297cbc1
RDS security group sg-00530a1f4f7648e65, ORIGINAL inbound rules:
   tcp 5432-5432  from sg-064ffce3bcbe8eb3b
ORIGINAL rule-set sha256: 76e9c75367c204f02dfcc52ff9d9dcc068e448b33fd2b3b664622ba8b514f175   (full copy: <tmp>/out/rds-sg-before.json)

== 3. PROPOSED CHANGES
  1. ADD to sg-00530a1f4f7648e65 :  inbound tcp 5432 from 10.20.132.179/32  (the admin host's own IP only; description 'TEMP-migrate-20261018T033820Z')
  2. Through that window, against ogevia_sv_test ONLY: check the ledger is exactly 52 / 0052, apply migrations 0053 to 0077 with the pinned runner, re-read the ledger, run the read-only verification set.
  3. REMOVE the rule again, then verify the complete rule set equals the original hash above.
  Reaches: RDS instance ogevia-prod-postgres on 5432 from the admin host only. That instance ALSO holds ogevia_prd: this script never names, connects to or queries it.

== 4. Window
window open: exactly one rule was added (verified: the group minus that rule equals the original).

== 5. Database and ledger precondition (read-only)
connected: ogevia_sv_test | read_only=on
ledger before: 52 migrations applied, latest 0052
enforcement activated for 0 of 2 agencies before (this run never changes it)

== 6. Migrations (the pinned runner, one transaction per file, against ogevia_sv_test only)
applying 0053_x.sql
   ... (8 more lines) ...
applying 0062_x.sql
Terminated
Interrupted: cleaning up.

== LEDGER at the moment of closing (best effort): 61 migrations applied, latest 0061

== CLEANUP: removing the temporary rule (tcp 5432 from 10.20.132.179/32 on sg-00530a1f4f7648e65) and verifying
RESTORED (verified): the temporary rule is gone and the RDS security group's complete rule set is identical to the recorded original (sha256 76e9c75367c204f0...).
```

## D. The migrations succeed but verification fails: reported, cleanup, exit 1

```
================================================================
MODE                   : migrate  (TEST only, database ogevia_sv_test)
UTC time              : 2026-10-18T03:38:25Z
================================================================
account 300094796789, region us-west-2: OK

== 0. The checkout is exactly the approved candidate (read-only)
commit d6aedccb443d84dfa668962ea3bf8e10301b2cdc (clean); migration set sha256 69b1e29837cecad9...: OK

== 1. Environment (read-only): TEST; expected database ogevia_sv_test
stack Ogevia-prod-ServiceVerificationApi: UPDATE_COMPLETE
Lambda fn-handler: DB_NAME=ogevia_sv_test  OGEVIA_ENV=test
Environment identified: TEST.

== 2. ORIGINAL CONFIGURATION (recorded before any change)
admin host i-0ce8db2d7e5839dd5: security groups [sg-00e01e2ca80442c1f]  (NOT modified by this script)
group sg-00e01e2ca80442c1f is used by 1 network interface(s) (not granted anything: the rule below names the admin host's own IP only)
admin host IP (live): 10.20.132.179 on eni-099616641dd91bcaf, the only interface and the only address; it maps to no other interface in vpc-0ee9df0c38297cbc1
RDS security group sg-00530a1f4f7648e65, ORIGINAL inbound rules:
   tcp 5432-5432  from sg-064ffce3bcbe8eb3b
ORIGINAL rule-set sha256: 76e9c75367c204f02dfcc52ff9d9dcc068e448b33fd2b3b664622ba8b514f175   (full copy: <tmp>/out/rds-sg-before.json)

== 3. PROPOSED CHANGES
  1. ADD to sg-00530a1f4f7648e65 :  inbound tcp 5432 from 10.20.132.179/32  (the admin host's own IP only; description 'TEMP-migrate-20261018T033825Z')
  2. Through that window, against ogevia_sv_test ONLY: check the ledger is exactly 52 / 0052, apply migrations 0053 to 0077 with the pinned runner, re-read the ledger, run the read-only verification set.
  3. REMOVE the rule again, then verify the complete rule set equals the original hash above.
  Reaches: RDS instance ogevia-prod-postgres on 5432 from the admin host only. That instance ALSO holds ogevia_prd: this script never names, connects to or queries it.

== 4. Window
window open: exactly one rule was added (verified: the group minus that rule equals the original).

== 5. Database and ledger precondition (read-only)
connected: ogevia_sv_test | read_only=on
ledger before: 52 migrations applied, latest 0052
enforcement activated for 0 of 2 agencies before (this run never changes it)

== 6. Migrations (the pinned runner, one transaction per file, against ogevia_sv_test only)
applying 0053_x.sql
   ... (23 more lines) ...
applying 0077_x.sql
applied 25, already applied 52
ledger after: 77 migrations applied, latest 0077

== 7. Verification set (read-only transactions; the runner's own db:verify)
verification: 1 PASS, 1 FAIL (exit 1); full output: <tmp>/out/verify.txt

STOPPED: the verification set did not pass. The migrations ARE applied; do not deploy the API or web; see the procedure.
Before the window opened nothing is different; after it opened, the cleanup above has restored and verified the security group. The database may be partly migrated: see the ledger line above and the recovery section of the procedure.

== LEDGER at the moment of closing (best effort): 77 migrations applied, latest 0077

== CLEANUP: removing the temporary rule (tcp 5432 from 10.20.132.179/32 on sg-00530a1f4f7648e65) and verifying
RESTORED (verified): the temporary rule is gone and the RDS security group's complete rule set is identical to the recorded original (sha256 76e9c75367c204f0...).
```

## E. The temporary rule cannot be removed: exit 3, marker, independent recovery commands

```
================================================================
MODE                   : migrate  (TEST only, database ogevia_sv_test)
UTC time              : 2026-10-18T03:38:49Z
================================================================
account 300094796789, region us-west-2: OK

STOPPED: an earlier migration window is marked OPEN (<tmp>/state/OPEN, started 20261018T033838Z). Run: bash candidate-migrate-test.sh --restore-only
Before the window opened nothing is different; after it opened, the cleanup above has restored and verified the security group. The database may be partly migrated: see the ledger line above and the recovery section of the procedure.
```

## F. The recovery session: --restore-only after E

```
================================================================
MODE                   : --restore-only  (TEST only, database ogevia_sv_test)
UTC time              : 2026-10-18T03:38:49Z
================================================================
account 300094796789, region us-west-2: OK
An open-window marker exists (20261018T033838Z). Restoring.

== CLEANUP: removing the temporary rule (tcp 5432 from 10.20.132.179/32 on sg-00530a1f4f7648e65) and verifying
RESTORED (verified): the temporary rule is gone and the RDS security group's complete rule set is identical to the recorded original (sha256 76e9c75367c204f0...).
```

## G. The TEST ledger is not exactly 52 / 0052: nothing is migrated

```
================================================================
MODE                   : migrate  (TEST only, database ogevia_sv_test)
UTC time              : 2026-10-18T03:37:52Z
================================================================
account 300094796789, region us-west-2: OK

== 0. The checkout is exactly the approved candidate (read-only)
commit 2b7f4e307e5775549c68bb560057e3a44b848908 (clean); migration set sha256 69b1e29837cecad9...: OK

== 1. Environment (read-only): TEST; expected database ogevia_sv_test
stack Ogevia-prod-ServiceVerificationApi: UPDATE_COMPLETE
Lambda fn-handler: DB_NAME=ogevia_sv_test  OGEVIA_ENV=test
Environment identified: TEST.

== 2. ORIGINAL CONFIGURATION (recorded before any change)
admin host i-0ce8db2d7e5839dd5: security groups [sg-00e01e2ca80442c1f]  (NOT modified by this script)
group sg-00e01e2ca80442c1f is used by 1 network interface(s) (not granted anything: the rule below names the admin host's own IP only)
admin host IP (live): 10.20.132.179 on eni-099616641dd91bcaf, the only interface and the only address; it maps to no other interface in vpc-0ee9df0c38297cbc1
RDS security group sg-00530a1f4f7648e65, ORIGINAL inbound rules:
   tcp 5432-5432  from sg-064ffce3bcbe8eb3b
ORIGINAL rule-set sha256: 76e9c75367c204f02dfcc52ff9d9dcc068e448b33fd2b3b664622ba8b514f175   (full copy: <tmp>/out/rds-sg-before.json)

== 3. PROPOSED CHANGES
  1. ADD to sg-00530a1f4f7648e65 :  inbound tcp 5432 from 10.20.132.179/32  (the admin host's own IP only; description 'TEMP-migrate-20261018T033752Z')
  2. Through that window, against ogevia_sv_test ONLY: check the ledger is exactly 52 / 0052, apply migrations 0053 to 0077 with the pinned runner, re-read the ledger, run the read-only verification set.
  3. REMOVE the rule again, then verify the complete rule set equals the original hash above.
  Reaches: RDS instance ogevia-prod-postgres on 5432 from the admin host only. That instance ALSO holds ogevia_prd: this script never names, connects to or queries it.

== 4. Window
window open: exactly one rule was added (verified: the group minus that rule equals the original).

== 5. Database and ledger precondition (read-only)
connected: ogevia_sv_test | read_only=on
ledger before: 52 migrations applied, latest 0053

STOPPED: the TEST ledger is 52 / 0053, not exactly 52 / 0052. Nothing was migrated.
Before the window opened nothing is different; after it opened, the cleanup above has restored and verified the security group. The database may be partly migrated: see the ledger line above and the recovery section of the procedure.

== CLEANUP: removing the temporary rule (tcp 5432 from 10.20.132.179/32 on sg-00530a1f4f7648e65) and verifying
RESTORED (verified): the temporary rule is gone and the RDS security group's complete rule set is identical to the recorded original (sha256 76e9c75367c204f0...).
```

## H. Database-only recovery (rollback) success: 0077 down to 0053 in ogevia_sv_test only

```
================================================================
MODE                   : rollback  (TEST only, database ogevia_sv_test)
UTC time              : 2026-10-18T03:39:00Z
================================================================
account 300094796789, region us-west-2: OK

== 0. The checkout is exactly the approved candidate (read-only)
rollback set sha256 1995e233ae085450...: OK; snapshot ogevia-prod-postgres-pre-0077-test is available for ogevia-prod-postgres
commit 15c13e9606006c2c6176934c42b501f56642a823 (clean); migration set sha256 69b1e29837cecad9...: OK

== 1. Environment (read-only): TEST; expected database ogevia_sv_test
stack Ogevia-prod-ServiceVerificationApi: UPDATE_COMPLETE
Lambda fn-handler: DB_NAME=ogevia_sv_test  OGEVIA_ENV=test
Environment identified: TEST.

== 2. ORIGINAL CONFIGURATION (recorded before any change)
admin host i-0ce8db2d7e5839dd5: security groups [sg-00e01e2ca80442c1f]  (NOT modified by this script)
group sg-00e01e2ca80442c1f is used by 1 network interface(s) (not granted anything: the rule below names the admin host's own IP only)
admin host IP (live): 10.20.132.179 on eni-099616641dd91bcaf, the only interface and the only address; it maps to no other interface in vpc-0ee9df0c38297cbc1
RDS security group sg-00530a1f4f7648e65, ORIGINAL inbound rules:
   tcp 5432-5432  from sg-064ffce3bcbe8eb3b
ORIGINAL rule-set sha256: 76e9c75367c204f02dfcc52ff9d9dcc068e448b33fd2b3b664622ba8b514f175   (full copy: <tmp>/out/rds-sg-before.json)

== 3. PROPOSED CHANGES
  1. ADD to sg-00530a1f4f7648e65 :  inbound tcp 5432 from 10.20.132.179/32  (the admin host's own IP only; description 'TEMP-migrate-20261018T033900Z')
  2. Through that window, against ogevia_sv_test ONLY: check the ledger is contiguous from 0053 upward, then revert the migrations from the latest down to 0053 with the pinned db/rollback files, one transaction per file (the ledger row is deleted in the same transaction), and re-read the ledger (expected 52 / 0052).
     DATA WARNING: several rollbacks drop tables and their history (BACKUP REQUIRED: 0055, 0056, 0060, 0063, 0064, 0067, 0068, 0069, 0071, 0072, 0073, 0074, 0077). The pre-migration snapshot is ogevia-prod-postgres-pre-0077-test.
  3. REMOVE the rule again, then verify the complete rule set equals the original hash above.
  Reaches: RDS instance ogevia-prod-postgres on 5432 from the admin host only. That instance ALSO holds ogevia_prd: this script never names, connects to or queries it.

== 4. Window
window open: exactly one rule was added (verified: the group minus that rule equals the original).

== 5. Database and ledger precondition (read-only)
connected: ogevia_sv_test | read_only=on
ledger before: 77 migrations applied, latest 0077
enforcement activated for 0 of 2 agencies before (this run never changes it)

== 6. Rollback (pinned db/rollback files, newest first, one transaction per file, against ogevia_sv_test only)
reverting 0077 (0077_m77.down.sql)
   ... (23 more lines) ...
reverting 0053 (0053_m53.down.sql)
ledger after: 52 migrations applied, latest 0052
enforcement state unchanged: 0 of 2 agencies activated

== CLEANUP: removing the temporary rule (tcp 5432 from 10.20.132.179/32 on sg-00530a1f4f7648e65) and verifying
RESTORED (verified): the temporary rule is gone and the RDS security group's complete rule set is identical to the recorded original (sha256 76e9c75367c204f0...).

================ SUMMARY ================
Environment : TEST (ogevia_sv_test)   commit 15c13e9606006c2c6176934c42b501f56642a823
RESULT: migrations 0077 to 0053 reverted; ledger 52 / 0052. The API and web must be rolled back too (procedure, Recovery).
SECURITY GROUP: restored and verified identical to the original
```

## I. Rollback: a rollback file fails (0070): stop, ledger position, cleanup

```
================================================================
MODE                   : rollback  (TEST only, database ogevia_sv_test)
UTC time              : 2026-10-18T03:39:24Z
================================================================
account 300094796789, region us-west-2: OK

== 0. The checkout is exactly the approved candidate (read-only)
rollback set sha256 1995e233ae085450...: OK; snapshot ogevia-prod-postgres-pre-0077-test is available for ogevia-prod-postgres
commit 6690bba5946665cff2fbcfdf00c5b23d36b21bd3 (clean); migration set sha256 69b1e29837cecad9...: OK

== 1. Environment (read-only): TEST; expected database ogevia_sv_test
stack Ogevia-prod-ServiceVerificationApi: UPDATE_COMPLETE
Lambda fn-handler: DB_NAME=ogevia_sv_test  OGEVIA_ENV=test
Environment identified: TEST.

== 2. ORIGINAL CONFIGURATION (recorded before any change)
admin host i-0ce8db2d7e5839dd5: security groups [sg-00e01e2ca80442c1f]  (NOT modified by this script)
group sg-00e01e2ca80442c1f is used by 1 network interface(s) (not granted anything: the rule below names the admin host's own IP only)
admin host IP (live): 10.20.132.179 on eni-099616641dd91bcaf, the only interface and the only address; it maps to no other interface in vpc-0ee9df0c38297cbc1
RDS security group sg-00530a1f4f7648e65, ORIGINAL inbound rules:
   tcp 5432-5432  from sg-064ffce3bcbe8eb3b
ORIGINAL rule-set sha256: 76e9c75367c204f02dfcc52ff9d9dcc068e448b33fd2b3b664622ba8b514f175   (full copy: <tmp>/out/rds-sg-before.json)

== 3. PROPOSED CHANGES
  1. ADD to sg-00530a1f4f7648e65 :  inbound tcp 5432 from 10.20.132.179/32  (the admin host's own IP only; description 'TEMP-migrate-20261018T033924Z')
  2. Through that window, against ogevia_sv_test ONLY: check the ledger is contiguous from 0053 upward, then revert the migrations from the latest down to 0053 with the pinned db/rollback files, one transaction per file (the ledger row is deleted in the same transaction), and re-read the ledger (expected 52 / 0052).
     DATA WARNING: several rollbacks drop tables and their history (BACKUP REQUIRED: 0055, 0056, 0060, 0063, 0064, 0067, 0068, 0069, 0071, 0072, 0073, 0074, 0077). The pre-migration snapshot is ogevia-prod-postgres-pre-0077-test.
  3. REMOVE the rule again, then verify the complete rule set equals the original hash above.
  Reaches: RDS instance ogevia-prod-postgres on 5432 from the admin host only. That instance ALSO holds ogevia_prd: this script never names, connects to or queries it.

== 4. Window
window open: exactly one rule was added (verified: the group minus that rule equals the original).

== 5. Database and ledger precondition (read-only)
connected: ogevia_sv_test | read_only=on
ledger before: 77 migrations applied, latest 0077
enforcement activated for 0 of 2 agencies before (this run never changes it)

== 6. Rollback (pinned db/rollback files, newest first, one transaction per file, against ogevia_sv_test only)
reverting 0077 (0077_m77.down.sql)
   ... (6 more lines) ...
reverting 0070 (0070_m70.down.sql)
ROLLBACK FAILED at 0070 (psql exit 3). That file's transaction was rolled back; 0070 and everything below it are still applied; files already reverted stay reverted. Last lines: ERROR: cannot drop table x because other objects depend on it 
Ledger now: 70 migrations applied, latest 0070

STOPPED: the rollback did not complete. Follow section 'Recovery' of the procedure.
Before the window opened nothing is different; after it opened, the cleanup above has restored and verified the security group. The database may be partly migrated: see the ledger line above and the recovery section of the procedure.

== LEDGER at the moment of closing (best effort): 70 migrations applied, latest 0070

== CLEANUP: removing the temporary rule (tcp 5432 from 10.20.132.179/32 on sg-00530a1f4f7648e65) and verifying
RESTORED (verified): the temporary rule is gone and the RDS security group's complete rule set is identical to the recorded original (sha256 76e9c75367c204f0...).
```

