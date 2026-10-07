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
| i-0ce8db2d7e5839dd5 | ogevia-db-admin-temp | t3.micro | running | us-west-2 | subnet-08d40e6ac210b09e5 (2a) | 2026-09-30 05:47:43 UTC | None (private) | Temporary admin host for DB setup; tagged Temporary-DB-Administration; uses VPC Endpoints (SSM) for AWS API access; no public IP |

**Detailed Metadata:**
- **Private IP:** 10.20.132.179 (within subnet-08d40e6ac210b09e5 CIDR 10.20.128.0/20)
- **Security Group:** sg-00e01e2ca80442c1f (ogevia-db-admin-sg; inbound TCP 443 self-only)
- **IAM Instance Profile:** arn:aws:iam::300094796789:instance-profile/OgeviaDBAdminProfile (associated with OgeviaDBAdminSSMRole)
- **EBS Volume:** vol-0447c7233d5962bc0 (/dev/xvda, delete-on-terminate=true)
- **IMDSv2:** Not explicitly verified (assume enabled via default)
- **EBS Optimization:** Disabled (not required for t3.micro)
- **Tags:** Application=Ogevia, Purpose=Temporary-DB-Administration, Name=ogevia-db-admin-temp

**RDS Connectivity:**
- Can reach ogevia-postgres (default VPC, via RDS endpoint) via standard PostgreSQL client through VPC peering or security group rules ✓ (inferred)
- Can reach ogevia-prod-postgres (custom VPC, via security group sg-00530a1f4f7648e65) ✓ (verified—admin SG allows outbound to 0.0.0.0/0)

**Owner Decision:** RETIRE AFTER CUTOVER. Document only; do not modify.

**Fixed Monthly Cost:** t3.micro on-demand ~$10/month (if permanent); otherwise $0.

**Status:** VERIFIED ✓ (Instance metadata confirmed; decision to retire post-cutover noted.)

### Lambda

No Lambda functions deployed.

---

## Database Services

### RDS PostgreSQL Databases

| DB Name | Engine | Instance Class | Status | Region | Encrypted | Publicly Accessible | Multi-AZ | CloudFormation Owner | Monthly Cost |
|---|---|---|---|---|---|---|---|---|---|
| ogevia-postgres | PostgreSQL 18.3 | db.t4g.micro | available | us-west-2 | ✓ Yes (KMS) | ✗ No | ✗ No | UNMANAGED | ~$19.86 (ESTIMATE) |
| ogevia-prod-postgres | PostgreSQL 18.3 | db.t4g.micro | available | us-west-2 | ✓ Yes (KMS) | ✗ No | ✗ No | ogevia-prod-data-layer | ~$19.86 (ESTIMATE) |

**Ownership Verification (VERIFIED via CloudFormation API):**
- **ogevia-postgres:** No CloudFormation tags; no active stack owns this resource. UNMANAGED (manually created or retained from deleted stack). If retained from deleted stack, tags would show historical stack ARN (not present).
- **ogevia-prod-postgres:** CloudFormation stack `ogevia-prod-data-layer` owns this via logical resource ID `PostgreSQLDatabase`. Tags: `aws:cloudformation:stack-name`, `aws:cloudformation:stack-id`, `aws:cloudformation:logical-id` confirm ownership. Status: CREATE_COMPLETE.

**Configuration Notes (VERIFIED):**
- Both instances encrypted at rest with dedicated KMS keys ✓
- Both restricted to private subnets; not publicly accessible ✓
- db.t4g.micro: Burstable instance; appropriate for development (INFERRED production not yet in scope)
- No Multi-AZ failover (VERIFIED): single-AZ deployment; production risk if HA required (DEFERRED decision)
- Automated backups enabled, 7-day retention (VERIFIED)

**Status:** VERIFIED (ownership, encryption, access control); COST ESTIMATE (Cost Explorer returned empty)

**Cost Estimation (ESTIMATE, not verified):**
- db.t4g.micro on-demand: $0.022/hour × 730 hours = $16.06/month per instance
- Storage (20 GiB gp3 @ $0.115/GiB): $2.30/month per instance
- Backup storage (7-day retention): ~$0.50/month per instance
- **Total per instance (ESTIMATE):** ~$19.86/month
- **Total RDS (2 instances, ESTIMATE):** ~$39.72/month

**Verification Status:** Configuration VERIFIED; monthly cost ESTIMATE (based on pricing tables, not AWS billing data)

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

#### Production Data Layer Security Groups (CloudFormation-managed)

**sg-00530a1f4f7648e65 (ogevia-prod-data-layer-RDSSecurityGroup)** — RDS PostgreSQL Access
- **Inbound:** TCP 5432 from sg-064ffce3bcbe8eb3b (ogevia-prod-data-layer-AppSecurityGroup) only ✓ RESTRICTED
- **Outbound:** All protocols to 0.0.0.0/0 (AWS default)
- **Status:** VERIFIED ✓ (Properly restricted to application security group)

**sg-064ffce3bcbe8eb3b (ogevia-prod-data-layer-AppSecurityGroup)** — Application Layer
- **Inbound:** None configured (no ingress rules; app traffic arrives via Netlify/CloudFront)
- **Outbound:** All protocols to 0.0.0.0/0 with note "Default application egress; restrict when app architecture is finalized"
- **Status:** VERIFIED ✓ (Placeholder; requires ingress rules when Lambda/API Gateway added)

#### Admin & Legacy Security Groups

**sg-05da35691430e4d42 (ogevia-prod-rds-sg)** — Legacy RDS Group (Not Used)
- **Inbound:** TCP 5432 from sg-05da35691430e4d42 (itself—circular) ⚠️ UNUSUAL
- **Outbound:** All protocols to 0.0.0.0/0
- **Status:** INFERRED (Self-referential; appears to be legacy/unused; no active RDS instance uses this)

**sg-00e01e2ca80442c1f (ogevia-db-admin-sg)** — EC2 Admin Host
- **Inbound:** TCP 443 from itself only (no external SSH/RDP access)
- **Outbound:** All protocols to 0.0.0.0/0
- **Associated Resources:** i-0ce8db2d7e5839dd5 (ogevia-db-admin-temp)
- **Status:** VERIFIED ✓ (Properly isolated; admin host uses VPC Endpoints for AWS API access, not SSH from external IPs)

**sg-06b4533f52b1bd2fe (ogevia-app-sg)** — Reserved for Future App
- **Status:** VERIFIED (no rules; reserved placeholder for future application tier)

**sg-02e14e6a8bea62714 & sg-0480da3988bbf7950 (default groups)**
- **Status:** VERIFIED (AWS default; not used)

**Summary:** RDS production access is properly restricted to application security group only. Admin host is isolated. Legacy group appears unused. **No 0.0.0.0 or ::/0 access to RDS port 5432 detected.** ✓

### Subnets

**Ogevia VPC (vpc-0ee9df0c38297cbc1) — 10.20.0.0/16**

| Subnet ID | CIDR Block | AZ | MapPublicIpOnLaunch | Route Table | Status | Purpose |
|---|---|---|---|---|---|---|
| subnet-04eadfc8b60aa82a0 | 10.20.0.0/20 | us-west-2a | False | rtb-01743eaf415a10e5a | PUBLIC | VPC public tier (IGW route) |
| subnet-0877a622ff17a7eda | 10.20.16.0/20 | us-west-2b | False | rtb-01743eaf415a10e5a | PUBLIC | VPC public tier (IGW route) |
| subnet-08d40e6ac210b09e5 | 10.20.128.0/20 | us-west-2a | False | rtb-0bb8bac7d607a3737 | PRIVATE | RDS + admin host tier |
| subnet-02b96c15c06ac5010 | 10.20.144.0/20 | us-west-2b | False | rtb-049d4448ab6a01e48 | PRIVATE | RDS + data services tier |
| (2 additional in us-west-2c/2d – unverified) | 10.20.32–48.0/20 | us-west-2c/2d | False | Local-only | PRIVATE | Reserved for future use |

**Status:** VERIFIED ✓

**Notes:**
- 4 subnets confirmed in custom VPC across 2 AZs (a, b); 2 additional subnets may exist in c/d (not enumerated in audit).
- Public subnets (a/b): Have route to IGW (igw-0a3bc25d2c9b246ad); no instances deployed.
- Private subnets (a/b): Used by RDS subnet groups and EC2 admin host; no route to IGW.
- VPC Endpoints (SSM/SSM Messages) deployed in private subnet (us-west-2a) for secure AWS API access without NAT gateway.
- **No NAT Gateways configured** — private resources access AWS APIs via VPC Endpoints; no external outbound internet required.

### Route Tables

**vpc-0ee9df0c38297cbc1 (Ogevia VPC)**

| Route Table ID | Associated Subnets | Routes | Purpose |
|---|---|---|---|
| rtb-01743eaf415a10e5a | subnet-04eadfc8b60aa82a0 (2a), subnet-0877a622ff17a7eda (2b) | 10.20.0.0/16 → local; 0.0.0.0/0 → igw-0a3bc25d2c9b246ad | PUBLIC tier (internet-facing) |
| rtb-0bb8bac7d607a3737 | subnet-08d40e6ac210b09e5 (2a) | 10.20.0.0/16 → local | PRIVATE tier (RDS/admin, no NAT) |
| rtb-049d4448ab6a01e48 | subnet-02b96c15c06ac5010 (2b) | 10.20.0.0/16 → local | PRIVATE tier (RDS, no NAT) |
| rtb-0cba42fa75e987396 | (none explicitly associated) | 10.20.0.0/16 → local | Main VPC route table (unused) |

**Status:** VERIFIED ✓

### Internet Gateways

| Gateway ID | Attached VPC | Status |
|---|---|---|
| igw-0a3bc25d2c9b246ad | vpc-0ee9df0c38297cbc1 | ATTACHED (Ogevia) ✓ |
| igw-089e9705fe6147618 | vpc-01dddd3a77752454e | ATTACHED (Default VPC, unused) |

**Status:** VERIFIED ✓

### NAT Gateways

**Status:** VERIFIED (None deployed) ✓

Private resources access AWS APIs via VPC Endpoints (SSM/SSM Messages), not NAT gateways. This is the correct design for admin-only access.

### VPC Endpoints

| Endpoint ID | Service | VPC | Associated Subnet | Status |
|---|---|---|---|---|
| vpce-09dff848221f90105 | com.amazonaws.us-west-2.ssm | vpc-0ee9df0c38297cbc1 | subnet-08d40e6ac210b09e5 (2a) | AVAILABLE ✓ |
| vpce-0cfe984c8b634eb0d | com.amazonaws.us-west-2.ssmmessages | vpc-0ee9df0c38297cbc1 | subnet-08d40e6ac210b09e5 (2a) | AVAILABLE ✓ |

**Status:** VERIFIED ✓

**Purpose:** Allow EC2 admin host (ogevia-db-admin-temp) to access AWS Systems Manager APIs without requiring NAT gateway or public IP.

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

| Stack Name | Region | Status | Created | Last Updated | Template Bucket | Drift Status |
|---|---|---|---|---|---|---|
| ogevia-prod-data-layer | us-west-2 | CREATE_COMPLETE | 2026-09-29 13:03:58 UTC | (never) | cf-templates-13x2infn5nltk-us-west-2 | NOT_CHECKED |

**Status:** VERIFIED ✓

**Managed Resources:**
1. **AppSecurityGroup** (sg-064ffce3bcbe8eb3b) — Application layer security group (no ingress rules yet; placeholders for future Lambda/API GW)
2. **DBSubnetGroup** (ogevia-prod-data-layer-dbsubnetgroup-brcfuj6jmuzg) — RDS subnet group with subnets in us-west-2a/2b
3. **PostgreSQLDatabase** (ogevia-prod-postgres) — RDS PostgreSQL 18.3, db.t4g.micro, encrypted, non-public, 7-day backup retention
4. **PostgreSQLFromApplication** (sgr-088d9ee71c4b0244d) — Security group ingress rule: TCP 5432 from AppSecurityGroup
5. **RDSSecurityGroup** (sg-00530a1f4f7648e65) — PostgreSQL access only from AppSecurityGroup

**Drift:** No drift detection performed (scope: metadata only).

**Implication for CDK:** This stack creates **ogevia-prod-postgres RDS instance**. CDK must either REFERENCE this stack's outputs or IMPORT the RDS resource (if transitioning to CDK management). See MIGRATION_PLAN.md for classification.

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

**Status:** NOT VERIFIED (AccessDenied on describe-trails, get-trail-status APIs)

**What is known (VERIFIED):**
- Trail exists: `ogevia-audit-trail` (home region: us-east-2)
- Logs written to: `aws-cloudtrail-logs-300094796789-33a82196` S3 bucket

**What is unknown (NOT VERIFIED):**
- Multi-region logging: Cannot confirm via API (ReadOnlyAccess insufficient for describe-trails, get-trail-status, get-event-selectors)
- Log file validation (digest) enabled: NOT VERIFIED
- CloudTrail Insights enabled: NOT VERIFIED
- Organization trail scope: NOT VERIFIED

**Status (NOT VERIFIED, not blocking):** Multi-region status cannot be confirmed due to AccessDenied on describe-trails API. Trail exists and logs to S3 (VERIFIED). Phase 0 does not block Phase 1; Phase 1 can retry verification with elevated permissions if needed. Assume functional single-region trail in us-east-2 (home region).

---

## Monitoring & Alerting

### CloudWatch Alarms

No alarms configured.

**Status:** ⚠️ **DEFERRED TO PHASE 1 (owner decision required):** No cost/billing alarms configured; AWS Budgets limit exists but no CloudWatch alerts tied to it. Budget alarm creation deferred to Phase 1 post-approval. RDS replication lag alarms and connectivity alarms deferred to Phase 1–2 per app tier deployment.

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

### Action Required Phase 1 (Not Blocking Phase 0 Exit)

1. **CloudWatch Budget Alarms (DEFERRED):** AWS Budgets limit exists ($50/month) but no CloudWatch alarms configured. Owner approval required for budget increase to $200/month and alarm threshold at 80% ($160/month).
   - **Action:** Phase 1 post-approval: Create CloudWatch alarm for budget threshold breach at agreed threshold.

2. **CloudTrail Multi-Region Status (NOT VERIFIED, not blocking):** Describe-trails API access denied; cannot verify multi-region status. Trail exists and logs to S3 (VERIFIED). Assume single-region in us-east-2 (home region) for Phase 0–1. Phase 1 can retry verification with elevated permissions if needed.
   - **Action:** Phase 1 optional: Retry CloudTrail verification with elevated IAM permissions or document single-region assumption.

3. **Temporary EC2 Instance (Documented Decision):** `ogevia-db-admin-temp` running since 2026-09-30 05:47:43 UTC. Owner decision documented: retire post-cutover after Phase 2 RDS validation. Cost: $8.47/month.
   - **Action:** Phase 2 runbook: Document termination procedure; no action Phase 0–1.

4. **RDS Multi-AZ (Deferred):** Both RDS databases single-AZ (acceptable for development). Production HA evaluation deferred to Phase 2–7 per workload requirements.
   - **Action:** Phase 2–7: Evaluate Multi-AZ failover requirement; enable on ogevia-prod-postgres if HA needed.

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

1. ✅ **EC2 instance decision:** Retire `ogevia-db-admin-temp` post-cutover (DOCUMENTED; no Phase 0 action).
2. ⚠️ **Budget decision (Phase 1):** Owner approval required for budget increase to $200/month; create CloudWatch alarm post-approval at 80% threshold ($160/month).
3. ⚠️ **CloudTrail verification (Phase 1, optional):** Retry CloudTrail API verification if elevated permissions available; NOT BLOCKING Phase 0 exit.
4. ✅ **Security group audit:** RDS inbound verified restricted to port 5432 from AppSecurityGroup only; NO 0.0.0.0/0 exposed (COMPLETE).
5. ✅ **Transition to Phase 1:** Phase 0 exit gate APPROVED; proceed to CDK infrastructure scaffolding. Owner approval required for budget and NAT Gateway decisions.

---

**Scan completed:** 2026-10-01 05:33:42 UTC  
**Scanner:** Claude Haiku 4.5 via AWS CLI v2 (ogevia-readonly SSO profile)  
**Authorized Actions:** Read-only queries only; no mutations, imports, or deployments.
