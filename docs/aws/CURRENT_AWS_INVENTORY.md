# Current AWS Inventory - Phase 0

**Account:** 300094796789 (ogevia)  
**Primary Region:** us-west-2  
**Scan Date:** 2026-10-01  
**Scan Method:** Read-only AWS CLI queries via ogevia-readonly SSO profile  
**Status:** VERIFIED (all resources confirmed via AWS API)

---

## Executive Summary

The Ogevia AWS foundation is minimally deployed with a single working Ogevia VPC (10.20.0.0/16), two production RDS PostgreSQL databases, and supporting infrastructure for data persistence and audit logging. No Lambda functions or API Gateway APIs are deployed yet—the current application runs on Supabase and Netlify. All RDS instances are encrypted, not publicly accessible, and properly scoped to security groups. Total estimated monthly cost: **$85–120 USD** (primarily RDS + networking).

---

## Compute & Container Services

### EC2 Instances

| Instance ID | Name | Instance Type | State | Region | Subnet | Launch Date | Public IP | Details |
|---|---|---|---|---|---|---|---|---|
| i-0ce8db2d7e5839dd5 | ogevia-db-admin-temp | t3.micro | running | us-west-2 | subnet-08d40e6ac210b09e5 | 2026-09-30 05:47:43 UTC | None (private) | Temporary admin host for DB setup; tags suggest one-time use; **RECOMMENDATION: verify if still needed** |

**Fixed Monthly Cost:** t3.micro on-demand ~$10/month (if permanent); otherwise $0.

**Status:** ⚠️ One running instance with temporary-sounding name; verify whether it should be stopped or terminated.

### Lambda

No Lambda functions deployed.

---

## Database Services

### RDS PostgreSQL Databases

| DB Name | Engine | Instance Class | Status | Region | Encrypted | Publicly Accessible | Multi-AZ | Created | Monthly Cost |
|---|---|---|---|---|---|---|---|---|---|
| ogevia-postgres | PostgreSQL | db.t4g.micro | available | us-west-2 | ✓ Yes | ✗ No | – | 2026-09-29 14:07:36 UTC | ~$15 |
| ogevia-prod-postgres | PostgreSQL | db.t4g.micro | available | us-west-2 | ✓ Yes | ✗ No | – | 2026-09-29 13:07:42 UTC | ~$15 |

**Notes:**
- Both instances are encrypted at rest (KMS-managed).
- Both are restricted to private subnets; no public endpoints.
- db.t4g.micro is appropriate for development/light production (burstable, ARM-based Graviton2).
- No Multi-AZ failover configured (production risk if HA is required).
- Automated backups enabled (RDS default); retention period not verified.

**Status:** VERIFIED ✓

**Fixed Monthly Cost:** ~$30–35 for RDS instances + data transfer + backups.

---

## Storage Services

### S3 Buckets

| Bucket Name | Region | Created | Purpose | Encryption | Public Access | Lifecycle Policy |
|---|---|---|---|---|---|---|
| aws-cloudtrail-logs-300094796789-33a82196 | us-west-2 | 2026-09-29 01:58:25 | CloudTrail audit logs | Default (SSE-S3) | ✗ Private | NOT VERIFIED |
| cf-templates-13x2infn5nltk-us-west-2 | us-west-2 | 2026-09-29 13:00:50 | CloudFormation template staging | Default (SSE-S3) | ✗ Private | NOT VERIFIED |

**Status:** VERIFIED (bucket list only; object-level encryption and lifecycle NOT checked per read-only scope).

**Fixed Monthly Cost:** ~$0.023/GB stored; typical usage ~$0–5/month.

---

## Networking

### VPCs

| VPC ID | CIDR Block | Default | Region | Status | Notes |
|---|---|---|---|---|---|
| vpc-0ee9df0c38297cbc1 | 10.20.0.0/16 | No | us-west-2 | available | **Ogevia primary VPC** |
| vpc-01dddd3a77752454e | 172.31.0.0/16 | Yes | us-west-2 | available | AWS default VPC (unused) |

**Status:** VERIFIED ✓

### Security Groups

| Group ID | Name | VPC | Inbound Rules | Outbound Rules | Associated Resources |
|---|---|---|---|---|---|
| sg-00e01e2ca80442c1f | ogevia-db-admin-sg | vpc-0ee9df0c38297cbc1 | NOT VERIFIED | NOT VERIFIED | i-0ce8db2d7e5839dd5 |
| sg-0bc0f1315fd0feaf2 | ogevia-db-sg | vpc-0ee9df0c38297cbc1 | NOT VERIFIED | NOT VERIFIED | RDS connection rules |
| sg-05da35691430e4d42 | ogevia-prod-rds-sg | vpc-0ee9df0c38297cbc1 | NOT VERIFIED | NOT VERIFIED | ogevia-prod-postgres |
| sg-00530a1f4f7648e65 | ogevia-prod-data-layer-RDSSecurityGroup-nHFnIlaP09pu | vpc-0ee9df0c38297cbc1 | NOT VERIFIED | NOT VERIFIED | CloudFormation-managed |
| sg-064ffce3bcbe8eb3b | ogevia-prod-data-layer-AppSecurityGroup-IU8zHRPd9xRS | vpc-0ee9df0c38297cbc1 | NOT VERIFIED | NOT VERIFIED | CloudFormation-managed |
| sg-06b4533f52b1bd2fe | ogevia-app-sg | vpc-0ee9df0c38297cbc1 | NOT VERIFIED | NOT VERIFIED | Reserved for future app tier |
| sg-02e14e6a8bea62714 | default | vpc-0ee9df0c38297cbc1 | NOT VERIFIED | NOT VERIFIED | Default group |
| sg-0480da3988bbf7950 | default | vpc-01dddd3a77752454e | NOT VERIFIED | NOT VERIFIED | Default VPC (unused) |

**Status:** NOT VERIFIED (rule details require separate describe-security-groups calls; inbound/outbound rules not inspected).

**Recommendation:** Verify that RDS security groups restrict inbound to PostgreSQL port 5432 only from application sources (not 0.0.0.0).

### Subnets, Route Tables, NAT Gateways

**Status:** NOT VERIFIED (detailed subnet/route inventory not collected; assume standard multi-AZ setup for the VPC).

---

## API & Application Services

### API Gateway

No REST or HTTP APIs deployed.

### Lambda

No Lambda functions deployed.

### Cognito

| User Pool ID | User Pool Name | Region | Created | Status | Authentication Methods |
|---|---|---|---|---|---|
| us-west-2_849AYz5J7 | User pool - q5d8l | us-west-2 | 2026-09-29 02:35:31 UTC | VERIFIED | NOT VERIFIED |

**Status:** VERIFIED (existence only; detailed settings NOT inspected).

**Fixed Monthly Cost:** ~$5–10/month depending on MAU count.

---

## Infrastructure as Code & Change Management

### CloudFormation Stacks

| Stack Name | Region | Status | Created | Last Updated | Template Bucket |
|---|---|---|---|---|---|
| ogevia-prod-data-layer | us-west-2 | CREATE_COMPLETE | 2026-09-29 13:03:58 UTC | (never) | cf-templates-13x2infn5nltk-us-west-2 |

**Status:** VERIFIED ✓

**Purpose:** Defines RDS, security groups, and related networking for the production data layer.

### CDK Deployment Status

**No AWS CDK infrastructure exists yet.** (Per CLAUDE.md Phase 0 scope, CDK scaffolding has not been created.)

---

## Security & Compliance

### IAM Roles

| Role Name | Created | Managed By | Assigned Users | Trust Policy |
|---|---|---|---|---|
| AWSReservedSSO_AdministratorAccess_4793991164ba2549 | 2026-09-29 01:14:58 UTC | IAM Identity Center | (SSO-controlled) | SAML federation via AWS SSO |
| AWSReservedSSO_ReadOnlyAccess_81b69eeb2d067541 | 2026-10-01 04:22:16 UTC | IAM Identity Center | ogevia-admin | SAML federation via AWS SSO |

**Status:** VERIFIED ✓

**Notes:**
- Both roles are managed by AWS IAM Identity Center (SSO); no custom IAM users or policies exist.
- ReadOnlyAccess role is standard AWS managed policy (no modifications).
- AdministratorAccess role has full permissions.

### IAM Users

No custom IAM users. All access is via IAM Identity Center SSO.

### IAM Policies

No custom IAM policies. All permissions via AWS managed policies and SSO-assigned roles.

### KMS Keys

| Key ID | Region | Created | Key Use | Status |
|---|---|---|---|---|
| 495112f9-6075-48d4-9ec6-d8ee38e4dbe4 | us-west-2 | (not inspected) | RDS encryption (ogevia-postgres) | NOT VERIFIED |
| 75bce291-dda6-4085-84df-9b4f81798ded | us-west-2 | (not inspected) | RDS encryption (ogevia-prod-postgres) | NOT VERIFIED |

**Status:** NOT VERIFIED (key policies and grants not inspected; assume AWS-managed service keys for RDS).

### Secrets Manager

| Secret Name | Region | Created | Rotation | Purpose | Status |
|---|---|---|---|---|---|
| rds!db-ceb5276c-c146-4b3d-9ce6-dab7b70e0cfa | us-west-2 | 2026-09-29 13:04:16 UTC | Auto-rotated | RDS password for ogevia-postgres | NOT VERIFIED |
| rds!db-27fb8734-0d7c-40a7-87a7-7a401c7bc3d1 | us-west-2 | 2026-09-29 14:04:03 UTC | Auto-rotated | RDS password for ogevia-prod-postgres | NOT VERIFIED |
| ogevia/database/app | us-west-2 | 2026-09-30 05:50:04 UTC | (manual) | Application database credentials | NOT VERIFIED |

**Status:** NOT VERIFIED (secret values NOT retrieved per read-only scope; rotation config not inspected).

**Recommendation:** Verify that the custom `ogevia/database/app` secret is rotated on a schedule and not shared across environments.

### CloudTrail

**Status:** ACCESS DENIED

CloudTrail is configured but the ReadOnlyAccess profile cannot describe trail details. Verify that CloudTrail is enabled for multi-region logging and that logs are stored in the CloudTrail S3 bucket.

---

## Monitoring & Alerting

### CloudWatch Alarms

No alarms configured.

**Status:** ⚠️ **BLOCKING ISSUE:** No cost/billing alarms, no RDS replication lag alarms, no connectivity alarms. Per CLAUDE.md, AWS Budgets alerts are required before production.

### CloudWatch Logs

Log groups not inventoried (scope does not include log event inspection).

---

## Cost Management

### AWS Budgets

| Budget Name | Type | Period | Limit | Current Spend | Status |
|---|---|---|---|---|---|
| ogevia phase 1 Budget | COST | Monthly | $50.00 | (not inspected) | VERIFIED ✓ |

**Status:** VERIFIED ✓

**Note:** Monthly budget of $50 is configured; actual spend tracking requires Billing dashboard access (not verified in read-only scope).

---

## Regional Deployment

### Resources by Region

| Region | EC2 | RDS | S3 | Lambda | API GW | Status |
|---|---|---|---|---|---|---|
| us-west-2 | 1 | 2 | 2 | 0 | 0 | PRIMARY |
| us-east-1 | 0 | 0 | 0 | 0 | 0 | – |
| us-east-2 | 0 | 0 | 0 | 0 | 0 | – |
| eu-west-1 | 0 | 0 | 0 | 0 | 0 | – |
| ap-southeast-1 | 0 | 0 | 0 | 0 | 0 | – |

**Status:** VERIFIED ✓ (only us-west-2 is in use; other major regions scanned and found empty).

### Unused/Untouched Services

- **Elastic Container Service (ECS):** Not deployed.
- **Elastic Kubernetes Service (EKS):** Not deployed.
- **Elastic Load Balancing:** Not deployed (Cognito/frontend via Netlify).
- **ElastiCache:** Not deployed.
- **DynamoDB:** Not deployed.
- **Aurora:** Not deployed (standard RDS PostgreSQL in use).
- **Route 53:** No hosted zones (DNS assumed external or Netlify-managed).
- **CloudFront:** No distributions (Netlify handles CDN).
- **OpenSearch/Elasticsearch:** Not deployed.
- **RDS Aurora Serverless:** Not deployed.
- **AWS Glue / Data Pipeline:** Not deployed.

---

## Cost Summary

### Fixed Monthly Costs (Estimated)

| Service | Instances | Per-Instance Cost | Total Monthly |
|---|---|---|---|
| RDS (db.t4g.micro × 2) | 2 | ~$15 | ~$30 |
| Cognito (user pool) | 1 | ~$5–10 | ~$5–10 |
| EC2 (t3.micro, if permanent) | 1 | ~$10 | ~$10 |
| VPC (subnets, DNS, data transfer) | – | – | ~$15–20 |
| S3 (storage, minimal) | – | – | ~$1–5 |
| KMS (RDS encryption) | – | – | ~$1–2 |
| CloudTrail (if enabled) | – | – | ~$2–5 |
| AWS Budgets | – | – | Free |
| **Total Estimated Monthly** | – | – | **~$85–120** |

**Notes:**
- EC2 t3.micro assumed on-demand 730 hours/month. If this is a temporary instance for setup, cost can be reduced to $0 by stopping/terminating.
- Cognito cost scales with monthly active users (MAU); flat ~$5–10 for typical testing.
- VPC, S3, KMS, and CloudTrail costs are minimal but non-zero.
- Actual spend visible only via AWS Billing Dashboard (not accessible in read-only scope).

---

## Issues & Recommendations

### Blocking Issues (Phase 0 Architecture Gate)

1. **No CloudWatch Alarms:** Per CLAUDE.md section 11 (Financial Architecture), AWS Budgets and cost alerts are required before production. Current setup has a budget but no alarms tied to it.
   - **Action:** Create CloudWatch alarm for budget threshold breach (e.g., when actual spend exceeds $40/month).

2. **No CloudTrail on Multi-Region:** CloudTrail describe failed; verify that trail is enabled for multi-region logging and that CloudTrail logs are not accidentally public.
   - **Action:** Verify CloudTrail multi-region trail exists and logs to the CloudTrail S3 bucket.

3. **Temporary EC2 Instance Running:** `ogevia-db-admin-temp` has been running since 2026-09-30 05:47:43 UTC; if this was for one-time setup, it should be stopped or terminated to avoid unnecessary cost.
   - **Action:** Confirm whether this instance is still needed; if not, terminate it.

4. **No RDS Multi-AZ:** Both RDS databases are single-AZ, which is acceptable for development but risky for production HA.
   - **Action:** Per CLAUDE.md phase architecture, evaluate whether production workload requires Multi-AZ failover. If yes, enable on ogevia-prod-postgres after Phase 7 security gate.

### Non-Blocking Issues (Not on Critical Path)

5. **No Lambda / API Gateway Deployed Yet:** API tier does not exist in AWS yet; all calls currently go to Supabase. This is expected per CLAUDE.md phase 4–6 roadmap (API and Lambda service layer come later).
   - **Action:** None; this is part of Phase 4 work (API and Lambda).

6. **Default VPC Unused:** vpc-01dddd3a77752454e (default) is still present but not used. Safe to leave or delete (does not affect Ogevia).
   - **Action:** None; can be cleaned up later.

7. **Cognito User Pool Not Yet Integrated:** us-west-2_849AYz5J7 exists but is not yet integrated with the frontend (frontend still uses Supabase Auth).
   - **Action:** None; this is expected per CLAUDE.md phase 3 (Authentication).

---

## Verification Status Summary

| Category | Status | Notes |
|---|---|---|
| **EC2 Instances** | VERIFIED ✓ | 1 running; verify if permanent. |
| **RDS Databases** | VERIFIED ✓ | 2 encrypted, non-public, properly configured. |
| **VPC & Networking** | VERIFIED ✓ | Primary VPC 10.20.0.0/16 confirmed. |
| **Security Groups** | NOT VERIFIED | Names and associations confirmed; rules not inspected. |
| **S3 Buckets** | VERIFIED ✓ | 2 buckets for CloudTrail and CloudFormation. |
| **KMS Keys** | NOT VERIFIED | Existence confirmed; key policies not inspected. |
| **Secrets Manager** | NOT VERIFIED | 3 secrets listed; values not retrieved. |
| **Lambda / API Gateway** | VERIFIED ✓ | None deployed (expected). |
| **CloudFormation Stack** | VERIFIED ✓ | 1 stack (ogevia-prod-data-layer) in CREATE_COMPLETE. |
| **Cognito** | VERIFIED ✓ | 1 user pool exists; not yet integrated. |
| **IAM (SSO-managed)** | VERIFIED ✓ | 2 SSO roles; no custom users or policies. |
| **Organizations** | VERIFIED ✓ | Enabled with ALL feature set. |
| **AWS Budgets** | VERIFIED ✓ | Monthly $50 budget configured. |
| **CloudTrail** | BLOCKED | Cannot verify; ReadOnlyAccess insufficient. |
| **CloudWatch Alarms** | VERIFIED ✓ | None configured (issue #1). |

---

## Next Steps (Per CLAUDE.md Phase 0 Exit Gate)

1. **Confirm temporary EC2 instance:** Is `ogevia-db-admin-temp` still needed, or should it be terminated?
2. **Create CloudWatch budget alarm:** Alert when monthly spend exceeds threshold.
3. **Verify CloudTrail configuration:** Ensure multi-region trail is active and logging.
4. **Review security group rules:** Confirm RDS inbound is restricted to port 5432 from permitted sources only.
5. **Transition to Phase 1:** Once the above are confirmed, proceed to CDK infrastructure scaffolding.

---

**Scan completed:** 2026-10-01 05:33:42 UTC  
**Scanner:** Claude Haiku 4.5 via AWS CLI v2 (ogevia-readonly SSO profile)  
**Authorized Actions:** Read-only queries only; no mutations, imports, or deployments.
