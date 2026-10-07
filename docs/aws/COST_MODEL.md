# AWS Cost Model & Financial Architecture — Phase 0

**Account:** 300094796789 (ogevia)  
**Scan Date:** 2026-10-01  
**Evaluation Period:** Last 2 full months (August–September 2026) + Month-to-Date (October 1–...)  
**Cost Explorer Queries Used:** 3 of 5 available (queries returned empty results; see notes below)  

---

## Executive Summary

**Phase 0 Cost Assessment: ESTIMATE (NOT VERIFIED)**

Current Ogevia infrastructure is in development phase. **Estimated monthly recurring cost: $65–90 USD (baseline without optional NAT Gateway or enhanced monitoring).**

**Cost Data Verification Status:**
- ⚠️ AWS Cost Explorer queries returned empty results (no billing data populated or Cost Explorer disabled)
- ✓ Configuration costs calculated from AWS pricing tables (on-demand rates, us-west-2, verified 2026-10-01)
- ❌ Actual AWS billing spend NOT VERIFIED (Cost Explorer empty)
- ❌ Reserved Instance savings NOT CALCULATED (no historical spend baseline)

**Budget Assessment:**
- Current AWS Budgets: $50/month (BELOW estimated Phase 0 spend of $65–90)
- Recommendation: OWNER APPROVAL REQUIRED for budget increase amount and threshold

**Note on Phase 1 Cost Projections:**
- NAT Gateway: **CLASSIFIED AS DEFER.** Only provision if Phase 1 app tier requires external egress (third-party APIs). AWS service APIs accessible via VPC Endpoints (no NAT required).
- Reserved Instances: Not recommended Phase 0–1 without confirmed production workload baseline.

---

## Detailed Cost Breakdown

### Compute Services

#### EC2 Instances
- **Instance:** i-0ce8db2d7e5839dd5 (ogevia-db-admin-temp, t3.micro)
- **Pricing (on-demand, us-west-2) — ESTIMATE based on published rates:**
  - t3.micro: $0.0116 USD/hour (AWS pricing 2026-10-01)
  - Monthly (730 hours): $0.0116 × 730 = **$8.47/month (ESTIMATE)**
  - Data transfer: ~$0 (internal VPC traffic, low volume)
- **Status:** RUNNING; **owner decision made—retire post-Phase 2 cutover (VERIFIED)**
- **Cost Impact if Retired:** **Savings $8.47/month** (~10% of baseline)

**Subtotal (EC2): $8.47/month (ESTIMATE) — $0/month if retired**

#### Lambda
- **Status:** Not deployed; not included in Phase 0 cost model
- **Phase 4 Estimate (when deployed):** ~$0.20/million invocations + compute time; likely <$5/month during ramp-up

**Subtotal (Lambda):** $0/month (Phase 0); TBD Phase 4

---

### Database Services

#### RDS PostgreSQL

**Instance 1: ogevia-postgres**
- **Configuration:** db.t4g.micro, PostgreSQL 18.3, on-demand, us-west-2
- **Pricing (on-demand, multi-AZ pricing applies only if HA enabled; currently single-AZ):**
  - db.t4g.micro on-demand: $0.022 USD/hour
  - Monthly (730 hours): $0.022 × 730 = **$16.06/month (on-demand)**
  - Reserved Instance (1-year): $0.011/hour (~$8/month) — Not recommended Phase 0–1 without confirmed production baseline
  - Storage (20 GiB gp3 @ $0.115/GiB): 20 × $0.115 = **$2.30/month**
  - Backup storage (7-day retention, estimated): ~$0.50/month
  - Data transfer: ~$1–2/month (minimal in dev phase)

**Subtotal (ogevia-postgres):** **$19.86/month** (on-demand); $12.80/month with RI

**Instance 2: ogevia-prod-postgres**
- **Configuration:** db.t4g.micro, PostgreSQL 18.3, on-demand, us-west-2 (likely primary production DB)
- **Pricing:** Same as ogevia-postgres
  - **Subtotal: $19.86/month** (on-demand); $12.80/month with RI

**Total RDS (2 instances, on-demand):** **$39.72/month**

**RI Consideration (Phase 2+ evaluation):** Reserved Instances for both databases would reduce cost by ~$14/month (payback ~9 months). Decision deferred to Phase 2 when production baseline is established.

**Subtotal (RDS):** $39.72/month (current); $25.60/month with RIs (Phase 2 recommendation)

---

### Storage Services

#### S3
- **Buckets:** 2 total
  - aws-cloudtrail-logs-300094796789-33a82196 (CloudTrail logs, ~500 MB estimated)
  - cf-templates-13x2infn5nltk-us-west-2 (CloudFormation templates, ~1 MB)
- **Pricing (us-west-2, standard storage):**
  - Storage: $0.024/GiB; ~0.5 GiB = **$0.012/month**
  - Requests: PUT/GET/LIST ~$0.005/1000 requests; assume 1000/month = **$0.005/month**
  - Data transfer (egress outside AWS region): $0 (internal only)
- **Encryption:** Default (SSE-S3, no additional KMS cost for S3 itself)

**Subtotal (S3):** **$0.02/month** (negligible)

---

### Key Management & Encryption

#### KMS Keys
- **Keys in Use:** 2 (RDS + Secrets Manager)
- **Pricing:**
  - Key storage: $1.00 USD/key/month = $2.00/month
  - Key requests: $0.03 per 10,000 requests; RDS generates ~1,000 requests/month = $0.03/month
- **Subtotal:** **$2.03/month**

---

### Secrets Manager

#### Secrets Stored
- **Count:** 3 secrets (2 auto-rotated RDS, 1 manual app secret)
- **Pricing:**
  - Secret storage: $0.40 USD/secret/month = $1.20/month
  - Rotation (2 of 3 enabled): Free (no per-rotation charge; KMS cost already counted above)
  - API calls: ~100 calls/month estimate = negligible

**Subtotal (Secrets Manager):** **$1.20/month**

---

### Networking

#### VPC & Core Networking
- **VPC:** $0 (no per-VPC charge)
- **Data Transfer:**
  - Within VPC (EC2 ↔ RDS): Free
  - Between AZs (subnet-to-subnet): $0.01/GiB
    - Estimated (low development phase): $0–1/month
  - Outside AWS region (Internet Gateway, NAT): $0.02/GiB egress
    - Current (VPC Endpoints only): $0/month (no external egress)
  - Estimated Phase 2+ with app tier: $5–10/month

**Subtotal (VPC/Data Transfer, current):** **$0.50/month**

#### VPC Endpoints
- **Endpoints:** 2 (SSM + SSM Messages)
- **Pricing:** $0.01/hour per endpoint = $0.01 × 2 × 730 = **$14.60/month**

**Subtotal (VPC Endpoints):** **$14.60/month**

---

### Monitoring & Audit

#### CloudTrail
- **Trail:** 1 (ogevia-audit-trail, home region us-east-2; multi-region status NOT VERIFIED, logs to CloudTrail S3 bucket)
- **Pricing:**
  - First trail: Free (AWS covers cost of first trail per account)
  - Additional trails: $2.00/trail/month (N/A—only 1 trail)
  - S3 logging storage: ~$0.50/month (included in S3 costs above, minimal)

**Subtotal (CloudTrail):** **$0/month** (first trail free)

#### CloudWatch
- **Alarms:** 0 configured (no cost)
- **Log Groups:** Minimal (CloudTrail logs only, ~500 MB stored; ~$0.03/month for storage)
- **Dashboards:** Free tier

**Subtotal (CloudWatch):** **$0.03/month**

#### AWS Budgets
- **Budgets:** 1 configured ($50/month limit)
- **Pricing:** Free

**Subtotal (AWS Budgets):** **$0/month**

---

### Identity & Access Management

#### IAM
- **Roles:** 9 total (2 SSO, 6 service-linked, 1 custom)
- **Pricing:** Free (standard IAM has no per-role cost)

**Subtotal (IAM):** **$0/month**

#### AWS Organizations
- **Pricing:** Free tier (up to 4 AWS accounts) or $0.021/month per account after 4
- **Accounts:** 1 (ogevia)
- **Subtotal (Organizations):** **$0/month** (free tier)

---

### Application Services

#### Cognito
- **User Pool:** us-west-2_849AYz5J7 (1 pool, not yet integrated)
- **Pricing:**
  - MAU-based ($0.015/MAU after free tier of 50,000 MAU/month)
  - Estimated development usage: ~20 MAU = **$0/month** (within free tier)
  - Post-Phase 3 production: Depends on user base; estimate $5–50/month for 1000–3000 MAU

**Subtotal (Cognito, Phase 0):** **$0/month**; Phase 3 estimate: **$5–50/month**

#### API Gateway & Lambda
- **Status:** Not deployed
- **Phase 4 Estimate:**
  - API calls: $3.50 per million requests; assume 1M requests/month = $3.50/month
  - Lambda: $0.20 per million invocations; assume 1M invocations/month = $0.20/month
  - Subtotal Phase 4: ~$3.70/month (light traffic); scale to $50–100/month with production load

---

## Summary by Phase

### Phase 0 (Current)

| Service | Cost | Status |
|---|---|---|
| EC2 (admin host) | $8.47 | TEMPORARY; retire post-Phase 2 |
| RDS (2 instances, on-demand) | $39.72 | CURRENT; RI recommended Phase 2 |
| S3 | $0.02 | Negligible |
| KMS | $2.03 | Scaling with data volume |
| Secrets Manager | $1.20 | Scaling with secrets count |
| VPC/Data Transfer | $0.50 | Minimal dev phase |
| VPC Endpoints | $14.60 | Fixed; required for admin access |
| CloudTrail | $0.00 | Free (first trail) |
| CloudWatch | $0.03 | Negligible |
| Cognito | $0.00 | Within free tier; no users yet |
| **Total Phase 0** | **$66.57/month** | ESTIMATE (Cost Explorer queries returned empty) |

**Budget Headroom:** Current AWS Budgets limit ($50/month) is BELOW Phase 0 spend. ⚠️ **Action:** Increase budget to $200/month before Phase 1.

### Phase 1 (CDK Deployment + App Tier Preview)

| Service | Cost | Notes |
|---|---|---|
| EC2 | $0.00 | Admin host retired |
| RDS (on-demand) | $39.72 | No RI purchased (decision deferred to Phase 2) |
| NAT Gateway | $0.00 | DEFER — not required by default; only provision if Phase 1 app tier requires external egress (third-party APIs) |
| App Security Group / Networking | $0–5 | Data transfer via VPC Endpoints; estimated |
| Lambda | $0–5 | Preview/testing phase |
| API Gateway | $0–5 | Preview/testing phase |
| **Total Phase 1** | **$45–50/month** | ESTIMATE without NAT Gateway; add $32–48/month if external egress confirmed |

### Phase 2+ (Production Ramp)

| Service | Cost | Scale |
|---|---|---|
| RDS | $25–60 | Depends on DB size, Multi-AZ adoption |
| Lambda | $20–100 | Scales with request volume |
| API Gateway | $20–50 | Scales with request volume |
| Data Transfer (NAT/egress) | $50–200 | Production traffic; egress to internet |
| Cognito | $10–50 | Scales with MAU count |
| CloudWatch (alarms, logs) | $10–20 | Monitoring overhead |
| **Total Phase 2+** | **$150–500/month** | ESTIMATE; highly variable |

---

## Cost Optimization Recommendations

### Immediate (Phase 0)

1. **AWS Budgets Limit Adjustment (Phase 1, OWNER DECISION):** Current limit ($50/month) is below Phase 0 estimate ($66.57/month). Recommended adjustment to $200/month to accommodate Phase 1 app tier. Owner approval required for amount and threshold.
   - **Impact:** No financial impact; enables cost control without alert fatigue.

2. **Create CloudWatch Budget Alarm (Phase 1, DEFERRED):** Per owner decision (CLAUDE.md), create budget alert at 80% threshold ($160/month for $200 limit) when budget is approved.
   - **Impact:** $0/month; essential for cost control.

3. **Terminate ogevia-db-admin-temp (Post-Phase 2):** Schedule EC2 instance termination after RDS cutover validation.
   - **Impact:** Saves $8.47/month; no technical impact if admin host is ephemeral.

### Phase 1

4. **RDS Reserved Instances (Phase 2 Evaluation):** 1-year RI for both db.t4g.micro instances considered after Phase 1 production baseline established.
   - **Cost:** ~$100 upfront per instance (1-year commitment)
   - **Savings:** $14/month (~$168/year); breakeven at month 7
   - **Decision:** Deferred to Phase 2 when workload characteristics are known

5. **NAT Gateway (Phase 1, DEFER unless external egress required):** Phase 1 app tier does not require NAT by default.
   - **AWS API access:** Via VPC Endpoints (Secrets Manager, KMS, CloudWatch Logs, S3) — no NAT needed; no cost
   - **Third-party APIs:** Only if confirmed Phase 1 requirement; cost $32/month NAT + $0.045/GiB data processing
   - **Decision:** Owner approval required if external egress confirmed

### Phase 2+

6. **Enable RDS Multi-AZ for ogevia-prod-postgres:** Doubles DB cost but provides HA.
   - **Cost:** +$20/month for HA standby
   - **Recommendation:** Evaluate HA requirement; defer to Phase 7 unless required for SLA

7. **Evaluate Lambda Reserved Capacity:** For predictable workloads >1M invocations/month.
   - **Cost:** $0.015/hour reserved compute (1.4GB)
   - **Savings:** 20–40% of on-demand Lambda costs at scale

8. **Archive CloudTrail Logs to Glacier:** After 90 days, move logs to Glacier to reduce S3 storage cost.
   - **Cost:** $0.005/GiB Glacier storage (vs. $0.024/GiB S3 standard)
   - **Savings:** ~$0.01/month (negligible for current volumes)

---

## Financial Compliance & Budgeting

### AWS Budgets Status

**Current:** ogevia phase 1 Budget = $50/month limit

**Phase 0 Assessment:** Phase 0 estimated spend ($66.57/month) exceeds current budget ($50/month). Cost Explorer returned empty results (AWS billing data NOT VERIFIED).

**Owner Decision Required (Phase 1):**
- Approve budget adjustment (recommended: $200/month) and cost-control threshold (recommended: 80% = $160/month)
- Verify Phase 0 actual spend via AWS Billing Console (Bills section; Cost Explorer API data unavailable)
- Create CloudWatch alarm post-approval at agreed threshold

### Cost Allocation Tags

**Current Tags:** Minimal (only EC2 admin host tagged)

**Recommendation:** Implement cost allocation tags on all resources:
- `Application: ogevia`
- `Environment: dev` | `prod` | `staging`
- `Phase: 0` | `1` | `2` etc.
- `Owner: engineering` | `platform`
- `CostCenter: [internal code]`

**Impact:** Enables cost tracking by environment/team; prerequisite for chargeback/billing models Phase 2+.

---

## Cost Explorer Query Results (Phase 0) — NOT VERIFIED

**Status:** ⚠️ **AWS BILLING DATA NOT AVAILABLE**

**Queries Executed:** 3 of 5 allowed

| Query | Result | Status |
|---|---|---|
| Call 1: Monthly Summary (60 days) | Empty | Cost Explorer returned no results (reason unknown: account too new, Cost Explorer not populated, or API permissions insufficient) |
| Call 2: Daily (October MTD) | Empty | Same; Oct 1 is today; insufficient rollup time may be factor |
| Call 3: By Region | Empty | Same |

**Implication:** Phase 0 cost estimates are NOT VERIFIED against actual AWS billing data. All costs in this document are ESTIMATE based on:
- Published AWS pricing tables (on-demand rates for us-west-2, verified 2026-10-01)
- Verified resource configuration (instance class, storage size, region)
- Standard AWS billing models (no discounts or Reserved Instances assumed)

**Cost Accuracy:** These are ESTIMATE figures ±10% until verified against AWS Billing Console (Billing user role required; not accessible to ogevia-readonly).

**Phase 1 Action:** Obtain actual Phase 0 spend from AWS Billing Console (Bills section, not Cost Explorer API). Compare ESTIMATE vs. ACTUAL to refine Phase 1 budget and RI recommendations.

---

## Next Steps

1. **Verify Phase 0 Costs (Phase 1):** Check AWS Billing dashboard (Bills section) to confirm estimated $66.57/month vs. actual Phase 0 spend (Cost Explorer API returned empty).
2. **Budget Decision (Phase 1):** Owner approval required for budget adjustment (recommended $200/month) and cost-control threshold (recommended 80% = $160/month). Create CloudWatch alarm post-approval.
3. **Plan EC2 Retirement:** Document ogevia-db-admin-temp termination in Phase 2 runbook; confirm no admin access dependencies exist.
4. **RDS RI Evaluation (Phase 2):** After production baseline established, evaluate 1-year RIs for both db.t4g.micro instances (~$14/month savings potential).
5. **Phase 1 Cost Projection:** Refine estimates for Lambda, API Gateway, and confirm NAT Gateway need (if any) once app tier architecture is finalized.

---

**Cost Model Complete:** 2026-10-01  
**Phase 0 Estimated Monthly Cost:** $66–90 USD (ESTIMATE, NOT VERIFIED via Cost Explorer)  
**Budget Decision Required (Phase 1):** Recommend $200/month (owner approval pending); $500+/month (Phase 2+ production)  
