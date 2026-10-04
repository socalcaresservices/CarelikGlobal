# Ogevia subscription pricing by active-client volume (proposal, not activated)

**Status:** recommendation for owner review, 2026-10-04. No paid subscription, payment processor or billing code is activated by this document.

## 1. What is charged: active clients

**Active client (per agency, per calendar month):** a client of that agency with, in that month, at least one of:
- a current authorization period that overlaps the month, or
- a scheduled shift, or
- a non-voided visit.

A client is counted **once per month**, however many services, authorizations, caregivers or visits they have. Rules:
- A discharged or inactive client with none of the above is not counted.
- Synthetic, test and demo clients are not counted.
- Records are never charged twice when a visit is corrected: the correction replaces the visit.

The count is computed server-side from the agency's own records as of the last day of the month, and shown to the Administrator before invoicing. *(The counting function is not built yet. It is a prerequisite for billing.)*

Caregiver seats are **not** charged. That matches a workforce with many part-time caregivers and turnover, and avoids an incentive to share logins.

## 2. Cost facts and assumptions

Prices come from `docs/aws/PHASE_1_COST_MODEL.md` (AWS list prices, us-west-2, marked VERIFIED 2026-10-01) and `docs/aws/COST_MODEL.md` (configuration estimate 2026-10-01; Cost Explorer had no data). **Not re-verified today.** Re-check before any price is published.

**Shared monthly cost, the same whatever the number of agencies:**

| Item | Monthly | Basis |
| --- | --- | --- |
| RDS PostgreSQL (current instance) | ≈ $39.72 | COST_MODEL.md on-demand estimate |
| Interface VPC endpoints (Secrets Manager / SSM) | ≈ $14.60 | $0.01 per endpoint-AZ-hour |
| Admin host (only while running) | ≈ $8.47 | COST_MODEL.md; stop it when idle |
| KMS keys | ≈ $1–3 | $1 per key version |
| Secrets Manager | ≈ $1.20 | $0.40 per secret |
| CloudWatch alarms (6) | $0.60 | $0.10 per alarm |
| **Shared total** | **≈ $60–70** | Before production hardening |

**Production hardening (expected before many agencies):** RDS Multi-AZ roughly doubles the RDS line (+$40). GuardDuty is usage-based after its 30-day trial. Flow logs cost under $1 at pilot volume (INFERRED).

**Added cost per agency (usage-based):** prices are from the verified list in PHASE_1_COST_MODEL.md. The usage figures are **assumptions**.

| Driver | Expected agency (25 active clients, 30 caregivers) | Higher-usage agency (100 clients, 120 caregivers) |
| --- | --- | --- |
| API + Lambda (requests and compute) | ~20k requests → ≈ $0.05 | ~100k → ≈ $0.30 |
| S3 storage: signatures, documents, logo (versions kept) | ~0.5 GB → ≈ $0.01 | ~5 GB → ≈ $0.12 |
| KMS requests (bucket keys on) | ≈ $0.01 | ≈ $0.05 |
| CloudWatch logs | ≈ $0.05 | ≈ $0.30 |
| Notifications: Cognito invitations and resets | $0 on Cognito's default email, but that sender has a **low daily limit** (INFERRED: 50/day; verify). Onboarding many caregivers needs Amazon SES, which costs a few cents per 1,000 emails (UNVERIFIED). | same |
| Cognito sign-ins | **UNVERIFIED.** The pool is on the Essentials tier; check the current monthly-active-user free tier and per-user price before pricing. | same |
| AI | **$0.** AskCare is rule-based with no model calls. No AI feature is in scope. | $0 |
| **Infrastructure per agency** | **≈ $0.15–1** | **≈ $1–3** |

**The dominant cost is support, not infrastructure.** Assumptions: about 2 support hours per agency per month (expected) or 5 (higher usage), at $50 per hour. That is **$100 or $250**. Onboarding (data entry help, training) is a separate one-time fee.

## 3. Recommended monthly prices

| Active clients | Monthly price | Effective per client |
| --- | --- | --- |
| 1–10 | $149 | $15–149 |
| 11–25 | $249 | $10–23 |
| 26–50 | $399 | $8–15 |
| 51–100 | $649 | $6.50–13 |
| 101–200 | $999 | $5–10 |
| 200+ | Quoted ($4–5 per active client) | — |

Plus a one-time onboarding fee of $500–1,500, depending on data volume and training.

**Why these numbers (analysis, not fact):**
- **Coverage:**
  - The lowest band ($149) covers the expected support load ($100) plus a share of the shared platform cost.
  - The expected 25-client agency ($249) covers about 2 support hours with margin.
  - The 100-client band ($649) covers the higher-usage support load ($250) and infrastructure under $5.
- **Value test (assumption to validate in the pilot):** if Ogevia saves 15–20 minutes of office reconciliation per active client per month, 25 clients is about 6–8 office hours. That is worth more than $249 at typical office wages.
- **Shared cost:** the shared ≈ $60–70 (≈ $100–110 after Multi-AZ) is covered from the second paying agency onward. At 1 agency (SCS alone), the platform runs at a loss unless SCS's own value covers it.

## 4. Scenarios (monthly)

| Scenario | Revenue | Infrastructure | Support (assumed) | Before owner time and tax |
| --- | --- | --- | --- | --- |
| SCS only, 25 clients | $249 | ≈ $70 | $100 | ≈ +$79 |
| 5 agencies, about 25 clients each | $1,245 | ≈ $115 (with Multi-AZ) | $500 | ≈ +$630 |
| 5 agencies, about 100 clients each (higher usage) | $3,245 | ≈ $125 | $1,250 | ≈ +$1,870 |

## 5. Before activating any subscription

1. Re-verify every AWS price above, and the Cognito tier and email limits, on the official pricing pages.
2. Build the active-client count (section 1), with an Administrator preview.
3. Choose a payment processor. Card data must never touch Ogevia's database.
4. Write the terms of service and BAA terms with each agency (Ogevia handles their ePHI).
5. Track support hours during the pilot and recalibrate the assumption.
