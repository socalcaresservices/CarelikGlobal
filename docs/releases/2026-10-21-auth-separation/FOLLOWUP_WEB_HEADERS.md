# Follow-up: the Production sign-in was blocked by the website's own security header

**Status (2026-10-22): proposed and tested locally. NOT deployed. Production authentication is NOT operational until this is deployed and a real login succeeds.**

## What happened
After the authentication separation was deployed (stacks `Ogevia-prd-Auth`, `Ogevia-prd-ServiceVerificationApi`) and the new website build was published, signing in failed on `/auth/callback` with
"Could not reach the sign-in service. Check your connection and try again." The sign-in page itself opened, so the redirect worked; the failing step was the browser's POST to
`<sign-in domain>/oauth2/token` (`packages/auth/src/cognito/oidc.ts`, any failed `fetch` becomes that message).

## Root cause (VERIFIED)
- Code: `infra/aws/lib/web-hosting-stack.ts` built the CloudFront Content-Security-Policy from `config.testSlice.cognitoDomain`, the SHARED pilot domain, for every environment.
- Live (read by the owner, 2026-10-22, `aws cloudfront get-response-headers-policy`): `connect-src 'self' https://*.execute-api.us-west-2.amazonaws.com https://us-west-2849ayz5j7.auth.us-west-2.amazoncognito.com`
  — production's own domain `https://ogevia-prd-300094796789.auth.us-west-2.amazoncognito.com` is absent, so the browser blocks the token request.
- Why it was missed: the release gate and package treated `Ogevia-prd-WebHosting` as "must not change" and only compared the API and Auth stacks; no test related the website's header to the domain the site was built with.

NOT yet verified live (read-only commands in the assessment): the browser console message, the Cognito client and token-endpoint checks. The Cognito-side values are unchanged by this fix.

## The fix (one value, one stack)
`webAuthDomain(config)` (config.ts) returns the dedicated pool's domain for production (the shared pilot domain for the pilot). The website's header uses it, so for production `connect-src` and `form-action`
list `https://ogevia-prd-300094796789.auth.us-west-2.amazoncognito.com` instead of the shared domain. Nothing else in the policy changes (no wildcard, no http, same other directives).
Deploying it is an in-place update of one CloudFront response-headers policy of `Ogevia-prd-WebHosting` (no replacement; exports and the old test client resource are unchanged; the unused old-client export is dropped
from the template, which is allowed because no live stack imports it — the gate checks that).

## New controls
- `infra/aws/test/production-auth.test.ts`: production's header allows exactly the domain the Auth stack outputs and not the shared one; nothing widened; the pilot is unchanged (fails on the old code).
- `web_headers_gate.py` (+ `infra/aws/test/web-headers-gate.test.ts`, fixtures `deployed/` = the templates deployed by the authentication release): live vs packaged templates must differ ONLY by that header value.
- `g-web-headers-prd.sh check|deploy|post`: guarded deploy (`--exclusively Ogevia-prd-WebHosting`, typed phrase `DEPLOY-Ogevia-prd-WebHosting-Headers`) and post-checks of the live policy AND the served page's response header.
- `c-web-prd.sh verify` now also fails when the served Content-Security-Policy would block the production sign-in domain.
- `auth_cutover_gate.py` accepts the same single header change, so a fresh baseline would carry it.

## Deployment (all YELLOW; needs the owner's new approval reference)
```
export OGEVIA_DEPLOY_APPROVAL=<new reference>
bash g-web-headers-prd.sh check
export OGEVIA_PREDEPLOY_SNAPSHOT_ID=<the existing available snapshot>
bash g-web-headers-prd.sh deploy      # type DEPLOY-Ogevia-prd-WebHosting-Headers
bash g-web-headers-prd.sh post        # waits for CloudFront to apply the header (a few minutes)
bash c-web-prd.sh verify
```
Then sign in in a private window. Authentication is operational only when that full login (password change, MFA enrolment, landing in the agency as the administrator) succeeds and `d-verify-prd.sh tokens` passes.

## Rollback
Redeploy the previous template of `Ogevia-prd-WebHosting` (from `previous/` in the package: `cd previous/infra/aws && npx cdk deploy -c env=prd -c mode=deploy --exclusively Ogevia-prd-WebHosting`,
YELLOW, new approval). That restores the header that blocks sign-in, so it is only for undoing an unexpected side effect. It touches no user, pool, API or data. The relink and the web publish are separate and
keep their own rollback (`b-admin-prd.sh undo`, `c-web-prd.sh rollback`).
