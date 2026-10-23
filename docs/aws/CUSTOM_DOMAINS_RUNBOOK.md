# Permanent URLs: app / admin / demo.ogevia.com

Status: PROPOSED. CDK change implemented and unit-tested; NOT deployed. Owner approval given in chat 2026-10-23 (no active users).
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
