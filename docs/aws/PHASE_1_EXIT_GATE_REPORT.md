# PHASE 1 EXIT GATE REPORT — Establish AWS CDK Source of Truth

**Date:** 2026-10-01 · **Branch:** `claude/phase1-cdk-source-of-truth` (based on `claude/phase0-aws-inventory` @ `449b04f`)
**Code baseline for this report:** `11ca406` (the final SHA is in the commit that adds this file)
**AWS changes:** **NONE.** No bootstrap, deploy, import, change set, IAM, budget, Cognito, RDS or SG change.
**Identity used:** `arn:aws:sts::300094796789:assumed-role/AWSReservedSSO_ReadOnlyAccess_81b69eeb2d067541/ogevia-admin`

## Verdict: PHASE 1: PASS

Every Phase 1 requirement was executed with code, tests, synth and a template-only diff. No AWS resource was created, modified, replaced or deleted. The open items below are **Phase 3/4 decision gates, not Phase 1 failures**.

## 1. Stack architecture

| Stack                                 | Kind      | Planned phase | Resources |
| ------------------------------------- | --------- | ------------- | --------- |
| (none) `ExistingFoundation` construct | REFERENCE | n/a           | 0         |
| `Ogevia-prod-EvidenceStorage`         | FUTURE    | 5             | 6         |
| `Ogevia-prod-ServiceVerificationApi`  | FUTURE    | 4             | 25        |
| `Ogevia-prod-Observability`           | FUTURE    | 4/7           | 8         |

Plus 3 `AWS::CDK::Metadata` resources, for 42 in total. See `PHASE_1_CDK_ARCHITECTURE.md`, `PHASE_1_RESOURCE_OWNERSHIP.md` and `PHASE_1_SYNTH_INVENTORY.md` (generated).

## 2. Quality gate (all run on this branch)

| Check                                                          | Result                                                                                                                                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                                                    | PASS (5/5 tasks)                                                                                                                                                                                   |
| `pnpm typecheck`                                               | PASS (6/6 tasks)                                                                                                                                                                                   |
| `pnpm test`                                                    | PASS: web 473, shared 118, ui 73, auth 10, **infra-aws 53**; 727 tests total                                                                                                                       |
| `pnpm build`                                                   | PASS (5/5 tasks)                                                                                                                                                                                   |
| infra typecheck / tests / cdk-nag                              | PASS (0 unacknowledged AwsSolutions and HIPAA Security findings; every acknowledgement has a written reason)                                                                                       |
| `cdk synth -c env=prod -c mode=plan`                           | PASS (3 templates, no warnings, no `cdk.context.json` created)                                                                                                                                     |
| Template scanner over `cdk.out`                                | PASS (0 violations)                                                                                                                                                                                |
| `cdk diff --method=template --lookups=false` (ogevia-readonly) | RAN: 3 stacks, additions only (`[+]`), **0 `[-]`, 0 `[~]`**. The CLI's attempt to assume the bootstrap lookup role failed (account not bootstrapped) and it fell back to the read-only credentials |

## 3. Duplicate / replacement / deletion analysis

- The synthesized templates contain **0** VPC, subnet, NAT, route, endpoint, SG, SG-rule, EC2, RDS instance/cluster/subnet-group, Cognito pool or Secrets Manager resources. Both a test and the scanner enforce this.
- None of the 3 CDK stack names matches the only existing stack, `ogevia-prod-data-layer`. No CDK resource sets a physical name that matches an existing resource. The only deterministic name is the new signature bucket, which `list-buckets` shows doesn't exist.
- Existing CloudFormation-owned SGs are referenced with `mutable: false`. A test shows that an explicit attempt to add rules emits nothing.
- **Replacement/deletion risk to existing AWS resources: none found.**

## 4. Security findings (live, read-only)

| ID     | Finding                                                                                                                                  | Severity                                                    | Action owner           |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------- |
| D-P1-2 | The `ogevia-web` client's only callback, `https://d84l1y8p4kdic.cloudfront.net`, is not a distribution in this account (0 distributions) | High before any user signs in; current exposure 0 (0 users) | Owner (Cognito change) |
| —      | `ogevia-prod-data-layer` termination protection is off                                                                                   | Medium                                                      | Owner                  |
| —      | RDS PostgreSQL log group never expires                                                                                                   | Low (cost/retention)                                        | Owner                  |
| —      | Phase 0 had the two RDS master secrets swapped; corrected in config                                                                      | Info                                                        | Done                   |

## 5. Decision gates carried to later phases

| ID     | Decision                                                                                                                                                                                                   | Phase                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| D-P1-1 | Lambda egress: Secrets Manager endpoint (≈ $14.60/month for 2 AZs) **or** RDS IAM auth (change to the CloudFormation-owned instance); S3 gateway endpoint (free; changes route tables). NAT stays DEFERRED | 4                       |
| D-P1-2 | Fix the Cognito callback; add `https://app.ogevia.com`; require PKCE in the frontend                                                                                                                       | 3                       |
| D-P1-3 | Lambda concurrency quota increase (account limit is 10 today)                                                                                                                                              | 4                       |
| D-P1-4 | Alarm notification recipients (SNS subscriptions)                                                                                                                                                          | 7                       |
| D-06   | Evidence and log retention periods                                                                                                                                                                         | 5/7                     |
| —      | Approval for `cdk bootstrap`                                                                                                                                                                               | before the first deploy |

## 6. Branch lineage note

As instructed, this branch is based on `claude/phase0-aws-inventory`. That branch is built on an older `main` (`1feb372`) and carries the unmerged PR #43 support-workflow commits. It lacks 8 newer `main` commits, including the SV v3 migrations. `infra/aws`, `docs/aws/PHASE_1_*` and the workspace/lockfile lines are self-contained, so they can be cherry-picked onto current `main` without carrying PR #43. Merging this branch as-is would also merge PR #43.

## 7. Phase 2 handoff (not started)

1. From a branch based on **current `main`**, take a schema-only dump of Supabase production and extract the SV tables and RPCs.
2. Write idempotent PostgreSQL migrations under `infra/aws/db/` with the Phase 0 M-1/M-2/M-3 fixes, plus a local Postgres test harness (tenant isolation, concurrency, idempotency, authorization versioning).
3. Ensure the `ogevia/database/app` secret carries `dbname`, or record the target DB name. RDS `DBName` is null. Verifying this requires an approved secret read or a DB connection.
4. Do not apply anything to `ogevia-prod-postgres` without approval.
