# Current AWS Inventory (Phase 0)

**Date:** 2026-10-07  **Region target:** us-west-2  **Status:** LIVE STATE NOT VERIFIED (BLOCKED)

## Blocker
`aws sts get-caller-identity` (AWS CLI installed in a scratch venv) returned
`InvalidClientTokenId: The security token included in the request is invalid.`
The `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` injected into this container are rejected by AWS.
No AWS resource below has been confirmed to exist. Nothing was modified in AWS.

**Needed from owner:** valid read-only credentials (e.g. an IAM Identity Center `ReadOnlyAccess`
session) injected into the environment, then re-run Phase 0 inventory.

## Last-known resources from CLAUDE.md section 7 (all UNVERIFIED)
| Resource | Identifier | Proposed class |
|---|---|---|
| VPC | vpc-0ee9df0c38297cbc1 | REFERENCE FROM CDK (pending verification) |
| SG ogevia-db-admin-sg | sg-00e01e2ca80442c1f | REFERENCE; review for retirement |
| SSM VPC endpoint | vpce-09dff848221f90105 | REFERENCE (interface endpoint = fixed cost) |
| SSM Messages VPC endpoint | vpce-0cfe984c8b634eb0d | REFERENCE (fixed cost) |
| IAM role / profile | OgeviaDBAdminSSMRole / OgeviaDBAdminProfile | REFERENCE; RETIRE with temp host |
| Temp admin host | ogevia-db-admin-temp | RETIRE AFTER CUTOVER |
| RDS PostgreSQL | ogevia-postgres | UNKNOWN whether it exists |
Still to inventory: subnets/AZs, route tables, IGW, NAT, SGs, RDS config (encryption, public access,
class, storage), KMS, CloudTrail, CloudWatch, S3, Cognito, API Gateway, Lambda, Budgets, CDK bootstrap/stacks.

## What the repository claims (not live evidence)
- `infra/aws/` contains **only `cdk.out/`** (committed synth output). **There is no CDK source**
  (no `bin/`, `lib/`, `package.json`, `cdk.json`, `test/`). The templates cannot be regenerated or reviewed as code.
- Synthesized stacks `Ogevia-prd-*` (resource counts from templates):
  - EvidenceStorage: KMS key+alias, 2 S3 buckets.
  - NetworkEgress: 3 VPC endpoints (Secrets Manager, Lambda = interface; S3 = gateway), 1 SG.
  - Observability: 6 alarms, SNS topic.
  - ServiceVerificationApi: HTTP API, JWT authorizer, 2 Lambdas, **122 routes**, 3 log groups.
  - WebHosting: CloudFront distribution + function, 2 S3 buckets, Cognito user pool client, managed-login branding.
- `docs/deployment/FINAL-DEPLOYMENT-SUMMARY.md` states "READY FOR EXECUTION" with "677 tests passing" and a
  Cognito/RDS design. No evidence in this session supports those claims.

## Conflicts with CLAUDE.md (require owner decision; work on these items paused)
1. **CloudFront WebHosting stack** vs. section 3 "Netlify remains the frontend host during migration."
2. **122 API routes** vs. section 14 Phase 4 minimal initial endpoint set (~8 operations). Scope appears to exceed the vertical slice.
3. **No CDK source** vs. section 6 (CDK is the source of truth). Templates in `cdk.out` are untraceable artifacts.
4. Interface VPC endpoints (Secrets Manager, Lambda, SSM x2) carry fixed hourly cost per AZ; not yet in an approved cost model.
5. `FINAL-DEPLOYMENT-SUMMARY.md` pushes a deploy sequence before the Phase 0 exit gate was passed.
