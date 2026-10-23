# Source behind the live Service Verification APIs (identified 2026-10-23)

The live API stacks were NOT built from outside this repository. They come from commits that are on branches other than `main`
(this checkout was shallow when first inspected, which hid them). `main` (d82fefc) is simply older than both deployments.

Status words: VERIFIED = observed output or exact reproduction; INFERRED = follows from verified facts; UNKNOWN = not yet observed.

## Pilot / test API (`Ogevia-prod-ServiceVerificationApi`, API `s0epy5rgzb`): baseline `e80b770210c54e423d28ecf48e00f1dda9506cec`
| Evidence | Status |
|---|---|
| Live Handler asset key (owner CloudShell `cdk diff`, 2026-10-23): `eab95a809b3b95b7479cfe6a572e1be0ea068ef6f12751419669443397fe7eda.zip` | VERIFIED |
| Rebuilding `e80b770` (esbuild bundle, no AWS access) gives the identical full 64-hex asset key for `Handler`; `IdentityHandler` `7c5f8eb6...` | VERIFIED (reproduced here) |
| `docs/releases/2026-10-19-test-rehearsal/DEPLOYED_RECORD_e80b770_TEST.md` (commits 865d7aa, 63577b5) records code commit `e80b770`, Handler asset `eab95a809b3b...`, stack tag `approved-owner-go-test-20261019-02` | VERIFIED (record) |
| Live stack tag in the same `cdk diff`: `approved-owner-go-test-20261019-02` | VERIFIED |
| `e80b770` is on `origin/claude/ogevia-test-deploy-e80b770`, `origin/claude/ogevia-prd-readiness`, `origin/claude/determined-franklin-on6umd`; NOT on `main` | VERIFIED |
| Every route the live stack has and `main` lacks (appearance/me, authorizations missing-rate, ComplianceSweep, onboarding, hour-limits, shift-pickups, client-documents, reports, action-issues) is present at `e80b770` | VERIFIED (git grep) |

## Production API (`Ogevia-prd-ServiceVerificationApi`, API `zk527zk4ua`): baseline branch tip `4f4488c` (`origin/claude/determined-franklin-on6umd`)
| Evidence | Status |
|---|---|
| Rebuilding the tip gives Handler `debd1d4305fc1e23...`; fixtures `infra/aws/test/fixtures/auth-separation/deployed` (state after the authentication release) carry the same hash; fixtures `before` carry `eab95a80...` | VERIFIED (reproduced here; fixtures are repository records) |
| Synthesized tip templates equal the `deployed` fixtures except the callback/logout lists, API CORS and the web headers policy (the later web-headers release) | VERIFIED |
| Live production sign-in uses pool `us-west-2_FHJoX71ca`, domain `ogevia-prd-300094796789`, client `4rnh9e5d02pkupirvfqdbngmv5` (CloudShell output); the tip's `Ogevia-prd-Auth` stack (`lib/auth-stack.ts`) defines exactly that dedicated pool/client | VERIFIED (live) + VERIFIED (code) |
| Live production web headers policy before 2026-10-23 allowed `ogevia-prd-300094796789` (CloudShell diff), which the tip's `webAuthDomain()` produces | VERIFIED |
| Live production Handler asset key (owner CloudShell `get-template`, 2026-10-23): `debd1d4305fc1e230fbc7c7a67ffded67d059f8b61cc3ccc3e238d64e74a3235.zip`, identical to the tip rebuild; live IdentityHandler `7c5f8eb6...` also identical | VERIFIED |
| Live `Ogevia-prd-Auth` Cognito client physical id: `4rnh9e5d02pkupirvfqdbngmv5` (the client the website uses) | VERIFIED |
| Which commit in `a03f43e..4f4488c` was deployed: the Lambda hash is identical across that range, but the tip is the only one consistent with the live web headers policy (efcacd0, inside the range) and its synthesized templates match the deployed fixtures | VERIFIED for the Lambda, INFERRED for the exact commit (tip) |
| Deployment-reference tags: web `approved-CR-2026-10-21-WEB-HEADERS` (live); not found in any commit | UNKNOWN (reference is supplied at deploy time) |

Conclusion: production is the tip `4f4488c` (Lambda hash VERIFIED against live; the exact commit within `a03f43e..4f4488c` is INFERRED from the live web headers policy). The pilot is `e80b770` (VERIFIED). No unresolved gap remains for the Lambda code.

## Live settings preserved in infrastructure code (not deployed; nothing live was changed)
Patches (code and tests only; the stale deployed-state fixtures also need the same three properties, regenerated from synth):
- `docs/aws/patches/custom-domains-on-production-baseline-4f4488c.patch` (552 infra tests pass on the patched tip; 544 before)
- `docs/aws/patches/custom-domains-on-pilot-baseline-e80b770.patch` (464 infra tests pass)

They add `customDomains` (hostnames + the us-east-1 certificate ARN) to `config.ts`, and make the hostnames CloudFront aliases, Cognito callback/logout URLs
(web client; production Auth client) and API CORS origins. Synthesized templates differ from each untouched baseline ONLY in those properties; Lambda assets,
routes, permissions and alarms are unchanged. Branches pushed to origin on 2026-10-23 (owner approved): `claude/custom-domains-prd-4f4488c` (db67c95) and `claude/custom-domains-pilot-e80b770` (8e139f4).

Correction to earlier notes: the production Cognito pool and client ARE managed by CDK (`Ogevia-prd-Auth`), and the live callback edit made by CLI on 2026-10-23 would be
reverted by the next deploy of that stack unless the patch above is carried. The earlier statement that the API source was outside this repository was wrong.
