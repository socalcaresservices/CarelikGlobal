# Security Decisions (Phase 0)

| # | Item | Status | Evidence / action |
|---|---|---|---|
| 1 | AWS BAA executed | UNKNOWN | Owner must confirm in AWS Artifact before any production ePHI |
| 2 | RDS private, encrypted | UNKNOWN | No RDS in templates; verify live `PubliclyAccessible=false`, `StorageEncrypted=true` |
| 3 | Credentials in this container | **FINDING** | Static `AWS_ACCESS_KEY_ID/SECRET` are present in the session environment and are invalid. Treat as exposed/stale: rotate/deactivate in IAM, and prefer short-lived Identity Center sessions. Values were not printed. |
| 4 | Authorization model | Design | Cognito groups → app roles; org and role resolved server-side from DB, never from request body. Replaces RLS `auth.uid()` reliance in browser. |
| 5 | Timestamps | Design | `now()` in PostgreSQL inside start/end functions; ignore client times |
| 6 | Signatures | Design | S3 SSE-KMS, block public access, random object keys, presigned URL issued only after tenant+visit authorization; never log payloads |
| 7 | Immutability/corrections | Preserve | Port `correct_service_visit` + corrections table append-only semantics unchanged |
| 8 | Lambda in VPC | Verify | One committed Lambda is VPC-attached, one is not; confirm which touches PHI/DB and that logs omit PHI |
| 9 | 122-route API | Review | Each route needs explicit authz and tenant tests; reduce to Phase 4 scope |
| 10 | Prior doc "never print secrets, no questions, single push" | Superseded | CLAUDE.md yellow gates apply |
| 11 | Public-facing claims | Rule | Do not label as "EVV compliant"; Service Verification ≠ CalEVV/Sandata (§10) |

Weakening any control above requires explicit owner approval (§8.16).
