# Deployed record: sign-in override routes in production

**Status: DEPLOYED and ACCEPTED by the owner (owner-reported, 2026-11-15): the admin approval for a caregiver with incomplete sign-in was tested in production and is a GO.** The record is built from the operator's pasted CloudShell output; the owner's acceptance statement was given in chat and no screenshots or caregiver details were supplied (none are required in the repository: no names or identifiers).
Release `2026-11-15-signin-override-production`, commit `19605dbf1f391762f52d86d9fdd2c7de45f4bebe` (pull request socalcaresservices/CarelikGlobal#109, CI green on that commit: `harness`, `validate`, `postgres`, run 43679688930). Account `300094796789`, region `us-west-2`, stack `Ogevia-prd-ServiceVerificationApi`, API `zk527zk4ua`. Operator: the owner, in AWS CloudShell. Approval: the owner's typed `OGEVIA_DEPLOY_APPROVAL=owner-signin-override-go` for `plan` and `apply`, following the owner's instruction of 2026-11-15 to do what is needed to go live.

## What changed in AWS
Exactly two `AWS::ApiGatewayV2::Route` resources were added by a CloudFormation change set: `GET /v1/signin-overrides` and `POST /v1/caregivers/{caregiverRecordId}/signin-override` (JWT). Nothing else: no Lambda code or configuration, IAM, permission, parameter, database or website change.

## Evidence (pasted by the operator)
| Step | Result |
|---|---|
| Leftover RDS rule | Found `sgr-07f9fac9399dcdeb8` (`10.20.132.179/32`, from the 2026-11-14 window) and revoked it. The group then listed only `sgr-088d9ee71c4b0244d` (source `sg-064ffce3bcbe8eb3b`) |
| Production database verification (`VERIFY_PRODUCTION_DB.sql`, temporary window, closed afterwards; the group again listed one rule) | `VERDICT: PASS` (section 9 skipped by design) |
| Plan, workspace `/tmp/ogevia-signin-override.kcHHFG`, change set `ogevia-signin-override-20261115T051545Z` | Handler `ogevia_prd`/`prd`; both routes absent before; "the live production template plus exactly two JWT routes"; stack unchanged meanwhile; "the change set adds exactly the two sign-in override routes" |
| Apply, re-check | stack identical to the plan; change set still exactly the two routes |
| Apply, after execute | live template identical to the planned template; "both override routes are present" |
| Smoke (no valid token) | `GET` no token 401; `GET` forged token 401; `POST` no token 401; route authorization types (information): 2 JWT |
| New 5xx in the last 10 minutes | none printed |

The first plan (workspace `ndzDBw`, change set `ogevia-signin-override-20261115T050833Z`) was never executed. It is obsolete and may be deleted.

## Owner acceptance
**Accepted (owner-reported, 2026-11-15):** "tested and the admin approval for incomplete sign-in is a GO." The individual checks of `RUNBOOK.md` step 5 (action visible to owner/administrator and hidden from manager/scheduler; blank reason refused; badge after a real approval; hard block when the background check is not clear) were not itemised in the report and are not separately evidenced here.

## Monitoring
**Owner-reported, 2026-11-15: "no server failures".** The length of the observation period was not stated, and the CloudWatch check at apply time (last 10 minutes) printed no 5xx. This is taken to cover the earlier `notifications` and `attention` 500s, but they were not individually confirmed as 200.

## Not separately confirmed
1. `notifications` and `attention` returning 200 in the browser (covered only by the owner's "no server failures").
2. The web console showing no CORS or 404 errors for the two routes.
3. A defined monitoring period (suggested: review the production Handler log group for `internal_error` after the next working day of use).

## Rollback (not invoked)
`OGEVIA_DEPLOY_APPROVAL=owner-signin-override-go bash /tmp/CarelikGlobal/infra/aws/scripts/production-signin-override-deploy.sh rollback /tmp/ogevia-signin-override.kcHHFG` (a change set that removes exactly the two routes; override records already written are kept). The workspace holds the captured live template; a copy is in the private assets bucket under `ogevia-production-release/signin-override-…/`.

## Baseline for the next release
Production API now has the two routes on top of the template captured at plan time. The CDK code still does not synthesize six production routes (`liveTestRepairs`) and production runs a branch that is not merged to `main`; neither changed.
