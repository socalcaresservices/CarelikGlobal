# Cost Model (Phase 0 draft)

**No dollar figures are asserted.** Current AWS prices and the actual account state were not verified (no valid credentials, and pricing must come from the AWS pricing pages at review time). This file lists resources, cost nature, and approval status per CLAUDE.md §11.

| Resource | Purpose | Fixed cost? | Scaling driver | Cheaper alternative | Status |
|---|---|---|---|---|---|
| RDS PostgreSQL (private) | Relational SV data | Yes (instance + storage + backup) | Instance class, storage | Single-AZ small class for pilot | Approved by directive; size UNKNOWN |
| Lambda + HTTP API | API layer | No | Requests/duration | — | Approved by directive |
| Cognito | Auth | No at small scale | MAU / tier | — | Approved by directive; verify tier pricing |
| S3 + KMS | Signatures | KMS key has monthly fee | Objects, requests | AWS-managed key (weaker control) | Approved by directive |
| VPC interface endpoints (SSM, SSM Messages, + any in NetworkEgress) | Admin access / private Lambda calls | **Yes, hourly per endpoint per AZ** | Endpoint × AZ count | Remove admin endpoints when temp host is retired | Existing; verify count |
| NAT Gateway | Lambda egress | **Yes, high** | Hours + data | VPC endpoints | **Not approved**; no NAT in committed templates |
| CloudFront/WebHosting | Frontend hosting | Usage + possible WAF | Transfer | Netlify (current) | **Not approved; DEFER** |
| WAF | Edge filtering | Yes | Rules + requests | Only if justified | Not approved |
| CloudWatch alarms/logs | Observability | Per alarm / per GB | Log volume | Finite retention | 6 alarms committed; verify retention set |
| CloudTrail, Budgets | Audit / cost | First trail free; verify | — | — | Verify existence |
| Temp EC2 `ogevia-db-admin-temp` | DB admin | Yes while running | Uptime | Stop/terminate after migrations | UNKNOWN state; verify and flag |

Open items: obtain actual Cost Explorer baseline once credentials work; confirm Lambda VPC egress needs (S3 gateway endpoint is free; Cognito/Secrets Manager calls from a VPC Lambda need interface endpoints or NAT).
