# Ogevia environments and links

Last checked: 2026-10-08. This page lists what runs where and how people sign in. It contains no passwords, secrets or personal email addresses. Anything not confirmed from the repository, a read-only check, or the owner is marked **Unverified**.

"Owner-confirmed" means the owner reported it; it was not observed directly.

## Environments

| Environment | URL | Purpose | Sign-in | Database | Status |
|---|---|---|---|---|---|
| **Production (customer-facing)** | `https://app.ogevia.com` (sign-in: `/login`) | The application customers and pilot users use. Served by the Netlify site `carelikglobal` from the `main` branch. | Supabase email and password. No multi-factor step in the app. | Supabase. The "CarelikGlobal" project holds the `socal-care-services` organization. **Unverified** that Netlify's production setting points at it. | Live. Latest deployed code: `main` at `a59a4b8` (PR #70), Published per the owner. |
| Netlify site address | `https://carelikglobal.netlify.app` | Netlify's own address for the same site. | Same as production. | Same as production. | **Unverified** (not opened). Do not give to customers. |
| Pull request previews | `https://deploy-preview-<number>--carelikglobal.netlify.app` | Temporary copy of a pull request for testing. | Email and password against the demo Supabase project only. | Demo Supabase project (`ldwhmuirjbwcpzwrwzgv`), set in `netlify.toml`. | Created per pull request. Retire when the pull request is closed. |
| **AWS TEST** | `https://d2xumch5w0izfg.cloudfront.net` | AWS version of Service Verification, synthetic data only. | Amazon Cognito hosted login. Multi-factor on, per the 2026-10-01 inventory (**unverified now**). | `ogevia_sv_test` | Deployed, release 0036 at `7b1236d` (owner-run, 2026-10-05). Phone acceptance owner-reported. |
| **AWS PRD (`ogevia_prd`)** | None yet | The planned AWS production. | Cognito, with multi-factor for the administrator. | `ogevia_prd` | **Not deployed.** NO-GO; items 6 to 17 NOT RUN (`docs/aws/PRODUCTION_DEPLOYMENT.md` section 7). `app.ogevia.com` has not been repointed. |
| Marketing site | `https://www.ogevia.com` | Public website. | No user login. | None. | **Unverified.** |
| API name | `https://api.ogevia.com` | Named in AWS planning documents only. | No user login. | None. | **Unverified.** Nothing shows it exists. |
| Code repository | `https://github.com/socalcaresservices/CarelikGlobal` | Source code. | GitHub account. | None. | Live. |

## Naming

- In the AWS documents, "prod" and "prd" are different things. The `Ogevia-prod-*` stacks are the pilot/test slice. `Ogevia-prd-*` and `ogevia_prd` are the planned production and are not deployed.
- "Production" in this file means the environment used for real operations: today that is Netlify with Supabase.

## Accounts by role

Roles in the production Supabase project: owner (`organization_owner`), manager, scheduler, caregiver. No administrator role was present on 2026-10-08. Look up current accounts in Supabase (Authentication) or in the AWS Cognito pool; this page does not list them so it cannot go stale or expose addresses.

Read-only check on 2026-10-08 found, in the production Supabase project: several owner accounts; manager, scheduler and caregiver accounts in the `socal-care-services` organization that are all test addresses; two other organizations (`ogevia-demo`, `ogethinks`) with test accounts; and two caregiver accounts with generic addresses in `ogevia-demo` that have never signed in. Production recorded 0 service visits on 2026-10-07.

## Open items

- Confirm the production database setting in Netlify (Site configuration, Environment variables).
- Create real user accounts for the pilot; current manager and caregiver accounts are test accounts.
- Confirm BAA coverage for Supabase and Netlify; only AWS is confirmed.
- Decide on multi-factor authentication for the Supabase sign-in.
- Review and remove test and generic accounts from the production Supabase project (data change; needs owner approval).
- Confirm whether `www.ogevia.com` and `api.ogevia.com` exist.
