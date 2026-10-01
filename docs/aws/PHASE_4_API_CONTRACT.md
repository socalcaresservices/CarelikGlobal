# Phase 4: Service Verification API (API Gateway + Lambda + PostgreSQL)

**Code:** `apps/sv-api` (handler), `infra/aws/lib/service-verification-api-stack.ts` (CDK). **Not deployed.**

## 1. Request lifecycle

1. API Gateway HTTP API: Cognito **JWT authorizer** on every route (issuer = pool; audience = `ogevia-web` + test-slice client). There is no `$default` or `ANY` route (scanner rule + tests).
2. Lambda `createHandler`:
   - route lookup by `routeKey` (unknown → 404, no DB);
   - `principalFromClaims` re-check (→ 401, no DB);
   - input validation (→ 400/422, no DB).
3. `withPrincipal`: `BEGIN; SET LOCAL ROLE ogevia_app; SELECT ogevia_api.begin_request(sub, request_id); <one ogevia_api function>; COMMIT`. The role has EXECUTE on `ogevia_api.*` only and no table privileges.
4. Response: JSON, `cache-control: no-store`, `x-request-id`.

## 2. Routes (handler table == CDK table, enforced by test)

| Route | DB function | Notes |
| --- | --- | --- |
| `GET /v1/me` | `get_my_context()` (0009) | Caller's active memberships, role, permissions (display only) |
| `GET /v1/visits/active?organizationId` | `get_active_service_visit` | |
| `GET /v1/clients/assigned?organizationId` | `list_assigned_visit_clients` | Client **codes** only |
| `GET /v1/clients/{clientId}/services?organizationId` | `list_authorized_services_for_client` | Monthly minutes |
| `POST /v1/visits` + `Idempotency-Key` | `start_ad_hoc_service_visit` | No time/caregiver/role parameter exists |
| `POST /v1/visits/{visitId}/end` | `end_service_visit` | Server time |
| `POST /v1/visits/{visitId}/confirm` + `Idempotency-Key` | `register_visit_evidence` + `confirm_service_visit` (one transaction) | See Phase 5 for the signature path |
| `GET /v1/visits?organizationId&filters` | `list_service_visits` | Reads filter to nothing on denial (Phase 2 contract) |
| `GET /v1/visits/{visitId}/corrections` | `list_visit_corrections` | |
| `POST /v1/visits/{visitId}/corrections` + `Idempotency-Key` | `correct_service_visit` | Original retained; before/after/actor/reason |
| `GET /v1/visits/{visitId}/signature` | `get_visit_signature_evidence` (0009) | `visits.read` only; audited; SHA-256 checked before bytes are served |
| `GET /v1/billing-review?organizationId&dateFrom&dateTo` | `list_billing_review_visits` | Data only; no approval or submission endpoint exists |

## 3. Errors

| SQLSTATE | HTTP | code |
| --- | --- | --- |
| OGA01 | 401 | unauthenticated |
| OGA03 | 403 | forbidden |
| OGN04 | 404 | not_found |
| OGC09 | 409 | conflict |
| OGV22 | 422 | validation_failed |
| OGI09 | 409 | idempotency_key_reused |
| 22P02 / 22007 / 22008 | 400 | bad_request (fixed message) |
| 23505 / 23P01 / 40001 / 40P01 | 409 | conflict / retry (fixed message) |
| 23514 | 422 | validation_failed (fixed message) |
| anything else | 500 | internal_error (fixed message) |

Only the Ogevia SQLSTATE messages (written for display, with no identifiers) reach the browser. Driver messages never do.

## 4. Idempotency and retries

- Start, confirm and correction require an `Idempotency-Key` UUID. The UI keeps one key per intended action and renews it when the input changes.
- Confirm with a signature first checks `get_confirmation_replay(visit, key)` (0009): a retry of a committed request returns the stored result **without a second upload**. Parallel duplicates race safely: tested with 4 parallel requests, giving 1 confirmation and identical results.
- Migration 0009 adds read-only functions only (rollback classified SAFE AUTOMATED; tested).

## 5. Logging

One JSON line per request: `level, requestId, apiRequestId, route (template), status, durationMs, errorCode, sqlState`. A test asserts no sub, organization/visit/client id, reason text or signature bytes appear in logs under real traffic.

## 6. Runtime configuration (identifiers only)

`AWS_REGION` (Lambda-provided), `COGNITO_USER_POOL_ID`, `COGNITO_APP_CLIENT_ID` (comma list), `DB_HOST`, `DB_PORT`, `DB_SECRET_ARN`, `DB_NAME=ogevia_sv_test`, `DB_SET_ROLE=ogevia_app`, `EVIDENCE_BUCKET`, `EVIDENCE_KEY_ARN`, `NODE_EXTRA_CA_CERTS=/var/runtime/ca-cert.pem`, `OGEVIA_ENV`, `LOG_LEVEL`. Config validation fails closed on cold start. The DB password is fetched from Secrets Manager at runtime and held in memory only. TLS uses `rejectUnauthorized: true`.

## 7. Network (D-P1-1)

The Lambda is in the existing private subnets with the existing AppSecurityGroup (RDS already admits it on 5432). There is no NAT. The NetworkEgress stack adds a **Secrets Manager interface endpoint** (1 AZ, private DNS, own SG: 443 from AppSG only; policy = the app secret only) and an **S3 gateway endpoint** (policy = evidence objects only). Scanner and tests confirm that no rule is added to a CloudFormation-owned SG.

## 8. Tests

- `apps/sv-api/test/unit.test.ts`: 48 tests (config, validation, PNG, error mapping, handler boundary, logging).
- `apps/sv-api/test/workflow.db.test.ts`: 27 tests through the real handler on PostgreSQL 16 migrated from zero. They cover:
  - the full caregiver flow, manager review and correction, billing review;
  - the no-signer path, S3 failure, parallel duplicates, integrity check;
  - the tenant-security block.
- `infra/aws/db/test/*`: 97 tests (93 Phase 2 + 4 deployment-SQL).
