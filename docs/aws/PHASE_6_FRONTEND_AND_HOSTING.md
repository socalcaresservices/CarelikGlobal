# Phase 6: Frontend on AWS (Cognito + AWS API) and AWS Hosting

**Production web (Netlify + Supabase) is unchanged.** The AWS path is selected at build time with `VITE_AUTH_PROVIDER=cognito`.

## 1. What changed in the web app

| Area | Change | Supabase build impact |
| --- | --- | --- |
| `src/main.tsx` | Chooses the root by `VITE_AUTH_PROVIDER` via dynamic import (unset → existing `App`) | None |
| `src/lib/sv-backend.ts` | Backend seam: the SV screens call `getActiveVisit`, `listAssignedClients`, `startVisit`, `endVisit`, `confirmVisit`, `listVisits`, `correctVisit`, … | Default = Supabase implementation with the **same RPC calls** as before |
| `src/lib/sv-backend-supabase.ts` | The existing Supabase calls, moved verbatim | Same behavior (27 existing SV page tests pass unchanged) |
| `src/lib/sv-backend-aws.ts`, `src/lib/aws-api.ts` | AWS API client: bearer token, idempotency keys, no cookies, `no-store`; maps API rows to the existing screen types (minutes → hours) | n/a |
| `src/lib/supabase.ts` | Client created on **first use** instead of at import | Same client, same options |
| SV screens | Unchanged UI; idempotency keys added per intended action | None visible |
| `src/aws/*` | AWS login (managed-login hand-off), `/auth/callback`, protected route (loading / expired / signed-out), org context from `/v1/me`, minimal shell, Billing review (read-only, "Billing Ready ≠ billed") with the audited signature view | n/a |

## 2. Workflow coverage (AWS build)

LOGIN → ASSIGNED CLIENT → AUTHORIZED SERVICE → START → ACTIVE → END → SIGNATURE / NO-SIGNER → SAVE EVIDENCE → LOCK → MANAGER REVIEW / CORRECTION → BILLING-REVIEW DATA.

Every step is exercised by:
- `src/aws/aws-app.test.tsx` (15 tests);
- `apps/web/e2e/aws-slice-smoke.mjs` (real Chromium, 390×844, touch; 22 checks; screenshots in the session scratchpad);
- `apps/sv-api/test/workflow.db.test.ts` (server side).

## 3. AWS hosting (WebHosting stack; not deployed)

- **Private S3 bucket** with OAC: no public access, versioned, SSE-S3, access logs.
- **CloudFront**: HTTPS redirect, HTTP/2+3, PriceClass 100, standard logs (90-day lifecycle).
- **SPA rewrite**: CloudFront Function (no error-page rewriting, so API errors are never masked).
- **Security headers**:
  - CSP: `default-src 'self'`; `script-src 'self'`; `connect-src` = self + regional execute-api + the Cognito domain; `frame-ancestors 'none'`; `form-action` self + Cognito.
  - HSTS 1 year, nosniff, `X-Frame-Options DENY`, `Referrer-Policy no-referrer`, a restrictive `Permissions-Policy`.
- The **test-slice Cognito app client** callback/logout URLs are bound to the distribution by CloudFormation.

Netlify can be retired later by pointing `app.ogevia.com` at this distribution. That requires:
- an ACM certificate (us-east-1);
- a DNS change;
- the `ogevia-web` callback fix (D-P1-2).

All three are Phase 8 actions and are **not** part of this approval.

## 4. Known product gaps (observed, not changed)

1. The existing success screen reads **"Confirmed / Visit saved"**. It does not show the Billing Ready state, the authorization remaining, or the explicit "not billed" statement described in the product directive's Screen 4. The directive also said "do not rebuild the SV UI", so this is a decision gate, not a silent change.
2. In the AWS build, the reports page letterhead shows the organization name only (no address/logo fields in the RDS schema), and client-city filters are empty (no addresses in the SV API, by data minimization).
