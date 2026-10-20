# Phase 2: Production / Pilot authentication separation (assessment and design only)

Date: 2026-10-20. Repository `socalcaresservices/CarelikGlobal`, branch `claude/determined-franklin-on6umd`, base `d82fefc` (plus two local documentation commits).
**Nothing was implemented, deployed, provisioned or migrated. AWS was not touched.** Every statement about deployed state is a repository-document claim
(UNVERIFIED) until the CloudShell inventory (`CLOUDSHELL_READONLY_INVENTORY.md`) is run and returned.

Evidence classes: **CODE** (read in this checkout, file:line), **TEST** (run this session), **DOC** (a repository document says so), **UNVERIFIED**.

## 0. Corrections and key findings first

**Correction to the Phase 1 assessment (section 4, defect 1).** Phase 1 said any pilot user obtains a token the production API accepts "via the legacy client". More precisely, from the code:

| Token comes from | Pilot (`env=prod`) API accepts | Production (`env=prd`) API accepts |
|---|---|---|
| Legacy client `ogevia-web` (`1i27abbina08fvg1i9u8vprgo9`) | **Yes** | **Yes** |
| `ogevia-web-prod-test-slice` (pilot web client) | Yes | **No** (not in the audience list) |
| `ogevia-web-prd` (production web client) | **No** | Yes |

(CODE: `service-verification-api-stack.ts:540-541` builds the audience from `[config.auth.appClientId, ...extraAppClientIds]`; `app.ts:100` passes only the web stack's own client; `config.ts:158` makes `appClientId` the legacy client for both environments because PRD spreads PROD, `config.ts:251-261`. Existing test `slice-contract.test.ts:65-70` and `slice/smoke.py:640` assert exactly this two-client audience.)

So the audience list alone does **not** let a pilot-client token into production. The real exposure is wider and is caused by the shared pool, not the list:

1. **Legacy client in both audiences.** A token from `ogevia-web` is valid at both APIs. That client allows `ALLOW_USER_SRP_AUTH` and `ALLOW_USER_AUTH` (DOC `PHASE_3_COGNITO_CURRENT_TARGET_MATRIX.md`; CODE `cognito-target.ts:29-35`), so a script can sign in without the broken callback URL.
2. **Any pool user can sign in through any client of the pool.** A Cognito user pool authenticates its users for every app client it hosts. A pilot user can use the **production** client id (it is public: it is in the production site's `/config.json`, `aws-runtime.ts:163-174`) with SRP, obtain a genuine production-audience token, and present it to the production API. That is how a "Pilot token" reaches Production.
3. **What stops them today** is the database, not authentication: `ogevia_api.begin_request` looks the `sub` up in the **production** database's `app_users` and raises `Not authenticated` when absent (CODE `0002_identity_tenancy.sql`, `begin_request`). That is a good last line of defence but it is the only one. It fails if the same person (same `sub`) exists in both databases, which is likely for the owner/administrator and any tester who was also given a production membership. Whether that overlap exists is UNVERIFIED.
4. The reverse direction is the same: a real production user's pool credentials work at the pilot sign-in page.

No identity separation exists at the token layer, so the target must change the pool, not just the audience list.

**Second finding: passwords cannot be moved.** Cognito never exports password hashes, and CSV user import carries no passwords (imported users must reset). The only way to "preserve" passwords is a Lambda user-migration trigger that receives each plaintext password at first sign-in (DOC `PHASE_3_USER_MIGRATION_MAPPING.md` option A, which the project already rejected). Section 5 therefore treats "preserve passwords" as **not recommended**, and uses invitation (option B, already the project's decision D-P3-3).

**Third finding: this is cheap to do now and expensive later.** Production has, per the documents, no customer on it yet: the URL registry says the production candidate is "not yet cleared for real client data" and `app.ogevia.com` is not repointed (DOC `URL_REGISTRY_AND_LAUNCH_CHECKLIST.md`, 2026-10-10). The real, live product for SoCal Care Services today is the Netlify/Supabase site at `www.ogevia.com` (owner-confirmed, DOC `docs/releases/2026-10-14-pilot-readiness/`), which uses Supabase Auth and is **unaffected** by this work.

---

## PART A: CURRENT AUTHENTICATION INVENTORY

### A.1 User pools referenced in the repository

| # | Pool | Where referenced (exact locations) | Status |
|---|---|---|---|
| P1 | `us-west-2_849AYz5J7` ("User pool - q5d8l", created 2026-09-29, Essentials, MFA ON/TOTP, admin-create only, deletion protection ACTIVE, no triggers, no groups, `COGNITO_DEFAULT` email, managed login v2) | CDK: `infra/aws/lib/config.ts:220` (`existing.cognitoUserPoolId`), consumed by `lib/existing-foundation.ts:113-116`, `lib/service-verification-api-stack.ts:442,449,466,515,540`, `lib/web-hosting-stack.ts:134,153`. Scripts: `scripts/deploy-test-slice.sh:40`, `slice/pilot-lib.sh:13`, `slice/finish.sh:20`, `slice/owner-access-check.sh:25`, `slice/pilot-change-email.sh:17`, `slice/pilot-evidence.sh:13`, `slice/pilot-regression-local.sh:20`, `slice/increment-bootstrap.sh:42`, `slice/increment-resume-block.sh:96`, `slice/increment_preflight.py:43`, `slice/phase7_evidence.py:32`, `slice/release-0026-bootstrap.sh:40`, `slice/release-0036-bootstrap.sh:40`, `slice/release_0026_gate.py:39`, `slice/smoke.py:38`, `slice/pilot-recover-scope.sh:213,219,361`, `slice/ogevia-live-status-block.sh:35,529`. Tests: `packages/auth/src/security.static.test.ts:55` (forbids the id in auth sources). Docs: `PHASE_3_COGNITO_CURRENT_TARGET_MATRIX.md`, `PHASE_3_AUTH_ARCHITECTURE.md`, `PHASE_1_RESOURCE_OWNERSHIP.md`, `MIGRATION_PLAN.md:198`, `docs/releases/2026-10-13-0047-0048-0049/DEPLOYMENT_PLAN.md:37`, `docs/releases/2026-10-14-pilot-readiness/PILOT_DEPLOYMENT_PROCEDURE.md:93`, `docs/releases/account-status/README.md:17` | **Shared by pilot and production (CODE: `config.ts:251` PRD spreads PROD)**. Live state UNVERIFIED. |
| P2 | `us-west-2_TESTPOOL1` (synthetic) | `packages/auth/src/test/tokens.ts:6`, `apps/web/e2e/aws-slice-smoke.mjs:8-10` | Test fixture only |
| P3 | Local-harness issuer (synthetic JWKS) | `infra/aws/local-harness/serve.ts` (config.json endpoint line 185; handler config line 102) and `slice/pilot-regression-local.sh:20` (sets `OGEVIA_LOCAL_POOL`) | Local only, never deployed |
| P4 | Supabase Auth (legacy, not Cognito) | `packages/auth/src/auth-provider.tsx` (default mode), `apps/web/src/env.ts` (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`), `netlify.toml:16-18` (deploy previews only), `apps/netlify-functions/*` (Supabase JWT) | Live production for `www.ogevia.com` per DOC; separate system; out of scope here |
| (proposed) | `docs/deployment/ogevia-prd-config-required.txt:14` suggests "create new **or reuse** `us-west-2_849AYz5J7`" | | Older document; conflicts with this design |

CDK does not own P1 (`PHASE_1_RESOURCE_OWNERSHIP.md`); it is imported by id.

### A.2 App clients

| # | Client | Defined at | Callback / logout | Notes |
|---|---|---|---|---|
| C1 | `ogevia-web` `1i27abbina08fvg1i9u8vprgo9` (legacy, manual, in P1) | `config.ts:158`; `cognito-target.ts:24`; `slice/smoke.py:43` | callback `https://d84l1y8p4kdic.cloudfront.net` (a distribution this account does not own, DOC D-P1-2); logout none (`cognito-target.ts:27-29`) | Flows: code, `ALLOW_REFRESH_TOKEN_AUTH`, `ALLOW_USER_AUTH`, `ALLOW_USER_SRP_AUTH`; refresh 5 days; **in the audience of both APIs**. A model target exists (`OGEVIA_WEB_TARGET`, `cognito-target.ts:41-55`: `https://app.ogevia.com/auth/callback`, logout `https://app.ogevia.com/`) but is not applied. |
| C2 | `ogevia-web-prod-test-slice` (CDK, in P1) | `lib/web-hosting-stack.ts:132-151` (name at :135) | callback `<pilot CloudFront origin>/auth/callback`; logout `<origin>/`; plus `config.testSlice.localDevOrigins` (currently `[]`, `config.ts:236`) | public, code+PKCE, SRP+refresh only, access/id 60 min, refresh 12 h, revocation on |
| C3 | `ogevia-web-prd` (CDK, in P1) | same construct, `clientName` branch at :135 | callback `<prd CloudFront origin>/auth/callback` | same settings; live ids DOC `URL_REGISTRY...`: app `d3l4psdkokkvnb.cloudfront.net` |
| C4 | `ogevia-prd-web` (never created) | `docs/deployment/ogevia-prd-config-required.txt:20-30` | `https://app.ogevia.com/auth/callback`, `http://localhost:5173/auth/callback` | Older plan; superseded by C3 |
| C5 | Test fixtures | `testclient0000000000000000` (`packages/auth/src/test/tokens.ts:6-7`), `someotherclient00000000000` (`principal.test.ts:41`, `unit.test.ts:126`), `localregressionclient000000` (`slice/pilot-regression-local.sh:20`) | | Synthetic |

Pilot CloudFront `d2xumch5w0izfg.cloudfront.net`, API `s0epy5rgzb`; production candidate `d3l4psdkokkvnb.cloudfront.net`, API `zk527zk4ua` (DOC only).

### A.3 Callback and logout URLs (complete list found)

| URL | Source |
|---|---|
| `https://d84l1y8p4kdic.cloudfront.net` (callback, C1) | `cognito-target.ts:28` |
| `https://app.ogevia.com/auth/callback`, `https://app.ogevia.com/` (target, C1; not applied) | `cognito-target.ts:42-43` |
| `<WebOrigin>/auth/callback`, `<WebOrigin>/` per environment (C2, C3), computed at deploy | `web-hosting-stack.ts:141-142`; `deploy-production.sh:326,333` |
| `http://localhost:5173/auth/callback`, `http://localhost:5173/` (dev) | `docs/deployment/ogevia-prd-config-required.txt` |
| `https://app.example.test/auth/callback`, `https://app.example.test/` (synthetic) | `packages/auth/src/test/tokens.ts:35-36` |
| `http://127.0.0.1:<port>/auth/callback` (local harness) | `local-harness/serve.ts` |
| CORS allowed origins (not Cognito, but related): `https://app.ogevia.com` plus the env's own `WebOrigin` | `config.ts:160`, `app.ts:99`, `service-verification-api-stack.ts:548` |

### A.4 Frontend environment configuration

| Key (browser) | Defined / validated | Set by |
|---|---|---|
| `VITE_AUTH_PROVIDER` (`cognito` or `supabase`; unset = supabase) | `packages/auth/src/auth-provider.tsx:~229-233`, `apps/web/src/main.tsx:12`, `env.ts:42` | pilot: `deploy-test-slice.sh:190`; prd: `deploy-production.sh:331`; Netlify: not set in `netlify.toml` (UNVERIFIED) |
| `VITE_COGNITO_REGION`, `_USER_POOL_ID`, `_CLIENT_ID`, `_DOMAIN`, `_REDIRECT_URI`, `_LOGOUT_URI`, `_SCOPES`, `_REFRESH_PERSISTENCE` | `packages/auth/src/cognito/config.ts:22-77` (fails closed on malformed value, pool/region mismatch, non-https redirect) | pilot `deploy-test-slice.sh:190-193`; prd `deploy-production.sh:331-334` (pool from `print-prd-config.ts:27`, client from stack output `TestAppClientId`, domain read from the pool at build time) |
| `VITE_SV_API_BASE_URL`, `VITE_APP_ENV` | `apps/web/src/aws/aws-runtime.ts:13-27` | same scripts |
| Runtime override `/config.json` (same origin; keys listed at `aws-runtime.ts:163-174`) | `aws-runtime.ts:47-60`; local `serve.ts:185` | deployment; **not validated against the environment**, so a mis-copied client id is accepted by the browser and only rejected later by the API |
| Cross-environment guard in the browser | `apps/web/src/aws/environment.ts:18-23` shows a label only (TEST banner / "not verified"); it does not compare pool or client with `VITE_APP_ENV` | gap |

### A.5 Backend authentication configuration

| Item | Value / rule | Location |
|---|---|---|
| Lambda env `COGNITO_USER_POOL_ID` | from `existing.userPool.userPoolId` (= P1) | `service-verification-api-stack.ts:515` |
| Lambda env `COGNITO_APP_CLIENT_ID` | comma list `[config.auth.appClientId, ...extraAppClientIds]` | `service-verification-api-stack.ts:516` |
| Lambda config loader | region match; pool id must match `^<region>_…`; every client id `^[a-z0-9]{26}$`; issuer derived `https://cognito-idp.<region>.amazonaws.com/<pool>`; `OGEVIA_ENV=prd` forces `DB_NAME=ogevia_prd` but **has no equivalent check for pool or client** | `apps/sv-api/src/config.ts:41-84` |
| API Gateway JWT authorizer | issuer = `cognitoIssuer(region, P1)`, audience = the same client list | `service-verification-api-stack.ts:539-542`; `lib/auth-contract.ts:61` |
| In-Lambda re-check | `principalFromClaims` (claims verified by API Gateway) | `packages/auth/src/server/principal.ts` |
| Full signature verification (defence in depth, tests) | `verifyAccessToken` via JWKS | `packages/auth/src/server/verify.ts` |
| Identity (email invitation / disable / enable) Lambda | env `COGNITO_USER_POOL_ID`; IAM `AdminCreateUser/GetUser/Disable/Enable` on the one pool ARN | `service-verification-api-stack.ts:442,449,466`; handler `apps/sv-api/src/identity-handler.ts` |
| Production bootstrap | administrator `sub` linked by SQL | `db/deploy/13_prd_bootstrap_admin.sql` |
| Per-environment function names | `Ogevia-<env>-IdentityAdmin` | `service-verification-api-stack.ts:58-60` |

### A.6 JWT validation rules, accepted audiences and issuers (what is enforced, by which layer)

| Check | API Gateway authorizer (before Lambda) | Lambda `principalFromClaims` |
|---|---|---|
| Signature (RS256, pool JWKS) | Yes (AWS documented behaviour) | No (trusts the gateway; `verifyAccessToken` exists for tests) |
| Issuer equals configured pool issuer | Yes | `wrong_issuer` |
| Audience / `client_id` in approved list | Yes (HTTP API checks `aud` or, for access tokens, `client_id`) | `wrong_client` |
| Not expired | Yes | `expired` |
| `token_use = access` | No | `wrong_token_use` (rejects ID tokens) |
| `sub` is a UUID | No | `malformed_sub` / `missing_sub` |
| Scope includes `openid` | Not configured | `missing_scope` |
| Tenant, role, membership | Never from the token | Database (`begin_request`, `is_active_member`, `has_permission`) |

**Accepted issuers today:** `https://cognito-idp.us-west-2.amazonaws.com/us-west-2_849AYz5J7` (the only one), for both APIs.
**Accepted audiences today:** pilot API `{C1, C2}`; production API `{C1, C3}` (CODE as above; live UNVERIFIED).

### A.7 Other places that fix the shared-pool assumption (will need change)

`slice/smoke.py:631,640` (asserts the legacy client exists and the audience is `{C1, test client}`); `test/slice-contract.test.ts:65-70`; `slice/release_0026_gate.py:39`, `slice/increment_preflight.py:43`, `slice/phase7_evidence.py:32`; `scripts/print-prd-config.ts:27` (prd reads the pilot's pool); `docs/aws/PHASE_3_*`, `PRODUCTION_DEPLOYMENT.md` section 8. The pilot scripts that hard-code P1 remain correct if P1 stays the pilot pool (a reason for the target mapping in Part C).

---

## PART B: AUTHENTICATION TRUST BOUNDARY REVIEW

**B.1 How production validates a JWT.** Request, then API Gateway HTTP API JWT authorizer (issuer P1, audience `{C1, C3}`), then Lambda `principalFromClaims` (issuer, `client_id`, `token_use=access`, `sub`, expiry, `openid`), then `withPrincipal` runs `begin_request(sub)` and `SET LOCAL ROLE ogevia_app` (CODE `handler.ts`, `db-bridge.ts`). Identity is only the `sub`; organization and role come from PostgreSQL.

**B.2 Audiences accepted (production):** C1 `ogevia-web` and C3 `ogevia-web-prd` (CODE). **Clients accepted:** two. **Multiple clients accepted:** yes, by design (`extraAppClientIds`).

**B.3 Are Pilot-generated tokens accepted by Production?** By code analysis:
- Token from the pilot's own web client C2: **rejected** at the authorizer (audience).
- Token from C1 (legacy, any pool user): **accepted** by the authorizer and Lambda. Rejected only at the database unless that `sub` exists in `ogevia_prd`.
- Token minted by a pilot user through C3 (the production client): **accepted** at the authorizer and Lambda for the same reason. Rejected only at the database.
- Not validated live. Verification: section E.5 live tests; inventory section 5 of CloudShell file shows the live audience and clients.

**B.4 Routes protected.** 169 route keys in `apps/sv-api/src/routes.ts`. 159 require the JWT authorizer. 10 are public, token-in-URL routes: `/v1/public/visit-confirmations/{token}/open|respond` (2), `/v1/public/care-portals/{token}` and its 4 request sub-routes (5), `/v1/public/care-offers/{token}`, `/respond`, `/cancel-assignment` (3). The exact approved list is `lib/public-routes.ts`; the stack refuses to synthesize any other unauthenticated route (`assertPublicRoutesApproved`, `service-verification-api-stack.ts` route loop). The public routes do not depend on the pool and are unaffected by this work. Protected routes that touch identity: `/v1/me`, `/v1/accounts*`, caregiver invitation routes (use the identity Lambda).

**B.5 Trust-boundary summary.**

| Boundary | Today | Assessment |
|---|---|---|
| Token to API (pilot vs production) | Same issuer; legacy client in both audiences | **Not a boundary** |
| Sign-in surface (who may obtain a production token) | Every user in the shared pool | **Not a boundary** |
| Token to tenant data | Database membership per request | Strong |
| Token to production database | `sub` must exist in `ogevia_prd.app_users` | Effective only while subs do not overlap between databases |
| Configuration fail-closed | DB name checked for prd (`config.ts:52-56` of sv-api); pool/client not checked | Gap |
| Identity Lambda scope | One pool ARN; the pilot and production functions both point at P1 | Not isolated |

---

## PART C: TARGET AUTHENTICATION ARCHITECTURE

### C.1 Principles

1. One user pool **per environment**; no pool is shared across environments; no pool per customer (agencies are tenants inside one pool, separated by database membership as today).
2. Each environment's API accepts exactly the clients of its own pool: issuer is that pool, audience is that pool's clients, nothing else.
3. Defence in depth: the same pairing is enforced at synth (CDK), at deploy (`assert`), at cold start (Lambda config) and in the browser (config check).
4. Roles, tenants and permissions remain in PostgreSQL. No Cognito groups, no custom attributes (unchanged decision).
5. A person who works in two environments has two identities (two `sub`s). That is intended.

### C.2 Pool inventory (target)

| Environment | Pool | Source | Web client(s) | API accepts | Notes |
|---|---|---|---|---|---|
| Production | **new** pool `ogevia-prd` | CDK-created (new AuthStack) | `ogevia-web-prd` only | issuer = new pool; audience = `{ogevia-web-prd}` | first priority; MFA ON; deletion protection; retain on stack delete |
| Pilot / Test (Staging) | **existing** `us-west-2_849AYz5J7` retained | unchanged (imported) | `ogevia-web-prod-test-slice` (legacy `ogevia-web` removed from the audience after the observation window) | issuer = P1; audience = `{test client}` | pilot users and the ~20 pilot scripts keep working with no change |
| Demo / Training | **new** pool `ogevia-demo` | CDK | `ogevia-web-demo` | its own only | synthetic users; invitations disabled or allow-listed (outside this document's scope) |
| Development | **new** pool `ogevia-dev` | CDK | `ogevia-web-dev` (+ localhost callbacks) | its own only | the only pool with localhost callbacks and a throw-away second client for negative tests |

Rationale for keeping P1 as the pilot/test pool rather than moving the pilot: P1 already carries every pilot sign-in and about twenty scripts; production is the environment with the fewest users and no live customer. Moving production is smaller and safer than moving the pilot.

### C.3 Diagrams

Today:

```text
 Pilot web (C2) ──┐                               ┌── Pilot API  (audience C1,C2)  ── DB ogevia_sv_test
 Prod web  (C3) ──┼── ONE POOL  us-west-2_849AYz5J7 ┤
 legacy    (C1) ──┘     (all users, all clients)     └── Prod API   (audience C1,C3)  ── DB ogevia_prd
                                                         ▲ any pool user can mint a token for C1 or C3
```

Target:

```text
 Dev  web ─ Dev pool  ─ Dev API  (iss=Dev pool,  aud={dev client})   ─ Dev DB
 Test web ─ P1 (kept) ─ Test API (iss=P1,        aud={test client})  ─ ogevia_sv_test
 Demo web ─ Demo pool ─ Demo API (iss=Demo pool, aud={demo client})  ─ Demo DB
 Prod web ─ Prod pool ─ Prod API (iss=Prod pool, aud={prd client})   ─ ogevia_prd
 Each token is signed by its own pool's keys; a token minted anywhere else fails signature/issuer at the gateway.
```

Layers enforcing the pairing (all must agree):

```text
 CDK synth test ─ one config entry per env: {pool, domain, clients} must be unique across envs
 CDK deploy      ─ authorizer issuer/audience, Lambda env, IAM pool ARN, web client all derived from the SAME entry
 Lambda start    ─ loadConfig refuses (pool, client) not registered for OGEVIA_ENV  [new]
 Browser start   ─ refuses a pool/client not matching VITE_APP_ENV and the API URL    [new]
 Database        ─ begin_request(sub) unchanged (last line)
```

### C.4 Required properties of each new pool (parity with P1, except where noted)

Email as username; admin-create-only; MFA ON, TOTP only; password min 12 with all classes, history 5; deletion protection ACTIVE; Essentials tier with managed login v2 and a per-environment domain prefix; no Lambda triggers; no groups; token revocation on; email sender `COGNITO_DEFAULT` initially (about 50 messages/day, DOC) with SES as a separate owner decision before volume onboarding. **Choose attribute and username settings carefully: they cannot be changed after the pool exists.** Define the pool in CDK with `RemovalPolicy.RETAIN` and stack termination protection.

### C.5 Design changes required (no code written)

| Area | Change |
|---|---|
| `lib/config.ts` | Per-environment `auth: { userPoolId, domainPrefix, clientIds }`; add envs `demo`, `dev` (names per Phase 1 D3); remove the shared `existing.cognitoUserPoolId` / `appClientId` for `prd`; assert pools, domains and client ids unique across environments |
| New `lib/auth-stack.ts` | Creates the pool, domain and managed-login branding (CDK) for `prd` (then demo, dev); exports `userPoolId` |
| `lib/existing-foundation.ts` | Stop importing the pool for `prd`; keep import for the pilot (P1) |
| `lib/web-hosting-stack.ts` | The client is created in the environment's own pool (`config.auth`), not `config.existing.cognitoUserPoolId`; rename construct id away from "TestSlice" for production only when safe (renaming a CloudFormation logical id replaces the client) |
| `lib/service-verification-api-stack.ts` | Issuer/audience and both identity IAM statements and the Lambda env from the environment's pool; **no legacy client** for `prd` |
| `apps/sv-api/src/config.ts` | `OGEVIA_ENV=prd` requires a pool id that is not the pilot's and a single client id; mirrors the existing DB-name check |
| `apps/web` `aws-runtime.ts` | Optional: refuse a production build whose client id is not in an embedded allow-list for that environment (fail-closed; changes no UI) |
| Scripts | `deploy-production.sh` and `print-prd-config.ts` read the production pool; `13_prd_bootstrap_admin.sql` unchanged (accepts a `sub`) |
| Tests | `slice-contract.test.ts:65-70` and `slice/smoke.py:640` updated per environment; new cross-environment tests (Part E) |
| Database | No schema change. `app_users.cognito_sub` is relinked in `ogevia_prd` only |

---

## PART D: ZERO-DOWNTIME MIGRATION PLAN

### D.0 Constraints that shape the plan

- An API Gateway JWT authorizer accepts **one issuer per authorizer** and each route has one authorizer. Running two pools side by side on the **same** API is therefore not possible without duplicating routes. This is why the plan uses a parallel stack only if real users exist (decision gate G1), and otherwise a short controlled switch.
- Production has, per documents, no live customer. The number of real production sign-ins is UNVERIFIED and must be established first (Phase 0).
- Passwords cannot be copied (see section 0). Users receive an invitation and enrol TOTP; they would have to enrol TOTP in any new pool anyway. This follows the project's existing decision D-P3-3.
- `app_users.cognito_sub` is unique and singular. Relinking a person is an audited SQL update on `ogevia_prd` only; the pilot database is untouched.
- The pilot, the pilot pool P1 and the Netlify/Supabase product are **not changed** at any phase except the optional cleanup in Phase 4.

### D.1 Phases

| Phase | What | Approval class | Success criteria | Rollback |
|---|---|---|---|---|
| **0 Evidence (read-only)** | Run the CloudShell inventory. Add: count of users in P1 (`EstimatedNumberOfUsers`), count of `ogevia_prd.app_users` and active memberships (counts only), list of `sub`s present in **both** databases (hash-compare, no emails), whether any production visit/record is real. Decision gate **G1**: real production users exist? | none (read-only) | Live clients/audiences recorded; user counts known; overlap list known | n/a |
| **1 Build and prove, no deploy** | Implement C.5 behind new config on a branch; `cdk synth` for all environments; all Part E local tests green; `cdk diff` reviewed (expect: prd authorizer, prd Lambda env, prd identity IAM, prd web client change; **pilot template unchanged**) | GREEN (code), owner review of diff | `pnpm typecheck/lint/test/test:all` pass; CDK assertions prove unique pools and exact audiences; pilot stack diff is empty | revert the branch |
| **2 Provision production pool (no traffic)** | Deploy only the new AuthStack for `prd`: pool, domain, branding, no users, no app client wired to anything yet | **YELLOW** (creates Cognito resources; cost about $0) | `describe-user-pool` matches C.4 exactly; MFA ON; deletion protection ACTIVE; zero users; existing prd API and web still on P1 and working | `cdk destroy` of the AuthStack is blocked by retain policy by design; deletion needs a separate RED instruction. The unused pool carries no risk. |
| **3 Cut production over** | (a) Invite production staff into the new pool (`AdminCreateUser`, invitation email) and record each new `sub`. (b) Deploy prd WebHosting (new client in the new pool) and prd API (authorizer, Lambda env, identity IAM) in one change set. (c) Relink `app_users.cognito_sub` for each person in `ogevia_prd` in one audited transaction, verify `GET /v1/me` per person. (d) Publish the prd web build with the new client/domain. If **G1 = no real users** this is a short window at a time chosen by the owner; if **G1 = yes**, build the new web and API as a parallel stack (`Ogevia-prd2-*`, pay-per-use, no fixed cost) and move users by link, keeping the old stack until all have signed in | **YELLOW** (API, Lambda, IAM, web, Cognito users, SQL) | Part E live matrix passes; each administrator signs in with MFA; `/v1/me` returns the right memberships; production token rejected by Pilot API; Pilot token rejected by Production API; alarms quiet for 24 h | Keep the old pool, old client and old stack untouched. Rollback = redeploy the previous commit (restores authorizer/env/web) and reverse the recorded `sub` mapping (reverse SQL), at most minutes. Do not delete the new pool or users; disable them |
| **4 Retire the shared paths** | After an observation window (suggest 7 days): remove `ogevia-web-prd` from P1 (production no longer uses it); remove legacy `ogevia-web` from the pilot audience once the owner confirms no use; add fail-closed checks permanently; update smoke/gate scripts; then Demo and Dev pools from the same AuthStack | **YELLOW** (deleting a client is irreversible for that client id; recreate gets a new id) | P1 hosts only pilot clients; no production client in P1; docs updated; `list-user-pool-clients` on P1 shows only pilot clients | recreate the client (new id) and redeploy the pilot web; the pilot is otherwise unaffected |

### D.2 How each requirement is met

| Requirement | Answer |
|---|---|
| Preserve existing users | Identity (email, role, membership, history) preserved: users are recreated by invitation; their roles/memberships/data are in PostgreSQL and are kept by relinking `cognito_sub`. Nobody is deleted anywhere. |
| Preserve passwords | **No**, except via a user-migration Lambda, which handles plaintext passwords and is not recommended (rejected earlier, D-P3-3). Users set a new password and enrol TOTP, which a new pool requires regardless. |
| Minimise operational risk | Pilot untouched; build and test first; production pool created empty; one change set; recorded mapping; old resources kept |
| Avoid customer disruption | No customer is on production per documents (to be confirmed in Phase 0); Netlify/Supabase product unaffected; if real users exist, parallel stack with user-by-user move |
| Allow rollback | Section D.1 column; old pool never deleted or modified before Phase 4 |

### D.3 Not in this plan

DNS for `app.ogevia.com`/`demo.ogevia.com`, SES, WAF, custom domain for Cognito, tenant lifecycle and platform-operator identity (Phase 1 D4), moving the pilot to a new pool.

---

## PART E: AUTHENTICATION VALIDATION SUITE

### E.1 Test layers

| Layer | Runs where | What it proves | Exists today |
|---|---|---|---|
| L1 principal / token unit tests | CI, no AWS | wrong audience, wrong issuer, expired, wrong token type, forged signature | **Yes**: `packages/auth/src/server/principal.test.ts:41` (unapproved client → `wrong_client`), `:42` (missing client), `:107` (forged), `:130` (JWKS path wrong client); `apps/sv-api/test/unit.test.ts:126` |
| L2 CDK template assertions | CI | each environment's authorizer issuer, audience, Lambda env, IAM pool ARN and web client all come from that environment's own pool; pools/domains/clients unique across environments; production audience has exactly one client | Partial: `slice-contract.test.ts:65-70` asserts the **shared** shape and must change |
| L3 handler integration with two synthetic issuers | CI, no AWS | cross-environment rejection through `createHandler` | Local issuer helper exists (`principal.test.ts`, `local-harness/serve.ts`); cross-env cases do not |
| L4 live negative matrix | after Phase 2/3, synthetic users only | real tokens from real pools against real APIs | No |

### E.2 Test cases (the seven you required, plus the ones the analysis showed are needed)

Notation: Pool/API pairs: Prod, Pilot (Test), Demo. HTTP expectations: gateway rejection is **401** with `www-authenticate: Bearer error="invalid_token"`; a token passing the gateway but failing Lambda checks is 401 `unauthenticated` (`handler.ts`); an unknown `sub` returns 401 from `begin_request`.

| ID | Case | Layer | Expected |
|---|---|---|---|
| E1 | Production token → Production API `GET /v1/me` | L3, L4 | 200, memberships returned |
| E2 | Demo token → Production API | L2/L3/L4 | 401 (issuer) |
| E3 | Pilot token → Production API | L2/L3/L4 | 401 (issuer) |
| E4 | Production token → Demo API | L2/L3/L4 | 401 |
| E5 | Wrong audience: token from another client of the **same** pool (L3 uses a second synthetic client; L4 only in the Dev pool with a throw-away client) → API | L1/L3/L4 | 401 `wrong_client` |
| E6 | Wrong issuer: token signed by pool B presented where pool A expected | L1 (`wrong_issuer`), L3, L4 | 401 |
| E7 | Expired token (clock injected in L1/L3; L4 uses a captured token older than its 60 minute life) | L1/L3/L4 | 401 `expired` |
| E8 | ID token instead of access token | L1 | `wrong_token_use` |
| E9 | Token for the **legacy** `ogevia-web` client (after Phase 4) → Pilot and Production | L2, L4 | 401 |
| E10 | A pilot user attempting to sign in at the production hosted UI / production client id (SRP) | L4 | Sign-in fails: the user does not exist in the production pool (this is the property the current design lacks) |
| E11 | Valid production token whose `sub` is unknown to `ogevia_prd.app_users` | integration | 401 `Not authenticated` |
| E12 | Disabled user / suspended membership with a still-valid token | integration (exists: `account-status.db.test.ts`) | refused on next call |
| E13 | Public token routes unaffected (10 routes) | L2/L4 | reachable without JWT, only with valid 64-hex token |
| E14 | Config guard: Lambda started with `OGEVIA_ENV=prd` and the pilot pool or two clients | L1 unit on `loadConfig` | `ConfigError` |
| E15 | Config guard: CDK config containing duplicate pool/domain/client across environments | L2 | synth/test fails |
| E16 | IAM: the production identity function's policy names only the production pool ARN, the pilot's only P1 | L2 | assertion |
| E17 | Web: a production build with a client id not in the production allow-list | web unit | start-up error, no redirect |

### E.3 Technical approach

- **L1/L3 (no AWS, deterministic):** generate two RSA key pairs and two issuers with the existing local issuer helper (`packages/auth/src/test`), mint access tokens per case, and drive `createHandler` (`apps/sv-api/src/handler.ts`) configured per environment (`{issuer, appClientIds}`) with an in-memory DB stub for E1 and a pg test database for E11. The JWT-authorizer step is emulated by running `verifyAccessToken` before the handler, with the environment's JWKS, because the real gateway cannot be run locally.
- **L2 (CDK):** `Template.fromStack` for each environment; assert `AWS::ApiGatewayV2::Authorizer` `JwtConfiguration.Issuer` contains the env's pool reference and `Audience` equals exactly the env's client list; Lambda `COGNITO_USER_POOL_ID/COGNITO_APP_CLIENT_ID`; IAM statements' resource ARN; no template mentions another environment's pool id. Add a pure config test that pool ids, domain prefixes and client ids are pairwise distinct.
- **L4 (live, synthetic only):** use dedicated synthetic users in each pool. Obtain an access token by the real sign-in in a browser and read it once from the request's `Authorization` header; pass it to `curl` through an environment variable, never write it to a file or log, discard it. Expired-token case: reuse a token older than 60 minutes. The script prints only the HTTP status and `routeKey`. No production data is read (`/v1/me` only). Run on the pilot and demo first, then production after Phase 3. Do not create password-based test clients in the production pool.
- **Gate:** E1-E7, E10, E14-E16 are mandatory release gates for Phase 3; the others are required before Phase 4.

---

## PART F: RISK REGISTER

Rating = severity if it occurs (probability noted). "Current" rows describe the shared-pool risks that exist today.

| # | Risk | Type | Rating | Likelihood / evidence | Mitigation |
|---|---|---|---|---|---|
| R1 | Any pilot/test user can obtain a production-audience token (legacy client, or the production client id) | Security (current) | **High** now; **Critical** once real customers are on production | Certain at the authentication layer (CODE); blocked at the database only when the `sub` is absent from `ogevia_prd` | Separate pools (this design); keep DB check; E2/E3/E10 gates |
| R2 | Same person/`sub` exists in both databases, so a token works on both APIs | Security (current) | **High** | UNVERIFIED; plausible for owner and testers | Phase 0 overlap check; separate pools give distinct subs |
| R3 | Legacy `ogevia-web` client: unowned callback, SRP enabled, 5-day refresh, accepted by both APIs | Security (current) | **High** | CODE/DOC | Remove from audiences (Phase 4); later delete |
| R4 | Accidental deletion of the new pool loses all production sign-ins; no pool backup exists (DOC `CONTINUITY_AND_RECOVERY.md:29`; relinking tool "not built") | Operational | **Critical** | Low probability, very high impact | Deletion protection ACTIVE, CDK `RETAIN`, stack termination protection, deletion is a RED action; build and test an audited relink/re-invite runbook |
| R5 | Administrator locked out during cutover (new password + TOTP not enrolled, invitation email missed) | Migration | **High** | Medium | Invite and have the administrator complete sign-in in the new pool **before** deploying the switch; keep old stack for rollback; keep the owner reachable; two administrators if the business allows |
| R6 | Wrong person linked to a `sub` (typo email, shared mailbox) gains owner rights | Security / Migration | **High** | Low | Link only the `sub` returned by `AdminGetUser` for the verified email; two-person review of the mapping; audited SQL; `13_prd_bootstrap_admin.sql` already refuses a second owner |
| R7 | Pool settings that are immutable after creation (username attributes, schema) are wrong | Migration | **Medium** | Low | Copy P1's verified settings into CDK; review `describe-user-pool` output before Phase 3 |
| R8 | Single-issuer authorizer prevents dual-running; brief sign-out of existing sessions | Operational | **Medium** | Certain, small | Schedule outside shifts; parallel stack when G1 = yes; sessions re-authenticate |
| R9 | `cdk deploy` replaces the web app client (logical id or pool change), invalidating the client id in a published web build | Migration | **Medium** | Medium | `cdk diff` review for replacement; deploy API and web in one planned order; Phase 1 gate "no unintended replacement" (CLAUDE.md section 14) |
| R10 | Cognito default email limit (about 50/day), sender reputation, invitation spoofing | Operational | **Medium** | Rises with onboarding | Decide SES before volume onboarding (separate decision); out of scope here |
| R11 | Config mis-copy: wrong client id in `/config.json` or build env | Operational | **Medium** | Medium | Browser and Lambda fail-closed checks (C.5); deploy script assertions |
| R12 | Hard-coded pool id in about 20 pilot scripts and gate scripts diverges from the CDK source of truth | Operational | **Low** | Certain, but pilot keeps P1 | Keep P1 as pilot; later move ids to config; update `smoke.py`, gates |
| R13 | Users must re-enrol TOTP and reset password; support burden | Operational | **Low** (few users) / **Medium** (many) | Certain | Written instructions; staged groups; support window |
| R14 | Confusion with the live Supabase product (separate auth) | Operational | **Low** | Medium | State clearly in release notes that `www.ogevia.com` users are unaffected |
| R15 | New pools add cost | Cost | **Low** | Essentials tier billed per monthly active user above a free allowance (DOC, **not re-verified**); about 20 users now | Verify current AWS pricing before Phase 2; cost model update |
| R16 | Conflicting older plans (`ogevia-prd-config-required.txt`, `docs/deployment/*`) reintroduce a shared pool | Process | **Low** | Medium | Mark superseded in Phase 1 documentation fix |
| R17 | Tests/scripts encoding the shared audience (`slice-contract.test.ts`, `smoke.py:640`) fail or are weakened | Process | **Low** | Certain | Update them as part of the change, never skip |

---

## PART G: EXECUTIVE DECISION MEMO

**To:** Owner. **Re:** Separate Production and Pilot sign-in before onboarding customers.

**Recommendation: Yes. Do it before any customer is onboarded to the AWS production environment, and before `app.ogevia.com` is pointed at it.**

**Why.** Production and the pilot share one user pool. The pilot's synthetic users, and the old shared client, can obtain sign-in tokens that the production API's front door accepts; only the database's membership check stops them today. That is one control instead of two, and it fails if the same sign-in exists in both databases. It is cheap to fix now (no customer on production, few users) and costly later (every customer would need to be moved).

**Corrected finding.** Your Phase 1 note is right in effect but the route is not the pilot's own client; it is the legacy client plus the fact that every user in the pool can sign in through any client of that pool. Fixing the audience list alone would not close it. Separate pools do.

**What I recommend building**

| | |
|---|---|
| Target | New production pool; keep the existing pool as the pilot/test pool; add Demo and Development pools later from the same code |
| Order | Production first |
| Passwords | Cannot be copied between pools; people set a new password and enrol an authenticator app once (same as any new pool) |

**1. Before customer onboarding?** Yes. Make it a release gate: no real customer data until E1-E7, E10, E14-E16 pass on production.

**2. Implementation complexity: Medium.** One new CDK stack, per-environment authentication configuration, changes to three existing stacks, two scripts and about fifteen tests and gate scripts. No database schema change and no screen changes. Main risk is review of the deployment diff for unintended replacement.

**3. Migration complexity: Low if production has few or no real users (expected per documents); Medium if real users exist** (then a parallel production stack and a user-by-user move). Confirm by Phase 0 counts.

**4. Required AWS changes (all need your explicit approval, none done):**
- Create the production user pool, its sign-in domain, branding and one app client; later Demo and Development pools.
- Change the production API's token check (issuer and allowed client), its Lambda settings and its identity function's permissions to the new pool.
- Re-publish the production web app with the new sign-in settings.
- Create the production sign-ins by invitation and relink them in the production database (one audited SQL change).
- After a week: remove the production client from the pilot pool and the legacy client from the pilot's allowed clients.
- Estimated recurring cost: about $0 at current user counts (pricing to be re-verified).

**5. Required application changes:** per-environment auth configuration; a startup check that refuses a production API or browser configured with the pilot's pool or an unexpected client; updated tests and smoke/gate scripts; documentation corrections. No change to roles, tenants, permissions or database.

**Decisions I need from you**
1. Approve production-first separation and keeping the existing pool as the pilot/test pool.
2. Confirm whether any real person already signs in to the AWS production environment (decides cutover style, gate G1).
3. Choose the sender for production invitation emails (Cognito default is limited to about 50 a day; SES is a separate decision).
4. Approve running the CloudShell inventory, including the user and `sub` overlap counts, so Phase 0 can close.

**Recommended smallest next step:** run the CloudShell inventory plus the count-only overlap checks (Phase 0). It is read-only, free, and determines the cutover style. Then Phase 1 (code and tests only, no deployment) for owner review.

---

## Appendix: assumptions and what was not verified

- All pool, client, audience and callback facts about deployed resources are from repository documents; none was observed live.
- AWS service behaviour cited (HTTP API JWT authorizer checks issuer/audience-or-`client_id`/expiry; Cognito does not export password hashes; user pools authenticate against any client in the pool; immutable pool attributes) is documented AWS behaviour and was not re-fetched in this session; confirm against current AWS documentation during Phase 1.
- Cognito pricing and the default email limit are from earlier project documents and were not re-verified.
- The number of users in the pool and the `sub` overlap between databases are unknown.
