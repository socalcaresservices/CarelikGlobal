# Production synthetic-data cleanup: execution plan (PREPARED, NOT EXECUTED)

Owner decision (final): remove ALL synthetic operational data from `ogevia_prd`, caregivers included. Clean slate.
Status words: **prepared** = in this folder; **tested** = said where; **executed** = nothing yet. Nothing here touches AWS, Cognito, S3 or `ogevia_sv_test`.

## What is in this folder
| File | Purpose | Test status |
|---|---|---|
| `sql/prd-synthetic-cleanup.sql` | One transaction: identity guard, count guard, lifts the 32 delete guards, deletes 64 tables children-first, removes caregiver memberships and unreferenced people, writes one audit event, verifies, restores and proves the guards, then COMMIT only with `-v do_commit=1` (default ROLLBACK) | **Tested locally** on PostgreSQL 16 with all 85 migrations: wrong database aborts; wrong count aborts; dry run changes nothing; commit empties and keeps config and audit; a failure injected after the deletes rolls everything back and leaves every guard enabled |
| `sql/prd-cleanup-readonly-counts.sql` | Read-only: every table count, the three reported totals, record dates, roles, audit actions, sign-in identities, object-store references | Tested locally (runs, read-only) |
| `scripts/f-cleanup-prd.sh` | Wrapper: runs the SQL through the EXISTING temporary database window (`window.sh`, unchanged) with typed phrases; snapshot check for commit | **Syntax-checked only. NOT mock-tested.** Must be reviewed and mock-tested before gate G1 |

## Verified facts (local schema built from migrations 0001-0085)
- 92 tables in `ogevia`: 64 emptied, 28 retained. Every `delete from` equals the computed set. No FK points from a retained table to an emptied one. No FK order violation (child deleted after parent). All 287 foreign keys are NO ACTION.
- 32 delete guards exist on the 64 tables; the script lifts exactly those 32 and re-enables exactly those 32 (catalog equality checked). 5 other delete guards are on retained tables (`audit_events`, `agency_*`, `billing_rounding_policies`) and are never touched.
- Lifting is transactional DDL: rollback or error restores them. A delete on `audit_events` is still refused after a committed cleanup.
- PostgreSQL cannot delete across databases from one connection, so statements run in an `ogevia_prd` connection cannot change `ogevia_sv_test`. The SQL additionally aborts unless `current_database() = 'ogevia_prd'`.
- **Not exercised with rows:** most of the 64 tables were empty in the local test (clients, authorizations, shifts, one visit, caregivers, memberships were populated). The order is correct by construction; the production dry run is the first run with production rows.
- After cleanup a former caregiver cannot reach any organization: every API function requires an active membership; the only code path that creates a person row is invitation acceptance (`0025:264`), and invitations are deleted.

## Gates
Each gate needs the owner's explicit approval at run time. A gate that fails stops the plan.

| Gate | Action | Changes | Approval phrase |
|---|---|---|---|
| G0 | Review this branch; mock-test `f-cleanup-prd.sh` (pattern: `infra/aws/db/test/auth-cutover-scripts.db.test.ts`) | none | - |
| G1a | AWS read-only evidence: snapshot, Cognito users, S3 inventory (commands below) | none | none (read-only) |
| G1b | `f-cleanup-prd.sh counts` | temporary /32 rule on the shared RDS group, removed and verified | `OPEN-5432-WINDOW-CLEANUP-COUNTS` |
| G2 | Fresh pre-cleanup snapshot (commands below) | billable snapshot | owner GO |
| G3 | `f-cleanup-prd.sh dryrun` | rule add/remove; brief table locks; everything rolled back | `OPEN-5432-WINDOW-CLEANUP-DRYRUN` |
| G4 | `f-cleanup-prd.sh commit` | **permanent deletion** | `OPEN-5432-WINDOW-CLEANUP-COMMIT` then `DELETE-PRD-SYNTHETIC-DATA` |
| G5 | Post-checks; then (separately approved) disable caregiver sign-ins; (separately approved) S3 orphans | see below | owner GO each |

Between G1b and G3, compare the G1b counts with 4 clients / 5 authorizations / 36 shifts. Any difference (or any table you did not expect) goes to the owner before G3.

## G1a: read-only AWS evidence (CloudShell; stops unless the account is right)
```bash
bash -euo pipefail <<'EOS'
[ "$(aws sts get-caller-identity --query Account --output text)" = "300094796789" ] || { echo "STOP: wrong account" >&2; exit 1; }
export AWS_REGION=us-west-2
echo "== SNAPSHOT (existing)"
aws rds describe-db-snapshots --db-snapshot-identifier ogevia-prod-postgres-pre-testdata-202610231702 --query 'DBSnapshots[0].[Status,SnapshotType,Encrypted,DBInstanceIdentifier,SnapshotCreateTime]' --output text
echo "== COGNITO PRODUCTION POOL USERS (kept in a private file; not printed)"
mkdir -p ~/ogevia-cleanup && chmod 700 ~/ogevia-cleanup
aws cognito-idp list-users --user-pool-id us-west-2_FHJoX71ca --output json \
 | jq -r '.Users[] | [(.Attributes[]|select(.Name=="sub")|.Value), ((.Attributes[]|select(.Name=="email")|.Value)//"(none)"), .UserStatus, (if .Enabled then "enabled" else "DISABLED" end)] | @tsv' | sort > ~/ogevia-cleanup/cognito-prd-users.tsv
chmod 600 ~/ogevia-cleanup/cognito-prd-users.tsv; echo "production-pool users: $(wc -l < ~/ogevia-cleanup/cognito-prd-users.tsv)"
echo "== S3 EVIDENCE BUCKET (metadata only; nothing deleted)"
BKT=$(aws cloudformation list-stack-resources --stack-name Ogevia-prd-EvidenceStorage --query "StackResourceSummaries[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId" --output text); echo "buckets: $BKT"
for b in $BKT; do
  echo "-- $b versioning: $(aws s3api get-bucket-versioning --bucket "$b" --query Status --output text)"
  aws s3api list-object-versions --bucket "$b" --output json > ~/ogevia-cleanup/s3-versions-$b.json
  jq -r '[(.Versions//[])[]] as $v | "versions: \($v|length), delete markers: \((.DeleteMarkers//[])|length), bytes: \($v|map(.Size)|add // 0), branding (kept): \($v|map(select(.Key|test("/branding/")))|length), other: \($v|map(select(.Key|test("/branding/")|not))|length)"' ~/ogevia-cleanup/s3-versions-$b.json
  jq -r '(.Versions//[])[] | select(.Key|test("/branding/")|not) | [.Key,.VersionId] | @tsv' ~/ogevia-cleanup/s3-versions-$b.json | sort > ~/ogevia-cleanup/s3-evidence-$b.tsv
done
echo DONE_READ_ONLY
EOS
```
Then compare the S3 key list with the database references from `counts` section E:
`comm -13 <(cut -f2,3 db-keys.tsv | sort) <(cut -f1 s3-evidence-<bucket>.tsv | sort)` shows objects with no database row (already orphaned). Object keys are UUID paths; they contain no names.

## G1b: identify caregiver sign-ins (join; output stays private)
`counts` mode section D prints `cognito_sub, role, membership_status, person_status, has_caregiver_record` (saved to `~/ogevia-prd-before/cleanup/counts-*.txt`, mode 600). Join it with the Cognito file:
```bash
F=$(ls -t ~/ogevia-prd-before/cleanup/counts-*.txt | head -1)
grep -P '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\t' "$F" | sort > ~/ogevia-cleanup/db-people.tsv
join -t $'\t' -1 1 -2 1 ~/ogevia-cleanup/db-people.tsv ~/ogevia-cleanup/cognito-prd-users.tsv     # sub, role, ..., email, status, enabled
```
Every row with role `caregiver` (or `has_caregiver_record = t`) is a caregiver sign-in. Rows in Cognito with no database row are sign-ins with no Ogevia access today.

## How access is prevented after cleanup
1. **Already enforced by the product (VERIFIED in code, not yet tested live):** no membership means no organization context; no invitation means no new person row. This is the control that matters.
2. **Defence in depth, only on a separate owner GO after G4:** disable (not delete) each caregiver sign-in in the production pool so they cannot authenticate at all. Disable keeps the account recoverable:
   `aws cognito-idp admin-disable-user --user-pool-id us-west-2_FHJoX71ca --username <sub>` once per caregiver `sub` from the join above. **Do not run until approved.** The shared demo pool is not part of this.

## G2: fresh pre-cleanup snapshot (YELLOW, billable; run only on the owner's GO)
The existing `ogevia-prod-postgres-pre-testdata-202610231702` is not accepted by `c1-snapshot-prd.sh` (it requires the `pre-prdrelease-` name) and is older than the data it would need to restore. Take a new one at most 2 hours before G4 (the wrapper enforces this name and age):
```bash
SNAP=ogevia-prod-postgres-pre-cleanup-$(date -u +%Y%m%d%H%M)
aws rds create-db-snapshot --db-instance-identifier ogevia-prod-postgres --db-snapshot-identifier "$SNAP" --tags Key=purpose,Value=pre-cleanup Key=approval,Value="$OGEVIA_DEPLOY_APPROVAL"
aws rds wait db-snapshot-available --db-snapshot-identifier "$SNAP"
aws rds describe-db-snapshots --db-snapshot-identifier "$SNAP" --query 'DBSnapshots[0].[Status,SnapshotType,Encrypted,DBInstanceIdentifier]' --output text
export OGEVIA_CLEANUP_SNAPSHOT_ID="$SNAP"
```
The snapshot covers the whole instance (including `ogevia_sv_test`). Restoring creates a NEW instance, not an in-place rollback (`docs/releases/2026-10-19-test-rehearsal/SNAPSHOT_RESTORE_ISOLATED_e80b770.md`: documented, not proven against real RDS).

## G3 / G4 commands
```bash
cd docs/releases/2026-10-25-prd-cleanup/scripts
OGEVIA_DEPLOY_APPROVAL=<ref> bash f-cleanup-prd.sh counts
OGEVIA_DEPLOY_APPROVAL=<ref> OGEVIA_CLEANUP_EXPECT_CLIENTS=<n> OGEVIA_CLEANUP_EXPECT_AUTHS=<n> OGEVIA_CLEANUP_EXPECT_SHIFTS=<n> bash f-cleanup-prd.sh dryrun
OGEVIA_DEPLOY_APPROVAL=<ref> OGEVIA_CLEANUP_EXPECT_CLIENTS=<n> OGEVIA_CLEANUP_EXPECT_AUTHS=<n> OGEVIA_CLEANUP_EXPECT_SHIFTS=<n> OGEVIA_CLEANUP_SNAPSHOT_ID=$SNAP bash f-cleanup-prd.sh commit
bash f-cleanup-prd.sh --restore-only      # only after an interrupted run
```

## G5: post-cleanup verification
Run `f-cleanup-prd.sh counts` again. Expect: only these tables non-empty: `organizations`, `app_users`, `organization_memberships` (non-caregiver), `permissions`, `role_permissions`, `services`, the agency/organization settings and policy tables, reference data, and `audit_events` (= before + 1, including `platform.synthetic_data_cleanup`); zero guards not enabled; the organization logo reference still present. S3 objects are untouched and now unreferenced: decide separately (the bucket is versioned; deleting is irreversible without versions).

## Remaining risks (not closed)
- Wrapper untested (G0). Lifting the 32 guards overrides immutability controls by design, once, inside a verified transaction. Rows in most tables were not exercised locally. Counts may differ from 4/5/36. The compliance sweep (15-minute rule) could add rows during a run; verification would fail and roll back. S3 evidence stays orphaned until separately approved. Cognito caregiver sign-ins stay until separately approved. Whether a former caregiver's sign-in behaves as expected after cleanup is UNVERIFIED live.
