# AWS TEST deployment plan: migrations 0019–0021, API routes, permissions, storage and web

**Status:** prepared 2026-10-04; executable workflow `infra/aws/slice/increment-deploy.sh`, rehearsed end to end against stubbed AWS and a local PostgreSQL copy at 0018 (9/9 checks PASS). **Not executed in AWS.** Production, Netlify and Supabase are not touched.

**Environment:** account 300094796789, us-west-2, database `ogevia_sv_test`, synthetic data only.

**Build to deploy:** the commit pinned in `infra/aws/slice/increment-bootstrap.sh` (the paste block). The script refuses any other commit and any checkout with local changes.

**Not affected:** the completed pilot deployment. This run uses its own state and rollback folder (`~/ogevia-increment-run`) and its own checkout (`/tmp/ogevia-increment`); `~/ogevia-pilot-run` and `/tmp/ogevia-pilot` are never written.

## 0. Preconditions: read live first, then decide

Run `infra/aws/slice/live-status-check.sh` (read-only). Proceed only if all of these hold:

| Check | Expected | If not |
| --- | --- | --- |
| Migration ledger | 0001–0018, contiguous, checksums match the repository | Stop and reconcile; never skip a migration |
| Live API code | Pilot build 87a9be2 (`CodeSha256` differs from the October 2 capture; `close` route present) | Stop; the base is not what this plan diffs against |
| CloudFormation stacks | All `*_COMPLETE`, no drift in the API stack | Stop |
| Owner | An active `organization_owner` in `scs-pilot-synthetic` (apply the OWNER fix first if missing) | Owner-only features cannot be accepted without one |
| Phase 7 settings | No new GAP versus the reviewed list | Record it; a regression stops the deploy |

## 1. Exact change set

Both sides of this comparison are local `cdk synth` (mode=plan): build 87a9be2 against the new build. The deploy-time scope gate repeats the comparison against the live templates captured just before DEPLOY.

| Stack | Change | Detail |
| --- | --- | --- |
| Ogevia-prod-ServiceVerificationApi | **+22** `AWS::ApiGatewayV2::Route`, all with the existing JWT authorizer and the existing integration | `GET /v1/attention`, `GET /v1/billing-approvals`, `GET /v1/branding`, `GET /v1/branding/logo`, `GET /v1/clients/directory`, `GET /v1/document-types`, `GET /v1/document-versions/{versionId}/file`, `GET /v1/documents`, `GET /v1/documents/alerts`, `GET /v1/documents/people`, `GET /v1/reports/utilisation`, `POST /v1/billing-approvals/{approvalId}/void`, `POST /v1/branding`, `POST /v1/branding/logo`, `POST /v1/branding/logo/clear`, `POST /v1/clients/{clientId}/legal-name`, `POST /v1/document-types`, `POST /v1/document-versions/{versionId}/review`, `POST /v1/documents/requests`, `POST /v1/documents/{documentId}/versions`, `POST /v1/me/display-name`, `POST /v1/visits/{visitId}/billing-approval` |
| Same | **+22** `AWS::Lambda::Permission` | One route-scoped invoke permission per new route, identical in shape to the existing ones |
| Same | **~** Handler code package only | Same runtime (nodejs24.x), memory (512 MB), timeout (10 s), VPC, role and environment |
| Same | **~** `HandlerPolicy`: exactly two statements **added**, none changed or removed | `StaffDocumentObjects`: s3:PutObject, GetObject, GetObjectVersion on `ogevia-prod-signature-evidence-300094796789-us-west-2/*/documents/*/*`. `AgencyLogoObjects`: the same three actions on `…/*/branding/logo/*`. The existing KMS grant (via S3 only) covers both. |
| EvidenceStorage, NetworkEgress, Observability, WebHosting | **No change** | The bucket, KMS key, lifecycle (no expiry), versioning and access logging are unchanged. No CORS, because files go through the API, not directly to S3. |
| Database `ogevia_sv_test` | Migrations **0019**, **0020**, **0021** in order, applied by the existing migrate script (one transaction each; ledger with checksum) | See section 2 |
| Web bucket | New AWS-mode build; `config.json` unchanged (same API and app client) | See section 3 |

Anything else in the live diff (any other resource, any removed resource, any changed attribute) fails the scope gate, and nothing is deployed.

## 2. Database

| Migration | Adds | Data effect on existing rows |
| --- | --- | --- |
| 0019 | `billing_approvals` (append-only); approve, void and list functions; `billing.read` (owner); a guard so an approved visit cannot be corrected until voided | None. No existing visit has an approval. |
| 0020 | Profile (display name); agency accent colour and logo columns; NEEDS ATTENTION and utilisation functions; `client_private_names` (owner and manager only) | Adds nullable columns. Existing rows are unchanged. |
| 0021 | Document types, requests and versions (append-only); review with audited owner self-review; alerts | None |

Steps:
1. Take an RDS manual snapshot `ogevia-prod-postgres-pre-0021-<UTC date>`, and wait until it is available.
2. Open the DB window: the app security group goes on the admin host and is restored on exit, with a check.
3. Pre-check: the ledger is 0001–0018 and the checksums match.
4. Apply 0019–0021.
5. Run `db:verify`: `latest_migration_is_0021` and `migration_count_is_21` must pass, and every other verification query must pass.
6. Optional, TEST only, needs the typed word **SEED**: `05_seed_synthetic_client_names.sql`. It refuses any database other than `ogevia_sv_test` and gives the three synthetic clients obviously synthetic names ("Synthetic Client Alpha" and so on).

## 3. Web assets

1. Build the AWS-mode web bundle from the pinned commit with the existing TEST settings.
2. Sync it to the web bucket.
3. Invalidate the CloudFront `/*` path.
4. Verify that the served `index.html` references this build's asset hashes.

The previous build's `index.html` and assets stay in the versioned bucket for rollback.

## 4. How to run (CloudShell, us-west-2, AdministratorAccess)

1. **Live check first** (read-only): paste `infra/aws/slice/live-status-bootstrap.sh`. Type `READ-DB` when asked. The ledger must read 0018 and every Phase 7 line must match the reviewed list. Do not type `OWNER` unless the owner row is missing.
2. **Deploy:** paste `infra/aws/slice/increment-bootstrap.sh`. It downloads the pinned commit (GitHub sign-in in the browser if needed, signed out again afterwards) and runs `increment-deploy.sh`:

| Step | What happens | Changes AWS? |
| --- | --- | --- |
| 1–3 | Tools, pinned clean commit, identity, inventory. Pilot preconditions: the `close` route is live, the Lambda serves `ogevia_sv_test`, no custom web domain. The live approval tag is read so the build's tags equal the deployed ones. | No |
| 4 | Lint, typecheck, unit tests, build (one task at a time), `cdk synth`, web build | No |
| 5 | Capture rollback material: 5 templates, Lambda version, 38 routes, Handler policy, web files | No |
| 6 | Strict scope gate (`increment_diff_gate.py`) plus its self-test, which must refuse 14 tampered variants of this exact build. It prints the exact change list. | No |
| 7 | **DEPLOY** prompt (the only approval) | No |
| 8 | Snapshot `ogevia-prod-postgres-pre-0021-<date>` | Yes |
| 9 | DB window. Checks: ledger exactly 0001–0018, checksums equal to the repository. Applies 0019–0021, then `db:verify` (all PASS). Checks that existing visits (id, times, signed time, status) are unchanged. Restores and verifies the admin-host security groups. | Yes |
| 10 | Gate again against the templates read just before deploying; `cdk deploy` of the API stack only; web files (`config.json` not changed); invalidation | Yes |
| 11 | 9 live checks (section 6) and `REPORT.md` | No |
| 12 | Optional **SEED** (typed): synthetic client names, TEST only | Yes (TEST data) |
| 13 | `pilot-manager-account.sh` (typed **MANAGER**). Creates the separate manager sign-in `ogemails+ogevia-pilot-manager@gmail.com` in the TEST Cognito pool (email invitation; MFA at first sign-in). Adds a `manager` membership in `scs-pilot-synthetic`, audited. Reads back that the role holds no `billing.read` and no `organization.update`, and that the owner remains. Rollback file: revoke (audited) and disable; nothing is deleted. Rehearsed: it refuses when there is no owner, applies once, and a re-run changes nothing. | Yes (TEST sign-in and data) |

A stop at any step prints the reason; pasting the block again resumes after the last completed step. A cancelled DEPLOY changes nothing (rehearsed: no AWS calls that change anything).

**Database tests** (193 + 38) need a PostgreSQL server, which CloudShell does not have. They ran in development on the pinned commit; CloudShell runs lint, typecheck, unit tests and build.

**Order rationale:** database before API (the running pilot API never calls 0019–0021); API before web (the old web never calls the new routes).

## 5. Rollback: what happens to records and files created after the deployment

`infra/aws/slice/increment-rollback.sh <status|export|web|api|db>`, run from `/tmp/ogevia-increment`. Each layer asks for `ROLLBACK <layer>`. It uses only `~/ogevia-increment-run/rollback`.

| Layer | What it does | Approvals, client names, documents, logo, audit rows | Files in S3 |
| --- | --- | --- | --- |
| `export` (read-only) | Copies every approval, client name, document record, document type, the organizations row and audit rows since DEPLOY to `~/ogevia-increment-run/export-<time>` (mode 700) | Unchanged | Unchanged |
| `web` | Restores the previous web files; `config.json` is not touched | Unchanged | Unchanged |
| `api` | Restores the captured API template: removes the 22 routes, their permissions and the 2 S3 statements, and the previous Lambda code returns | Unchanged. The previous API never calls the new tables, so the data stays, unused. | Unchanged; no longer reachable through the API |
| `db` | Runs 0021 → 0020 → 0019 down scripts. **Each refuses while its records exist** (documents; client names; approvals); a refusal leaves that migration and its data intact. | Kept unless the layer is empty | Never deleted by any rollback |
| Full restore | `status` prints the command: restore the snapshot to a **new** instance, never in place | The live database is untouched | Unchanged |

**Recommended rollback** if the new build misbehaves: `web`, then `api`. The database stays at 0021 with every record created after the deployment, ready for a fixed build. Use `db` only when no records exist.

Rehearsed against the rehearsal deployment:
- `export` wrote 3 client names and 3 audit rows.
- `db` rolled back 0021 (no documents), then **refused 0020** because client names exist. All 3 names and all 8 visits stayed.
- `web` and `api` restored the previous build. `config.json` was unchanged.

**S3:** the evidence bucket is versioned with no expiry. Documents (`{org}/documents/...`) and the logo (`{org}/branding/logo/...`) remain after any rollback, and the IAM role simply loses access to those two prefixes after an `api` rollback.

## 6. Acceptance checks

**Automated** (the deploy block prints PASS or FAIL for each):
1. The API stack is `UPDATE_COMPLETE` after the approval time.
2. 22 new routes exist; every one has the JWT authorizer; the routes from 87a9be2 are unchanged.
3. Each new route returns 401 without sign-in (checked on 3 of them).
4. The Lambda `CodeSha256` matches this build's asset.
5. The policy has exactly the two new statements, on the two documented key shapes.
6. The ledger shows 0021 and 21 migrations, with checksums matching the repository; `db:verify` passes.
7. The served web build matches, and `config.json` is unchanged.
8. The DB window is closed: the admin host's security groups are back to the original.
9. The pre-deploy snapshot is available.

**Real phones** (synthetic data):
1. **Owner:** shows OWNER VIEW with your name; the logo upload appears in the header for the manager and caregiver too; the colour change applies; Home financial cards appear, with cost and margin "Unavailable".
2. **Manager** (`ogemails+ogevia-pilot-manager@gmail.com`, not the owner account): shows MANAGER VIEW; NEEDS ATTENTION shows a count and opens the exceptions list.
   - Approves one Billing Ready visit and sees no dollar amounts.
   - Voids it with a reason.
   - Correcting an approved visit is refused until the approval is voided.
3. **Manager:** Visit records appear as cards on the phone. The Clients page sets a synthetic name, and the calendar print shows "Client: name (code)" with per-service totals in landscape.
4. **Caregiver:** shows CAREGIVER VIEW, with no Clients or billing menus and no names. My documents: upload a photo, then "Uploaded – awaiting review".
5. **Manager or owner:** reject without a reason is refused; verify works; the owner can verify their own upload, and the audit row shows it as an owner self-review.
6. **Isolation:** the second (test-slice) agency's manager sees none of this agency's data.

## 7. Cost and security

**No new fixed (always-on) charge.** This deployment creates:
- no instance, NAT gateway, VPC endpoint, KMS key, bucket, alarm or log group;
- no change to the RDS instance class or storage.

The API stack gains routes and permissions, which have no standing charge.

**Variable costs (pay per use)**, at the current TEST scale:

| Driver | What increases it |
| --- | --- |
| Lambda requests and duration | Each call of the new screens (Home, NEEDS ATTENTION, documents, billing review) |
| API Gateway HTTP API requests | The same calls, per request |
| S3 storage and requests | Uploaded documents (up to 4 MB each) and one logo (up to 512 KB), per GB-month; PUT/GET per request. Versioning keeps replaced files, which are also billed. |
| KMS requests | Encrypting and decrypting those objects; S3 bucket keys reduce this |
| CloudFront | Data transfer for the web app and the logo |
| CloudWatch Logs | Lambda log ingestion, with the existing finite retention |
| RDS snapshot storage | `ogevia-prod-postgres-pre-0021-<date>`: charged per GB-month only beyond the free backup allowance (equal to the provisioned storage). It is kept until you delete it. |

Prices were not re-checked today. The AWS Budgets alert configured in Phase 7 is the control.

**Security:**
- IAM grows by two prefix-scoped statements.
- No public access, no CORS, no new secrets.
- Names and documents are stored only in TEST, and only synthetic data is allowed until the BAA and security gate are confirmed.
- Billing:
  - Managers approve billable **hours**.
  - Rates and dollar amounts are returned only with `billing.read` (owner).
  - Automatic payer submission is **outside launch scope**.
