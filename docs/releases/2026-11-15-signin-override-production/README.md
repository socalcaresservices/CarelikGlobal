# Release 2026-11-15: enable the administrator sign-in override in production

**Status: PROPOSED and IMPLEMENTED in code, TESTED locally. Not deployed. Nothing in AWS was changed by this preparation.**
Owner request, 2026-11-15: let authorized administrators approve caregivers who have not signed in, with a required reason. Hiding the action does not meet that goal.

## 1. What this release changes (and what it does not)
| | |
|---|---|
| **Changes** | Two API Gateway routes are added to the production API `Ogevia-prd-ServiceVerificationApi`: `GET /v1/signin-overrides` and `POST /v1/caregivers/{caregiverRecordId}/signin-override`. Both require the Cognito JWT. Code: `ENVIRONMENTS.prd.features.signInOverride` is now `true` (`infra/aws/lib/config.ts`). |
| **Does NOT change** | Lambda code or configuration (production already runs the accepted Handler, SHA-256 `98e84618…`, which contains the override handlers), IAM, the Lambda invoke permission (it already covers every route, `…/*/*/*`), parameters, the database, the website. Bulk import and duplicate-staff review stay off. |
| **Web** | No web change and no web deploy. The production bundle `index-BwZUq_5c.js` already contains the action and already calls both routes (visible in the owner's browser console on 2026-11-15, where each call returns 404 today). The earlier web "hide" change in this PR was reverted: the action stays visible. |
| **Database** | No migration in this release. Migration `0103_caregiver_signin_override.sql` (called "0090" in some comments and test names: that was its draft number) is recorded in the production ledger since 2026-11-11 (owner-reported). Verify it, do not re-apply it: see section 3. |

The change set is exactly two `AWS::ApiGatewayV2::Route` resources. `infra/aws/scripts/production-signin-override-release.py` refuses anything else.

## 2. How the approval works (server rules, all tested)
- Who: `organization_owner` and `organization_admin` (permission `caregivers.signin_override`). Never a manager, scheduler or caregiver. Another agency's administrator gets 404.
- Reason required: at least 5 characters after trimming, at most 500. The server refuses empty, blank or short reasons and the browser refuses them before sending.
- Background check stays a hard block: no override is recorded unless the check is verified clear (409 `OGC09`, nothing recorded). Required training and every other hard requirement are unchanged. CPR/TB keep their own grace rules.
- One record per caregiver, append-only (update and delete refused). Approver, time and an audit event are written in the same transaction. A second call or two simultaneous calls leave one record and one audit event.
- A caregiver who has already signed in needs no override. The badge "Approved by override — not signed in" stays until the first real sign-in.
- **No visit verification before sign-in.** Starting a visit takes no caregiver parameter: the server uses the caller's own Care Team profile. An overridden caregiver has no sign-in identity, and an administrator or manager has no caregiver profile, so `POST /v1/visits` returns 422 `not_ready` and no visit is created (tested at database and HTTP level, added in this PR).

## 3. What was verified, and what is still missing
| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Production ledger includes 0103 with checksum `963d8cf4…dfe54` | **OWNER-REPORTED** (107 rows, 2026-11-11). **NOT verified live** | `docs/releases/2026-11-10-ux-redesign-test/RELEASE_READINESS.md`; this session has no AWS access. **Run `VERIFY_PRODUCTION_DB.sql` before the change.** |
| 2 | The override objects, owners and grants are right | **TESTED on a production-shaped database** (0001–0102, then the real production upgrade SQL = 107 ledger rows). All checks passed: table and functions owned by `ogevia_owner`, RLS on, `ogevia_app` can execute, PUBLIC cannot, `ogevia_owner` can execute and read everything the path touches. **NOT verified on production** | `VERIFY_PRODUCTION_DB.sql` (sections 1–9) |
| 3 | Permission rows | Tested locally (owner and admin only). **Which production members hold it is UNKNOWN** until section 7 of the SQL is run | |
| 4 | Production Handler already has the override code | OWNER-REPORTED hash match (2026-11-11) | `RELEASE_READINESS.md` |
| 5 | The CDK code does not describe production | **VERIFIED in code**: the synthesized `prd` template lacks six accepted production routes (`liveTestRepairs`: business documents, missing visits, QR check-in…). A `cdk deploy` of this stack would **remove them**. | `production-signin-override-release.test.ts` (last test) |
| 6 | The two 2026-11-14 manual database changes are not in any migration | VERIFIED: see `PRODUCTION_DB_CHANGES_2026-11-14.md`. A database rebuilt from the repository would not have them. | |

**Missing or open before a GO:**
1. Live verification of items 1–3 (read-only SQL, needs the temporary database window).
2. The security-group window opened on 2026-11-14 for the `action_issue_rows` grant (`TEMP-prd-grant-fix2`) has **no recorded closing**. Confirm the RDS group `sg-00530a1f4f7648e65` shows only the rule from `sg-064ffce3bcbe8eb3b`:
   `aws ec2 describe-security-group-rules --region us-west-2 --filters Name=group-id,Values=sg-00530a1f4f7648e65 --query "SecurityGroupRules[?IsEgress==\`false\`].[SecurityGroupRuleId,ReferencedGroupInfo.GroupId,CidrIpv4]" --output text`
3. Confirmation that `notifications` and `attention` now return 200 in production (not yet seen).
4. Phases B to E of `docs/TESTING_AND_RELEASE_PROCESS.md` are not done. The harness and TEST were not run for this change (no AWS and no harness browser here). Section 6 lists what I recommend as the minimum.

## 4. Tests run (this checkout, local PostgreSQL 16)
See `CHECKLIST.md` for counts. New or changed: `signin-override-switch.test.ts` (production on, two JWT routes only), `staff-routes-switch.test.ts`, `production-ux-release.test.ts` (override routes accepted, import and duplicates still refused), `production-signin-override-release.test.ts` (26 tests, including real synthesized templates), `signin-override-0090.db.test.ts` (+1: no verification before sign-in), `signin-override.db.test.ts` (+1: HTTP 422). Existing override tests unchanged: reason, background hard block, other hard requirements, permissions, cross-tenant, idempotency and concurrency, append-only, badge list, rollback, web screens.

## 5. Deployment plan (not executed; needs the owner's explicit GO on one commit SHA)
Full commands: `RUNBOOK.md`. Summary, about 30 minutes, one operator:
1. **Preconditions:** GO recorded; CI green on the SHA; clean checkout at the SHA; account `300094796789`, region `us-west-2`; no other production release running; window agreed.
2. **Open the temporary read window** (same `/32` procedure as 2026-11-14, with a second CloudShell open for recovery) and run `VERIFY_PRODUCTION_DB.sql`. Every PASS line must pass. Close the window and confirm the RDS group is back to one rule. **Any failure: STOP.**
3. **Capture rollback inputs** (read-only): the live template, stack parameters, route list, Handler `CodeSha256`.
4. **Build the change:** synthesize the candidate to a scratch folder, run `production-signin-override-release.py patch` (live template + exactly the two routes), upload to the private assets bucket, create a change set.
5. **Guard:** `production-signin-override-release.py changes` must pass (exactly two route additions, nothing else). Anything else: delete the change set, STOP.
6. **Execute** the change set; wait for `UPDATE_COMPLETE`.
7. **Verify:** routes present; unauthenticated call now 401 (was 404); forged token 401; owner opens a caregiver profile; log search for new 5xx; web console shows no CORS errors for these two routes.
8. **Acceptance:** the owner approves one real caregiver (background check clear, not signed in) with a real reason, confirms the badge, the audit line and the Care Team and Schedule views. Do not create a throw-away record in production for testing.

## 6. Rollback plan
| Trigger | Action |
|---|---|
| Step 5 guard fails, or the change set errors | Delete the change set. Nothing was changed. |
| After execute: smoke fails, a new 5xx appears on any route, or the owner calls it | Create a change set from the captured live template, guard it with `rollback-changes` (exactly two route removals), execute, verify routes absent and `equal` to the captured template. About 3 minutes. |
| Something wrong in the data written by an approval | Do not drop the table. Approvals are append-only history. Contact the owner; fix forward. |

What rollback does **not** undo: override records already written (append-only, kept) and caregivers already approved for work. Their sign-in row still reads "Approved by override" because that comes from the database. After rollback the web action returns 404 (no worse than today). The database `down` script (`pending/rollback/0103…down.sql`) is **BACKUP REQUIRED**, drops the table with its rows and would send approved caregivers back to "not ready". It is not part of this release and is not recommended after real use.

## 7. Risks
| Risk | Likelihood | Effect | Control |
|---|---|---|---|
| A definer function cannot read an object owned by another role (the class of defect behind the 2026-11-14 500s) | Low: tested on a production-shaped DB, but production ownership is partly drifted (`ogevia_admin` owns 4 tables and 17 functions) | The two routes return 500 | `VERIFY_PRODUCTION_DB.sql` sections 3 and 5 before the change; rollback in 3 minutes |
| `cdk deploy` run by habit | Medium | Removes six live routes | The runbook forbids it; the gate only patches the captured live template |
| Migration 0103 not actually in production | Low (owner-reported) | The routes would 500 | Section 1 of the SQL; do not execute otherwise |
| An administrator approves the wrong caregiver | Low | Caregiver becomes schedulable without signing in | Reason and approver recorded; append-only; badge visible on Care Team and Schedule; they still cannot verify a visit |
| API route throttling or stage changes | Very low | None expected | Stage and Handler are untouched; the change set is two Route resources |

## 8. Decision needed
Approve **GO for this SHA** (to be recorded in `CHECKLIST.md` section E) or name what to change. Recommended: GO, after steps 2 and 3 of section 3 are answered and the owner accepts that Phase B to D were reduced to the checks listed here, because the change is two JWT routes in front of code and a database that production already runs.
