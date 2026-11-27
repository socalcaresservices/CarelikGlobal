# Security readiness checklist: AWS, Cognito, SES, RDS, S3, CloudWatch

Date: 2026-11-27. How to use: each row is a check with **evidence in the repository** (what the code or CDK does) and **a read-only way to confirm it live**. "Repo" status is what the code defines; **live status is UNKNOWN until someone runs the confirm command against the real account** (this session had no AWS access). Do not paste secret values anywhere. `[ ]` = open, `[x]` = confirmed in the repository only.

## Account and access (AWS)
- [ ] MFA enforced for every human admin (IAM Identity Center). Confirm: Identity Center console, or `aws sso-admin list-instances`.
- [ ] No long-lived access keys for people; automation uses roles. Confirm: `aws iam generate-credential-report` then read it (no secrets in it).
- [ ] Least privilege for the deploy role and Lambda roles. Repo: CDK roles are narrow (one SES identity, one evidence bucket, one database secret). Confirm: `aws iam simulate-principal-policy` on the Lambda role for actions it must NOT have.
- [ ] CloudTrail on in all regions, log file validation on, delivered to a protected bucket. Confirm: `aws cloudtrail describe-trails` and `get-trail-status`.
- [ ] AWS Budgets and billing alerts exist (`docs/aws/COST_MODEL.md`). Confirm: `aws budgets describe-budgets`.
- [ ] Root account: MFA, no access keys, contact details current.

## Cognito
- [x] Individual accounts only (no shared caregiver login); app client ids and issuer checked server-side (the API refuses tokens from another pool; `auth-separation.test.ts`).
- [x] User pool has deletion protection and RETAIN removal (`auth-stack.ts`).
- [ ] Password policy and MFA option for office staff. Confirm: `aws cognito-idp describe-user-pool`.
- [ ] Self-signup disabled (invitation only). Confirm: pool `AdminCreateUserConfig`.
- [ ] Hosted UI/redirect URIs list only the production hostnames. Confirm: `describe-user-pool-client`.
- [ ] Invitation and password-reset email wording reviewed (no client details). Repo: branded invitation Lambda validates/escapes brand values.

## SES (email)
- [ ] Production access granted (out of sandbox) and a verified sending identity with DKIM, SPF, DMARC. Confirm: `aws sesv2 get-account`, `get-email-identity`.
- [x] Alert emails carry no client details by design (notification text rule, `docs/stabilization/cover-shift-notifications.md`); the send function sits outside the VPC with one `ses:SendEmail` statement on one identity.
- [ ] Bounce and complaint handling (configuration set with event destination) so bad addresses stop receiving mail.
- [ ] BAA coverage for SES confirmed before any PHI-bearing email (see BAA checklist). Until then alerts stay PHI-free.

## RDS (PostgreSQL)
- [x] Private subnets only, not publicly accessible; credentials in Secrets Manager (`CLAUDE.md` section 8; `database-secret-stack.ts`).
- [ ] Storage encryption on, TLS required (`rds.force_ssl`), deletion protection on, automated backups retention set, Multi-AZ decision recorded. Confirm: `aws rds describe-db-instances` (fields `StorageEncrypted`, `PubliclyAccessible`, `DeletionProtection`, `BackupRetentionPeriod`, `MultiAZ`).
- [x] Tenant isolation: row security enabled with no policy for the application role on new tables, `SECURITY DEFINER` functions with pinned `search_path`, no PUBLIC execute; the cross-tenant sweep (`tenant-isolation-sweep.db.test.ts`) runs in CI on every route.
- [ ] Restore tested from a snapshot into a scratch instance and the result recorded (`docs/aws/CONTINUITY_AND_RECOVERY.md`).
- [ ] Ownership drift and two manual production grants (database-audit.md, 0108 proposal) resolved.

## S3 (evidence, web)
- [x] Evidence bucket: block all public access, `enforceSSL`, KMS key with rotation, versioning, access logs, RETAIN (`evidence-storage-stack.ts`).
- [x] Object keys contain ids only (no names).
- [ ] Bucket policy denies non-TLS and cross-account access. Confirm: `aws s3api get-bucket-policy` (policy text contains no secrets).
- [ ] Retention/lifecycle decided (see `RETENTION_POLICY.md`); Object Lock only with explicit owner approval.
- [ ] Cross-region replication decision (cost and DR gate, not approved).

## CloudWatch and monitoring
- [x] Finite log retention on every CDK log group (one year in production config).
- [x] No signature data, tokens or codes in logs (API tests assert tokens and image bytes are absent from log output).
- [ ] Alarms: Lambda errors and throttles, API 5xx, RDS CPU/storage/connections, SES bounce rate, budget. Confirm: `aws cloudwatch describe-alarms`.
- [ ] A named person receives the alarms (SNS topic with confirmed subscriptions).
- [ ] Drift monitoring run on a schedule (`docs/aws/DRIFT_MONITORING_PROPOSAL.md`).

## Application controls (repository)
- [x] Server-authoritative times, roles and agency on every write; client-supplied agency/role/time never trusted.
- [x] Release switches OFF by default for new features; deployment only through the owner-approved release process.
- [x] Dependency audit: production advisories 0 at 2026-11-23 (`docs/stabilization/security-review.md`); dev-tool advisories documented.
- [ ] Secret scanning of history and a penetration test (not performed; run before onboarding a second agency).
- [ ] Incident response contact list and breach-notification procedure written (see HIPAA checklist).
