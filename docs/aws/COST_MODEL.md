# Ogevia — AWS Cost Model (Phase 0)

**Date:** 2026-09-30 · **AWS changes:** NONE

## Price-verification status: ALL PRICES UNVERIFIED

The figures below are **last-known us-west-2 on-demand list prices from general knowledge**. They could not be checked in this session because:

- `aws.amazon.com` pricing pages are blocked by the session's network egress policy, and
- the AWS Price List API (`aws pricing get-products`) needs working credentials, which were rejected (`CURRENT_AWS_INVENTORY.md` §1).

**Do not approve spend from these numbers.** Before any YELLOW approval, verify each line with the AWS Pricing Calculator or with:

```bash
aws pricing get-products --region us-east-1 --service-code AmazonRDS \
  --filters Type=TERM_MATCH,Field=location,Value="US West (Oregon)" \
            Type=TERM_MATCH,Field=instanceType,Value=db.t4g.micro \
            Type=TERM_MATCH,Field=databaseEngine,Value=PostgreSQL \
            Type=TERM_MATCH,Field=deploymentOption,Value=Single-AZ
```

The actual current spend is also **UNKNOWN**. Run `aws ce get-cost-and-usage` from inventory §4 first. It shows what the manually created resources cost today.

Hours per month used below: 730.

---

## 1. Resources that may ALREADY be billing (manual foundation, unverified)

| Resource                                      | Fixed cost?                         | Est. monthly (UNVERIFIED)                                                   | Note                                                                                                                                                                       |
| --------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2 interface VPC endpoints (SSM, SSM Messages) | **Yes**, hourly per endpoint per AZ | ~$7.30 per endpoint-AZ, so **~$14.60 (1 AZ) to ~$29.20 (2 AZ)** + ~$0.01/GB | Endpoints bill 24/7 even when idle. If the admin host is used rarely, deleting the endpoints between uses is cheaper, but that is a YELLOW change and the owner's decision |
| `ogevia-db-admin-temp` EC2 host               | Yes, while running                  | ~$3–8 (t4g.nano/micro) + EBS ~$0.80 per 8 GB                                | Stopping it when idle leaves only the EBS cost                                                                                                                             |
| `ogevia-postgres` RDS (if it exists)          | **Yes**                             | see §2                                                                      | Largest fixed line item                                                                                                                                                    |
| NAT Gateway (if any exists)                   | **Yes**                             | ~$32.85 + $0.045/GB                                                         | Directive forbids it without approval. Verify none exists                                                                                                                  |

## 2. Target architecture: per-resource model

| Resource                                                | Purpose                                    | Fixed? | Dev / month                                                      | Initial prod / month                           | Scaling driver                                                                                                                                                                                                                | Cheaper alternative considered                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------ | ------ | ---------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **RDS PostgreSQL** `db.t4g.micro`, Single-AZ, 20 GB gp3 | System of record                           | Yes    | ~$12 instance + ~$2.30 storage ≈ **$14**                         | —                                              | Instance class, storage, backup beyond DB size                                                                                                                                                                                | Aurora Serverless v2 has a higher floor (min ACU) and was rejected by the directive. DynamoDB would mean a rewrite and was rejected |
| RDS prod `db.t4g.small`, **Multi-AZ**, 20 GB gp3        | HA for prod                                | Yes    | —                                                                | ~$47–53 instance + ~$4.60 storage ≈ **$52–58** | Same                                                                                                                                                                                                                          | Single-AZ prod (~$26) cuts cost but accepts an AZ-outage window. **Owner decision D-07**                                            |
| RDS automated backups                                   | PITR                                       | Usage  | $0 up to 100% of DB size                                         | Same                                           | Retention days × change rate                                                                                                                                                                                                  | —                                                                                                                                   |
| **KMS** customer-managed key (1 per stage)              | Encrypt evidence (and RDS, if using a CMK) | Yes    | **$1** + $0.03/10k requests                                      | $1 + requests                                  | Requests (reduced by S3 Bucket Keys, which are enabled)                                                                                                                                                                       | AWS-managed `aws/s3` key costs nothing per key, but key policy is not under Ogevia's control                                        |
| **S3** signature bucket + access-log bucket             | Evidence storage                           | No     | < $0.10                                                          | < $1                                           | ~20–60 KB PNG per visit. 10k visits ≈ 0.5 GB ≈ $0.01/mo storage; PUTs $0.005/1k                                                                                                                                               | —                                                                                                                                   |
| **Cognito** user pool                                   | Auth                                       | No     | $0                                                               | ~$0 up to the free-tier MAU limit              | MAU. **Tier and free-tier limits changed in late 2024 and must be verified**                                                                                                                                                  | Keeping Supabase Auth would contradict the directive                                                                                |
| **API Gateway HTTP API**                                | API                                        | No     | $0 (free tier, first 12 months only)                             | ~$1 per million requests                       | Requests                                                                                                                                                                                                                      | REST API costs about 3.5× more per request, and its extra features aren't needed                                                    |
| **Lambda** (arm64)                                      | Business logic                             | No     | $0                                                               | ≈ $0–2                                         | Invocations × duration × memory                                                                                                                                                                                               | Always-on ECS/EC2 was rejected by the directive                                                                                     |
| Lambda in VPC → RDS                                     | Private DB access                          | —      | —                                                                | —                                              | Needs ENIs (free). **Secrets Manager or other AWS API calls from a VPC Lambda need a NAT or interface endpoints.** Plan: use RDS IAM auth or a Secrets Manager interface endpoint (~$7.30/AZ, fixed) instead of NAT (~$32.85) | Decision D-08                                                                                                                       |
| **Secrets Manager**                                     | DB credentials                             | Yes    | $0.40 per secret                                                 | $0.40–1.20                                     | Secret count                                                                                                                                                                                                                  | RDS-managed master secret (still a Secrets Manager secret). RDS IAM auth avoids a stored app password                               |
| **CloudWatch Logs**                                     | App/API logs                               | No     | < $1                                                             | $1–5                                           | GB ingested ($0.50/GB) × retention                                                                                                                                                                                            | Finite retention required: 30 days dev, 365 days prod proposed (D-06)                                                               |
| CloudWatch alarms                                       | Ops                                        | Yes    | $0.10 per alarm                                                  | ~$1                                            | Alarm count                                                                                                                                                                                                                   | —                                                                                                                                   |
| **CloudTrail** management events, 1 trail               | Audit                                      | No     | $0 (first copy of management events) + S3                        | Same                                           | Data events cost extra ($0.10 per 100k) and are not proposed initially                                                                                                                                                        | —                                                                                                                                   |
| **AWS Budgets**                                         | Cost alert                                 | Low    | Likely $0 for the first budgets (**free-tier terms unverified**) | Same                                           | Budget count                                                                                                                                                                                                                  | —                                                                                                                                   |
| WAF                                                     | Edge protection                            | Yes    | not proposed                                                     | ~$5 + $1/rule + $0.60/M req                    | —                                                                                                                                                                                                                             | Deferred until the exposure model justifies it (`CLAUDE.md` §4)                                                                     |

## 3. Totals (UNVERIFIED, excludes existing manual resources in §1)

| Stage                                                             | Fixed floor                                      | Usage (pilot scale) | **Estimated total / month** |
| ----------------------------------------------------------------- | ------------------------------------------------ | ------------------- | --------------------------- |
| Dev                                                               | RDS ~$14 + KMS $1 + secret $0.40 + alarms ~$0.50 | ~$1                 | **≈ $17–20**                |
| Prod, Single-AZ `t4g.small`                                       | ~$26 + $1 + $0.40–1.20 + ~$1                     | ~$2–6               | **≈ $31–36**                |
| Prod, Multi-AZ `t4g.small`                                        | ~$52–58 + $1 + ~$1.20 + ~$1                      | ~$2–6               | **≈ $57–68**                |
| + Secrets Manager interface endpoint (if chosen over IAM DB auth) | +$7.30 per AZ                                    |                     |                             |

Pilot-scale assumption: 1 tenant, ≤ 100 caregivers, ≤ 5,000 visits/month, ≤ 1M API calls/month.

**Per-caregiver marginal cost is effectively $0** (Cognito within free MAU tier, Lambda/API per-request, S3 per-KB), in line with `CLAUDE.md` §11.

## 4. What the Phase 1 scaffold would cost if deployed

`infra/aws` → `Ogevia-<stage>-EvidenceStorage` (not deployed):

- 1 KMS CMK: **$1/month fixed** per stage (UNVERIFIED), plus requests.
- 2 S3 buckets: $0 fixed, cents per month at pilot scale.
- No NAT, no endpoints, no compute, no database.

## 5. Cost controls to create before production

1. An AWS Budget with 50%, 80%, and 100% alerts on a monthly limit set by the owner. Proposed: $75 for prod, $30 for dev.
2. Cost-allocation tags `project=ogevia` and `stage=<stage>`. The CDK app applies these already.
3. Finite CloudWatch log retention on every log group.
4. A monthly `ce get-cost-and-usage` review, added to the runbook.
