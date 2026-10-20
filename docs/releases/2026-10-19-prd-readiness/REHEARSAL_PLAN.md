# Rehearsal plan: upgrade a copy of ogevia_prd from 0046 to 0085

Designed 2026-10-20. **Design only: nothing here has been run, no AWS change has been made, and no step is approved.** Every YELLOW or RED step needs the owner's explicit approval at the time it is run.
Evidence classes: REPO (read from this repository), OWNER-AWS (owner-reported from CloudShell), UNKNOWN (must be established in R0).

## 1. Purpose and what it must prove
Production (`ogevia_prd`) is at 46 / 0046 (OWNER-AWS); the accepted TEST release is 85 / 0085. The static reviews (`MIGRATION_REVIEW_*`) found no migration-time data loss but could not test the upgrade. The rehearsal applies 0047-0085 to a **restored copy** and proves, with evidence:

| # | Claim | Pass condition |
|---|---|---|
| C1 | A snapshot of the shared instance restores to a new instance | New instance `available`, same engine/encryption/privacy, `ogevia_prd` present at 46 / 0046 |
| C2 | The 39 migrations apply cleanly to production-shaped data | Ledger 85 / 0085; every applied file's checksum equals the package manifest; no error; 0061's duplicate guard passes |
| C3 | The result is the TEST schema | Schema-only comparison of the copy's `ogevia_prd` against `ogevia_sv_test` shows no difference (or each difference explained) |
| C4 | Existing data is untouched | Per-table row counts and content hashes before and after are identical for every table that existed at 0046, except the rows the migrations are documented to add (permission rows 0048/0055/0069, policy row 0060) |
| C5 | The repository's verification set passes | `infra/aws/db/verification/01-08` all pass on the copy |
| C6 | Duration is known | Per-file and total migration time recorded, to size the production window |
| C7 | (Optional) rollback works | `db:rollback-to 0047` returns the copy to 46 / 0046 and the fingerprint equals the R3 baseline except the 11 availability-override objects the 0047 down script keeps by design |

Non-goals: no change to production (`ogevia-prod-postgres`), the shared security group `sg-00530a1f4f7648e65`, any `Ogevia-prd-*` or `Ogevia-prod-*` stack, TEST, Cognito, DNS, or any deploy.

## 2. Design decisions
| Decision | Choice | Why |
|---|---|---|
| Where the copy lives | A **new RDS instance restored from a fresh manual snapshot**, never the production instance | The only way to test without touching production; the production instance is shared with TEST, so any in-place trial would risk both |
| Network | New dedicated security group for the copy: tcp 5432 only from the admin host's own IP as /32; private, not publicly accessible; same VPC and subnet group | **Avoids touching the shared RDS security group at all.** Creating a security group and instance are YELLOW actions |
| Encryption and size | Same KMS encryption and the same instance class (db.t4g.micro) | Timing and behavior comparable; encryption is a security control that must not be weakened |
| Data handling | Treat the copy as production data. Output only counts, hashes, timings and object names; never row contents. No exports off the admin host. | Production may hold PHI (unverified); `CLAUDE.md` s.8 |
| Runner | The same pinned migration runner and file set as TEST (`infra/aws/db/scripts/migrate.ts`: one transaction per file, SHA-256 ledger, advisory lock, refuses drift), run from the admin host through an SSM tunnel to the copy. The runner refuses non-local targets unless `OGEVIA_ALLOW_REMOTE_MIGRATION=approved-by-owner`, so that variable is set deliberately for the copy only | Rehearse the exact mechanism that production will use |
| Order | Migrations only. The API and web are NOT deployed against the copy | See R7 residual risk |
| Lifetime | Delete the copy when done (RED action, separate explicit instruction naming the exact identifier) | Cost and data exposure |
| Naming | Snapshot `ogevia-prod-postgres-pre-rehearsal-YYYYMMDDHHMM`; instance `ogevia-prd-rehearsal-YYYYMMDD`; tag `purpose=rehearsal-delete-after` | The name must make a mistaken target impossible |

Cost (REPO: `docs/aws/COST_MODEL.md` lists db.t4g.micro on-demand at $0.022/hour): about $0.53 per day of instance time (0.022 x 24). Storage and snapshot charges are NOT computed here; compute them from the live allocated size in R0. Treat all as needing owner approval before creation (`CLAUDE.md` s.11).

## 3. Phases
| Phase | Action | Class | Evidence produced | Stop condition |
|---|---|---|---|---|
| R0 | Establish unknowns, read-only: allocated storage and KMS key of `ogevia-prod-postgres`; subnet group and parameter group; whether the restored instance can use the source master credential or needs a new password (restore behaviour of the RDS-managed secret: confirm against AWS documentation before R2, NOT verified); whether `pg_dump` and `psql` exist on the admin host; admin host outbound reachability to a new security group; non-PHI row counts of `ogevia_prd` (organizations, users, clients, shifts, visits); build the production rehearsal package pinned to commit e80b770 and the 0047-0085 set hash | Read-only (row counts need a read script and the temporary rule: separate approval) | R0 record with every answer | Any unknown unresolved |
| R1 | Take a fresh named manual snapshot of `ogevia-prod-postgres`; verify available, manual, encrypted, created inside the window (reuse `snapshot-verify.sh`) | YELLOW | Snapshot id | Not available / not encrypted |
| R2 | Create the dedicated security group; restore the snapshot to `ogevia-prd-rehearsal-<date>` (private, same class, encrypted, deletion protection off, tagged); wait until available; verify | YELLOW (cost) | Instance description | Public, unencrypted, wrong class, shares the production security group |
| R3 | Baseline on the copy (read-only): databases present, ledger summary and the list of (version, checksum) rows, database size, per-table row counts and content hash for every table, counts of functions/triggers/policies/indexes; connection proven read-only and to the copy's endpoint (never the production endpoint) | Read-only on the copy | `baseline.txt` | Ledger is not 46 / 0046 |
| R4 | Apply 0047-0085 to `ogevia_prd` on the copy with the pinned runner; record start/end per file and total; stop at the first error; applied files are never edited (fix forward only) | Mutates the copy only | `migrate.log`, timings | Any error: stop, record, do not retry blindly |
| R5 | Verify: ledger 85 / 0085 and file checksums equal the manifest; run `infra/aws/db/verification/01-08`; schema-only dump of the copy's `ogevia_prd` versus TEST's `ogevia_sv_test` (normalized), differences listed; per-table row counts and hashes versus R3 (C4); object counts versus TEST | Read-only on the copy and on TEST (TEST read uses its own approved window) | `verify.txt`, `schema-diff.txt` | Any unexplained difference |
| R6 | Optional rollback rehearsal. First review the 39+ down scripts in `infra/aws/db/rollback/` (reviewed: `ROLLBACK_SCRIPTS_REVIEW_0047_0085.md`: 26 SAFE AUTOMATED, 13 BACKUP REQUIRED; down scripts do not remove ledger rows, the runner does; no runner exists for 0085 down to 0047 and one must be written; **built 2026-10-20**: `infra/aws/db/scripts/rollback-range.ts` + `rollback-to.ts`, tested locally 9 of 9; the rollback is expected to leave 11 availability-override objects in place by design). Then run them 0085 down to 0047 on the copy and compare to R3 | Mutates the copy only | `rollback.log`, comparison | A down script that cannot be explained |
| R7 | Window sizing: total migration time + API deploy (TEST measured: CDK deploy 46 s, 89.8 s total) + web publish + CloudFront settle (60 s used on TEST) + smoke. Output the minimum quiet window and the exact order | Document | Window recommendation | |
| R8 | Teardown: delete the rehearsal instance, its security group, and (owner's choice) the rehearsal snapshot; verify none remain; keep the evidence files | **RED**: needs a separate instruction naming the exact identifiers | Deletion record | The identifier is not the rehearsal instance |

## 4. Residual risk the rehearsal does not remove
- **API compatibility is not tested.** The copy has no application; the old API's behaviour during the migration-to-deploy gap (35 dropped functions, including the caregiver start and confirm functions in 0050) is known from reading, not from running. Mitigation: schema parity with TEST (C3) plus TEST's accepted workflow results; and the production run must go migrations, then API, then web without pause in a window with no users. Optional, not recommended: deploy a temporary API stack against the copy (extra cost and exposure).
- The copy proves behaviour on **today's** production data. If production data changes before the real run, the real run's pre-checks (ledger exactly 46 / 0046, the 0061 guard, a fresh snapshot) must still pass.
- Row counts may show production has no tenant data; then C4 is trivially met and the rehearsal mostly proves the mechanics, the schema parity and the timing. That is still worth knowing before the real window.

## 5. Open decisions for the owner (recommended defaults)
1. Run the optional rollback rehearsal (R6)? Recommended yes, after the down scripts are reviewed.
2. Keep the rehearsal snapshot after teardown? Recommended: delete both instance and snapshot within 7 days of use.
3. Approve a read of non-PHI row counts of `ogevia_prd` (R0)? Recommended yes; it decides whether C4 is meaningful.
4. Who signs the restore and deletion approvals, and the target dates? Not set.

## 6. Deliverables to build before R1 (all GREEN, local, nothing deployed)
Production rehearsal package (one tarball with checksum, same pattern as `ogevia-prd-ledger-read.tar.gz`) containing: pin check for commit e80b770 and the 0047-0085 set hash; snapshot-verify (reused); restore-and-verify script (describe-only checks plus the YELLOW create steps behind typed phrases); baseline, migrate, verify and compare scripts that refuse any host except the rehearsal endpoint; mock tests for each; and a README with the stop rules. Tests use mocks only; nothing touches AWS until the owner runs it.

## 7. Package built and tested locally (2026-10-20)
Source: `docs/releases/2026-10-19-prd-readiness/rehearsal/` (scripts, SQL, README template, `build-package.sh`); tests `infra/aws/db/test/prd-rehearsal.db.test.ts` with `prd-rehearsal-aws-mock.sh` and `prd-rehearsal-proxy.cjs`. Package: `docs/releases/2026-10-19-prd-readiness/package/ogevia-prd-rehearsal.tar.gz` (reproducible; BUILD_INFO and MANIFEST inside; the README carries the two pinned set hashes).
Scripts: R0 preflight (read-only, also checks the CLI knows the 11 restore parameters), R1 snapshot, R2 restore (own security group, own tag, never the shared group), R3 baseline, R4 migrate (psql, same semantics as the runner, resume), R5 verify (ledger checksums, the repository verification set, schema parity with the copy of TEST, existing data unchanged), R6 rollback (optional), R8 teardown (RED, plan first).
Tests (14, all passing on PostgreSQL 16 with a mocked aws): package manifest and counts; R0 read-only; R1 window, phrase, wrong instance, unencrypted; R2 own group, no production change, endpoint and tag guards; R3 login failure, baseline, drift detection; R4 hash, tamper, phrase and resume refusals, failure at 0050 leaves the ledger at 0049 and `--resume` finishes; psql-applied schema equals the repository runner's (all keys and digests) and the SQL fingerprint equals the TypeScript one; R5 pass and detection of a changed row count and an extra column; R6 hash and phrase refusals and a full rollback to 46|0046 with the schema equal to the baseline except the 11 kept objects; R8 plan, tag and phrase refusals, deletion only of the tagged copy and its group; across the run no call touched production, the shared security group, or any service outside rds/ec2/ssm/secretsmanager/sts.
Defects the tests caught and fixed: the master-secret ARN check rejected `!` (RDS-managed secret ARNs look like `rds!db-...`).
NOT verified: any AWS run; the master credential on a restored copy; the fingerprint SQL on PostgreSQL 18.3; password rejection (the sandbox accepts any password); eslint of the new TypeScript and shell files.

## 8. R0 preflight result (OWNER-PASTED RAW OUTPUT, 2026-10-20 01:22Z)
Package verified in CloudShell first: tarball sha256 `ce4bf51c...a2b8` matched, `MANIFEST OK`, BUILD_INFO source commit `20835646...` tree clean. R0 then printed `R0 PASSED ... Nothing was changed.`
| Fact | Value |
|---|---|
| Account / region | 300094796789, us-west-2 |
| Production instance | `ogevia-prod-postgres`: db.t4g.micro, PostgreSQL 18.3, 20 GB gp3, single-AZ, subnet group `ogevia-prod-data-layer-dbsubnetgroup-brcfuj6jmuzg`, parameter group `default.postgres18` |
| Preconditions checked by the script | available, not public, encrypted, only security group `sg-00530a1f4f7648e65` (all passed; the script stops otherwise) |
| Admin host | `i-0ce8db2d7e5839dd5` at 10.20.132.179 in `vpc-0ee9df0c38297cbc1`, one interface, one private IP, same VPC as the database |
| Manual snapshots of the instance | **11** |
| Leftover rehearsal instances | none reported |
| AWS CLI | knows all 11 restore parameters the package uses (the flags are now checked against the live CLI) |
| Cost | 0.528 USD per day of instance time at the cost-model rate; 20 GB storage and snapshot charges not computed (pricing not checked) |
Correction: the 2026-10-19 inventory summary listed four manual snapshots and led to blocker B10 ("no `pre-prd` snapshot recorded"). R0 counts eleven. The earlier summary was incomplete, so B10 is NOT established either way until the eleven snapshot names are listed.
Still unknown before R2: whether the restored copy accepts the source master credential; the live storage/snapshot prices; the release window for R1.

## 9. Snapshot listing (OWNER-PASTED RAW OUTPUT, 2026-10-20; INCOMPLETE)
The paste shows five rows and ends at a pager prompt (`:`), so six of the eleven manual snapshots counted by R0 were not seen. All five seen are `available` and encrypted:
| Snapshot | Created (UTC) |
|---|---|
| `ogevia-prod-postgres-pre-0085-202610192111` | 2026-10-19 21:11:34 |
| `ogevia-prod-postgres-pre-0085-202610190330` | 2026-10-19 03:30:19 |
| `ogevia-prod-postgres-pre-0077-202610180858` | 2026-10-18 08:58:34 |
| `ogevia-prod-postgres-pre-0052-20261015` | 2026-10-15 01:41:18 |
| `ogevia-prod-postgres-pre-prd-20261010` | 2026-10-10 05:44:48 |
Blocker B10 as first written ("no `pre-prd` snapshot recorded") was wrong: `ogevia-prod-postgres-pre-prd-20261010` exists. It was taken 2026-10-10 05:44Z, before the production secret (06:00Z) and Lambda (06:11Z) were created, so it is the anchor of the original production deployment, not a pre-upgrade anchor for the current state; it is ten days old. It is not a substitute for the fresh snapshot R1 takes. The other six snapshots are not yet seen.

## 10. Full snapshot listing (OWNER-PASTED RAW OUTPUT, 2026-10-20) - completes section 9
Eleven manual snapshots of `ogevia-prod-postgres`, matching the count R0 reported (sorted newest first):
| Snapshot | Created (UTC) |
|---|---|
| `ogevia-prod-postgres-pre-0085-202610192111` | 2026-10-19 21:11:34 |
| `ogevia-prod-postgres-pre-0085-202610190330` | 2026-10-19 03:30:19 |
| `ogevia-prod-postgres-pre-0077-202610180858` | 2026-10-18 08:58:34 |
| `ogevia-prod-postgres-pre-0052-20261015` | 2026-10-15 01:41:18 |
| `ogevia-prod-postgres-pre-prd-20261010` | 2026-10-10 05:44:48 |
| `ogevia-prod-postgres-pre-prd-20261008` | 2026-10-08 19:29:51 |
| `ogevia-prod-postgres-pre-0036-20261005` | 2026-10-05 09:49:08 |
| `ogevia-prod-postgres-pre-0026-20261005` | 2026-10-05 02:51:02 |
| `ogevia-prod-postgres-at-0021-v2-20261005` | 2026-10-05 00:20:27 |
| `ogevia-prod-postgres-pre-0021-20261004` | 2026-10-04 23:09:11 |
| `ogevia-prod-postgres-pre-pilot-20261004` | 2026-10-04 00:10:51 |
(Encryption and status were shown only for the first five in the earlier paste: all available and encrypted. The remaining six were not shown with those columns; R1 verifies only the snapshot it creates.)
Findings: there are two `pre-prd` snapshots (2026-10-08 and 2026-10-10), both taken before production was created, neither of the current state. No snapshot is named `pre-rehearsal`, so the rehearsal naming `ogevia-prod-postgres-pre-rehearsal-YYYYMMDDHHMM` cannot clash. Eleven manual snapshots of a 20 GB instance are accumulating storage charges; a retention rule for them is an owner decision (deleting any is a RED action and is not proposed here). B10 stands as re-stated: a fresh snapshot of the current production state is required and does not yet exist.

## 11. R1 result (OWNER-REPORTED SUMMARY, 2026-10-20)
`r1-snapshot.sh create` run in CloudShell with the window 10 minutes before to 2 hours after the run (computed by the shell). Reported: snapshot `ogevia-prod-postgres-pre-rehearsal-202610200131`, status available, instance `ogevia-prod-postgres`, type manual, encrypted true, created 2026-10-20T01:32:01Z, `SNAPSHOT VERIFIED`. The script's own checks (status, instance, type, encryption, creation inside the window and not in the future) all passed. The owner pasted a summary, not the raw output; the snapshot id is recorded in the CloudShell state file (`~/ogevia-prd-rehearsal/state.env`, SNAP_ID).
Scope of the copy it will produce: the state of the SHARED instance at about 01:32Z on 2026-10-20 (both `ogevia_prd`, expected at 46/0046 per the 2026-10-20 ledger read, and `ogevia_sv_test` at 85/0085). It is the rehearsal source only, not the production rollback anchor for a real window.
Next gate: R2 restore (YELLOW, creates a security group, one ingress rule on it, and an RDS instance that costs money until deleted): needs the owner's explicit approval and the typed phrase `RESTORE-ogevia-prd-rehearsal-YYYYMMDD` (UTC date of the run).

## 12. R1 raw output seen; R2 not yet run (2026-10-20)
The owner's CloudShell scroll-back contained the raw R1 run: window `2026-10-20T01:21:32Z .. 03:31:32Z`, `SNAPSHOT-NOW` typed, `SNAPSHOT VERIFIED: ogevia-prod-postgres-pre-rehearsal-202610200131` (status=available, instance=ogevia-prod-postgres, type=manual, created 2026-10-20T01:32:01.153Z, encrypted=true). This replaces the summary in section 11 as the evidence. The same scroll-back also showed the older snapshots with status `available` and encryption `True` for pre-0036, pre-0026, at-0021-v2, pre-0021 and pre-pilot.
It also showed `r2-restore.sh verify` and `r8-teardown.sh plan` both answering "no rehearsal instance recorded in state.env". That means the R2 `restore` command had NOT been run (the state file records the rehearsal id only after the confirmation phrase is typed). The state file cannot show whether AWS holds a rehearsal instance or group by itself; a direct read-only list is needed to confirm none exists.

## 13. R2 result (OWNER-REPORTED SUMMARY, 2026-10-20)
`r2-restore.sh restore` run in CloudShell with the typed phrase. Reported: security group `sg-02430ba691bb25ea6` created; instance `ogevia-prd-rehearsal-20261020` status available, class db.t4g.micro, not public, encrypted; `RESTORE VERIFIED ... production untouched`. The script's own checks (own security group only, KMS key equal to production's, endpoint different from production's, tag purpose=rehearsal-delete-after, single-AZ) are part of that verdict. The owner pasted a summary, not the raw output.
**From this point a billed copy of production data exists** (about 0.53 USD per day of instance time plus storage). It must be deleted with R8 when the rehearsal ends. Next: R3 baseline (read-only); it also answers whether the copy accepts the source master credential.

## 14. R3 baseline result (OWNER-PASTED RAW OUTPUT, 2026-10-20 02:18Z)
`r3-baseline.sh` on `ogevia-prd-rehearsal-20261020` (endpoint `ogevia-prd-rehearsal-20261020.c50cageec7mv.us-west-2.rds.amazonaws.com`), tunnel via admin host `i-0ce8db2d7e5839dd5` on 127.0.0.1:15441. Read-only session.
| Fact | Value |
|---|---|
| Login with the source master credential | **Accepted.** The open question from R0/R2 is answered: the restored copy accepts it. |
| Databases on the copy | `ogevia_prd`, `ogevia_sv_test` |
| `ogevia_prd` ledger | 46 migrations applied, latest 0046 (confirms the production ledger read) |
| Ledger checksums 0001-0046 | equal the repository's files (no drift: the real runner would not refuse) |
| `ogevia_prd` size | 14 MB |
| Fingerprint of `ogevia_prd` | 2307 keys; 28 of 62 `ogevia` tables non-empty; **448 rows in total** |
| Fingerprint of `ogevia_sv_test` (copy of TEST) | 3375 keys; ledger 85|0085 |
| Result | `BASELINE RECORDED ... Nothing was changed.` |
448 rows in 28 tables is small and is consistent with seed and reference data plus little or no tenant data. That is INFERRED, not verified: the per-table counts are in `~/ogevia-prd-rehearsal/baseline-fp.tsv` on the owner's CloudShell and can be read from that file without any new database access.

## 15. R2 and R4 raw output seen (OWNER-PASTED, 2026-10-20)
R2 raw output: plan as designed (own group `ogevia-prd-rehearsal-20261020-sg` in `vpc-0ee9df0c38297cbc1`, tcp 5432 from `10.20.132.179/32` on that group only, restore of `ogevia-prod-postgres-pre-rehearsal-202610200131` to `ogevia-prd-rehearsal-20261020`, db.t4g.micro, subnet group `ogevia-prod-data-layer-dbsubnetgroup-brcfuj6jmuzg`, parameter group `default.postgres18`, private, single-AZ, deletion protection off), phrase typed, `created sg-02430ba691bb25ea6`, `status=available class=db.t4g.micro public=false encrypted=true`, `RESTORE VERIFIED ... production untouched`. This replaces the summary in section 13.
R4 raw output (mutates the copy only): the phrase `MIGRATE-ogevia-prd-rehearsal-20261020` was typed; 39 migrations 0047-0085 applied one transaction each with no error; `ledger after: 85 migrations applied, latest 0085; total 11 s`; `MIGRATED`. Per-file times: sum 9678 ms, mean 248 ms, slowest 0074 (630 ms), 0055 (598 ms), 0054 (529 ms), 0053 (525 ms). (One earlier attempt in the owner's shell used a command with a trailing dot and failed with "No such file"; nothing ran.)
Consequences: the 0061 duplicate-shift guard passed on this data; no migration failed; the whole 39-file upgrade of a 14 MB database took 11 seconds on a db.t4g.micro. Window sizing input (R7): migration about 11 s; the TEST API deploy took 46 s (CDK deployment 46.07 s, 89.81 s total); the old production API cannot start or confirm a visit (0050 drops those functions) between the end of the migration and the end of the API deploy, so the compatibility gap is roughly 1 to 2 minutes plus the web publish, if the steps run back to back. Real production timings will depend on its data at the time.
Next: R5 verify (read-only on the copy), which has not run yet.

## 16. R5 verification result (OWNER-PASTED RAW OUTPUT, 2026-10-20)
`r5-verify.sh` on the migrated copy (read-only session): `VERIFIED: the copy passes C2-C5.`
| Check | Result |
|---|---|
| Ledger | 85|0085 |
| C2: ledger checksums | all 85 equal the repository's files |
| C5: repository verification set | 01_schema_version 3 rows, 02_required_objects 95, 03_constraints_indexes 26, 04_roles_grants 9, 05_tenant_boundaries 11, 06_authorization_invariants 6, 07_visit_invariants 11, 08_release_objects 214: 375 check rows, none failed |
| C3: schema parity with the copy of TEST (`ogevia_sv_test`) | 3283 schema keys compared; 0 differences |
| C4: existing data | 62 tables compared; 0 problems (row counts and content unchanged, except permission rows the migrations add) |
Claims C1, C2, C3, C4, C5 and C6 are now supported by raw output on the restored copy: C1 restore (R2/R3), C2 (R4/R5), C3 and C5 (R5), C4 (R5), C6 duration (R4: 11 s). C7 (rollback) has not been run.
What this does NOT establish: API compatibility during the migration-to-deploy gap (no application ran against the copy); behavior with real tenant data (the copy holds 448 rows in 28 tables, so C4 is satisfied but is a weak test of data preservation; the per-table counts that would show whether any tenant data exists are still unread); the production run itself (different moment, different data); the BACKUP REQUIRED rollback scripts with data.

## 17. Per-table counts from the baseline file (OWNER-PASTED, 2026-10-20): CORRECTION of earlier inferences
Read from `~/ogevia-prd-rehearsal/baseline-fp.tsv` (a local file; counts only; the copy was taken from the snapshot of 2026-10-20 01:32Z). The owner pasted 8 of the 28 non-empty tables:
| Table | Rows |
|---|---|
| `ogevia.organizations` | 1 |
| `ogevia.app_users` | 5 |
| `ogevia.organization_memberships` | 5 |
| `ogevia.clients` | 4 |
| `ogevia.client_authorizations` | 5 |
| `ogevia.caregiver_records` | 4 |
| `ogevia.shifts` | 36 |
| `ogevia.audit_events` | 89 |
These eight tables hold 149 of the 448 rows; the other 20 non-empty tables were not pasted.
**Corrections.** (1) Section 14 inferred "little or no tenant data" and the readiness plan (sections 11, 23) read "enforcement activated for 0 of 0 agencies" as suggesting no tenant: both inferences are WRONG. Production holds one organization with users, clients, caregivers, authorizations, shifts and an audit trail. "0 of 0 agencies" counts rows of the readiness-settings table, not organizations; that table is empty. (2) Section 4's remark that C4 would be "trivially met" does not apply: the data-unchanged check ran against real rows (see below).
**Not established:** whether these rows are real people and real service records or synthetic acceptance-test data. The production configuration says "real data only here" and the production deployment documents describe creating labelled synthetic records for smoke tests; 4 clients, 4 caregivers, 36 shifts and 89 audit events could be either. Until the owner states which, the copy and its fingerprint files are to be treated as production data that may contain PHI.
**Effect on what the rehearsal proves.** R5's C4 (62 tables, 0 problems) now has weight: the 1 organization, 5 users, 5 memberships, 4 clients, 5 authorizations, 4 caregivers, 36 shifts and 89 audit events survived the 39 migrations with unchanged counts, and unchanged content for every table whose columns the migrations did not change (for tables that gained columns, such as `shifts`, only the count is compared). It is still a small data set and a snapshot of one moment.
**Effect on the production window.** There is at least one existing organization with 5 user accounts. During the migration-to-API-deploy gap (estimated 1-2 minutes) the old API cannot start an unscheduled visit or confirm a visit; the window must be agreed with those users, with no visit in progress and no confirmation pending. Pre-window checks to add: no open (started, not ended) visit; no shift starting inside the window; a fresh snapshot (B10) at the window start.
**Effect on R6.** Rolling back now acts on a copy that has real rows in the tables the old schema had; the new tables are empty, so the guards should not trigger, but the 13 BACKUP REQUIRED scripts and the down scripts that touch existing tables are exercised against real rows for the first time. R6 remains optional and recommended.
**Effect on the copy.** It holds production data that may be PHI. Keep its life short, export nothing, and delete the baseline and fingerprint files in `~/ogevia-prd-rehearsal/` and `~/prd-rehearsal-pkg/` together with the copy (R8). The fingerprint files contain md5 digests of whole tables, not values.

## 18. OWNER-CONFIRMED (2026-10-20): all existing production records are fake/synthetic test data
Stated by the owner in the session; not independently verified by the engineer (the engineer cannot tell synthetic from real rows from counts). It resolves the question left open in section 17.
Instructions recorded with it: preserve the existing records during testing; run R6 on the verified, isolated rehearsal copy only; report the results; **this does not authorise a production deployment or any change to the live database.**
Effects: (1) the rehearsal copy is owner-confirmed synthetic data, so the PHI concern in section 17 is withdrawn for the existing rows; the conservative handling is kept anyway (short life, no exports, files deleted with the copy). (2) The operational concern in section 17 (existing real users affected by the compatibility gap) is withdrawn for the existing accounts; the window checks stay (open visits, shifts in the window, fresh snapshot) because the accounts and records are the ones the owner tests with. (3) "Preserve them" is satisfied by design: the rehearsal acts on a restored copy, the production instance is never written to, and the existing production rows were unchanged by R1-R5 (a snapshot and a copy only).
This does not change the readiness verdict: first real customer data and the BAA/security gates (MFA sign-in, tenant isolation, signature storage on production) remain separate gates.
