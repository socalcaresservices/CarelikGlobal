# Phase 3: Cognito Current vs Target Matrix

CURRENT = VERIFIED read-only on 2026-10-01 (`describe-user-pool`, `describe-user-pool-client`, `describe-user-pool-domain`, `list-user-pool-clients`). **No Cognito setting was changed.**

## User pool `us-west-2_849AYz5J7`

| SETTING | CURRENT | TARGET | CHANGE REQUIRED? | DEPLOYMENT PHASE | SECURITY IMPACT |
| --- | --- | --- | --- | --- | --- |
| Pool count | 1 | 1 (reuse) | No | n/a | No duplicate identity store |
| Tier | ESSENTIALS | ESSENTIALS | No | n/a | Managed login v2 available |
| Deletion protection | ACTIVE | ACTIVE | No | n/a | Prevents accidental loss |
| Username | email, case-insensitive | same | No | n/a | One identity per address |
| MFA | ON (TOTP; SMS/email off; WebAuthn single-factor) | ON (TOTP) | No | n/a | Strong second factor for every user |
| Password policy | ≥12, all classes, history 5, temp 7 days | same | No | n/a | Meets the directive |
| Self sign-up | Disabled (`AllowAdminCreateUserOnly`) | Disabled | No | n/a | Invitation-only access |
| Recovery | verified email, then phone | verified email | No | n/a | |
| Email sender | COGNITO_DEFAULT | COGNITO_DEFAULT (test); SES later if volume requires | No (test) | 8 | Email content is generic; no PHI |
| Lambda triggers | none | none | No | n/a | No custom code in the auth path |
| Groups | none | none (roles live in PostgreSQL) | No | n/a | Groups can never override the DB |
| Advanced security / threat protection | off | off (Plus tier cost) | No | 7 decision | Document as a Phase 7 decision |
| Domain | `us-west-2849ayz5j7`, managed login v2, ACTIVE | same (custom domain later) | No | 8 | |
| Users | 0 | test: 2 synthetic sign-ins; prod: per migration plan | Yes | Test slice / 8 | Individual identities only |

## App client `ogevia-web` (`1i27abbina08fvg1i9u8vprgo9`), not modified in Phases 3-6

| SETTING | CURRENT | TARGET | CHANGE REQUIRED? | DEPLOYMENT PHASE | SECURITY IMPACT |
| --- | --- | --- | --- | --- | --- |
| Secret | none | none | No | n/a | Public SPA client |
| OAuth flows | code | code (+ PKCE enforced by the app) | No | n/a | |
| Scopes | email, openid | email, openid | No | n/a | |
| Callback URLs | `https://d84l1y8p4kdic.cloudfront.net` (not owned by the account; D-P1-2) | `https://app.ogevia.com/auth/callback` | **Yes** | 8 (cutover) | Removes a redirect to a domain Ogevia does not control |
| Logout URLs | none | `https://app.ogevia.com/` | **Yes** | 8 | Enables a complete logout |
| Explicit auth flows | REFRESH, USER_AUTH, USER_SRP | REFRESH, USER_SRP | **Yes** | 8 | Narrows the auth surface (managed login uses SRP) |
| PreventUserExistenceErrors | ENABLED | ENABLED | No | n/a | No user enumeration |
| Token revocation | on | on | No | n/a | |
| Access / ID token validity | 60 / 60 min | 60 / 60 min | No | n/a | |
| Refresh token validity | 5 days | 12 hours | **Yes** | 8 | Shorter stolen-token window; one shift fits |

The model and the change list are in `infra/aws/lib/cognito-target.ts`; tests in `infra/aws/test/cognito-target.test.ts` assert exactly the four changes.

## New app client `ogevia-web-prod-test-slice` (CDK, WebHosting stack, not deployed)

| SETTING | CURRENT | TARGET | CHANGE REQUIRED? | DEPLOYMENT PHASE | SECURITY IMPACT |
| --- | --- | --- | --- | --- | --- |
| Existence | absent | created by CloudFormation | Yes (create) | Test slice | Isolated from `ogevia-web`; deleting the stack removes only this client |
| Secret | n/a | none (`GenerateSecret: false`) | n/a | Test slice | |
| Flows / scopes | n/a | code; openid, email | n/a | Test slice | |
| Callback / logout | n/a | `https://<distribution>.cloudfront.net/auth/callback` and `/` | n/a | Test slice | Bound by CloudFormation to the distribution Ogevia owns |
| Auth flows | n/a | REFRESH, USER_SRP | n/a | Test slice | No plaintext-password flows (scanner rule) |
| Tokens | n/a | access 60 min, ID 60 min, refresh 12 h, revocation on | n/a | Test slice | |
| Managed login branding | n/a | Cognito-provided defaults | n/a | Test slice | |
| API authorizer audience | `ogevia-web` | `ogevia-web` + test client | Yes | Test slice | Both clients are explicit; any other client is rejected |
