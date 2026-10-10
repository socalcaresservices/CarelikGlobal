# Ogevia URL registry and launch checklist

Last updated: 2026-10-10. Repository checked at `main` = `24eabe2` (fetched 2026-10-10).
Evidence classes used below. Nothing here is a deployment instruction.

- **OWNER-AWS**: output the owner pasted from AWS CloudShell or the AWS console (us-west-2). Claude did not run it and cannot re-run it (no AWS CLI or credentials in the Claude session).
- **CLAUDE-CHECK**: Claude ran it from the Claude session (repository reads, public unauthenticated HTTP GET).
- **OWNER-STATED**: the owner said so; no output or document reached the repository.
- **UNVERIFIED**: no evidence either way. This means "not yet confirmed", not "not done".

## 1. URL registry

| Name | App (CloudFront) | API (API Gateway) | Database | Use for |
|---|---|---|---|---|
| Pilot / test (`env=prod`, stacks `Ogevia-prod-*`) | `https://d2xumch5w0izfg.cloudfront.net` | `https://s0epy5rgzb.execute-api.us-west-2.amazonaws.com` | `ogevia_sv_test` (repository records; live not re-checked) | **Synthetic data only.** `docs/aws/PRODUCTION_DEPLOYMENT.md` says not to use it as production. |
| Production candidate (`env=prd`, stacks `Ogevia-prd-*`) | `https://d3l4psdkokkvnb.cloudfront.net` | `https://zk527zk4ua.execute-api.us-west-2.amazonaws.com` | `ogevia_prd` (Lambda configured for it; connectivity unverified) | Intended for real client use, **after the open items in section 3 are closed.** Not yet cleared for real client data. |

`app.ogevia.com` DNS is not repointed to either link. That is a separate owner decision.

## 2. Evidence recorded (2026-10-10)

| # | Fact | Class | Source |
|---|---|---|---|
| 1 | `Ogevia-prd-ServiceVerificationApi-Handler886CB40B-KQ2l1HsdGkhR` exists in us-west-2, `State=Active`, `LastUpdateStatus=Successful`, `LastModified=2026-10-10T06:11:29.031+0000` | OWNER-AWS | `lambda get-function-configuration`, CloudShell |
| 2 | That Lambda has `DB_NAME=ogevia_prd` and `OGEVIA_ENV=prd` | OWNER-AWS | same output |
| 3 | CloudFormation: `Ogevia-prd-WebHosting` = `UPDATE_COMPLETE`; `Ogevia-prd-ServiceVerificationApi` = `UPDATE_COMPLETE` | OWNER-AWS | CloudFormation |
| 4 | CloudFormation identifies `https://d3l4psdkokkvnb.cloudfront.net` as the production candidate app and `https://zk527zk4ua.execute-api.us-west-2.amazonaws.com` as the prd API | OWNER-AWS | CloudFormation |
| 5 | AWS BAA confirmed. The agreement itself is not in the repository. | OWNER-STATED | owner statement (previously confirmed) |
| 6 | Both API addresses answer an unauthenticated `GET /v1/me` with HTTP 401 and `www-authenticate: Bearer` (at 2026-10-10 about 15:03 UTC). The API is up and requires a login. This does not show what either API is connected to. | CLAUDE-CHECK | public GET |
| 7 | The prd address is a configured stack in the repository: `Ogevia-prd-*` stacks, `ogevia_prd` database and `OGEVIA_ENV=prd` fail-closed check (`apps/sv-api/src/config.ts`, `infra/aws/lib/config.ts`). A mismatch makes the Lambda refuse to start, which supports (but does not prove) a working configuration. | CLAUDE-CHECK (repository read) | code |
| 8 | Claude could not open either CloudFront address (sandbox proxy blocks them), so it has not seen what the frontend calls. | CLAUDE-CHECK (limit) | curl |

Corrections to earlier records:
- `docs/aws/PRODUCTION_DEPLOYMENT.md` section 7 (written before this deployment) lists items 6–17 as NOT RUN and states "deployment not yet executed". Items 13 (stack deployed, Lambda `DB_NAME=ogevia_prd`) and part of 17 (frontend published) now have owner-provided evidence. The other rows stay as written until evidence arrives. Rows marked NOT RUN mean "not recorded", not "not performed".
- The production database is **not** claimed absent. The Lambda being configured for `ogevia_prd` does not by itself prove the database exists, is migrated, or is reachable.
- The BAA gate in `docs/aws/SECURITY_DECISIONS.md` was written as "not yet satisfied". It is now **owner-confirmed** (item 5 above). The agreement itself has not been reviewed by Claude.

## 3. Launch checklist (production candidate)

| # | Check | Status | Evidence / what is needed |
|---|---|---|---|
| 1 | Production Lambda deployed, `DB_NAME=ogevia_prd`, `OGEVIA_ENV=prd` | **PASS (owner-provided)** | OWNER-AWS items 1–2 |
| 2 | prd stacks deployed (`WebHosting`, `ServiceVerificationApi`) | **PASS (owner-provided)** | OWNER-AWS item 3 |
| 3 | AWS BAA | **Owner-confirmed** | Keep a copy of the executed agreement with business records |
| 4 | Production frontend actually calls the prd API | OPEN | Check that the deployed bundle contains `zk527zk4ua` and not `s0epy5rgzb` |
| 5 | Database connectivity from the Lambda to `ogevia_prd` | OPEN | Run `deploy-production.sh smoke` (read-only), or check `pg_stat_activity` for `application_name=ogevia-sv-api` on `ogevia_prd` as `ogevia_prd_app` |
| 6 | Applied migrations in `ogevia_prd` | OPEN | `select count(*), max(version) from ogevia_meta.schema_migrations` — expected 38 / 0038 if the 38-migration release is what was deployed; 46 / 0046 only if the caregiver-readiness release (merged to `main`, documented as not deployed) was applied |
| 7 | Deployed commit / version | OPEN | Record the commit SHA of the build used for `Ogevia-prd-*` (the CloudShell / deploy log, or Lambda code hash compared against a local `cdk synth` of the SHA) |
| 8 | Test credential refused on `ogevia_prd` | OPEN | `deploy-production.sh database` access checks or equivalent |
| 9 | Administrator sign-in with MFA on the prd app | OPEN | Browser test on `d3l4psdkokkvnb`, owner account |
| 10 | Synthetic visit and signature workflow on the prd app: start, end, client confirmation, Signed status, manager view | OPEN | Browser/phone test; delete or void the synthetic record afterward |
| 11 | Signature object lands in the `ogevia-prd-signature-evidence-…` bucket | OPEN | S3 listing (metadata only) after item 10 |
| 12 | Caregiver-role user cannot see agency data | OPEN | Browser test |
| 13 | Cross-tenant and unauthorized-access negative checks on prd | OPEN | Existing automated tests ran locally; not run against prd |
| 14 | Backups, snapshot and restore procedure on RDS | UNVERIFIED | `deploy-production.sh check` output |
| 15 | `app.ogevia.com` DNS decision | OPEN (owner decision) | Not part of this work |

No item above moves to PASS on the strength of this document alone.

## 4. Next verification step

See the chat reply for the single next step. In short: confirm which API the production frontend calls (item 4), then run the read-only `smoke` step (items 5–6).
