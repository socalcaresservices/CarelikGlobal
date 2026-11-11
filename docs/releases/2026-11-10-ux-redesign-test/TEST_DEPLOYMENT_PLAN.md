# TEST deployment preparation — not executed

Current application: `f4316c5f1a9a844dc7749152243271cee003e94c`, continuing draft PR #108. Later changes in this continuation are test/release tooling and documentation. No merge, deploy, AWS migration, IAM change or production-data access has occurred.

The owner's decisions are final: CSV only (2 MB / 2,000 rows); accepted caregiver label privacy; duplicates OFF in both environments; CPR/TB is one-click, never automatically assigned to new agencies; TEST only. There is no Excel template asset to remove: both existing download templates were CSV. Excel parsing and exceljs are removed.

## Shared-instance answer

Repository records and current infrastructure configuration put TEST `ogevia_sv_test` and production `ogevia_prd` on `ogevia-prod-postgres`. This is recorded/configured state, **not a live verification**. The read-only commands in `toolchain/PHASE_C_COMMANDS.md` compare both live API Lambdas' `DB_HOST` and `DB_NAME` with actual RDS endpoints. Counting RDS instances alone does not prove which database either app uses.

**Yes, the TEST deployment can affect production availability if that shared-instance topology is still live.** Database backup/migrations use the same CPU, I/O, roles and connections; the tunnel temporarily changes the shared admin host's security groups. No planned SQL targets the production database. TEST API/web publishing uses separate stacks/bucket/distribution, verified by the script before writing. This does not remove the shared database resource risk.

Recommendation: separate TEST onto its own RDS instance first, using synthetic data only. That is a separate infrastructure decision with ongoing cost; no resource is created here. If chosen, repin the endpoint/instance/security-group expectations and rerun the gates before using the commands. The current scripts deliberately refuse a topology different from the recorded one.

## Each proposed step and its production effect

| Step | What it touches | Can affect production? |
|---|---|---|
| Live inventory | STS, stack metadata, selected Lambda configuration fields, RDS metadata | No: read-only APIs; no secret values or client records |
| Install/build/synth | Local checkout, dependencies, output templates | No: local only; no deployment |
| Capture/diff gate | TEST template/Lambda metadata, TEST web files copied to a local backup | No: reads only; no publish |
| DB probe/final | TEST SQL and shared admin-host tunnel/temporary SG attach | Yes: SQL is read-only, but the access setup changes a shared host; cleanup restores it |
| TEST logical backup | `pg_dump` of `ogevia_sv_test` only, private local dump + checksum + metadata | Yes: reads TEST only, but consumes shared instance resources and uses the shared access host |
| Apply 0090–0094 | TEST schema plus TEST migration ledger, each file in its own transaction | Yes: shared server load and cluster-wide roles; no SQL targets `ogevia_prd` |
| Deploy API | `Ogevia-prod-ServiceVerificationApi`, exactly 3 new routes and Handler asset | No direct production write: the expected-only gate rejects other changes; shared DB load remains possible |
| Publish web | TEST bucket/distribution; commit stamp | No: guard proves they differ from production before uploading |
| Verify | TEST smoke/API/UI and read-only TEST SQL | Yes for DB probes' shared-host setup and shared server load; API/web reads do not write production |
| Roll back web/API | Captured TEST web files and previous TEST API asset | No direct production write; same shared DB qualification |
| Roll back DB | TEST down scripts 0094→0090 plus removal of each matching ledger row | Yes: shared host/server load; no instance restore or production SQL |

No RDS instance snapshot is part of the proposed commands: it would include production on the shared server. The prepared DB script now refuses snapshot mode. It uses a TEST-only custom-format logical dump, checks its hash, database name and freshness (under 4 hours for apply), and refuses an overwrite. The dump is not printed. Keep the dump, `.sha256` and `.meta` files together.

## Migration ledger

The older plan intentionally kept pending migrations outside the ledger to preserve old pinned release packages. That would let later promotion reapply the same SQL. Fixed in the existing operator transaction: advisory lock → refuse an existing version → apply as `ogevia_owner` → reset role → insert version/original filename/SHA-256 → commit. A ledger failure rolls back the schema change too. Down SQL and deletion of its matching checksum row also commit together. Read-only verification now checks all five ledger checksums.

Expected ledger: before **88/0088**, after **93/0094**, after full rollback **88/0088**. 0089 was withdrawn; do not resurrect its old SQL. Future normal-runner promotion must use the identical 0090–0094 filenames/bytes and explicitly reserve the withdrawn 0089 slot while updating the contiguous-set expectations. Until then the normal runner refuses unknown UX ledger versions, so it cannot silently reapply them.

## R6 linked records

A merge only accepts an office `staff_profiles` duplicate without a sign-in or pending invitation. It cannot merge a caregiver record. Shifts, visits and client assignments refer to caregiver/user identities, not that office profile, and are neither moved nor renamed. The duplicate office profile remains in Staff as inactive. Prior audit events retain their original profile ID and actor; a new `staff.merged` event and append-only link record the reason and kept profile. Nothing is deleted or reassigned. The DB regression checks the FK boundary, unchanged caregivers, retained inactive listing and unchanged earlier audit rows. No product-code fix was needed. Merge routes stay OFF.

## Prepared commands

Exact read-only CloudShell inventory and the separate, unexecuted backup/deploy/verify/rollback sequence: `toolchain/PHASE_C_COMMANDS.md`. Updated pins: `toolchain/PINS.md`. CI and operator facts must match before a deployment could be approved. No new signature/checklist document is requested.
