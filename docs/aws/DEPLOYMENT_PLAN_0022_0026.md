# AWS TEST deployment plan: release 0022–0026 (office administration, invitations, planned assignments, schedule and call-outs)

**Status:** prepared 2026-10-04 and re-pinned at `a3b1681` after the 0019–0021 policy-size fix. Rehearsed end to end at that commit against stubbed AWS that enforces the 20,480-byte Lambda policy limit, on the revised increment's state (ledger 0021, 60 routes, one invoke statement): scope gate PASS; self-test 27/27, including per-route and widened permissions; 13/13 live checks PASS. At 90 routes the policy is still one statement (384 bytes; peak 384). The API rollback keeps one statement. The earlier rehearsal at `0c739c9` covered every rollback layer and a resume; those scripts are unchanged except for the policy check. **Not executed in AWS. Run only after the 0019–0021 increment is verified live** (paste block `infra/aws/slice/increment-resume-block.sh`, revision 69e8799). Paste block for this release: `infra/aws/slice/release-0026-bootstrap.sh`.

**Environment:** account 300094796789, us-west-2, database `ogevia_sv_test`, synthetic data only.

**Base (required):** the revised 0019–0021 increment (migrations 0019–0021, `GET /v1/attention` live, the API Lambda's resource policy is ONE invoke statement for this API). The script refuses to run on any other base. Its own state and rollback folder is `~/ogevia-release-0026-run`; earlier run folders are never written.

## 0. Preconditions (checked by the script before anything changes)

| Check | Expected | If not |
| --- | --- | --- |
| Migration ledger | exactly 0001–0021, contiguous, every checksum equal to the repository file | Stop. No applied migration is ever modified. |
| Live API | `GET /v1/attention` present and exactly one Lambda invoke statement (revised increment); `GET /v1/clients` absent | Stop; finish the 0019–0021 increment first |
| Stacks | all five `*_COMPLETE` | Stop |
| RDS | available, private, encrypted | Stop |
| Scope gate | `release_0026_gate.py` PASS against the live templates; its self-test refuses 25 tampered variants | Stop; nothing changed |

## 1. Exact change set

| Stack / target | Change |
| --- | --- |
| Ogevia-prod-ServiceVerificationApi | **+30** JWT routes on the existing integration, covered by the existing single API-scoped invoke permission (no permission added; the gate refuses any): `GET/POST /v1/assignments`, `POST /v1/assignments/{assignmentId}/end`, `POST /v1/authorizations/{authorizationId}/amend`, `GET/POST /v1/caregivers`, `POST /v1/caregivers/{id}/details`, `…/status`, `…/invitation`, `…/invitation/resend`, `GET/POST /v1/client-types`, `GET/POST /v1/clients`, `GET/POST /v1/clients/{clientId}/authorizations`, `POST /v1/clients/{clientId}/details`, `…/status`, `GET/POST /v1/services`, `POST /v1/services/{serviceId}/name`, `…/status`, `GET/POST /v1/shifts`, `POST /v1/shifts/{shiftId}/callout`, `…/caregiver`, `…/cancel`, `GET /v1/shifts/{shiftId}/coverage`, `GET /v1/my-shifts`, `POST /v1/my-shifts/{shiftId}/callout` |
| Same | **~** Handler: code package + one environment variable `IDENTITY_FUNCTION_NAME=Ogevia-prod-IdentityAdmin`. Runtime, memory, timeout, VPC, role and every other variable unchanged. |
| Same | **~** HandlerPolicy: one statement added, `InvokeIdentityAdmin` = `lambda:InvokeFunction` on the identity function only. |
| Same | **+** `Ogevia-prod-IdentityAdmin` Lambda (outside the VPC, 256 MB, 8 s, pool id its only setting), its role (trust: Lambda only), its managed policy (`cognito-idp:AdminCreateUser`, `cognito-idp:AdminGetUser` on pool `us-west-2_849AYz5J7` only; logs to its own group), its log group (365 days, retained). |
| Ogevia-prod-NetworkEgress | **+** Lambda interface endpoint: 1 AZ, private DNS, the existing endpoint security group (443 from the API Lambda only), endpoint policy = invoke `Ogevia-prod-IdentityAdmin` only. |
| Same | **~** S3 gateway endpoint policy `Resource`: the signature key shape **plus** `*/documents/*/*` and `*/branding/logo/*` (the shapes the API role already has since 0020/0021). |
| EvidenceStorage, WebHosting, Observability | No change |
| Database | Migrations 0022, 0023, 0024, 0025, 0026 (one transaction each) |
| Web | New build; `config.json` unchanged |

### Why a separate identity function and an endpoint (decision record)

- The API Lambda runs in private subnets without NAT. It cannot reach Cognito.
- Cognito PrivateLink cannot be used: the pool has a managed-login domain (VERIFIED in `infra/aws/lib/config.ts`), and AWS documents that a user pool with a domain cannot be used through the Cognito interface endpoint.
- Options: NAT gateway (≈ 32 USD/month + data; directive requires approval and broad egress) vs. a Lambda interface endpoint (≈ 7.30 USD/month, 1 AZ) to a function that only holds two Cognito permissions. Chosen: the endpoint. **This is a new fixed cost of about 7.30 USD/month and needs your approval; typing DEPLOY approves it.**

### Defect corrected by this release (found during this work)

The S3 gateway endpoint policy deployed with the egress stack allows only the signature key shape. Staff-document uploads (0021) and the agency logo (0020) store objects under other keys, so those requests from the private API Lambda are expected to be refused by the endpoint (INFERRED from the template; not yet observed live, because the 1a39dd5 live checks verify policies and routes, not an upload). This release adds the two key shapes. Acceptance check 6.4 below proves it.

## 2. Database

| Migration | What it adds | Existing data |
| --- | --- | --- |
| 0022 | client types, client city/type, client and authorization administration functions | unchanged |
| 0023 | caregiver and service administration functions; unique service code per agency (refuses to apply if two services share a code) | unchanged |
| 0024 | assignment administration functions | unchanged |
| 0025 | assignments keyed by Care Team record (backfilled), planned assignments, invitation table and functions | every existing assignment keeps its sign-in and access |
| 0026 | staff-scheduled shifts (reserved against the authorization), call-outs, replacements, coverage history; caregivers' own shifts and call-out | existing shifts, Care Requests and reservations unchanged |

The script records, before and after, the counts of users, memberships (and active ones), caregiver records, clients, authorizations, assignments (and those with access) and billing approvals, plus the visit fingerprint. Any difference stops the run.

## 3. How to run

Paste `infra/aws/slice/release-0026-bootstrap.sh` (the block printed in the reply) into AWS CloudShell, us-west-2, AdministratorAccess. Everything before the `DEPLOY` prompt is read-only. Pasting again resumes.

## 4. Live checks (12, read-only, printed as PASS/FAIL)

1 stacks updated after approval · 2 exactly 30 new JWT routes, earlier ones unchanged · 3 new routes return 401 without sign-in · 4 API Lambda runs this build, identity name set, still on `ogevia_sv_test` · 5 Handler policy = previous + the invoke statement · 6 identity function outside the VPC with only the two Cognito actions on the one pool · 7 Lambda endpoint available with the one-function policy; S3 endpoint allows three key shapes · 8 identity function answers and refuses bad input without calling Cognito · 9 database at 0026, verification all PASS, accounts and records kept · 10 web serves the build, config.json unchanged · 11 DB window closed · 12 snapshot available.

## 5. Rollback (records and files created after the deployment are kept)

`bash infra/aws/slice/release-0026-rollback.sh <layer>`, in this order, only as far as needed:

1. `status` (read-only), `export` (read-only CSV of the new records).
2. `web`: previous files; no data change.
3. `api`: previous API template and Lambda code. Removes the 30 routes and the identity function (its log group stays). No data change; Cognito users created by invitations stay and stay linked.
4. `egress`: removes the Lambda endpoint (stops its cost) and restores the previous S3 endpoint policy. Refuses while the identity function exists.
5. `db` (rarely needed): 0026…0022 down. 0026 refuses while staff-scheduled shifts exist; 0025 while invitations or planned assignments exist; 0022 refuses while client types or cities exist. Leaving the database at 0026 after an api/web rollback is safe.
6. Full restore only to a NEW instance from snapshot `ogevia-prod-postgres-pre-0026-<date>` (command printed by `status`).

## 6. Acceptance checks on the screens (synthetic data only)

| # | Who | Action | Pass when |
| --- | --- | --- | --- |
| 6.1 | Administrator | Clients → add a synthetic client and an authorization with a rate | Saved; rate visible to the Administrator only |
| 6.2 | Manager | Care Team → add a caregiver (Onboarding) → client page → Assign | "Planned. Access starts once the caregiver has signed in and is Ready to work or Active." |
| 6.3 | Manager | Caregiver page → Send invitation to a test inbox you control | "Invitation sent"; status "Invited — has not signed in yet"; the email arrives from Cognito with a temporary password; Ogevia never shows it |
| 6.4 | Administrator | Settings → upload the agency logo; Documents → upload a test PDF | Both succeed (proves the S3 endpoint fix) |
| 6.5 | Invited caregiver | Sign in, set a password | Caregiver page shows "First signed in …"; while Onboarding they see no clients |
| 6.6 | Manager | Change the caregiver to Ready to work | Their planned assignment shows access; the caregiver sees the client |
| 6.7 | Manager | Resend after first sign-in | Refused with a plain message |
| 6.8 | Manager | Schedule → Add shift for a synthetic client, no caregiver | "Shift scheduled as OPEN"; hours reserved; NEEDS COVERAGE shown |
| 6.9 | Manager | Assign a caregiver; then Record call-out with a reason; then Assign a replacement | States go Covered → NEEDS COVERAGE → Covered; History shows both events |
| 6.10 | Caregiver | My shifts → I can't make it, with a reason | "The office has been told"; the office sees NEEDS COVERAGE |
| 6.11 | Manager | Try to schedule more hours than the authorization has left this month | Refused with the minutes left |

## 7. Cost and security

- New fixed cost: Lambda interface endpoint ≈ 7.30 USD/month (1 AZ) plus 0.01 USD/GB processed. Identity Lambda: per-invocation, negligible. No NAT.
- Cognito default email sender (INFERRED limit about 50 emails/day) is sufficient for a pilot; a larger roll-out needs SES (separate decision).
- Security: invitations can only create caregiver memberships in the inviting agency (server-checked; staff sign-ins are refused); invite and resend are audited without the email address; no password passes through Ogevia; the identity function has no database, S3, KMS or secret access.
