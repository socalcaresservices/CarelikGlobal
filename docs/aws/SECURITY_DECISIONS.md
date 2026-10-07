# Security Decisions and Gaps (Phase 0)

**Status:** repo-level review only. Nothing here is verified against live AWS.

## Gates not yet met (CLAUDE.md section 8)
- AWS BAA acceptance: UNKNOWN (account-level; owner must confirm). No production PHI until confirmed.
- RDS private/encrypted/backups: UNVERIFIED.
- CloudTrail, finite log retention, Budgets: UNVERIFIED.

## Credential handling (action for owner)
Static `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` exist in this container's environment and are rejected by AWS.
Do not reuse; if they were ever real keys, rotate/deactivate them. Preferred: short-lived IAM Identity Center credentials, read-only for Phase 0.

## Design decisions carried forward
1. Individual Cognito identities; no shared caregiver logins.
2. Tenant id derived server-side from the verified token mapping, never from request body.
3. Timestamps for start/end generated in the database/Lambda.
4. Signature bytes only in private SSE-KMS S3; DB holds key + metadata; no payloads in logs; opaque object keys (no client name/ID).
5. Confirmed/locked visits immutable via ordinary paths; corrections append-only with original, new value, actor, time, reason.
6. No NAT gateway, no public RDS, no Object Lock without explicit approval.
7. Billing approval stays a human action; Ready for billing is not billed.

## Repo findings
- `infra/aws/cdk.out/` committed build output without source: remove from VCS tracking or restore source; confirm templates contain no account-specific secrets before any sharing.
- 122 routes in the API template exceed the approved vertical slice; each exposed route is attack surface and needs authorization-negative tests.
- Deployment docs instruct sequential production deployment without the Phase 0 sign-off; superseded by CLAUDE.md gates.
