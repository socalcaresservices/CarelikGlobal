# Ogevia monthly platform cost estimate (October 2026)

**Status:** ESTIMATE. This is not an invoice and has not been reconciled
with AWS Cost Explorer or a bill.

**Region:** us-west-2.

**Sources:**
- Resource list: the deployed CloudFormation templates of release 0022–0026
  (pin `0ca5616`). These were read from the CDK output that matches the
  owner-reported deployment, not from a live AWS call.
- Unit rates: `COST_MODEL.md` and `PHASE_1_COST_MODEL.md` (verified there on
  2026-10-01).
- SES and SMS rates: secondary sources, because aws.amazon.com is blocked
  from this environment. Re-check them on the AWS pricing pages before any
  approval.

**Billing check:** the owner should compare this estimate with the AWS
Billing console (Bills → us-west-2, current month) to confirm it.

## 1. Fixed baseline: what runs today (AWS TEST, one agency)

| Item | Basis | Monthly | Status |
|---|---|---|---|
| RDS `ogevia-prod-postgres` (db.t4g.micro, single-AZ, 20 GiB gp3, 7-day backups) | $0.022/h × 730 + storage + backup | ≈ $19.86 | Deployed (CloudFormation-owned) |
| RDS `ogevia-postgres` (second instance, not owned by any stack) | same | ≈ $19.86 | **Last-known; verify.** If it is unused, retiring it is a RED action: snapshot first, then delete only with explicit approval. |
| Interface endpoint: Secrets Manager (1 AZ) | $0.01/endpoint-AZ-hour | ≈ $7.30 | Deployed (NetworkEgress) |
| Interface endpoint: Lambda (1 AZ), for the identity function, approved with release 0022–0026 | same | ≈ $7.30 | Deployed (NetworkEgress) |
| S3 gateway endpoint | free | $0 | Deployed |
| SSM + SSM Messages interface endpoints (admin host access) | 2 × $7.30 | ≈ $14.60 | Last-known (manual); verify |
| Admin host `ogevia-db-admin-temp` (t3.micro) | $0.0116/h while running; about $0.64 for the disk while stopped | $0.64–8.47 | Used only during release DB windows; keep it stopped otherwise |
| KMS keys (evidence bucket key + RDS/Secrets keys) | $1 per key | ≈ $2–3 | Deployed |
| Secrets Manager | $0.40 per secret | ≈ $1.20 | Deployed |
| CloudWatch alarms (6) + SNS topic | $0.10 per alarm | ≈ $0.60 | Deployed (Observability) |
| CloudFront, S3 web bucket, Cognito | free tier or usage-based at pilot volume | ≈ $0–1 | Deployed. Cognito pricing tier: verify (INFERRED: free below 10,000 monthly active users) |
| **Fixed total (today)** | | **≈ $54–83** | The range depends on the second RDS instance, the SSM endpoints and the admin host |
| Fixed total if the unused second RDS instance and SSM endpoints are retired | | ≈ $33–40 | Each retirement needs its own approval |

**New fixed cost in release 0027–0034: none.** That release adds no AWS
resource, only API routes, code and migrations, as checked by
`release_0036_gate.py`.

## 2. Variable cost per agency (usage-driven)

Assumption for the pilot: one agency, about 25 clients, 30 caregivers and
1,500 visits per month, with about 30 API calls per visit (screens plus
actions).

| Driver | Pilot (1 agency) | 10 agencies (about 15,000 visits) |
|---|---|---|
| API Gateway HTTP API ($1.00 per million requests) | about 45k → $0.05 | about 450k → $0.45 |
| Lambda arm64 512 MB, about 100 ms | ≈ $0.05 | ≈ $0.50 |
| S3 signatures and documents (about 30 KB per signature, versions kept) | < $0.05 | ≈ $0.20 |
| CloudWatch Logs (365-day retention, $0.50/GB ingest) | ≈ $0.05 | ≈ $0.50 |
| KMS requests (bucket keys on) | ≈ $0.01 | ≈ $0.05 |
| **Variable total** | **< $1** | **≈ $2–3** |

## 3. Signature delivery (missing-signature recovery, not built)

| Option | Fixed | Per message | Pilot (≈ 50 requests per month) |
|---|---|---|---|
| Staff copy the link (recommended) | $0 | $0 | $0 |
| Amazon SES email | $0 | ≈ $0.10 per 1,000 (pay-as-you-go; secondary sources report SES plans introduced 07/21/2026) | < $0.01 |
| SMS, 10DLC (AWS End User Messaging) | ≈ $4 one-time + ≈ $10/month campaign (≈ $2 low-volume) + ≈ $2/month number | ≈ $0.0088 per US message | ≈ $4–12 per month + registration time |

SMS is a new fixed cost and needs approval. See
`docs/product/SIGNATURE_RECOVERY_DESIGN.md` gate A.

## 4. Scenarios (AWS only)

| Scenario | Fixed | Variable | Monthly AWS |
|---|---|---|---|
| Pilot today (as deployed, both RDS, SSM endpoints) | ≈ $54–83 | < $1 | **≈ $55–84** |
| Pilot after retiring the unused second instance and endpoints | ≈ $33–40 | < $1 | **≈ $34–41** |
| 10 agencies, production-hardened: RDS db.t4g.small Multi-AZ (≈ $47 + ≈ $5 storage), endpoints in 2 AZs (+$14.60), GuardDuty (≈ $5–15, usage-based), 35-day backups | ≈ $100–140 | ≈ $2–3 | **≈ $105–145** |

The 10-agency instance size is an **INFERRED** sizing. Confirm it with load
tests and RDS CloudWatch metrics (CPU credits, memory, connections) before
committing to it.

## 5. Maintenance effort (people cost dominates)

| Activity | Hours per month (estimate) |
|---|---|
| Dependency and security updates, Node/Lambda runtime patches | 4–8 |
| Release management (rehearse, deploy window, verification) | 4–8 per release |
| Monitoring, alarms, backup and restore drills | 2–4 |
| Agency support (from PRICING_PROPOSAL.md) | 2–5 per agency |

At 10 agencies, support (20–50 hours) is far larger than infrastructure.
The $50 per hour support rate in PRICING_PROPOSAL.md is an assumption.

## 6. Pricing by client volume

Unchanged. See `docs/product/PRICING_PROPOSAL.md`: a proposal from $149 for
1–10 active clients to $999 for 101–200, plus onboarding. It is **not
activated.**

At 10 agencies averaging 25 clients ($249 each), revenue is about $2,490 per
month, against about $105–145 for AWS and about $1,000–2,500 for support at
2–5 hours per agency. That is an assumption to validate in the pilot.

## 7. Actions that change cost (each needs approval)

1. Confirm that `ogevia-postgres` and the SSM endpoints are unused, then
   approve retirement (saves ≈ $34/month). The admin host relies on SSM.
   Replacing it with another DB access path is a design change.
2. Create the AWS Budget and alert at the agreed threshold. The current
   budget ($50) is below today's estimate.
3. Signature delivery channel (section 3).
4. Production hardening (Multi-AZ, 2-AZ endpoints, GuardDuty) before real
   client data at more than one agency.
