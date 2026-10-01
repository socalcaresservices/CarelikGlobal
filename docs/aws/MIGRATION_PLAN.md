# AWS Infrastructure Migration Plan — Phase 0 Exit Gate

**Account:** 300094796789 (ogevia)  
**Scan Date:** 2026-10-01  
**Status:** Phase 0 detailed assessment complete  

---

## Resource Classification Matrix

Every AWS resource is classified into one of seven categories to guide CDK infrastructure scaffolding:

| Classification | Meaning | Action |
|---|---|---|
| **KEEP EXISTING** | Resource works; no changes needed; CDK reads-only via outputs/references | Document resource IDs; configure CDK to reference, not recreate |
| **REFERENCE FROM CDK** | CloudFormation stack exists; CDK should import stack outputs or use data sources | Update CDK to depend-on or data.source stack resources |
| **IMPORT INTO CDK** | Live resource should be transitioned to CDK management | Use CDK `FromLookup()` or `CfnResource` to adopt existing resource; no delete/recreate |
| **CREATE NEW** | Resource does not exist; CDK must define and create it | Add resource definition to CDK stacks; deploy via cdk deploy |
| **MIGRATE FROM SUPABASE** | Supabase-managed metadata (e.g., auth, org models) must move to AWS IAM/Cognito | Plan Supabase to AWS transition during Phase 3 (Auth)  |
| **DEFER** | Decision pending; requires clarification before CDK scaffolding | Note decision blocker; resolve in follow-up meeting |
| **RETIRE AFTER CUTOVER** | Resource exists but should be removed after Phase N cutover | Document in runbook; schedule termination post-migration |

---

## Phase 0 Resource Classifications

### Networking

#### VPC & Core Networking

| Resource | Type | Current State | Classification | CDK Action | Notes |
|---|---|---|---|---|---|
| vpc-0ee9df0c38297cbc1 | VPC (10.20.0.0/16) | EXISTS | **KEEP EXISTING** | Reference via data source; do not recreate | Primary Ogevia VPC; production traffic flows here |
| igw-0a3bc25d2c9b246ad | Internet Gateway (Ogevia VPC) | EXISTS | **KEEP EXISTING** | Reference; do not recreate | Attached; used by public subnets (2a, 2b) |
| rtb-01743eaf415a10e5a | Route Table (public, 2a/2b) | EXISTS | **KEEP EXISTING** | Reference; do not recreate | Routes to IGW; ready for future app tier |
| rtb-0bb8bac7d607a3737 | Route Table (private, 2a) | EXISTS | **KEEP EXISTING** | Reference; do not recreate | Local-only; used by RDS + admin host |
| rtb-049d4448ab6a01e48 | Route Table (private, 2b) | EXISTS | **KEEP EXISTING** | Reference; do not recreate | Local-only; used by RDS data tier |
| vpc-01dddd3a77752454e | Default VPC (172.31.0.0/16) | EXISTS, UNUSED | **RETIRE AFTER CUTOVER** | Do not reference; schedule deletion post-Phase 1 | No resources deployed; kept for AWS defaults |

#### Subnets

| Subnet ID | CIDR | AZ | Purpose | Classification | CDK Action |
|---|---|---|---|---|---|
| subnet-04eadfc8b60aa82a0 | 10.20.0.0/20 | 2a | PUBLIC tier (reserved) | **KEEP EXISTING** | Reference for future app/ALB |
| subnet-0877a622ff17a7eda | 10.20.16.0/20 | 2b | PUBLIC tier (reserved) | **KEEP EXISTING** | Reference for future app/ALB |
| subnet-08d40e6ac210b09e5 | 10.20.128.0/20 | 2a | RDS + admin host | **KEEP EXISTING** | Reference; used by RDS subnet groups |
| subnet-02b96c15c06ac5010 | 10.20.144.0/20 | 2b | RDS data services | **KEEP EXISTING** | Reference; used by RDS subnet groups |
| (2 additional) | 10.20.32–48.0/20 | 2c/2d | Reserved for future | **KEEP EXISTING** | Reference if discovered; part of multi-AZ setup |

#### VPC Endpoints

| Endpoint ID | Service | Classification | CDK Action |
|---|---|---|---|
| vpce-09dff848221f90105 | SSM | **KEEP EXISTING** | Reference; used by admin host for secure API access |
| vpce-0cfe984c8b634eb0d | SSM Messages | **KEEP EXISTING** | Reference; paired with SSM endpoint |

---

### Security Groups

#### Production Security Groups (CloudFormation-managed)

| Group ID | Name | Purpose | Classification | CDK Action | Notes |
|---|---|---|---|---|---|
| sg-00530a1f4f7648e65 | ogevia-prod-data-layer-RDSSecurityGroup | RDS PostgreSQL access | **REFERENCE FROM CDK** | CloudFormation stack manages this; CDK uses stack outputs or data source | Ingress rule: TCP 5432 from AppSecurityGroup |
| sg-064ffce3bcbe8eb3b | ogevia-prod-data-layer-AppSecurityGroup | Application layer (reserved) | **REFERENCE FROM CDK** | CloudFormation stack manages this; CDK uses stack outputs or data source | Placeholder; no ingress rules yet |

#### Admin & Legacy Security Groups

| Group ID | Name | Purpose | Classification | CDK Action | Notes |
|---|---|---|---|---|---|
| sg-00e01e2ca80442c1f | ogevia-db-admin-sg | EC2 admin host | **KEEP EXISTING** | Reference; do not recreate; tied to OgeviaDBAdminSSMRole instance profile | Self-referential inbound; used by i-0ce8db2d7e5839dd5 |
| sg-05da35691430e4d42 | ogevia-prod-rds-sg | Legacy (unused) | **RETIRE AFTER CUTOVER** | Do not reference; not in use; can be deleted post-Phase 1 | Self-referential; appears abandoned |
| sg-06b4533f52b1bd2fe | ogevia-app-sg | Reserved for app tier | **KEEP EXISTING** | Reference if needed for future app tier | Currently empty (placeholder) |
| sg-02e14e6a8bea62714, sg-0480da3988bbf7950 | Default VPC security groups | Unused | **RETIRE AFTER CUTOVER** | Do not reference; delete with default VPC | Not used by Ogevia resources |

---

### Compute

#### EC2 Instances

| Instance ID | Name | Type | Classification | CDK Action | Notes | Retirement Plan |
|---|---|---|---|---|---|---|
| i-0ce8db2d7e5839dd5 | ogevia-db-admin-temp | t3.micro | **RETIRE AFTER CUTOVER** | Do not manage in CDK; leave untouched; schedule termination after Phase 2 cutover | Temporary admin host for DB setup; not production workload | **Owner Decision:** Retire post-cutover. Document in runbook; terminate after production RDS cutover validation (~Phase 3 timebox). Cost savings: ~$10/month |

---

### Databases

#### RDS Instances

| Instance | Engine | Classification | CDK Action | Current Owner | Notes |
|---|---|---|---|---|---|
| ogevia-postgres | PostgreSQL 18.3, db.t4g.micro | **REFERENCE FROM CDK** | CloudFormation manages (via ogevia-prod-data-layer stack); CDK may reference stack outputs for connection strings | CloudFormation (ogevia-prod-data-layer stack) | Likely development/staging database; encrypted, non-public, 7-day backups |
| ogevia-prod-postgres | PostgreSQL 18.3, db.t4g.micro | **REFERENCE FROM CDK** | CloudFormation manages (via ogevia-prod-data-layer stack); CDK may reference stack outputs for connection strings | CloudFormation (ogevia-prod-data-layer stack) | Production database; encrypted, non-public, 7-day backups; managed by app layer |

**Migration Strategy:**
- **Phase 1 CDK Scaffolding:** Create CDK stack that depends-on or references the CloudFormation stack (ogevia-prod-data-layer).
- **Phase 2 (optional):** If transitioning RDS management to CDK, use `CfnResource` or manual adoption; do NOT recreate instances.

#### RDS Subnet Groups

| Subnet Group | Subnets | Classification | CDK Action | Notes |
|---|---|---|---|---|
| ogevia-private-db-subnets | subnet-08d40e6ac210b09e5 (2a), subnet-02b96c15c06ac5010 (2b) | **KEEP EXISTING** | Reference for data layer; do not recreate | Manual creation (pre-CDK); used by both RDS instances |
| ogevia-prod-data-layer-dbsubnetgroup-brcfuj6jmuzg | subnet-08d40e6ac210b09e5 (2a), subnet-02b96c15c06ac5010 (2b) | **REFERENCE FROM CDK** | CloudFormation-managed; CDK references stack outputs | Auto-created by CloudFormation stack |

#### RDS Snapshots

| Snapshot ID | DB Instance | Classification | CDK Action | Notes |
|---|---|---|---|---|
| (4 snapshots) | ogevia-postgres (2), ogevia-prod-postgres (2) | **KEEP EXISTING** | Reference for backups/recovery; do not recreate | All encrypted; available for restore |

---

### Storage

#### S3 Buckets

| Bucket Name | Purpose | Region | Classification | CDK Action | Notes |
|---|---|---|---|---|---|
| aws-cloudtrail-logs-300094796789-33a82196 | CloudTrail audit logs | us-west-2 | **KEEP EXISTING** | Reference or manage lifecycle in CDK | Encrypted (SSE-S3); public access blocked |
| cf-templates-13x2infn5nltk-us-west-2 | CloudFormation template staging | us-west-2 | **KEEP EXISTING** | Reference; do not recreate | Auto-created by CloudFormation; may be safe to delete post-Phase 1 if CDK replaces it |

**Cost:** Minimal (~$1-5/month for storage).

---

### Key Management

#### KMS Keys

| Key ID | Purpose | Classification | CDK Action | Notes |
|---|---|---|---|---|
| 495112f9-6075-48d4-9ec6-d8ee38e4dbe4 | RDS encryption (ogevia-postgres, ogevia-prod-postgres) | **KEEP EXISTING** | Reference in CDK for RDS encryption config; do not recreate | AWS-managed customer master key |
| 75bce291-dda6-4085-84df-9b4f81798ded | Secrets Manager encryption | **KEEP EXISTING** | Reference if Secrets Manager is used; do not recreate | AWS-managed customer master key |

---

### Secrets & Configuration

#### Secrets Manager

| Secret Name | Purpose | Classification | CDK Action | Notes |
|---|---|---|---|---|
| rds!db-ceb5276c-c146-4b3d-9ce6-dab7b70e0cfa | RDS auto-rotation (ogevia-prod-postgres) | **KEEP EXISTING** | Reference in CDK; do not recreate | Auto-rotated by RDS; already configured |
| rds!db-27fb8734-0d7c-40a7-87a7-7a401c7bc3d1 | RDS auto-rotation (ogevia-postgres) | **KEEP EXISTING** | Reference in CDK; do not recreate | Auto-rotated by RDS; already configured |
| ogevia/database/app | App DB credentials | **KEEP EXISTING** | Reference in CDK; ensure rotation is configured | Manual secret; verify rotation policy exists |

---

### Identity & Access Management

#### IAM Roles

| Role Name | Purpose | Classification | CDK Action | Notes |
|---|---|---|---|---|
| OgeviaDBAdminSSMRole | EC2 admin host SSM access | **KEEP EXISTING** | Reference in CDK for admin host instance profile; do not recreate | Custom role; allows SSM Session Manager access |
| AWSReservedSSO_ReadOnlyAccess_81b69eeb2d067541 | Phase 0 audit access | **KEEP EXISTING** | Reference if needed for post-Phase 1 read-only audits; do not recreate | SSO-managed; no custom policies |
| AWSReservedSSO_AdministratorAccess_4793991164ba2549 | Admin access for CDK deployments | **KEEP EXISTING** | Reference for CDK deploy role; do not recreate | SSO-managed; full permissions |
| AWSServiceRoleForRDS, AWSServiceRoleForOrganizations, etc. | AWS service-linked roles | **KEEP EXISTING** | Do not reference in CDK; AWS manages automatically | AWS service-linked; do not recreate |

---

### Monitoring & Audit

#### CloudTrail

| Trail Name | Type | Classification | CDK Action | Notes |
|---|---|---|---|---|
| ogevia-audit-trail | Multi-region trail (home: us-east-2) | **REFERENCE FROM CDK** | CDK may reference trail ARN; do not recreate | Trail logs to aws-cloudtrail-logs bucket; AccessDenied on metadata verification (NOT VERIFIED) |

#### CloudWatch

| Resource | Classification | CDK Action | Notes |
|---|---|---|---|
| Budget alarms | **CREATE NEW** | CDK or manual (owner decision: deferred for later phase) | Currently none; should be created after Phase 1 |
| Log groups | **CREATE NEW** | CDK creates as needed | No baseline log groups; app/RDS will generate logs during Phase 2+ |

#### AWS Budgets

| Budget Name | Limit | Classification | CDK Action | Notes |
|---|---|---|---|---|
| ogevia phase 1 Budget | $50/month | **KEEP EXISTING** | Reference in CDK or leave manual; do not recreate | Configured; alarm not yet created |

---

### Misc. Services

#### Cognito

| User Pool ID | Name | Classification | CDK Action | Notes |
|---|---|---|---|---|
| us-west-2_849AYz5J7 | User pool - q5d8l | **REFERENCE FROM CDK** (Phase 3) | Phase 3 (Auth): CDK to import or recreate as part of auth tier; for Phase 0, keep as-is | Currently unused; frontend uses Supabase Auth; will transition during Phase 3 |

#### API Gateway & Lambda

| Service | Status | Classification | CDK Action | Notes |
|---|---|---|---|---|
| API Gateway | Not deployed | **CREATE NEW** (Phase 4) | Phase 4: CDK defines REST/HTTP API; Lambda integration | Expected in Phase 4 roadmap |
| Lambda | Not deployed | **CREATE NEW** (Phase 4) | Phase 4: CDK defines Lambda functions; RDS/Cognito integration | Expected in Phase 4 roadmap |

#### Route 53, CloudFront

| Service | Status | Classification | CDK Action | Notes |
|---|---|---|---|---|
| Route 53 | No hosted zones | **DEFER** (or external) | Assume external DNS or Netlify management; CDK references if needed | DNS management decision pending |
| CloudFront | Not deployed | **DEFER** | Netlify currently handles CDN; future decision on AWS CDN | Not in Phase 0–2 scope |

---

## CDK Duplicate Analysis

### Existing CloudFormation Stack vs. CDK Scaffolding

**Stack:** ogevia-prod-data-layer (CloudFormation)

**Resources Managed:**
1. AppSecurityGroup (sg-064ffce3bcbe8eb3b)
2. DBSubnetGroup (ogevia-prod-data-layer-dbsubnetgroup-brcfuj6jmuzg)
3. PostgreSQLDatabase (ogevia-prod-postgres)
4. PostgreSQLFromApplication (ingress rule sgr-088d9ee71c4b0244d)
5. RDSSecurityGroup (sg-00530a1f4f7648e65)

### CDK Scaffolding Strategy (Phase 1)

**Option A (Recommended for Phase 0):** CDK stack depends-on CloudFormation stack
- CDK Subnets, VPC, IGW definitions reference existing resources via `data.aws_*` sources
- CDK does NOT recreate VPC, subnets, security groups managed by CloudFormation
- CDK output: RDS connection string, app security group ID for future Lambda/API Gateway
- **Result:** Zero duplication; CloudFormation owns data layer; CDK owns application layers (to be added Phase 2+)

**Option B (Post-Phase 1):** Gradual CDK adoption of CloudFormation stack
- Phase 1: Run `cdk bootstrap` and `cdk synth` to validate stack structure (no deploy yet)
- Phase 2: Use `cdk import` to transition RDS instance management to CDK (manual, complex)
- **Risk:** High; requires RDS snapshot/restore or manual adoption; not recommended for Phase 0

### Proposed Phase 1 CDK Structure

```
infra/
├── lib/
│   ├── ogevia-vpc-stack.ts          # References existing VPC, subnets, IGW, route tables
│   ├── ogevia-data-layer-stack.ts   # References existing RDS via CloudFormation stack outputs
│   ├── ogevia-app-stack.ts          # PLACEHOLDER (Phase 2) — Lambda, API Gateway
│   └── ogevia-auth-stack.ts         # PLACEHOLDER (Phase 3) — Cognito, IAM
├── bin/
│   └── ogevia.ts                    # Main CDK app; instantiates stacks
└── cdk.json                         # CDK configuration
```

**Stack Dependencies:**
- App Stack depends-on Data Layer Stack
- Data Layer Stack imports CloudFormation stack outputs
- Shared VPC Stack referenced by both

---

## Phase 1 Readiness Assessment

### Green Light ✓ (No Blockers)

1. **VPC, Subnets, Networking:** All exist; ready to reference in CDK
2. **RDS Instances:** Encrypted, properly secured; can be referenced via CloudFormation stack outputs
3. **Security Groups:** CloudFormation-managed; can be referenced; no conflicts
4. **IAM Roles:** SSO-managed admin role; custom admin SG role exists; ready for instance profiles
5. **Secrets Manager:** RDS secrets auto-rotated; app secret created; ready to reference

### Yellow Light ⚠️ (Action Required Before CDK Deploy)

1. **EC2 Admin Host:** Remains RUNNING; decision to retire post-cutover noted. CDK should NOT manage this instance; leave manual for now.
2. **CloudTrail:** Cannot verify multi-region configuration (AccessDenied). Assume active; verify separately.
3. **CloudWatch Alarms:** None configured. Create after Phase 1 (owner decision: deferred).
4. **RDS Multi-AZ:** Not configured. Acceptable for dev; document as future HA upgrade (Phase 7).

### Red Light ✗ (Blocking Issues)

**None for Phase 0 → Phase 1 transition.** All critical resources exist and are accessible.

---

## Next Steps (Immediate)

1. **Verify CloudTrail:** Separately confirm multi-region trail is active and logging (AccessDenied prevents automated verification).
2. **Initialize CDK scaffold:** Create `infra/` directory with cdk.json, bin/, lib/ structure per Phase 1 plan.
3. **Run `cdk synth`:** Generate CloudFormation template from CDK to verify stack topology (no deploy).
4. **Run `cdk diff`:** Compare generated template to existing CloudFormation stack; confirm zero duplication.
5. **Document decisions:** Confirm EC2 retirement plan, budget alarm creation timing, Cognito/Route 53 decisions.

---

**Classification Complete:** 2026-10-01  
**Phase 1 Readiness:** ✅ Approved (pending CloudTrail verification and CDK initialization)  
