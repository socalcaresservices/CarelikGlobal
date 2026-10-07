# Phase 1 — Cost Model of Modeled Infrastructure

**Date:** 2026-10-01 · **Deployment status of everything below: NOT DEPLOYED (cost today = $0).** No purchasing decision or budget change is made or implied. The AWS budget is unchanged.

## Price source

Unit prices marked **VERIFIED** came from the AWS Price List API (`aws pricing get-products`, read-only, `ogevia-readonly`) for US West (Oregon) on 2026-10-01. Free tiers are **ignored**, so these are upper-bound list prices. Usage figures are **assumptions**.

| Unit                                   | VERIFIED list price                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| KMS customer-managed key               | $1.00 per key **version** per month (rotation adds versions; AWS's published cap on rotation charges was not returned by the API and is UNVERIFIED) |
| KMS requests (symmetric)               | $0.03 per 10,000                                                                                                                                    |
| CloudWatch alarm (standard resolution) | $0.10 per alarm-month                                                                                                                               |
| CloudWatch Logs ingestion (Standard)   | $0.50 per GB                                                                                                                                        |
| CloudWatch Logs storage                | $0.03 per GB-month                                                                                                                                  |
| Lambda arm64 compute                   | $0.0000133334 per GB-second (tier 1)                                                                                                                |
| Lambda arm64 requests                  | $0.20 per million                                                                                                                                   |
| API Gateway HTTP API                   | $1.00 per million (first 300M)                                                                                                                      |
| S3 Standard storage                    | $0.023 per GB-month (first 50 TB)                                                                                                                   |
| Secrets Manager                        | $0.40 per secret-month                                                                                                                              |
| Interface VPC endpoint                 | $0.01 per endpoint-AZ-hour (≈ $7.30/month per AZ)                                                                                                   |
| NAT gateway                            | $0.045 per hour (≈ $32.85/month) + data processing                                                                                                  |

## Modeled resources

Pilot assumption: 1 tenant, 5,000 visits/month, about 8 API calls per visit (40,000 requests), ~200 ms × 512 MB per call, ~1 KB of logs per call, ~50 KB per signature.

| Resource                                                                          | Cost class | Fixed monthly                            | Usage at pilot (est.)                     | Scaling driver                             | Cheaper alternative considered                                                                   | Status       |
| --------------------------------------------------------------------------------- | ---------- | ---------------------------------------- | ----------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------ |
| KMS evidence key                                                                  | FIXED      | $1.00 (more as rotation versions accrue) | KMS requests ≈ $0.01 (Bucket Key enabled) | Number of key versions                     | AWS-managed `aws/s3` key ($0), rejected because Ogevia can't control its key policy for evidence | NOT DEPLOYED |
| Signature + access-log buckets                                                    | USAGE      | $0                                       | ≈ $0.01 (0.25 GB/month added)             | Visits × signature size; versions retained | —                                                                                                | NOT DEPLOYED |
| HTTP API                                                                          | USAGE      | $0                                       | $0.04                                     | Requests                                   | REST API costs more per request                                                                  | NOT DEPLOYED |
| Lambda                                                                            | USAGE      | $0                                       | requests $0.008 + compute ≈ $0.05         | Requests × duration × memory               | Always-on compute, rejected by the directive                                                     | NOT DEPLOYED |
| 2 log groups (365 d)                                                              | USAGE      | $0                                       | ingestion ≈ $0.02 + storage < $0.01       | Log volume × retention                     | Shorter retention (owner decision D-06)                                                          | NOT DEPLOYED |
| 6 CloudWatch alarms                                                               | FIXED      | $0.60                                    | —                                         | Alarm count                                | Fewer alarms                                                                                     | NOT DEPLOYED |
| SNS topic                                                                         | USAGE      | $0                                       | ≈ $0 (no subscriptions)                   | Notifications                              | —                                                                                                | NOT DEPLOYED |
| IAM role / policy, routes, permissions, stage, authorizer, alias, bucket policies | FREE       | $0                                       | $0                                        | —                                          | —                                                                                                | NOT DEPLOYED |
| **Total (if all deployed)**                                                       |            | **≈ $1.60/month**                        | **≈ $0.15/month**                         |                                            |                                                                                                  |              |

## Not modeled, but required to make the Lambda functional (decision D-P1-1)

| Option                                                | Fixed monthly                  | Note                                                |
| ----------------------------------------------------- | ------------------------------ | --------------------------------------------------- |
| Secrets Manager interface endpoint, 2 AZs             | ≈ $14.60 (+$0.01/GB)           | Or ≈ $7.30 in one AZ (loses AZ redundancy)          |
| RDS IAM authentication instead of fetching the secret | $0                             | Requires changing the CloudFormation-owned instance |
| S3 gateway endpoint                                   | $0                             | Adds routes to existing private route tables        |
| **NAT gateway**                                       | **$0, DEFERRED, not deployed** | Would be ≈ $32.85/month + $0.045/GB                 |

## Optional hardening not modeled (owner cost decisions)

| Item                                                         | Fixed monthly                     |
| ------------------------------------------------------------ | --------------------------------- |
| Customer-managed KMS key for log groups                      | $1.00 + requests                  |
| Customer-managed KMS key for the SNS alarm topic             | $1.00 + requests                  |
| RDS Multi-AZ (existing instance; change in its owning stack) | roughly doubles the instance cost |

## Existing baseline (unchanged by Phase 1)

The existing resources' costs are covered in `COST_MODEL.md` (Phase 0) and are not changed here. A newly confirmed fixed cost is the 2 SSM interface endpoints in 1 AZ: 2 × $0.01 × 730 ≈ $14.60/month, using the VERIFIED unit price.
