# Permanent URLs: app / admin / demo.ogevia.com

Status: APPLIED 2026-10-23 (owner-run); see docs/aws/URL_REGISTRY_AND_LAUNCH_CHECKLIST.md section 1. Original status line: PROPOSED. CDK change implemented and unit-tested; NOT deployed. Owner approval given in chat 2026-10-23 (no active users).
Scope: URLs only. No database, tenant, subscriber-data or onboarding change. The Cognito change is the app client's callback/logout list (additive), applied through CDK.

| Name | Environment | Distribution | Previously |
|---|---|---|---|
| app.ogevia.com, admin.ogevia.com | prd (production candidate) | d3l4psdkokkvnb.cloudfront.net | app: Netlify A 52.52.192.191, 13.52.188.95; admin: none |
| demo.ogevia.com | prod (pilot/test) | d2xumch5w0izfg.cloudfront.net | CNAME carelikglobal.netlify.app |

DNS is Netlify DNS (nsone). The account has no Route53 zone for ogevia.com.

## How it is applied
- `customDomains` in `infra/aws/lib/config.ts` + `OGEVIA_WEB_CERT_ARN` (us-east-1 ACM certificate) at synth time.
- Adds: CloudFront alternate domain names (SNI, TLSv1.2_2021), Cognito callback/logout URLs (`https://<host>/auth/callback`, `/`), API CORS origins.
- Keeps: the CloudFront URL as callback, logout and CORS origin; the CloudFront distributions themselves.
- A `mode=deploy` without the certificate variable is refused, so a later deploy cannot silently drop the hostnames.
- The sign-in redirect is runtime config (`/config.json` key `VITE_COGNITO_REDIRECT_URI`), so no frontend rebuild.
  Both hostnames of one distribution share one `config.json`: admin.ogevia.com signs in through app.ogevia.com.
  Signing in from the raw CloudFront URL also returns to the permanent host.

## Rollback
Restore the Netlify records (app A 52.52.192.191 + 13.52.188.95; demo CNAME carelikglobal.netlify.app), re-add the domains to the Netlify site, and
delete the `VITE_COGNITO_REDIRECT_URI`/`VITE_COGNITO_LOGOUT_URI` keys from each bucket's `config.json` (or restore the saved copy).

## As-applied corrections (2026-10-23)
- DNS is Netlify DNS with a wildcard and `NETLIFY`-type records; `app` and `admin` were Netlify domain aliases and had to be removed from the site first.
- Only the two WebHosting stacks were deployed (`--exclusively`). The ServiceVerificationApi stacks differ from this repository (missing routes) and were not deployed; API CORS was changed with `aws apigatewayv2 update-api` (backups were saved in the CloudShell session only).
- Production's real Cognito pool/client are `us-west-2_FHJoX71ca` / `4rnh9e5d02pkupirvfqdbngmv5`, not the pool in `config.ts`. Its callback/logout lists were extended by `update-user-pool-client` (full settings read back and rewritten; only the two URL lists changed).
- `config.ts` now gives `prd` its own `testSlice.cognitoDomain` so the CSP matches the deployed one. An earlier deploy briefly replaced it with the pilot domain and was corrected the same day.
- Sign-in: production MFA is required; the owner's authenticator entry had to be located. No MFA reset was possible (no admin API deletes an enrolled authenticator).
