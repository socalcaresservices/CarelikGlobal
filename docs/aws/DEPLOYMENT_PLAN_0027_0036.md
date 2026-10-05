# AWS TEST deployment plan: release 0027–0036

This release adds:
- visit review, and missing-signature recovery (0036);
- daylight-saving refusals (0035), and the shift-card fix;
- document reminders and a single Needs attention count;
- recurring shifts and billing rounding;
- the continuity pack, outage records, hire type and family relationship.

It replaces the unreleased 0027–0034 package (`859728f`). That package was
never deployed; all of its content is included here unchanged.

- **Status:** PREPARED and REHEARSED against stubbed AWS (section 6). **Not
  deployed.** Deploying needs the owner to type DEPLOY in CloudShell.
- **Pinned code:** `7b1236d86294c4dacee155d7d3fa06c0af55d9c1` on
  `claude/ogevia-socal-pilot-prep-vfu5tf`.
- **Base:** release 0022–0026 (`0ca5616`), owner-reported live. The script
  checks this itself.
- **Environment:** TEST only, synthetic data only. Production, Netlify,
  Supabase, Cognito, DNS and config.json are not touched.

## 0. Preconditions (checked by the script before anything changes)

- The account and region are correct, and the checkout is exactly the pin.
- `GET /v1/shifts` and the identity function exist. `GET /v1/shift-series`
  is not live yet; if it is, the run is a resume.
- The API Lambda has exactly one invoke permission, scoped to the API.
- The DB ledger is exactly 0001–0026, and every checksum matches. An applied
  migration that was modified stops the run.
- The quality gate passes: lint, typecheck, unit tests, build, synth and the
  web build.
- The strict scope gate (`release_0036_gate.py`) passes, and its self-test
  refuses all 25 tampered variants.

## 1. Exact change set (the approval scope)

| Layer | Change | New fixed cost |
|---|---|---|
| RDS | Snapshot `ogevia-prod-postgres-pre-0036-<date>` (kept until you delete it) | Snapshot storage only, cents |
| DB `ogevia_sv_test` | Migrations 0027–0036, one transaction each | none |
| API stack | 30 new JWT routes, plus 2 owner-approved public routes (details below). All are on the existing integration and covered by the existing API-scoped invoke permission (none added). New Handler code package. No IAM, environment, memory, timeout or VPC change; the identity function is unchanged | none |
| Web | New files to the existing site bucket; CloudFront invalidated; `config.json` unchanged | none |
| Not changed | NetworkEgress, EvidenceStorage, Observability and WebHosting stacks; Cognito; RDS security groups; IAM policies | — |

**The 2 public routes:**
- `POST /v1/public/visit-confirmations/{token}/open`
- `POST /v1/public/visit-confirmations/{token}/respond`

They are the visit-confirmation link, which needs both a 256-bit token and a
6-digit phone code.

**The gate's public-route check:** each public route is compared with the
live public route `POST /v1/public/care-offers/{token}/respond` and must match
it except for its RouteKey. With these 2 added, the approved public list is 10
routes.

**No IAM change:** late-confirmation evidence uses the existing private
evidence-bucket key patterns:
- `{org}/{id}/client-signature.png`
- `{org}/documents/{id}/paper-form`

The full route list is `NEW_ROUTES` and `NEW_PUBLIC_ROUTES` in
`infra/aws/slice/release_0036_gate.py`.

## 2. Database (what each migration adds)

| Migration | Adds | Down script refuses while |
|---|---|---|
| 0027 continuity pack | Offline agency export, `continuity.export` | continuity exports exist |
| 0028 outage visit records | Outage visit records and reconciliation | outage records exist |
| 0029 billing rounding | Versioned rounding per payer and service; separately approved adjustments; `billing.rounding.manage` | policies or adjustments exist |
| 0030 hire type, scheduling, billing review | Hire type, flexible scheduling, family relationship; monthly approval summary (minutes only) | any are recorded |
| 0031 visit review decisions | Review page data; "accept capped billable" and "close not billable" (append-only, revocable until approval) | review decisions exist |
| 0032 shift card | Cancelled shift shows no reserved time; "X hr Y min available" | — |
| 0033 reminders, Needs attention | Reminder days per agency and type (90/60/30/14/7); one attention definition | custom reminder days exist |
| 0034 recurring shifts | Weekly series, monthly limits, this-occurrence and this-and-future changes | shift series exist |
| 0035 daylight saving | One-time shifts and one-date changes refuse a local time that does not exist (spring forward) or happens twice (fall back). Series flag those dates; skipping them must be an explicit choice | a skipped date records a daylight-saving reason |
| 0036 missing-signature recovery | See below | any request, response or review exists |

**0036 in detail:**
- Confirmation requests: a link with a code given by phone, or a paper form. A
  request expires, can be revoked, locks after 5 wrong codes, and becomes void
  if the visit changes.
- Responses are append-only (confirm or dispute).
- A person reviews each response.
- An acceptance computes minutes under the authorization lock. It makes the
  visit eligible for the separate human approval, and only up to those
  minutes.
- A visit waiting for a response is out of the Needs attention count; a
  response puts it back.
- Rounding covers review-accepted visits once they are approved.

**Record safety:** every row of the 31 tables that exist at 0026 is captured
by value before the migrations and must match after them. Permissions must be
the baseline plus exactly 2 permissions and 3 role grants; 0035 and 0036 add
none. Earlier audit rows must be unchanged. Any difference stops the run
before the API and web are changed.

## 3. How to run

In CloudShell (us-west-2), paste the bootstrap block, which is
`infra/aws/slice/release-0036-bootstrap.sh` on the branch. Type DEPLOY at the
single prompt. Pasting it again resumes the run. The run state is kept in
`~/ogevia-release-0036-run`.

## 4. Live checks (14, read-only, printed as PASS/FAIL)

1. The API stack is UPDATE_COMPLETE after the approval.
2. The other four stacks are unchanged.
3. 32 new routes: 30 JWT plus exactly the 2 approved public routes. Every
   earlier route is unchanged.
4. New staff routes return 401 without sign-in. The public link route returns
   400 without a code, before any database work.
5. The Lambda runs this build and still serves `ogevia_sv_test`.
6. The Lambda configuration is unchanged apart from its code.
7. The Handler IAM policy is unchanged.
8. The identity function configuration is unchanged.
9. The database is at 0036, db:verify passes, and accounts are kept.
10. (Printed as 9b.) Every existing record is unchanged by value, and the
    permission delta is exact.
11. The web URL serves this build, and config.json is unchanged.
12. The DB window is closed.
13. The snapshot is available.
14. There is still exactly one invoke statement.

## 5. Rollback (records created after the deployment are kept)

From the pinned checkout, run
`bash infra/aws/slice/release-0036-rollback.sh <layer>`, one layer at a time:

| Layer | Effect | Data |
|---|---|---|
| `status` | Read-only summary, with the restore-to-new-instance command | — |
| `export` | Read-only copy of records made since DEPLOY | — |
| `web` | Previous web files (config.json untouched) | No data change |
| `api` | Previous API template (the 32 routes removed, including both public routes) and previous Lambda code | No data change |
| `db` | Down scripts 0036 to 0027, one transaction each | Each one **refuses** while it would lose records (section 2) |

A full restore goes to a **new** instance from the snapshot, never in place.

## 6. Rehearsal evidence (stubbed AWS, local PostgreSQL 16, pin `7b1236d`)

| Run | Result |
|---|---|
| Clean | **14/14 PASS**. Quality gate, synth, scope gate PASS; self-test refused all 25 tampered variants. Mutations exactly: snapshot; security group attached and restored; `cdk deploy --exclusively ServiceVerificationApi`; web sync; invalidation. 90 → 122 routes; one invoke statement (385 bytes); db:verify 119 checks PASS; every row of 31 tables unchanged by value |
| Tampered (a side effect during 0036 changes one confirmation's signer name; counts unchanged) | **STOPPED in the DB window**: "visit_confirmations changed (rows 8 -> 8)". No `cdk deploy`, no web sync; security groups restored |
| Rollback `status`, `export`, `web`, `api` | All completed; `api` restored the captured template (the 32 routes removed) |
| Rollback `db` with a confirmation request present | **0036 REFUSED** ("missing-signature recovery records exist"); ledger stayed at 0036, nothing changed |
| Rollback `db` without such records | 0036 → 0027 rolled back; ledger 0026. Visits, confirmations, evidence, shifts, reservations, clients, authorizations, users, memberships, caregiver records, assignments, role permissions and audit rows byte-identical to the base |

**Limits:**
- The stub cannot prove AWS-side behavior: CloudFormation timing, real
  CloudFront, IAM evaluation, or real API Gateway routing of the public
  routes. Live checks 1–4 cover that after deployment.
- The base database had no staff documents or billing approvals, so those
  tables were compared while empty.

## 7. Retest batch (synthetic data only; after 14/14)

The numbered steps are in the release report and in
`PILOT_SCOPE_RECONCILIATION.md` §18. They cover:
- missing-signature recovery: link, recipient, review, approval, paper,
  dispute and lock;
- daylight saving;
- the earlier 0027–0034 items.

## 8. Cost and security

- **New fixed cost:** none. Requests and responses use the existing Lambda,
  RDS and S3. Staff send links themselves, so there is no email or SMS
  service.
- **Security changes:**
  - Two public routes are added, as the owner approved on 10/05/2026.
    - Using one needs possession of a 256-bit token, plus a 6-digit code given
      by phone.
    - The database stores only hashes: SHA-256(token), and SHA-256(token hash
      + ":" + code).
    - Five wrong codes lock the link.
    - Every invalid, expired, revoked, answered or void link gets the same
      "not valid" answer.
    - The recipient sees only the agency, service, date, times, length and the
      caregiver's first name: no client code, name, DOB or payer IDs.
    - Neither the token nor the code is logged; the API tests assert this.
  - No IAM or security-group change.
  - The manager money boundary is preserved: summaries show minutes only.
- **Not established by software:** whether any payer accepts late or
  electronic confirmations. Real-client activation stays blocked until the
  owner confirms payer acceptance and the security requirements (BAA,
  Phase 7).

## 9. Deployment record and the check-6 defect (10/05/2026)

**Deployed:** owner-run, approved commit `7b1236d`. Live verification
reported 13/14 PASS, with FAIL 6.

**Cause (verified in the code and reproduced in the rehearsal):** check 6 was
a comparison defect, not evidence of a configuration change.
- It compared the full Lambda configuration after removing only six fields.
  `CodeSize` was not removed, and it changes with every new code package.
- The rehearsal stub did not return `CodeSize`, so the rehearsal could not
  catch this.
- `REPORT.md` was a fixed template. It stated "Lambda configuration and IAM
  unchanged apart from code" whatever the checks found.

**Fix (`d690994`), with the check kept strict:**
- Every configuration field must be identical, except:
  - `CodeSha256` and `CodeSize`, which must equal the SHA-256 and size of the
    S3 package the live template deploys;
  - `RuntimeVersionConfig`, which may differ only when the function's runtime
    update mode is Auto and `Runtime` is unchanged. Under Auto, AWS Lambda
    applies the newest runtime version to a function when it is updated (the
    first phase of its two-phase rollout). The change is reported, never
    hidden.
- `State` must be Active and `LastUpdateStatus` must be Successful.
- Differences are listed with environment values hashed, never printed.
- `REPORT.md` is now written from the check results.
- `release-0036-verify.sh` reruns the 14 checks read-only on the finished
  deployment. It uses the approved build, which must reproduce the approved
  scope-gate result.

**Rehearsal of the fix (stub now returns `CodeSize`, the runtime version and
the S3 package):**
- The pinned script reproduces 13/14, FAIL 6, and the false report line.
- The verify-only rerun gives 14/14 with no AWS mutation, and keeps the
  earlier `VERIFY.txt` and `REPORT.md` as copies.
- An environment variable added, memory changed, or code that is not the
  package: each gives FAIL 6 naming the field, and the environment value never
  appears.
- A build that is not the approved commit is refused.
- A clean rebuild of `7b1236d` reproduces the identical Lambda asset keys and
  the identical scope-gate hash.
- The fixed deploy script reaches 14/14 on a fresh run.

**Owner steps:**
1. `release-0036-check6-diagnose.sh` (read-only): the field list.
2. `release-0036-verify-bootstrap.sh`: the read-only rerun.

**Owner-run diagnosis (read-only), 10/05/2026 10:10 UTC** (saved in
`~/ogevia-release-0036-run/check6-diagnosis-20261005T101055Z.txt`):
- Exactly one field differs: `CodeSize`, 244,853 → 248,020 bytes.
- `RuntimeVersionConfig` is unchanged (update mode Auto).
- State is Active; LastUpdateStatus is Successful.
- The live code is exactly the deployed package (size 248,020, SHA-256
  `p1YuHmva…U7s=`). The live template references
  `b410e5994d8e…376a.zip`, the same key the clean rebuild of `7b1236d`
  produces.

**Conclusion:** VERIFIED comparison defect. There was no unapproved change.
Next: the read-only rerun (`release-0036-verify-bootstrap.sh`).

**Verify-only rerun, attempt 1 (owner, 10:16 UTC):**
- It stopped at "3/4 Read-only inventory: missing FN". Nothing was checked
  and nothing was changed.
- **Cause (verified):** the API stack grew from 104 to 136 resources with this
  release. `DescribeStackResources` returns only the first 100 resources, and
  the API Lambda was no longer among them.
- **Fix (`efcdba1`):** use `ListStackResources`, which returns every resource,
  in the current scripts. The superseded historical scripts were left
  unchanged.
- **Rehearsal:** the stub now models the 100-resource limit. The previous
  verify script reproduces "missing FN"; the fixed one gives 14/14.

**Verify-only rerun, attempt 2 (owner, 10:34 UTC):**
- It stopped at "3/4: the API Lambda is not the one captured before the
  deployment". Nothing was checked and nothing was changed; the identity
  guard worked as intended.
- **Cause (verified, reproduced):** with `--output text`, the AWS CLI applies
  `--query` to each page of results. The 136 resources span two pages, so
  `... | [0]` returned the function name plus "None".
- **Fix (`95087eb`):** lookups read the whole result as JSON and require
  exactly one match. Status scripts that took "the first Lambda" now select
  the Handler, not the identity function.
- **Rehearsal:** the stub now models per-page text output. `efcdba1`
  reproduces the stop; `95087eb` gives 14/14.

**Verify-only rerun, attempt 3 (owner, 10:37 UTC): 14/14 PASS. Release
0027–0036 is DEPLOYED AND VERIFIED on AWS TEST** (owner-run; output pasted in
the session).
- Check 6: the code is the approved package (248,020 bytes, was 244,853).
  The runtime version is unchanged. No other configuration field differs.
- Data:
  - ledger 0001–0036; db:verify 119 checks PASS;
  - every row of 31 tables unchanged by value;
  - permissions = baseline + 2 permissions + 3 role grants;
  - the 140 earlier audit rows unchanged;
  - kept: 6 users, 6 memberships, 4 caregiver records, 6 clients,
    7 authorizations, 6 assignments, 1 billing approval, 12 shifts,
    3 held reservations, 1 staff document.
- API: 90 → 122 routes; Handler IAM policy unchanged; one invoke
  statement.
- Web: serves this build; config.json unchanged.
- Snapshot `ogevia-prod-postgres-pre-0036-20261005` is available.
- The earlier 13/14 result is kept as
  `VERIFY-20261005T103755Z-before-rerun.txt`.

**Next:** the retest batch in `PILOT_SCOPE_RECONCILIATION.md` §19, on
synthetic data only.
