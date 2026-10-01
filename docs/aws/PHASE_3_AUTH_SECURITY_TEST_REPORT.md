# Phase 3: Authentication Security Test Report

All tokens are **synthetic**: signed by a local RS256 key pair with a local JWKS (`packages/auth/src/test/tokens.ts`), or unsigned shapes for browser-only paths. There are no production tokens or real users. Date: 2026-10-01.

## Results

| Area | Suite | Tests | Result |
| --- | --- | --- | --- |
| Provider modes + config fail-closed | `packages/auth/src/cognito/config.test.ts` | 26 | PASS |
| PKCE (RFC 7636 vector, verifier entropy/charset, state/nonce, constant-time compare) | `pkce.test.ts` | 5 | PASS |
| Transaction storage (single use, TTL, corruption) + open-redirect sanitizing | `storage.test.ts` | 13 | PASS |
| Session: callback state/nonce/iss/aud/token_use, replay, expiry, error params, exchange failures, refresh single-flight, identity-switch rejection, reload restore, memory persistence, sign-out revocation, no console output, no secrets in errors | `client.test.ts` | 29 | PASS |
| JWT contract: 19 rejection cases + string `exp`, array scope, required scopes; RS256 verify (wrong key, tampered payload, `alg=none`, expired, wrong issuer, ID token, unapproved client, garbage); `withPrincipal` (only `sub` passed, rollback paths, SET ROLE injection) | `server/principal.test.ts` | 38 | PASS |
| React provider (Cognito): recovery, expiry, sign-out, delegation, unsupported methods | `cognito-auth-provider.test.tsx` | 9 | PASS |
| React provider (Supabase, unchanged) | `auth-provider.test.tsx` | 10 | PASS |
| Static: no localStorage, no client secret, no console in Cognito/server code, no secret literals, no hard-coded pool/client, principal ignores groups/email/custom claims | `security.static.test.ts` | 8 | PASS |
| **Tenant security through the real Lambda handler + PostgreSQL**: browser org cannot grant access; groups/custom role/org claims ignored; body cannot impersonate a caregiver; unknown sub → 401; other tenant's sub sees nothing; same sub in 2 orgs gets per-org roles; disabled app user → 401 | `apps/sv-api/test/workflow.db.test.ts` (tenant block) | 7 | PASS |
| API authorization coverage: CDK routes == handler routes; every route JWT; no `$default`/`ANY`; audience exactly 2 approved clients; scanner negative controls (unauthenticated route, catch-all, weak authorizer, client secret, implicit flow, http callback, password flow) | `infra/aws/test/slice-contract.test.ts` | 19 | PASS |
| Handler boundary: unauthenticated/forged claims rejected before any DB connection; logs contain no sub/ids/inputs | `apps/sv-api/test/unit.test.ts` | 47 | PASS |
| User-migration tool: classification, no email output, no credential fields, roles from DB, no deletes | `infra/aws/test/user-migration.test.ts` | 7 | PASS |
| Cognito target model (D-P1-2) | `infra/aws/test/cognito-target.test.ts` | 3 | PASS |
| Real Chromium (390×844, touch): PKCE params on the wire, verifier only at the token endpoint, single-use transaction, code stripped from the URL, no tokens in local/session storage, no tokens in console, only app/Cognito/API hosts contacted | `apps/web/e2e/aws-slice-smoke.mjs` | 22 checks | PASS |

## Negative controls (did the tests catch a real defect?)

- The scanner rule tests inject each forbidden construct and assert that the rule fires (8 tests).
- The e2e initially showed `Confirm` disabled. The cause was an off-screen canvas in the test (mouse coordinates outside the viewport), not product code; a real CDP touch drag passes.
- A deploy-SQL test initially passed `begin_request` without `SET ROLE`. The cause: node-postgres `connectionString` overrides `user`, so the test connected as superuser. After fixing the test, it proves the NOINHERIT login gets `42501` without `SET ROLE`.
- A `1/0` guard in the login-role SQL was constant-folded by PostgreSQL and fired unconditionally; it was replaced by a `DO` check, which the test now exercises.

## Not verified (requires deployment)

- The real Cognito managed-login pages, TOTP enrolment and invitation email.
- The API Gateway JWT authorizer against real Cognito JWKS.
- TLS from Lambda to RDS with `NODE_EXTRA_CA_CERTS=/var/runtime/ca-cert.pem` (INFERRED from AWS Lambda Node.js runtime documentation; verified by the deployment smoke test).
