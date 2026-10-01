# Phase 3: Authentication Architecture (Cognito)

**Status:** built and tested locally. **Not deployed.** Production still uses Supabase Auth.

## 1. Flow

```text
Browser (React, VITE_AUTH_PROVIDER=cognito)
  │ 1. signIn(): code_verifier (32 random bytes), S256 challenge, state, nonce
  │    -> sessionStorage "ogevia.auth.tx" (10 min TTL, single use)
  ▼
Cognito managed login (existing pool us-west-2_849AYz5J7, Essentials, MFA ON)
  │ 2. /oauth2/authorize?response_type=code&code_challenge_method=S256&state&nonce
  ▼
/auth/callback
  │ 3. state checked (constant-time) -> code + verifier -> /oauth2/token (no client secret)
  │ 4. ID token claims checked: iss, aud = app client, token_use = id, exp, nonce
  │ 5. code/state removed from the address bar; return to the saved in-app path (same-origin only)
  ▼
API call: Authorization: Bearer <ACCESS token>  (memory only)
  ▼
API Gateway HTTP API: JWT authorizer (issuer = pool, audience = approved app clients)
  ▼
Lambda: principalFromClaims() re-checks sub (UUID), iss, client_id, token_use = access, exp, openid scope
  ▼
PostgreSQL: BEGIN; SET LOCAL ROLE ogevia_app; SELECT ogevia_api.begin_request(sub, request_id); <API fn>; COMMIT
            app_users.cognito_sub -> organization_memberships -> role_permissions (authoritative)
```

## 2. What is trusted

| Input | Trusted? | Where it is decided |
| --- | --- | --- |
| Cognito `sub` from a verified access token | Yes: the only identity input | API Gateway verifies the signature; Lambda re-checks the claims |
| Organization, role, permissions, assignment | Never from the browser or the token | PostgreSQL (`is_active_member`, `has_permission`, assignments) |
| `cognito:groups`, `custom:*`, email claims | Ignored | Tests prove forged claims change nothing |
| Browser `organizationId` parameter | Only selects a scope; the database rejects or filters anything the caller cannot access | `ogevia_api.*` |
| Timestamps | Never from the browser | `now()` in PostgreSQL |

## 3. Provider modes (`packages/auth`)

| Mode | Selected by | Behavior |
| --- | --- | --- |
| `SUPABASE_CURRENT` | `VITE_AUTH_PROVIDER` unset or `supabase` | `AuthProvider`: the previous behavior. Production stays here. |
| `COGNITO_FUTURE` | `VITE_AUTH_PROVIDER=cognito` | `CognitoAuthProvider` + `CognitoAuthClient`. Unknown values fail closed (`config_invalid`). |

Both expose the same `useAuth()` (`user`, `session`, `loading`, `signOut`, …) plus `provider`, `error`, `sessionExpired`, `signIn`, `completeSignIn`, `getAccessToken`. Supabase-only methods throw `unsupported_in_mode` in Cognito mode, so a password is never handled by app code.

## 4. Token handling

| Item | Where | Why |
| --- | --- | --- |
| Access token, ID token | Memory only | Minimizes XSS persistence |
| Refresh token | Memory, or `sessionStorage` (`VITE_COGNITO_REFRESH_PERSISTENCE=session`, the test-slice setting) | Survives reload within the tab; cleared when the tab closes; **never `localStorage`** |
| PKCE transaction | `sessionStorage`, 10 minutes, deleted on first read | Redirect round trip |
| Refresh | 60 s before expiry, single flight; a failed refresh clears the session and shows "session expired"; a refresh that changes `sub` is rejected | |
| Sign-out | Revokes the refresh token (best effort), clears local state, redirects to `/logout?client_id&logout_uri` | |

Errors shown to users are fixed messages; they never contain tokens, codes, verifiers, issuers, or provider text. The static test `security.static.test.ts` fails on `localStorage`, `client_secret`, or console output in the Cognito/server code.

## 5. Server contract (`@carelik/auth/server`)

- `principalFromClaims(claims, {issuer, clientIds, requiredScopes?})` → `AuthenticatedPrincipal {sub, issuer, clientId, tokenUse:"access", scopes, expiresAt}`. It rejects `missing_claims`, `missing_sub`, `malformed_sub`, `wrong_issuer`, `wrong_client`, `wrong_token_use`, `expired`, `missing_scope` and `malformed_claims`. Messages never echo claim values.
- `verifyAccessToken(token, jwks, …)`: full RS256 verification (`jose`), for defense in depth and tests.
- `withPrincipal(client, principal, work, {requestId, setRole})` is the only way Lambda runs SQL for a caller.

## 6. Decisions

| ID | Decision | Status |
| --- | --- | --- |
| D-P3-1 | Access tokens (not ID tokens) authorize the API; audience = approved app client IDs | Built |
| D-P3-2 | A **new** public app client for the test slice (`ogevia-web-prod-test-slice`), bound to the CloudFront origin by CloudFormation; `ogevia-web` untouched | Modeled; deploy = approval |
| D-P1-2 | `ogevia-web` callback points at a CloudFront domain this account does not own. Target: `https://app.ogevia.com/auth/callback` + logout `https://app.ogevia.com/` | Modeled in `infra/aws/lib/cognito-target.ts`; change at production cutover |
| D-P3-3 | User migration: Option B (admin-created users + invitation; no password migration) | Recommended (see mapping doc) |
| D-P3-4 | No Verified Permissions, no Lambda authorizer, no WAF, no second pool | Held |

## 7. Cost

There is no new fixed cost for authentication. The Essentials tier bills per monthly active user (MAU) above its free allowance; with about 22 users, the expected cost is $0. Cognito pricing was not re-verified this session; see `PHASE_1_COST_MODEL.md`. The app client and managed-login branding are free.
