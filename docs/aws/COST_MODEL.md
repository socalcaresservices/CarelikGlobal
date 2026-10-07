# Cost Model (Phase 0) - NO PRICES ASSERTED

**Status:** structure only. Current AWS prices were not verified in this session (no AWS access; pricing must be taken from
the official AWS pricing pages/Calculator for us-west-2 before approval). No dollar figures are stated here by design.

| Resource | Purpose | Fixed cost? | Cost driver | Cheaper alternative considered | Status |
|---|---|---|---|---|---|
| RDS PostgreSQL (single-AZ, smallest viable class) | relational store | Yes | instance hours, storage, backups | Supabase (already in use; not HIPAA-BAA verified for this use) | Existence unverified |
| Interface VPC endpoints (Secrets Manager, Lambda, SSM, SSM Messages) | private access without NAT | Yes, per endpoint per AZ + data | endpoint-hours x AZs | NAT gateway (higher fixed cost, needs approval); fetch secrets at deploy/inject env; drop Lambda endpoint if Lambda not in VPC-to-Lambda path | Needs review |
| S3 gateway endpoint | private S3 | No | none | n/a | Fine |
| API Gateway HTTP API + Lambda | API | No | requests, GB-s | n/a | Variable |
| Cognito | auth | No at small scale (tier-dependent) | monthly active users | Supabase Auth | Verify tier/pricing |
| KMS key(s) | encryption | Yes (per key) + requests | key count | AWS-managed keys (no per-key fee, less control) | Review key count |
| CloudFront + WebHosting S3 | frontend | Usage-based | requests, transfer | Netlify (already used) | CONFLICT with directive |
| CloudWatch alarms/logs, SNS | monitoring | Small, per alarm | alarms, log GB | finite retention | Verify retention set |
| AWS Budgets | cost alert | Free tier of budgets applies | n/a | n/a | Must exist before prod |

Required before any deploy: dev and initial-production monthly estimates built with the AWS Pricing Calculator and approved by the owner.
