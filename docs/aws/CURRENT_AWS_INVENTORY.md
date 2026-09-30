# Ogevia — Current AWS Inventory (Phase 0)

**Date:** 2026-09-30
**Author:** Claude Code (Phase 0, per `CLAUDE.md` §14 / §17)
**Region in scope:** `us-west-2`
**AWS changes made during Phase 0:** NONE

> **PHASE 0 STATUS: INCOMPLETE — blocked on live AWS inventory.**
> The next gate is **AWS INVENTORY, not AWS DEPLOYMENT.** In order:
>
> 1. Get controlled **read-only** access to the Ogevia AWS account (no AdministratorAccess, no long-lived admin keys).
> 2. Verify the live resources in `us-west-2` (§4 command set).
> 3. Update this file.
> 4. Reconcile the inventory against the provisional CDK proposal (`infra/aws`).
> 5. Identify duplicate or unnecessary resources, fixed monthly costs, and what should be imported or referenced rather than recreated.
> 6. Run a non-mutating `cdk diff` only after account identity and existing infrastructure are verified.
>
> **Stop there.** No `cdk bootstrap`, `cdk deploy`, `cdk import`, database migration, or any other AWS mutation is authorized.

Classification legend: **VERIFIED** (observed directly) · **INFERRED** (strongly implied, not observed) · **UNKNOWN** (not established).

---

## 1. Result: live AWS inventory is BLOCKED

| Check                                            | Result                                                                                                                                                        | Status                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `aws sts get-caller-identity --region us-west-2` | `InvalidClientTokenId: The security token included in the request is invalid.`                                                                                | **VERIFIED** (the call failed)                 |
| AWS CLI present in session container             | Not preinstalled. `awscli 1.46.1` was installed into the container's user site-packages for read-only use                                                     | VERIFIED                                       |
| Credentials source                               | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are set in the session environment. `~/.aws/config` has no profile or region. No `AWS_SESSION_TOKEN` is present | VERIFIED (presence only; values were not read) |
| `cdk synth` environment resolution               | `aws://unknown-account/us-west-2`: the CDK CLI could not resolve an account from these credentials                                                            | VERIFIED                                       |

**Likely causes (INFERRED, not verified):** the key pair was deactivated or rotated, or it is a temporary credential that needs a session token which isn't present.

**Consequence:** none of the resources in `CLAUDE.md` §7 could be verified. Every resource below is **UNKNOWN**, and **no CDK reference or import may be written for any of them** until a read-only inventory succeeds (`CLAUDE.md` §7).

### What is needed to unblock

Store a working **read-only** credential in the Claude Code cloud environment settings (environment menu → Edit → environment variables or API credentials). **Do not paste secrets into chat.**

- Preferred: a dedicated IAM role or user with the AWS-managed `ReadOnlyAccess` or `SecurityAudit` policy. Its keys go in `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, plus `AWS_SESSION_TOKEN` if the credential is temporary. Set `AWS_DEFAULT_REGION=us-west-2`.
- The credential must not carry write permissions. Phase 0 and Phase 1 need only reads. Deploy credentials are a separate YELLOW approval.

A new session picks up the change. After that, run the read-only command set in §4 and replace every UNKNOWN in this file.

---

## 2. Last-known AWS foundation (from `CLAUDE.md` §7) — ALL UNKNOWN

| Resource                           | Last-known identifier                         | Live status                                                                                  | Proposed classification (after verification)                                                                                                                                 |
| ---------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Region                             | `us-west-2`                                   | Approved by directive                                                                        | —                                                                                                                                                                            |
| VPC                                | `vpc-0ee9df0c38297cbc1`                       | UNKNOWN                                                                                      | REFERENCE FROM CDK (`Vpc.fromLookup` by ID, after verification)                                                                                                              |
| Security group                     | `ogevia-db-admin-sg` / `sg-00e01e2ca80442c1f` | UNKNOWN                                                                                      | REFERENCE FROM CDK; inbound rules must be reviewed first                                                                                                                     |
| SSM VPC endpoint                   | `vpce-09dff848221f90105`                      | UNKNOWN                                                                                      | KEEP EXISTING / REFERENCE. **Fixed hourly cost**: see `COST_MODEL.md`                                                                                                        |
| SSM Messages VPC endpoint          | `vpce-0cfe984c8b634eb0d`                      | UNKNOWN                                                                                      | KEEP EXISTING / REFERENCE. **Fixed hourly cost**                                                                                                                             |
| EC2 Messages endpoint              | not listed in §7                              | UNKNOWN                                                                                      | Session Manager normally also needs `ec2messages`; verify whether it exists                                                                                                  |
| IAM role                           | `OgeviaDBAdminSSMRole`                        | UNKNOWN                                                                                      | KEEP EXISTING until least-privilege review; IMPORT candidate later                                                                                                           |
| Instance profile                   | `OgeviaDBAdminProfile`                        | UNKNOWN                                                                                      | KEEP EXISTING                                                                                                                                                                |
| Temporary admin EC2 host           | tag/name `ogevia-db-admin-temp`               | UNKNOWN                                                                                      | **If running, it is a fixed cost.** RETIRE AFTER CUTOVER, or stop when idle (owner decision)                                                                                 |
| RDS PostgreSQL                     | `ogevia-postgres`                             | UNKNOWN (existence, engine, class, storage, encryption, public accessibility all unverified) | IMPORT INTO CDK **only if** it is encrypted and private. If it is unencrypted, it cannot be encrypted in place; snapshot → encrypted copy → restore is required (YELLOW/RED) |
| IAM Identity Center + MFA          | configured (per directive)                    | UNKNOWN                                                                                      | KEEP EXISTING (outside CDK)                                                                                                                                                  |
| Subnets / route tables / IGW / NAT | not listed                                    | UNKNOWN                                                                                      | Verify. **Any NAT Gateway is a fixed cost and needs documented approval** (`CLAUDE.md` §11)                                                                                  |
| KMS keys / aliases                 | not listed                                    | UNKNOWN                                                                                      | —                                                                                                                                                                            |
| Secrets Manager entries            | not listed                                    | UNKNOWN (metadata only when verified; never values)                                          | —                                                                                                                                                                            |
| CloudTrail                         | not listed                                    | UNKNOWN                                                                                      | Needed before production (Phase 7)                                                                                                                                           |
| CloudWatch log groups / alarms     | not listed                                    | UNKNOWN                                                                                      | Retention must be finite                                                                                                                                                     |
| S3 buckets                         | not listed                                    | UNKNOWN                                                                                      | Check for a pre-existing signature bucket before deploying `EvidenceStorage`                                                                                                 |
| Cognito pools/clients              | not listed                                    | UNKNOWN                                                                                      | —                                                                                                                                                                            |
| API Gateway / Lambda               | not listed                                    | UNKNOWN                                                                                      | —                                                                                                                                                                            |
| AWS Budgets                        | not listed                                    | UNKNOWN                                                                                      | Required before production (`CLAUDE.md` §11)                                                                                                                                 |
| CDK bootstrap (`CDKToolkit` stack) | not listed                                    | UNKNOWN                                                                                      | `cdk bootstrap` is YELLOW; it creates an S3 bucket, ECR repository, and IAM roles                                                                                            |
| CloudFormation stacks              | not listed                                    | UNKNOWN                                                                                      | —                                                                                                                                                                            |

---

## 3. Non-AWS systems observed (read-only, for migration context)

### 3.1 Supabase (via the Supabase MCP connector, read-only calls only)

| Project                      | Ref                    | Region    | Status                        | Role (INFERRED from `netlify.toml` and names)                            |
| ---------------------------- | ---------------------- | --------- | ----------------------------- | ------------------------------------------------------------------------ |
| CarelikGlobal                | `cdxxpdyobsqvqveabsda` | us-east-2 | ACTIVE_HEALTHY, Postgres 17.6 | **Production**                                                           |
| Ogevia Candidate Hiring Demo | `ldwhmuirjbwcpzwrwzgv` | us-east-2 | ACTIVE_HEALTHY                | Deploy-preview/demo (named in `netlify.toml` `[context.deploy-preview]`) |
| Carelik                      | `uxqfbbovhpzezvvixaak` | us-east-2 | INACTIVE                      | Legacy                                                                   |

**Production data volume (VERIFIED, `list_tables` row estimates, 2026-09-30):**

| Table                                                                  | Rows  |
| ---------------------------------------------------------------------- | ----- |
| `service_visits`, `visit_signatures`, `visit_corrections`              | **0** |
| `billing_approvals`, `billing_submissions`, `billing_submission_items` | **0** |
| `clients`                                                              | 9     |
| `client_authorizations`                                                | 10    |
| `caregiver_records`                                                    | 12    |
| `caregiver_assignments`                                                | 4     |
| `shifts`                                                               | 5     |
| `organizations`                                                        | 3     |
| `user_profiles`                                                        | 22    |
| `audit_logs`                                                           | 353   |

Implications:

- **Service Verification has never recorded a production visit.** The AWS cutover has no visit or signature data to migrate. That lowers Phase 8 risk considerably.
- Production does hold client, authorization, and caregiver records. Whether they are real people's PHI or test data is **UNKNOWN**. This matters for the Supabase BAA question (`SECURITY_DECISIONS.md` D-01).

**Migration history parity (VERIFIED, `list_migrations` vs `supabase/migrations/`):**

- 158 repo files vs 160 applied migrations.
- Repo-only names (3): `document_reminders`, `lock_down_visit_number_trigger_grant`, `organization_branding_drop_svg`. Each has a renamed live counterpart (`document_reminders_settings_and_queue`, `service_routing_lock_down_visit_number_trigger_grant`, `remove_svg_from_organization_branding_allowlist`).
- Live-only names with **no repo file** (2): `service_routing_fix_status_filter`, `cancel_shift_with_reason_part2`.
- Live version timestamps differ from repo filenames because migrations were applied through the MCP connector.
- **Consequence:** the repo cannot faithfully rebuild production. The AWS schema port must start from a **schema-only dump of production** (`pg_dump --schema-only`, no data), diffed against a replay of the repo migrations. Replaying the repo alone is not enough.

**Security advisors (VERIFIED, `get_advisors security`):** no ERROR-level findings.

- WARN, 18 findings: SECURITY DEFINER functions executable by `anon`. Most are intentional token-based public flows (candidate portal, shift claim, public org lookup). Two, `list_care_team_records(uuid)` and `reassign_shift(uuid, uuid, text)`, have `revoke … from anon` in the repo but are still anon-executable live. That is **grant drift**. Both function bodies reject unauthenticated callers (`has_permission` / `auth.uid() is null`), so this is **not exploitable as written (INFERRED from source)**, but production does not match the repo.
- WARN, 130 findings: SECURITY DEFINER executable by `authenticated`. This is the app's intended RPC pattern.
- WARN: leaked-password protection is disabled in Supabase Auth.
- WARN: `pg_net` extension is in the `public` schema.
- WARN: `public.prevent_direct_authorization_edit` has a mutable `search_path`. The repo has a fix migration (`20260812190325`), yet the live function still flags.
- INFO: RLS is enabled with no policy on `domain_events`, `integration_secrets`, and `stripe_webhook_events`. Deny-all is the intended outcome.

### 3.2 Netlify

- `netlify.toml`: builds with `pnpm typecheck && pnpm lint && pnpm test && pnpm --filter @carelik/web build`, publishes `apps/web/dist`, and runs functions from `apps/netlify-functions/functions` (Stripe checkout, billing portal, webhook). Live Netlify state was **not inspected** (no connector).

---

## 4. Read-only command set to run once credentials work

All of these are Describe/List/Get calls. None mutates anything and none retrieves a secret value.

```bash
export AWS_REGION=us-west-2
aws sts get-caller-identity
aws ec2 describe-vpcs --vpc-ids vpc-0ee9df0c38297cbc1
aws ec2 describe-vpc-attribute --vpc-id vpc-0ee9df0c38297cbc1 --attribute enableDnsSupport
aws ec2 describe-vpc-attribute --vpc-id vpc-0ee9df0c38297cbc1 --attribute enableDnsHostnames
aws ec2 describe-subnets --filters Name=vpc-id,Values=vpc-0ee9df0c38297cbc1
aws ec2 describe-route-tables --filters Name=vpc-id,Values=vpc-0ee9df0c38297cbc1
aws ec2 describe-internet-gateways --filters Name=attachment.vpc-id,Values=vpc-0ee9df0c38297cbc1
aws ec2 describe-nat-gateways --filter Name=vpc-id,Values=vpc-0ee9df0c38297cbc1
aws ec2 describe-vpc-endpoints --filters Name=vpc-id,Values=vpc-0ee9df0c38297cbc1
aws ec2 describe-security-groups --filters Name=vpc-id,Values=vpc-0ee9df0c38297cbc1
aws ec2 describe-instances --filters Name=tag:Name,Values=ogevia-db-admin-temp
aws iam get-role --role-name OgeviaDBAdminSSMRole
aws iam list-attached-role-policies --role-name OgeviaDBAdminSSMRole
aws iam list-role-policies --role-name OgeviaDBAdminSSMRole
aws iam get-instance-profile --instance-profile-name OgeviaDBAdminProfile
aws rds describe-db-instances
aws rds describe-db-clusters
aws rds describe-db-subnet-groups
aws rds describe-db-parameter-groups
aws secretsmanager list-secrets          # metadata only; never get-secret-value
aws kms list-aliases
aws cloudtrail describe-trails
aws cloudtrail get-trail-status --name <trail>   # per trail found
aws logs describe-log-groups
aws cloudwatch describe-alarms
aws s3api list-buckets
aws cognito-idp list-user-pools --max-results 60
aws apigatewayv2 get-apis
aws apigateway get-rest-apis
aws lambda list-functions
aws budgets describe-budgets --account-id <account-id>
aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE
aws ce get-cost-and-usage --time-period Start=2026-09-01,End=2026-10-01 --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE
```

For each RDS instance, record `StorageEncrypted`, `PubliclyAccessible`, `MultiAZ`, `DBInstanceClass`, `EngineVersion`, `BackupRetentionPeriod`, `DeletionProtection`, `KmsKeyId`, and `IAMDatabaseAuthenticationEnabled`.
