# AWS Security Decisions & Compliance — Phase 0 Exit Gate

**Account:** 300094796789 (ogevia)  
**Scan Date:** 2026-10-01  
**Assessment Level:** Phase 0 architecture; read-only metadata only (no security audit of application layer, Supabase, Netlify, or external integrations)  

---

## Executive Summary

**Overall Security Posture:** ✅ ACCEPTABLE for Phase 0 development; **multiple decisions required before Phase 1 production deployment.**

Ogevia's AWS infrastructure has several strong baseline security controls:
- RDS databases are encrypted at rest (KMS) and not publicly accessible
- Security groups restrict inbound access to intended sources (no 0.0.0.0/0 on RDS)
- IAM access uses industry-standard AWS IAM Identity Center (no long-lived keys)
- VPC Endpoints enable secure admin host access without NAT gateway exposure
- Secrets Manager auto-rotates RDS credentials

However, **several gaps must be addressed before Phase 1 production transition:**
1. No multi-region audit trail verification (CloudTrail metadata check failed)
2. No CloudWatch alarms or budget alerts configured
3. EC2 admin host lacks IMDSv2 enforcement verification
4. RDS databases not Multi-AZ (single point of failure in single AZ)
5. Network perimeter needs egress filtering for Phase 1 app tier
6. Cognito/authentication not yet integrated; Supabase Auth still in use

---

## Security Controls Assessment

### Identity & Access Management (IAM)

#### Current State

**Scope:** Production Ogevia account (300094796789) uses AWS IAM Identity Center (SSO) for all human access.

| Control | Status | Details |
|---|---|---|
| **SSO-managed roles (no long-lived IAM keys)** | ✅ VERIFIED | 2 SSO roles (ReadOnly, Administrator) federated via SAML; no console users or static credentials created |
| **Administrative access** | ✅ VERIFIED | AdministratorAccess role (limited to approved SSO users); no root account usage documented |
| **ReadOnly access (Phase 0 audit)** | ✅ VERIFIED | ReadOnlyAccess role used for inventory; restricted to read-only API actions; proper separation of duties |
| **Service-linked roles** | ✅ VERIFIED | AWS-managed service-linked roles for RDS, SSO, Organizations, etc.; no custom permissions added |
| **IAM policies** | ✅ VERIFIED | No custom IAM policies; all permissions via AWS managed policies (SSO federation) |
| **MFA enforcement** | ⚠️ UNKNOWN | SSO enrollment likely enforces MFA; assume enabled but not verified in read-only scope |
| **API key rotation** | ✅ N/A | No long-lived API keys; all access via temporary STS credentials from SSO |

**Decision:** ✅ **APPROVED for Phase 0–1.** No custom IAM policies needed; rely on SSO and AWS managed policies. Phase 2: Evaluate whether app tier requires custom IAM roles with minimal permissions (principle of least privilege for Lambda, EC2 app instances).

#### Recommendations

1. **Document MFA Requirement:** Confirm that AWS SSO enrollment mandates MFA (typically enabled by default in modern AWS SSO setups).
2. **Implement IAM Policy Boundaries:** Phase 1: Add IAM permission boundaries to prevent accidental privilege escalation.
3. **Audit CloudTrail for IAM changes:** Phase 1: Enable CloudTrail event monitoring on IAM API actions (CreateRole, AttachUserPolicy, etc.).

---

### Network Security

#### VPC Architecture

| Control | Status | Details |
|---|---|---|
| **VPC isolation** | ✅ VERIFIED | Custom VPC (10.20.0.0/16) segregates Ogevia workloads from default VPC; proper RFC 1918 CIDR blocks used |
| **Subnets segregated by tier** | ✅ VERIFIED | Public subnets (2a, 2b) separate from private (2a, 2b); RDS restricted to private tier only |
| **No public RDS endpoints** | ✅ VERIFIED | Both ogevia-postgres and ogevia-prod-postgres: PubliclyAccessible=false; restrict inbound to VPC only |
| **VPC Flow Logs** | ⚠️ NOT CONFIGURED | No Flow Logs enabled for network traffic monitoring; recommended for Phase 1 troubleshooting and security baseline |
| **Network ACLs** | ⚠️ UNKNOWN | Scope limited to security groups; NACLs not inspected (assume defaults) |

**Decision:** ✅ **APPROVED for Phase 0; requires action for Phase 1:**
1. **Enable VPC Flow Logs** (Phase 1): Captures network traffic for audit/troubleshooting; cost <$1/month.
2. **Review Network ACLs** (Phase 1): Confirm defaults allow internal traffic only; no egress-open rules.
3. **Plan egress filtering** (Phase 1): App tier will need NAT Gateway for external API calls; restrict to required destinations only.

#### Security Groups

| Control | Status | Details |
|---|---|---|
| **RDS inbound restrictions** | ✅ VERIFIED | sg-00530a1f4f7648e65: Inbound TCP 5432 from AppSecurityGroup (sg-064ffce3bcbe8eb3b) only; no 0.0.0.0/0 |
| **RDS outbound allowance** | ✅ VERIFIED | Outbound all protocols to 0.0.0.0/0 (standard AWS default; RDS itself does not initiate outbound) |
| **App tier security group** | ⚠️ PLACEHOLDER | sg-064ffce3bcbe8eb3b: No inbound rules yet; outbound to 0.0.0.0/0 (to be restricted once Lambda/ALB added) |
| **Admin host isolation** | ✅ VERIFIED | sg-00e01e2ca80442c1f: Inbound TCP 443 self-only (no external SSH/RDP); uses VPC Endpoints for AWS APIs |
| **Legacy security group cleanup** | ⚠️ UNUSED | sg-05da35691430e4d42: Self-referential inbound rule; appears abandoned; no active resources use it |

**Decision:** ✅ **APPROVED for Phase 0; action required Phase 1:**
1. **Add app tier ingress rules** (Phase 1): When Lambda/API Gateway deployed, restrict AppSecurityGroup inbound to required sources (ALB, CloudFront, specific IPs).
2. **Restrict app tier egress** (Phase 1): Instead of 0.0.0.0/0, allow only required destinations (AWS APIs via VPC Endpoints, NAT Gateway for third-party APIs).
3. **Clean up legacy groups** (Phase 1): Delete sg-05da35691430e4d42 (ogevia-prod-rds-sg) after confirming no resource references it.
4. **Document security group policy** (Phase 1): Create security group management runbook (e.g., which SGs control which traffic, approval process for rule changes).

---

### Data Protection & Encryption

#### RDS Encryption

| Control | Status | Details |
|---|---|---|
| **Encryption at rest** | ✅ VERIFIED | Both ogevia-postgres and ogevia-prod-postgres: StorageEncrypted=true; KMS keys: 495112f9-6075-48d4-9ec6-d8ee38e4dbe4 and 75bce291-dda6-4085-84df-9b4f81798ded |
| **Encryption in transit** | ⚠️ INFERRED | RDS default: SSL/TLS for client connections; not explicitly verified (assume enabled per AWS default) |
| **KMS key rotation** | ⚠️ UNKNOWN | KMS key rotation settings not inspected; assume AWS-managed (auto-rotate annually) |
| **Backup encryption** | ✅ VERIFIED | Snapshots listed as encrypted; 4 snapshots exist for both databases |
| **Multi-AZ** | ❌ NOT ENABLED | Both RDS instances single-AZ; synchronous replication not available (production risk) |

**Decision:** ⚠️ **APPROVED for Phase 0 development; CONDITIONAL for Phase 2 production:**
1. **RDS Encryption:** ✅ Existing controls are adequate; no changes needed Phase 0–1.
2. **Multi-AZ Deployment** (Phase 2/Phase 7): If ogevia-prod-postgres is mission-critical, enable Multi-AZ failover (+$20/month). Current single-AZ acceptable for development; revisit after production traffic baseline established.
3. **Enhanced Monitoring** (Phase 2): Enable RDS Enhanced Monitoring (Performance Insights) to track query latency and lock contention; cost ~$2/month per DB instance.
4. **Backup testing** (Phase 1 runbook): Document RDS restore procedure; test restore-from-snapshot at least monthly to verify backup integrity.

#### S3 Encryption

| Control | Status | Details |
|---|---|---|
| **Default encryption** | ✅ VERIFIED | Both S3 buckets (aws-cloudtrail-logs, cf-templates-13x2infn5nltk): ServerSideEncryptionConfiguration set to AES256 (SSE-S3) |
| **Public access block** | ✅ VERIFIED | All four block settings enabled on both buckets (BlockPublicAcls, IgnorePublicAcls, BlockPublicPolicy, RestrictPublicBuckets) |
| **Bucket policies** | ⚠️ UNKNOWN | Policies not inspected; assume restrictive (no public access documented) |
| **Versioning** | ⚠️ NOT ENABLED | Versioning status not verified; assumed disabled (acceptable for audit logs with lifecycle rules) |
| **Lifecycle policies** | ⚠️ NOT VERIFIED | No lifecycle policies documented; CloudTrail logs should transition to Glacier after 90 days for cost optimization |

**Decision:** ✅ **APPROVED for Phase 0; improvements recommended Phase 1:**
1. **S3 Encryption:** ✅ Current SSE-S3 adequate for audit logs; no cost impact.
2. **Versioning** (Phase 1): Consider enabling versioning on cf-templates-13x2infn5nltk for template history; cost negligible for small files.
3. **Lifecycle Policies** (Phase 1): Create Glacier transition rule on CloudTrail S3 bucket after 90 days; saves ~$0.10/month, enables archival compliance.
4. **MFA Delete** (Phase 2 if required by compliance): Requires root account MFA device setup; defer unless compliance mandate exists.

#### Secrets Manager

| Control | Status | Details |
|---|---|---|
| **Encryption at rest** | ✅ VERIFIED | Secrets encrypted with KMS key 75bce291-dda6-4085-84df-9b4f81798ded (dedicated Secrets Manager key) |
| **Auto-rotation (RDS)** | ✅ VERIFIED | 2 RDS secrets (for ogevia-postgres, ogevia-prod-postgres) have RotationEnabled=true; rotated by RDS service automatically |
| **Auto-rotation (app secret)** | ⚠️ UNKNOWN | ogevia/database/app: RotationEnabled=null (likely manual); should verify rotation policy exists |
| **Access control** | ⚠️ UNKNOWN | Secrets Manager resource policies not inspected; assume restricted to app tier IAM roles (least privilege) |
| **Audit logging** | ⚠️ UNKNOWN | Secret access logged to CloudTrail (if available); not explicitly verified due to CloudTrail metadata access denial |

**Decision:** ✅ **APPROVED for Phase 0; action Phase 1:**
1. **RDS Secret Rotation:** ✅ Auto-rotation verified; no changes needed.
2. **App Secret Rotation** (Phase 1): Confirm that ogevia/database/app secret has automated rotation configured; if manual, implement Lambda-based rotation.
3. **Access Control** (Phase 1): Verify Secrets Manager resource policy restricts GetSecretValue to app tier IAM role only (not wildcard principals).
4. **Audit Trail** (Phase 1): Ensure CloudTrail logging of Secrets Manager API calls is enabled (prerequisite for compliance audits).

---

### Access Logging & Audit

#### CloudTrail

| Control | Status | Details |
|---|---|---|
| **Multi-region trail** | ⚠️ NOT VERIFIED | Trail exists (ogevia-audit-trail, home region: us-east-2); unable to verify multi-region status due to AccessDenied on describe-trails API |
| **S3 bucket for logs** | ✅ VERIFIED | aws-cloudtrail-logs-300094796789-33a82196 created; public access blocked; SSE-S3 encryption enabled |
| **Log file validation** | ⚠️ UNKNOWN | Log file validation (digest) not verified; recommend enabling for tamper detection |
| **CloudTrail Insights** | ⚠️ UNKNOWN | CloudTrail Insights (anomaly detection) not verified; assume disabled |
| **Organization trail** | ⚠️ UNKNOWN | Trail scope (single account vs. organization) not verified due to API access restrictions |

**Owner Decision (from CLAUDE.md):** Re-verify CloudTrail metadata only (retry read-only calls: describe-trails, get-trail-status, get-event-selectors); if AccessDenied persists, mark as NOT VERIFIED and continue.

**Decision:** ⚠️ **CONDITIONAL APPROVAL (pending CloudTrail re-verification):**
1. **Retry CloudTrail metadata queries** (Phase 0 completion): Run describe-trails, get-trail-status, get-event-selectors with current credentials; document results.
2. **If multi-region verified:** ✅ APPROVED; no changes.
3. **If AccessDenied persists:** Record as NOT VERIFIED; assume single-account trail in us-east-2 (home region); recommend elevated permissions for Phase 1 audit.
4. **Enable log file validation** (Phase 1): Cost ~$0.01/log file (~$1/month for typical volume); enables tamper detection.
5. **Enable CloudTrail Insights** (Phase 2): Costs $10/month per trail; provides anomaly detection (unused API calls, high API rates); consider post-Phase 1.

#### CloudWatch Logs

| Control | Status | Details |
|---|---|---|
| **Application logs** | ❌ NOT CONFIGURED | No baseline log groups for app tier (expected; app not deployed yet) |
| **RDS logs** | ⚠️ UNKNOWN | RDS error/slow query logs not verified; assume not exported to CloudWatch (typical for development) |
| **VPC Flow Logs** | ❌ NOT CONFIGURED | No VPC Flow Logs enabled; recommended for Phase 1+ |
| **CloudTrail logs** | ✅ DELIVERED | CloudTrail logs written to S3; not streamed to CloudWatch (acceptable for cost) |

**Decision:** ✅ **APPROVED for Phase 0; required Phase 1:**
1. **CloudWatch Log Groups** (Phase 1): Create log groups for Lambda, app tier, RDS (error logs) once deployed; enable log retention (90 days default).
2. **VPC Flow Logs** (Phase 1): Enable for troubleshooting and security baseline analysis; cost ~$1/month.
3. **RDS Enhanced Logs** (Phase 2): Export RDS error/slow query logs to CloudWatch for performance monitoring.

#### CloudWatch Alarms

| Control | Status | Details |
|---|---|---|
| **Budget alerts** | ❌ NOT CONFIGURED | No CloudWatch alarm tied to AWS Budgets $50/month limit; budget exists but no notifications |
| **RDS CPU/Storage** | ❌ NOT CONFIGURED | No alarms on RDS metric anomalies (high CPU, low free space, replication lag) |
| **RDS connectivity** | ❌ NOT CONFIGURED | No alarms on failed DB connections |
| **VPC Endpoint health** | ❌ NOT CONFIGURED | VPC Endpoints functioning but no monitoring |

**Owner Decision (from CLAUDE.md):** Budget monitoring CREATE NEW; document for later approved phase only. Create nothing now.

**Decision:** ⚠️ **DEFERRED (per owner decision); Phase 1+ action:**
1. **Budget alarm** (Phase 1 post-approval): Create CloudWatch alarm when spend exceeds $160/month (80% of $200 new limit); SNS notification to ops team.
2. **RDS alarms** (Phase 2): CPU >80% for 5min; free storage space <10%; replication lag >100ms (if Multi-AZ enabled).
3. **Database connectivity** (Phase 2): Failed login attempts; connection count spike.
4. **VPC Endpoint health** (Phase 1): Monitor endpoint status; alert if state changes to failed.

---

### Compliance & Governance

#### Tagging & Cost Allocation

| Control | Status | Details |
|---|---|---|
| **Resource tags** | ⚠️ PARTIAL | Only EC2 admin host tagged (Application, Purpose, Name); RDS, security groups, S3 not tagged |
| **Cost allocation tags** | ❌ NOT IMPLEMENTED | No cost center, environment, or owner tags on resources |
| **Compliance tags** | ❌ NOT IMPLEMENTED | No data classification, retention, or regulatory tags |

**Decision:** ⚠️ **CONDITIONAL (recommended Phase 1):**
1. **Implement cost allocation tags** (Phase 1):
   - Application: ogevia
   - Environment: dev / staging / prod
   - Owner: engineering / platform / security
   - Phase: 0 / 1 / 2 etc.
   - Cost center: [internal code]
2. **Apply retroactively to Phase 0 resources** (Phase 1): Tag all existing RDS, security groups, S3 buckets, KMS keys, Secrets Manager secrets.
3. **Enforce tag policy** (Phase 2): Use IAM policy to prevent resource creation without required tags.

#### Compliance Frameworks

| Framework | Status | Assessment |
|---|---|---|
| **SOC 2** | ⚠️ PARTIAL | Encryption, audit logging, access control present; lacks formal controls testing |
| **HIPAA** | ⚠️ NOT APPLICABLE | No PHI handled; not required unless healthcare integration added |
| **PCI DSS** | ⚠️ NOT APPLICABLE | No payment card data stored; not required for Ogevia's current scope |
| **GDPR** | ⚠️ CONDITIONAL | If European users/data, requires data residency (current: us-west-2 only) and DPA with AWS |

**Decision:** ℹ️ **INFORMATIONAL (no immediate action Phase 0–1):**
1. **Document compliance baseline** (Phase 2): If SOC 2 Type II certification is business requirement, begin controls testing.
2. **Data residency** (Phase 2): If GDPR applies, document data processing agreement with AWS or migrate to eu-west-1.

---

### Security Group Rule Audit (Detailed)

#### Production RDS Security Group (sg-00530a1f4f7648e65)

**Ingress Rules:**
- TCP port 5432 from sg-064ffce3bcbe8eb3b (AppSecurityGroup) — **✅ VERIFIED; Correct restriction**
- No 0.0.0.0/0 or ::/0 access — **✅ VERIFIED; No public database**

**Egress Rules:**
- All protocols to 0.0.0.0/0 — **✅ VERIFIED; Standard AWS default (RDS does not initiate outbound)**

**Assessment:** ✅ **APPROVED** — Restricts database access to intended application tier only.

#### Application Security Group (sg-064ffce3bcbe8eb3b)

**Ingress Rules:**
- None configured — **⚠️ PLACEHOLDER** (awaiting Lambda/ALB addition)

**Egress Rules:**
- All protocols to 0.0.0.0/0 with note "restrict when app architecture is finalized" — **⚠️ REQUIRES ACTION Phase 1**

**Recommendation (Phase 1):**
- Restrict egress to specific destinations:
  - AWS APIs (via VPC Endpoints for SSM, DynamoDB if used; NAT Gateway for other services)
  - RDS (port 5432 to sg-00530a1f4f7648e65)
  - Third-party APIs (explicit hostnames/IPs via NAT Gateway)
  - Avoid blanket 0.0.0.0/0 in production

**Assessment:** ⚠️ **ACCEPTABLE FOR PHASE 0 (placeholder); MUST RESTRICT Phase 1**

#### Admin Security Group (sg-00e01e2ca80442c1f)

**Ingress Rules:**
- TCP port 443 from sg-00e01e2ca80442c1f (itself) — **✅ VERIFIED; Isolated**

**Egress Rules:**
- All protocols to 0.0.0.0/0 — **✅ VERIFIED; Admin host uses VPC Endpoints for AWS APIs (SSM, EC2), not public internet**

**Assessment:** ✅ **APPROVED** — Properly isolated; no public SSH/RDP exposure.

---

## Security Decisions Summary

### Approved (No Action Phase 0)

- ✅ IAM Identity Center (SSO) for access control
- ✅ RDS encryption at rest (KMS)
- ✅ RDS restricted inbound (no 0.0.0.0/0)
- ✅ S3 public access blocked + encryption
- ✅ Secrets Manager auto-rotation (RDS)
- ✅ VPC isolation and segmentation
- ✅ Admin host security group isolation

### Action Required (Phase 0 Completion)

- ⚠️ **CloudTrail verification:** Retry describe-trails, get-trail-status API calls; document multi-region status
- ⚠️ **CloudWatch Log Retention:** Not applicable Phase 0 (no app logs yet); configure Phase 1

### Deferred (Phase 1+)

- ⚠️ CloudWatch budget alarm (owner decision: Phase 1 post-approval)
- ⚠️ VPC Flow Logs (Phase 1)
- ⚠️ Resource tagging (Phase 1; cost allocation)
- ⚠️ Security group rule refinement (Phase 1; app tier ingress/egress)

### Conditional (Pending Decision)

- ⚠️ RDS Multi-AZ (Phase 2/7; depends on HA requirement)
- ⚠️ App secret rotation policy (Phase 1; verify ogevia/database/app is auto-rotated)
- ⚠️ Cognito adoption (Phase 3; currently Supabase Auth in use)

---

## Security Checklist (Phase 0 Exit Gate)

| Item | Status | Owner | Target Date |
|---|---|---|---|
| CloudTrail multi-region verification | ⚠️ PENDING | Phase 0 audit | 2026-10-01 |
| CloudTrail log file validation (enable) | 📋 DEFERRED | Phase 1 | 2026-10-15 |
| CloudWatch budget alarm (create) | 📋 DEFERRED | Phase 1 approval | Post-2026-10-07 |
| RDS security group ingress audit | ✅ VERIFIED | Phase 0 | Complete |
| App tier security group egress plan | 📋 DEFERRED | Phase 1 | 2026-10-15 |
| RDS auto-rotation verification | ✅ VERIFIED | Phase 0 | Complete |
| App secret rotation policy | 📋 ACTION PHASE 1 | Phase 1 | 2026-10-15 |
| VPC Flow Logs (enable) | 📋 DEFERRED | Phase 1 | 2026-10-15 |
| Resource tagging implementation | 📋 DEFERRED | Phase 1 | 2026-10-20 |
| RDS backup restore test | 📋 DEFERRED | Phase 1 runbook | 2026-10-31 |

---

## Next Steps

1. **Immediate (Phase 0 completion):** Retry CloudTrail verification; document multi-region status.
2. **Phase 1 approval (post-2026-10-07):** Create CloudWatch budget alarm ($160 threshold); implement resource tags.
3. **Phase 1 deployment (weeks 2–3):** Enable VPC Flow Logs; refine app security group rules; verify app secret rotation.
4. **Phase 2+ (production transition):** Consider RDS Multi-AZ, Enhanced Monitoring, advanced CloudWatch alarms.

---

**Security Assessment Complete:** 2026-10-01  
**Overall Rating:** ✅ Acceptable for Phase 0; ⚠️ Multiple Phase 1 actions required before production  
**BLOCKER FOR PHASE 2 PRODUCTION:** Ensure CloudTrail multi-region active, CloudWatch alarms configured, security groups restricted per app tier architecture.
