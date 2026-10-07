# Current AWS Inventory (Phase 0)

**Prepared:** 2026-10-07 · **Region target:** us-west-2 · **Status:** PARTIAL — live AWS state NOT VERIFIED

## 1. Live AWS verification — BLOCKED

| Check | Result |
|---|---|
| AWS CLI in container | Not installed; installed v1 into a scratch venv |
| `aws sts get-caller-identity` | **FAILED** `InvalidClientTokenId` — the `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` set in the container environment are rejected by STS |
| Any other read-only inventory call | Not attempted (no valid identity) |

Consequence: every resource in CLAUDE.md §7 is **UNKNOWN** (last-known state only): VPC `vpc-0ee9df0c38297cbc1`, SG `sg-00e01e2ca80442c1f`, VPC endpoints `vpce-09dff848221f90105` / `vpce-0cfe984c8b634eb0d`, role `OgeviaDBAdminSSMRole`, profile `OgeviaDBAdminProfile`, host `ogevia-db-admin-temp`, RDS `ogevia-postgres`. No claim in this repo that they exist or are configured correctly is verified here.

**To unblock (owner action):** provide valid credentials for a read-only role (e.g. `ReadOnlyAccess` + `SecurityAudit` via IAM Identity Center, session token included), or run the read-only command list in §5 yourself and paste the output (metadata only, no secret values).

## 2. Repository evidence (VERIFIED from files)

| Item | Finding |
|---|---|
| `infra/aws/` | Contains **only committed `cdk.out/` synth output** (5 stacks, `Ogevia-prd-*`). **No CDK source** (`bin/`, `lib/`, `package.json`, `cdk.json`) is in the repo. Output cannot be regenerated or reviewed as code. |
| `docs/aws/` | Did not exist before this file. |
| `docs/deployment/` | Prior pilot→production plan (`FINAL-DEPLOYMENT-SUMMARY.md`, dated 2026-10-07, "READY FOR EXECUTION", tag `release/prd-v1`). Describes execution phases; **no evidence in repo that any was executed**. Treated as a plan, not as state. |
| Supabase migrations | 162 files in `supabase/migrations/` (prior doc says 161). |
| Supabase client use | 173 occurrences across 54 files in `apps/web`, `packages/auth`, `supabase/functions`, `apps/netlify-functions`. |

### Stacks in committed `cdk.out` (VERIFIED from template JSON, not from AWS)

| Stack | Resources | Conflict with CLAUDE.md |
|---|---|---|
| EvidenceStorage | KMS key+alias, 2 S3 buckets + policies | Consistent (§4, §14 Phase 5). Retention/versioning not yet reviewed. |
| NetworkEgress | 1 SG, 3 VPC endpoints | Needs review vs. §11 (interface endpoints carry hourly cost). Name implies egress path; confirm no NAT. |
| Observability | SNS topic, 6 alarms | Consistent. |
| ServiceVerificationApi | HTTP API, 1 JWT authorizer, **122 routes**, 2 Lambdas (nodejs24.x; one VPC-attached), log groups | Consistent in shape. 122 routes far exceeds the §14 Phase 4 initial scope (~8 operations) — scope creep to review. |
| WebHosting | S3 ×2, **CloudFront distribution**, CloudFront Function, **Cognito UserPoolClient** | **Conflicts with §3** (Netlify remains frontend host during migration). CloudFront is a new billable resource requiring approval (§11). |

No RDS, Cognito UserPool, WAF, NAT, or Budget resource appears in these templates (UserPool not defined → client references an external pool; **UNKNOWN**).

## 3. Service Verification surface to migrate (VERIFIED from code)

Browser → Supabase RPCs used by `apps/web/src/pages/service-verification-page.tsx`:
`list_assigned_visit_clients`, `list_authorized_services_for_client`, `list_scheduled_shifts_for_visit`, `get_active_service_visit_v3`, `start_ad_hoc_service_visit`, `end_service_visit`, `confirm_service_visit`.
Manager/billing RPCs elsewhere: `list_service_visits`, `correct_service_visit`, `list_visit_corrections`, `close_missed_service_visit`, `approve_visit_for_billing`, `list_billing_ready_visits`.
Storage: bucket `visit-signatures` accessed directly from the browser (`service-verification-page.tsx:629`) → must become S3 via API.
Defining migrations: `20260824010000_service_verification_v3.sql`, `20260828_visit_verification_redesign.sql`, plus later visit/shift migrations (`20260826*`). Auth: `packages/auth/src/auth-provider.tsx`, `apps/web/src/lib/supabase.ts`.

## 4. Classification (pending live verification)

| Component | Class |
|---|---|
| VPC, SG, SSM endpoints, DB admin role/profile/host | UNKNOWN — verify, then REFERENCE or IMPORT |
| RDS `ogevia-postgres` | UNKNOWN — verify existence/privacy/encryption; IMPORT or CREATE NEW |
| Cognito pool/groups | CREATE NEW (none defined in repo) |
| API Gateway/Lambda | CREATE NEW, reduced to Phase 4 scope |
| S3 signatures + KMS | CREATE NEW (EvidenceStorage template as starting point after review) |
| CloudFront/WebHosting | DEFER (conflicts §3) |
| Observability alarms, Budgets, CloudTrail | CREATE NEW / verify existing |
| Supabase schema + RPCs | MIGRATE FROM SUPABASE |
| Supabase, Netlify | KEEP; RETIRE only after cutover acceptance |

## 5. Read-only commands to run once credentials work

```
aws sts get-caller-identity; aws configure get region
aws ec2 describe-vpcs --vpc-ids vpc-0ee9df0c38297cbc1
aws ec2 describe-subnets|route-tables|internet-gateways|nat-gateways|vpc-endpoints|security-groups (filter by VPC)
aws rds describe-db-instances|describe-db-clusters|describe-db-subnet-groups
aws secretsmanager list-secrets            # metadata only; never get-secret-value
aws kms list-aliases; aws cloudtrail describe-trails
aws logs describe-log-groups; aws cloudwatch describe-alarms
aws s3api list-buckets; aws cognito-idp list-user-pools --max-results 20
aws apigatewayv2 get-apis; aws lambda list-functions
aws budgets describe-budgets --account-id <id>; aws cloudformation list-stacks
```
