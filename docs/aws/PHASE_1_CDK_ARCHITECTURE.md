# Phase 1 — CDK Architecture (Source of Truth)

**Date:** 2026-10-01 · **Branch:** `claude/phase1-cdk-source-of-truth` · **AWS changes:** NONE
**Account / region:** `300094796789` / `us-west-2` · **Read-only identity used:** `AWSReservedSSO_ReadOnlyAccess` (`ogevia-readonly`)

Legend: **VERIFIED** = read from a live read-only AWS API or the synthesized templates on 2026-10-01 · **INFERRED** · **DECISION** = owner decision required.

---

## 1. Target architecture and ownership

```text
                Netlify / React (existing app, unchanged)
                              |
                              v
        Cognito user pool us-west-2_849AYz5J7  ............ EXISTING (manual) — REFERENCED
        app client "ogevia-web" 1i27abbina08fvg1i9u8vprgo9  ... EXISTING (manual) — REFERENCED
                              |  access token (JWT)
                              v
        API Gateway HTTP API + JWT authorizer .............. FUTURE (CDK, Phase 4) — NOT DEPLOYED
                              |
                              v
        Lambda (arm64, Node 24, placeholder 501) ........... FUTURE (CDK, Phase 4) — NOT DEPLOYED
          in EXISTING private subnets 2a/2b, with EXISTING AppSecurityGroup (REFERENCED)
              |
              +--> RDS PostgreSQL ogevia-prod-postgres ..... EXISTING (CloudFormation ogevia-prod-data-layer) — REFERENCED
              |      RDSSecurityGroup already admits 5432 from AppSecurityGroup (existing rule)
              |
              +--> S3 signature bucket + KMS key ........... FUTURE (CDK, Phase 5) — NOT DEPLOYED
              |
              +--> Secrets Manager ogevia/database/app ..... EXISTING (manual) — REFERENCED (ARN only)
              |
              +--> CloudWatch log groups + 6 alarms + SNS .. FUTURE (CDK, Phase 4/7) — NOT DEPLOYED
```

Nothing in the diagram labelled EXISTING is created, imported, modified or owned by CDK. Every CDK resource is FUTURE: it appears in synthesized templates for review, but has no approval to deploy.

## 2. Code structure (`infra/aws`)

| Layer                       | File                                    | Role                                                                                                                                                                                                                                                  |
| --------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config                      | `lib/config.ts`                         | The **only** file holding live identifiers. Typed `OgeviaEnvironmentConfig`. Requires `-c env=prod`. Refuses to synthesize if the active credentials belong to another account. `assertVerified` fails synth on any `__PLACEHOLDER__`.                |
| A. Existing references      | `lib/existing-foundation.ts`            | A `Construct` (not a stack) using only `from*Attributes` / `from*Id` / `fromSecretCompleteArn`. Adds zero CloudFormation resources and makes no AWS calls at synth (no `fromLookup`, so no `cdk.context.json`). Security groups use `mutable: false`. |
| B. Future: evidence         | `lib/evidence-storage-stack.ts`         | `Ogevia-prod-EvidenceStorage` (Phase 5)                                                                                                                                                                                                               |
| B. Future: API tier         | `lib/service-verification-api-stack.ts` | `Ogevia-prod-ServiceVerificationApi` (Phase 4)                                                                                                                                                                                                        |
| B. Future: observability    | `lib/observability-stack.ts`            | `Ogevia-prod-Observability` (Phase 4/7)                                                                                                                                                                                                               |
| Auth contract               | `lib/auth-contract.ts`                  | Roles, server-side authorization boundary, app-client requirements, issuer URL                                                                                                                                                                        |
| C. Deferred + allowed types | `lib/ownership.ts`                      | `DEFERRED_RESOURCE_TYPES` (forbidden), `ALLOWED_RESOURCE_COST_CLASS`, retention list, wildcard-IAM allowlist                                                                                                                                          |
| Scanner                     | `lib/template-scan.ts`                  | Static template rules, shared by the tests and the inventory script                                                                                                                                                                                   |
| App                         | `lib/app.ts`, `bin/ogevia.ts`           | `buildOgeviaApp` (shared with tests). `-c mode=plan` is the only mode. Tags every stack `ogevia:ownership=cdk-future`, `ogevia:deployment-status=not-approved`, `ogevia:planned-phase=N`                                                              |
| Inventory                   | `scripts/synth-inventory.ts`            | Builds `docs/aws/PHASE_1_SYNTH_INVENTORY.md` from `cdk.out` and the registry. Exits 1 on any violation                                                                                                                                                |

**Stack modes.** `-c mode=plan` is the only mode. It synthesizes the complete future architecture for tests, review and template-only diff. A deploy mode does not exist. It will be added only after owner approval (`CLAUDE.md` §13). The AWS account has no `CDKToolkit` bootstrap stack (VERIFIED), so `cdk deploy` cannot succeed today either.

## 3. CloudFormation / CDK boundary and RDS ownership

| Item                                                                                                                       | Owner                            | CDK treatment                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ogevia-prod-data-layer` stack (AppSG, RDSSG, DBSubnetGroup, `ogevia-prod-postgres`, ingress rule `sgr-088d9ee71c4b0244d`) | CloudFormation (manual template) | **Reference only.** Values are taken from the stack's Outputs (VERIFIED: AppSecurityGroupId, RDSSecurityGroupId, DBEndpoint, DBPort, MasterUserSecretArn, DBInstanceIdentifier) and copied into `config.ts`. **No `Fn::ImportValue`**: the stack exports nothing (VERIFIED `list-exports` = []), and static IDs avoid coupling CDK to that stack's update lifecycle. |
| `ogevia-postgres` (legacy/manual RDS, SG `ogevia-db-sg`)                                                                   | Manual                           | **Not referenced.** Kept. No CDK code path can reach it.                                                                                                                                                                                                                                                                                                             |
| VPC, 4 subnets, route tables, IGW, SSM endpoints, admin SG                                                                 | Manual                           | Reference only (VPC, subnets, endpoints, admin SG)                                                                                                                                                                                                                                                                                                                   |
| Cognito pool + `ogevia-web` client                                                                                         | Manual                           | Reference only                                                                                                                                                                                                                                                                                                                                                       |

CDK never adds a rule to a CloudFormation-owned security group. Lambda reuses the AppSecurityGroup, which the RDSSecurityGroup already admits on 5432 (VERIFIED rule). A test proves that even an explicit `addIngressRule(anyIpv4, 5432)` on the referenced groups emits nothing.

## 4. Network egress requirements (NAT = DEFER)

Live routes (VERIFIED): the private route tables `rtb-0bb8bac7d607a3737` and `rtb-049d4448ab6a01e48` have only `10.20.0.0/16 → local`. There is no NAT and no gateway endpoint, and the only interface endpoints are SSM and SSM Messages.

| Lambda dependency                               | Reachable today from the private subnets?  | Options (none created in Phase 1)                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RDS PostgreSQL (5432)                           | **Yes** (local route + existing SG rule)   | —                                                                                                                                                                                                                                                                                                                            |
| Secrets Manager `GetSecretValue`                | **No**                                     | (a) Secrets Manager interface endpoint (VERIFIED $0.01/endpoint-AZ-hour, ≈ $7.30 per AZ per month); (b) RDS IAM database authentication: token signing is local, so no egress is needed, but it requires enabling IAM auth on the CloudFormation-owned instance (`IAMDatabaseAuthenticationEnabled` = false today, VERIFIED) |
| S3 `HeadObject` to verify an uploaded signature | **No**                                     | S3 **gateway** endpoint (no hourly charge), but it adds routes to the existing private route tables                                                                                                                                                                                                                          |
| Presigned S3 URL generation                     | Yes (local signing)                        | —                                                                                                                                                                                                                                                                                                                            |
| KMS for SSE-KMS                                 | Not needed by Lambda (S3 calls KMS)        | —                                                                                                                                                                                                                                                                                                                            |
| Cognito token validation                        | Not needed (API Gateway validates JWTs)    | —                                                                                                                                                                                                                                                                                                                            |
| CloudWatch Logs                                 | Not needed (the Lambda service ships logs) | —                                                                                                                                                                                                                                                                                                                            |

**DECISION D-P1-1 (Phase 4 prerequisite):** pick the secret path, (a) or (b), and approve or decline the S3 gateway endpoint. Until then the modeled Lambda is synthesizable but not functional. NAT remains DEFERRED ($32.85+/month VERIFIED price, no requirement).

## 5. Stack details

### 5.1 `Ogevia-prod-EvidenceStorage` (FUTURE, Phase 5)

- Customer-managed KMS key with rotation enabled, `Retain`.
- Signature bucket `ogevia-prod-signature-evidence-300094796789-us-west-2`. The name is deterministic, so other stacks reference it without an export. It uses SSE-KMS with a Bucket Key, Block Public Access ×4, `BucketOwnerEnforced`, TLS-only plus TLS ≥ 1.2 deny statements, versioning, server access logs, `Retain`, and a lifecycle rule that aborts incomplete multipart uploads after 7 days.
- Access-log bucket: SSE-S3 (the only option S3 log delivery supports), Block Public Access, TLS-only, versioned, `Retain`.
- **No Object Lock. No expiration.** The retention period is a legal DECISION (D-06).
- Object key design: `{organization_uuid}/{visit_uuid}/client-signature.png`. It contains UUIDs only: no client code, name, DOB or payer identifier.
- Backend access model: the API role may only `s3:PutObject`, `s3:GetObject` and `s3:GetObjectVersion` on `…/*/*/client-signature.png`, and only `kms:Decrypt` and `kms:GenerateDataKey` on the evidence key, with the condition `kms:ViaService = s3.us-west-2.amazonaws.com`. The server checks tenant ownership before every presign.

### 5.2 `Ogevia-prod-ServiceVerificationApi` (FUTURE, Phase 4)

- HTTP API. CORS allows `https://app.ogevia.com` (VERIFIED in the repo) for GET/POST/OPTIONS. Headers: `authorization`, `content-type`, `idempotency-key`.
- JWT authorizer: issuer `https://cognito-idp.us-west-2.amazonaws.com/us-west-2_849AYz5J7`, audience = the existing `ogevia-web` client.
- Eight routes, all JWT-protected: `GET /v1/visits/active`, `GET /v1/clients/assigned`, `GET /v1/clients/{clientId}/services`, `POST /v1/visits`, `POST /v1/visits/{visitId}/end`, `POST /v1/visits/{visitId}/signature-upload`, `POST /v1/visits/{visitId}/confirm`, `POST /v1/visits/{visitId}/corrections`.
- `$default` stage throttled to 20 rps with a burst of 50. The access-log format records only requestId, requestTime, routeKey, status, latency, integrationStatus and authorizer error. It never records path, query, body, headers or source IP.
- Lambda: Node 24, arm64, 512 MB, 10 s timeout. Inline placeholder that returns 501 and logs nothing. Placed in the private subnets 2a/2b with the existing AppSecurityGroup.
- Environment contract: `OGEVIA_ENV, DB_HOST, DB_PORT, DB_SECRET_ARN, EVIDENCE_BUCKET, EVIDENCE_KEY_ARN, COGNITO_USER_POOL_ID, COGNITO_APP_CLIENT_ID, LOG_LEVEL`. These are identifiers only. The DB name and credentials come from the app secret at runtime. RDS `DBName` is null (VERIFIED), so no application DB name is available from metadata.
- IAM: a dedicated role with one **customer-managed** policy and no AWS-managed policies. Statements:
  - `logs:CreateLogStream` and `logs:PutLogEvents` on its own log group;
  - `secretsmanager:GetSecretValue` on the exact app-secret ARN (the RDS master secret is never granted);
  - the S3 and KMS statements in §5.1;
  - five ec2 ENI actions on `*`. This is the only wildcard resource, because `DescribeNetworkInterfaces` has no resource-level permissions.
- Log groups: 365-day retention, `Retain`.
- Account Lambda concurrency limit = 10, unreserved = 10 (VERIFIED). Reserved concurrency is therefore impossible, and a quota increase is a Phase 4 prerequisite (D-P1-3).

### 5.3 `Ogevia-prod-Observability` (FUTURE, Phase 4/7)

- Six standard-resolution alarms at 5-minute periods:
  - Lambda Errors and Throttles;
  - API 5xx;
  - RDS CPU ≥ 80% (3 periods), FreeStorageSpace < 2 GiB, and CPUCreditBalance < 20. These read the **existing** `ogevia-prod-postgres` by `DBInstanceIdentifier`; reading a metric does not modify the instance.
- TLS-only SNS topic with **no subscriptions** (D-P1-4).
- No dashboards, canaries, X-Ray, detailed monitoring or third-party tools.

## 6. Authentication contract (Phase 3 integration)

- The pool and client are referenced, not modified. Live settings (VERIFIED): MFA **ON** (TOTP enabled; WebAuthn single-factor configured), Essentials tier, email username, password ≥ 12 with all character classes, 0 users, no groups. Client `ogevia-web`: public (no secret), OAuth `code` flow, scopes `openid` and `email`, access/ID tokens 60 min, refresh 5 days, token revocation on, user-existence errors prevented.
- Server-side authorization boundary (`AUTHORIZATION_BOUNDARY`): API Gateway only proves the token is valid. Tenant and role are resolved per request in PostgreSQL from `sub`. `organization_id`, role, timestamps and amounts from the client are never trusted. Cognito groups are never the tenant control.
- Phase 3 gaps found (DECISIONS, not Phase 1 changes):
  - **D-P1-2 (security):** the client's only callback URL is `https://d84l1y8p4kdic.cloudfront.net`. The account has **no CloudFront distributions** (VERIFIED), so authorization codes would be redirected to a domain this account does not control. Exposure today is zero (0 users). Remove or replace the URL, add `https://app.ogevia.com`, and require PKCE in the frontend. Changing Cognito needs approval.
  - MFA ON applies to caregivers too, which adds field friction. It's a product and security decision.
  - Email uses `COGNITO_DEFAULT` (sending limits apply). SES is a later decision.
  - Custom tenant domains (`custom_domain_tenant_resolution`) would each need a CORS origin and callback URL.

## 7. Security safeguards (enforced by tests)

The no-public-RDS rule, the 0.0.0.0/0 PostgreSQL rule, public/unencrypted S3, the TLS deny, secrets in Outputs, secrets in Lambda env, missing `Retain`, SG mutation, duplicate VPC/subnet/NAT/RDS/subnet group, unexpected resource classes, wildcard IAM actions and wildcard resources outside the ENI allowlist are all enforced by `lib/template-scan.ts` over every stack. There are negative tests for each rule. Also enforced:

- cdk-nag AwsSolutions and HIPAA Security have zero unacknowledged findings, and every acknowledgement carries a written reason;
- live IDs appear only in `config.ts`;
- no credential material exists in the source;
- explicit env/mode are required, and synth refuses credentials for another account.

## 8. Deployment prerequisites (none satisfied or requested in Phase 1)

1. Owner approval of `cdk bootstrap aws://300094796789/us-west-2` (YELLOW: creates an S3 bucket, an ECR repository, IAM roles and an SSM parameter).
2. D-P1-1 egress decision; D-P1-3 Lambda quota increase.
3. D-P1-2 Cognito callback fix before any real user signs in.
4. BAA/security gate before any PHI (`CLAUDE.md` §8).
5. A reviewed **change-set** diff by a deploy-capable role at deploy time. Phase 1 used template-only diff.
6. Phase 4 handler code in place of the 501 placeholder.

## 9. Rollback considerations

- Nothing is deployed, so there is nothing to roll back today.
- If deployed later: every stateful resource (KMS key, buckets, log groups) is `Retain`, and every stack has termination protection. Deleting a stack therefore leaves data behind; that's intended, and cleanup must be explicit.
- The future stacks are additive. They reference, and never own, the existing VPC, SGs, RDS, secrets and Cognito. Removing them cannot delete or modify `ogevia-prod-data-layer` resources.
- Cross-stack references are `strong`: EvidenceStorage exports the key ARN, and ServiceVerificationApi exports the function and API IDs to Observability. Consumers must be removed before producers.
