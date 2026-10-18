# Rehearsal transcripts of slice/candidate-migrate-test.sh (FAKE AWS, FAKE psql, throwaway git clone)

**These are rehearsals, not AWS runs.** They are produced by `infra/aws/test/candidate-migrate-test.test.ts` (86 tests) against test doubles that keep the RDS security group's rules in a file, so adding and removing the rule changes state the test compares. They show the script's own control flow and its messages; they cannot show what real AWS, the real tunnel or the real runner print. Commit SHAs, hashes, timestamps and the host IP in these transcripts are synthetic. Nothing was run against any AWS account or database. Sections J to N show refusals: in each, no rule was added, no tunnel opened, no secret read and nothing migrated.

## A. Success (migrate): snapshot validated first, one /32 rule, 25 migrations, verification, cleanup

```
================================================================
MODE                   : migrate  (TEST only, database ogevia_sv_test)
UTC time              : 2026-10-18T05:25:37Z
================================================================
account 300094796789, region us-west-2: OK

== 0. The checkout is exactly the approved candidate (read-only)
snapshot ogevia-prod-postgres-pre-0077-202610180515: available, manual, belongs to ogevia-prod-postgres, created 2026-10-18T05:15:37.123000+00:00 inside the release window 2026-10-18T04:25:37Z to 2026-10-18T08:25:37Z. (A recovery PREREQUISITE only: restoring from it is not a prepared procedure.)
commit f48c5c70fac142a0505c5fcd66d124beeb78a39e (clean); migration set sha256 69b1e29837cecad9...: OK

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
  1. ADD to sg-00530a1f4f7648e65 :  inbound tcp 5432 from 10.20.132.179/32  (the admin host's own IP only; description 'TEMP-migrate-20261018T052537Z')
  2. Through that window, against ogevia_sv_test ONLY: check the ledger is exactly 52 / 0052, apply migrations 0053 to 0077 with the pinned runner, re-read the ledger, run the read-only verification set.
  3. REMOVE the rule again, then verify the complete rule set equals the original hash above.
  Reaches: RDS instance ogevia-prod-postgres on 5432 from the admin host only. That instance ALSO holds ogevia_prd: this script never names, connects to or queries it.

== 4. Window
window open: exactly one rule was added (verified: the group minus that rule equals the original).

== 5. Database and ledger precondition (read-only)
connected: ogevia_sv_test | read_only=on
ledger before: 52 migrations applied, latest 0052
enforcement activated for 1 of 2 agencies before (this run never changes it)

== 6. Migrations (the pinned runner, one transaction per file, against ogevia_sv_test only)
applying 0053_x.sql
   ... (23 more lines) ...
applying 0077_x.sql
applied 25, already applied 52
ledger after: 77 migrations applied, latest 0077

== 7. Verification set (read-only transactions; the runner's own db:verify)
verification: 369 PASS, 0 FAIL (exit 0); full output: <tmp>/out/verify.txt
enforcement state unchanged: 1 of 2 agencies activated

== CLEANUP: removing the temporary rule (tcp 5432 from 10.20.132.179/32 on sg-00530a1f4f7648e65) and verifying
RESTORED (verified): the temporary rule is gone and the RDS security group's complete rule set is identical to the recorded original (sha256 76e9c75367c204f0...).

================ SUMMARY ================
Environment : TEST (ogevia_sv_test)   commit f48c5c70fac142a0505c5fcd66d124beeb78a39e
RESULT: migrations 0053 to 0077 applied; ledger 77 / 0077; verification 369 PASS, 0 FAIL.
SECURITY GROUP: restored and verified identical to the original
```

## B. A migration fails (0060): stop, ledger position, cleanup, exit 1

```
================================================================
MODE                   : migrate  (TEST only, database ogevia_sv_test)
UTC time              : 2026-10-18T05:24:18Z
================================================================
account 300094796789, region us-west-2: OK

== 0. The checkout is exactly the approved candidate (read-only)
snapshot ogevia-prod-postgres-pre-0077-202610180514: available, manual, belongs to ogevia-prod-postgres, created 2026-10-18T05:14:18.123000+00:00 inside the release window 2026-10-18T04:24:18Z to 2026-10-18T08:24:18Z. (A recovery PREREQUISITE only: restoring from it is not a prepared procedure.)
commit b1152fe5611967710a330ad4667b28f42cc34e67 (clean); migration set sha256 69b1e29837cecad9...: OK

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
  1. ADD to sg-00530a1f4f7648e65 :  inbound tcp 5432 from 10.20.132.179/32  (the admin host's own IP only; description 'TEMP-migrate-20261018T052418Z')
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
The window had been opened: the cleanup above restored and verified the security group. The database may be partly migrated: see the ledger line above and the recovery section of the procedure.

== LEDGER at the moment of closing (best effort): 59 migrations applied, latest 0059

== CLEANUP: removing the temporary rule (tcp 5432 from 10.20.132.179/32 on sg-00530a1f4f7648e65) and verifying
RESTORED (verified): the temporary rule is gone and the RDS security group's complete rule set is identical to the recorded original (sha256 76e9c75367c204f0...).
```

## C. Interrupted in the middle of a migration (SIGTERM): ledger position, cleanup, exit 130

```
================================================================
MODE                   : migrate  (TEST only, database ogevia_sv_test)
UTC time              : 2026-10-18T05:24:22Z
================================================================
account 300094796789, region us-west-2: OK

== 0. The checkout is exactly the approved candidate (read-only)
snapshot ogevia-prod-postgres-pre-0077-202610180514: available, manual, belongs to ogevia-prod-postgres, created 2026-10-18T05:14:22.123000+00:00 inside the release window 2026-10-18T04:24:22Z to 2026-10-18T08:24:22Z. (A recovery PREREQUISITE only: restoring from it is not a prepared procedure.)
commit 827a1e6f604dd750ab022b24a90d401b4f8ba11e (clean); migration set sha256 69b1e29837cecad9...: OK

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
  1. ADD to sg-00530a1f4f7648e65 :  inbound tcp 5432 from 10.20.132.179/32  (the admin host's own IP only; description 'TEMP-migrate-20261018T052422Z')
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
UTC time              : 2026-10-18T05:24:26Z
================================================================
account 300094796789, region us-west-2: OK

== 0. The checkout is exactly the approved candidate (read-only)
snapshot ogevia-prod-postgres-pre-0077-202610180514: available, manual, belongs to ogevia-prod-postgres, created 2026-10-18T05:14:26.123000+00:00 inside the release window 2026-10-18T04:24:26Z to 2026-10-18T08:24:26Z. (A recovery PREREQUISITE only: restoring from it is not a prepared procedure.)
commit 7ebbc628462b338fb06cd56a65f39d91af4889f5 (clean); migration set sha256 69b1e29837cecad9...: OK

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
  1. ADD to sg-00530a1f4f7648e65 :  inbound tcp 5432 from 10.20.132.179/32  (the admin host's own IP only; description 'TEMP-migrate-20261018T052426Z')
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
The window had been opened: the cleanup above restored and verified the security group. The database may be partly migrated: see the ledger line above and the recovery section of the procedure.

== LEDGER at the moment of closing (best effort): 77 migrations applied, latest 0077

== CLEANUP: removing the temporary rule (tcp 5432 from 10.20.132.179/32 on sg-00530a1f4f7648e65) and verifying
RESTORED (verified): the temporary rule is gone and the RDS security group's complete rule set is identical to the recorded original (sha256 76e9c75367c204f0...).
```

## E. The temporary rule cannot be removed: exit 3, marker, independent recovery commands

```
================================================================
MODE                   : migrate  (TEST only, database ogevia_sv_test)
UTC time              : 2026-10-18T05:24:40Z
================================================================
account 300094796789, region us-west-2: OK

== 0. The checkout is exactly the approved candidate (read-only)
snapshot ogevia-prod-postgres-pre-0077-202610180514: available, manual, belongs to ogevia-prod-postgres, created 2026-10-18T05:14:40.123000+00:00 inside the release window 2026-10-18T04:24:40Z to 2026-10-18T08:24:40Z. (A recovery PREREQUISITE only: restoring from it is not a prepared procedure.)
commit 48dbe2276edc992e350d205dcdfbd1f94755063b (clean); migration set sha256 69b1e29837cecad9...: OK

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
  1. ADD to sg-00530a1f4f7648e65 :  inbound tcp 5432 from 10.20.132.179/32  (the admin host's own IP only; description 'TEMP-migrate-20261018T052440Z')
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
NOT RESTORED (exit 3; access may still be open). Rule still present: YES. Rule-set hash now cf225e98e4f0de49... vs original 76e9c75367c204f0...
DO THIS NOW in a SEPARATE session. First identify (read-only); the temporary rule is the ONE row with cidr 10.20.132.179/32, tcp, 5432, description beginning TEMP-migrate-:
  aws ec2 describe-security-group-rules --region us-west-2 --filters Name=group-id,Values=sg-00530a1f4f7648e65 --query 'SecurityGroupRules[?IsEgress==`false`].{rule:SecurityGroupRuleId,proto:IpProtocol,from:FromPort,to:ToPort,cidr:CidrIpv4,sourceSg:ReferencedGroupInfo.GroupId,desc:Description}' --output table
Then remove ONLY that rule by id (never the row whose sourceSg is the application group sg-064ffce3bcbe8eb3b):
  aws ec2 revoke-security-group-ingress --region us-west-2 --group-id sg-00530a1f4f7648e65 --security-group-rule-ids sgr-<id of that one row>
Then re-run: bash candidate-migrate-test.sh --restore-only   (verifies against the recorded original)
  The marker <tmp>/state/OPEN stays in place until restoration is verified.

================ SUMMARY ================
Environment : TEST (ogevia_sv_test)   commit 48dbe2276edc992e350d205dcdfbd1f94755063b
RESULT: migrations 0053 to 0077 applied; ledger 77 / 0077; verification 369 PASS, 0 FAIL.
SECURITY GROUP: NOT RESTORED, see the instructions above
```

## F. The recovery session: --restore-only after E

```
================================================================
MODE                   : --restore-only  (TEST only, database ogevia_sv_test)
UTC time              : 2026-10-18T05:24:50Z
================================================================
account 300094796789, region us-west-2: OK
An open-window marker exists (20261018T052440Z). Restoring.

== CLEANUP: removing the temporary rule (tcp 5432 from 10.20.132.179/32 on sg-00530a1f4f7648e65) and verifying
RESTORED (verified): the temporary rule is gone and the RDS security group's complete rule set is identical to the recorded original (sha256 76e9c75367c204f0...).
```

## G. The TEST ledger is not exactly 52 / 0052: nothing is migrated

```
================================================================
MODE                   : migrate  (TEST only, database ogevia_sv_test)
UTC time              : 2026-10-18T05:23:42Z
================================================================
account 300094796789, region us-west-2: OK

== 0. The checkout is exactly the approved candidate (read-only)
snapshot ogevia-prod-postgres-pre-0077-202610180513: available, manual, belongs to ogevia-prod-postgres, created 2026-10-18T05:13:42.123000+00:00 inside the release window 2026-10-18T04:23:42Z to 2026-10-18T08:23:42Z. (A recovery PREREQUISITE only: restoring from it is not a prepared procedure.)
commit 09d5f6188005fc5d5792bcf22e45eb5eb6044132 (clean); migration set sha256 69b1e29837cecad9...: OK

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
  1. ADD to sg-00530a1f4f7648e65 :  inbound tcp 5432 from 10.20.132.179/32  (the admin host's own IP only; description 'TEMP-migrate-20261018T052342Z')
  2. Through that window, against ogevia_sv_test ONLY: check the ledger is exactly 52 / 0052, apply migrations 0053 to 0077 with the pinned runner, re-read the ledger, run the read-only verification set.
  3. REMOVE the rule again, then verify the complete rule set equals the original hash above.
  Reaches: RDS instance ogevia-prod-postgres on 5432 from the admin host only. That instance ALSO holds ogevia_prd: this script never names, connects to or queries it.

== 4. Window
window open: exactly one rule was added (verified: the group minus that rule equals the original).

== 5. Database and ledger precondition (read-only)
connected: ogevia_sv_test | read_only=on
ledger before: 51 migrations applied, latest 0051

STOPPED: the TEST ledger is 51 / 0051, not exactly 52 / 0052. Nothing was migrated.
The window had been opened: the cleanup above restored and verified the security group. The database may be partly migrated: see the ledger line above and the recovery section of the procedure.

== CLEANUP: removing the temporary rule (tcp 5432 from 10.20.132.179/32 on sg-00530a1f4f7648e65) and verifying
RESTORED (verified): the temporary rule is gone and the RDS security group's complete rule set is identical to the recorded original (sha256 76e9c75367c204f0...).
```

## H. Database-only recovery (rollback) success: 0077 down to 0053 in ogevia_sv_test only

```
================================================================
MODE                   : rollback  (TEST only, database ogevia_sv_test)
UTC time              : 2026-10-18T05:25:19Z
================================================================
account 300094796789, region us-west-2: OK

== 0. The checkout is exactly the approved candidate (read-only)
rollback set sha256 1995e233ae085450...: OK
snapshot ogevia-prod-postgres-pre-0077-202610180515: available, manual, belongs to ogevia-prod-postgres, created 2026-10-18T05:15:19.123000+00:00 inside the release window 2026-10-18T04:25:19Z to 2026-10-18T08:25:19Z. (A recovery PREREQUISITE only: restoring from it is not a prepared procedure.)
commit 3c032de72abba6da097be4ed8e2ec56dd52d6a7b (clean); migration set sha256 69b1e29837cecad9...: OK

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
  1. ADD to sg-00530a1f4f7648e65 :  inbound tcp 5432 from 10.20.132.179/32  (the admin host's own IP only; description 'TEMP-migrate-20261018T052519Z')
  2. Through that window, against ogevia_sv_test ONLY: check the ledger is contiguous from 0053 upward, then revert the migrations from the latest down to 0053 with the pinned db/rollback files, one transaction per file (the ledger row is deleted in the same transaction), and re-read the ledger (expected 52 / 0052).
     DATA WARNING: several rollbacks drop tables and their history (BACKUP REQUIRED: 0055, 0056, 0060, 0063, 0064, 0067, 0068, 0069, 0071, 0072, 0073, 0074, 0077). The pre-deployment snapshot is ogevia-prod-postgres-pre-0077-202610180515 (restoring it is NOT a prepared procedure).
  3. REMOVE the rule again, then verify the complete rule set equals the original hash above.
  Reaches: RDS instance ogevia-prod-postgres on 5432 from the admin host only. That instance ALSO holds ogevia_prd: this script never names, connects to or queries it.

== 4. Window
window open: exactly one rule was added (verified: the group minus that rule equals the original).

== 5. Database and ledger precondition (read-only)
connected: ogevia_sv_test | read_only=on
ledger before: 60 migrations applied, latest 0060
enforcement activated for 0 of 2 agencies before (this run never changes it)

== 6. Rollback (pinned db/rollback files, newest first, one transaction per file, against ogevia_sv_test only)
reverting 0060 (0060_m60.down.sql)
   ... (6 more lines) ...
reverting 0053 (0053_m53.down.sql)
ledger after: 52 migrations applied, latest 0052
enforcement state unchanged: 0 of 2 agencies activated

== CLEANUP: removing the temporary rule (tcp 5432 from 10.20.132.179/32 on sg-00530a1f4f7648e65) and verifying
RESTORED (verified): the temporary rule is gone and the RDS security group's complete rule set is identical to the recorded original (sha256 76e9c75367c204f0...).

================ SUMMARY ================
Environment : TEST (ogevia_sv_test)   commit 3c032de72abba6da097be4ed8e2ec56dd52d6a7b
RESULT: migrations 0077 to 0053 reverted; ledger 52 / 0052. The API and web must be rolled back too (procedure, Recovery).
SECURITY GROUP: restored and verified identical to the original
```

## I. Rollback: a rollback file fails (0070): stop, ledger position, cleanup

```
================================================================
MODE                   : rollback  (TEST only, database ogevia_sv_test)
UTC time              : 2026-10-18T05:25:23Z
================================================================
account 300094796789, region us-west-2: OK

== 0. The checkout is exactly the approved candidate (read-only)
rollback set sha256 1995e233ae085450...: OK
snapshot ogevia-prod-postgres-pre-0077-202610180515: available, manual, belongs to ogevia-prod-postgres, created 2026-10-18T05:15:23.123000+00:00 inside the release window 2026-10-18T04:25:23Z to 2026-10-18T08:25:23Z. (A recovery PREREQUISITE only: restoring from it is not a prepared procedure.)
commit 58a4bee0211ed1a11f9867cdb2dc1f4552636747 (clean); migration set sha256 69b1e29837cecad9...: OK

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
  1. ADD to sg-00530a1f4f7648e65 :  inbound tcp 5432 from 10.20.132.179/32  (the admin host's own IP only; description 'TEMP-migrate-20261018T052523Z')
  2. Through that window, against ogevia_sv_test ONLY: check the ledger is contiguous from 0053 upward, then revert the migrations from the latest down to 0053 with the pinned db/rollback files, one transaction per file (the ledger row is deleted in the same transaction), and re-read the ledger (expected 52 / 0052).
     DATA WARNING: several rollbacks drop tables and their history (BACKUP REQUIRED: 0055, 0056, 0060, 0063, 0064, 0067, 0068, 0069, 0071, 0072, 0073, 0074, 0077). The pre-deployment snapshot is ogevia-prod-postgres-pre-0077-202610180515 (restoring it is NOT a prepared procedure).
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
The window had been opened: the cleanup above restored and verified the security group. The database may be partly migrated: see the ledger line above and the recovery section of the procedure.

== LEDGER at the moment of closing (best effort): 70 migrations applied, latest 0070

== CLEANUP: removing the temporary rule (tcp 5432 from 10.20.132.179/32 on sg-00530a1f4f7648e65) and verifying
RESTORED (verified): the temporary rule is gone and the RDS security group's complete rule set is identical to the recorded original (sha256 76e9c75367c204f0...).
```

## J. migrate refuses a snapshot that is still being created (before any access is opened)

```
================================================================
MODE                   : migrate  (TEST only, database ogevia_sv_test)
UTC time              : 2026-10-18T05:25:42Z
================================================================
account 300094796789, region us-west-2: OK

== 0. The checkout is exactly the approved candidate (read-only)

STOPPED: snapshot ogevia-prod-postgres-pre-0077-202610180515 is 'creating', not available. Wait for it to finish; nothing was changed.
No access window was opened and nothing was changed.
```

## K. migrate refuses a snapshot of another instance

```
================================================================
MODE                   : migrate  (TEST only, database ogevia_sv_test)
UTC time              : 2026-10-18T05:25:43Z
================================================================
account 300094796789, region us-west-2: OK

== 0. The checkout is exactly the approved candidate (read-only)

STOPPED: snapshot ogevia-prod-postgres-pre-0077-202610180515 belongs to 'some-other-instance', not ogevia-prod-postgres
No access window was opened and nothing was changed.
```

## L. rollback refuses a snapshot created before the release window

```
================================================================
MODE                   : rollback  (TEST only, database ogevia_sv_test)
UTC time              : 2026-10-18T05:25:50Z
================================================================
account 300094796789, region us-west-2: OK

== 0. The checkout is exactly the approved candidate (read-only)
rollback set sha256 1995e233ae085450...: OK

STOPPED: snapshot ogevia-prod-postgres-pre-0077-202610180513 was created at 2026-10-18T05:55:50.123000+00:00, outside the release window 2026-10-18T04:23:34Z to 2026-10-18T05:43:34Z (or in the future); it was not captured for this release
No access window was opened and nothing was changed.
```

## M. migrate refuses once the release window has ended

```
================================================================
MODE                   : migrate  (TEST only, database ogevia_sv_test)
UTC time              : 2026-10-18T05:25:54Z
================================================================
account 300094796789, region us-west-2: OK

== 0. The checkout is exactly the approved candidate (read-only)

STOPPED: the release window ended at 2026-10-18T04:25:54Z; migrating outside it is refused
No access window was opened and nothing was changed.
```

## N. migrate refuses when no named snapshot is given

```
================================================================
MODE                   : migrate  (TEST only, database ogevia_sv_test)
UTC time              : 2026-10-18T05:25:42Z
================================================================
account 300094796789, region us-west-2: OK

== 0. The checkout is exactly the approved candidate (read-only)

STOPPED: set OGEVIA_PREDEPLOY_SNAPSHOT_ID to the named pre-deployment snapshot (pattern ogevia-prod-postgres-pre-0077-YYYYMMDDHHMM, UTC)
No access window was opened and nothing was changed.
```

