# AWS TEST deployment plan: migrations 0019–0021, API routes, permissions, storage and web

**Status:** prepared 2026-10-04. **Not executed.** Production, Netlify and Supabase are not touched.

**Environment:** account 300094796789, us-west-2, database `ogevia_sv_test`, synthetic data only.

**Build to deploy:** branch `claude/ogevia-socal-pilot-prep-vfu5tf` at the commit named in the deploy block. The pinned commit is fixed when the block is generated, and the block refuses any other commit.

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

## 4. Order and approvals

1. Run the read-only live status (section 0).
2. Run the quality gate on the pinned commit: lint, typecheck, unit tests, build, database tests (193), API database tests (38), `cdk synth`.
3. Run the scope gate against the live templates. It prints the exact change list.
4. **DEPLOY** (typed). This takes the snapshot, then runs the database migrations, then the API stack, then the web.
5. Live acceptance (section 6).
6. Optional **SEED** (typed).

Reason for the order: the database comes before the API because the old API code never calls the new functions, so 0019–0021 are safe under the running build. The API comes before the web because the old web never calls the new routes.

## 5. Rollback (reverse order; each step independent)

| Layer | How | Data |
| --- | --- | --- |
| Web | Re-sync the previous build (kept in the versioned bucket and in `~/ogevia-pilot-run/rollback`) and invalidate | None |
| API | Deploy the captured 87a9be2 templates or code (`pilot-rollback.sh api`). This removes the 22 routes, the 22 permissions and the 2 policy statements. | None. The new tables simply stop being called. |
| Database | Run the down scripts 0021 → 0020 → 0019. Each **refuses** while its records exist (documents, client names, approvals), so data is never silently dropped. If records exist, restore the pre-deploy snapshot to a new instance instead (as in the restore drill). | S3 document and logo files are never deleted by a rollback |

## 6. Acceptance checks

**Automated** (the deploy block prints PASS or FAIL for each):
1. The API stack is `UPDATE_COMPLETE` after the approval time.
2. 22 new routes exist; every one has the JWT authorizer; the routes from 87a9be2 are unchanged.
3. Each new route returns 401 without sign-in (checked on 3 of them).
4. The Lambda `CodeSha256` matches this build's asset.
5. The policy has exactly the two new statements, on the two documented key shapes.
6. The ledger shows 0021 and 21 migrations, with checksums matching the repository; `db:verify` passes.
7. The served web build matches.
8. The DB window is closed: the admin host's security groups are back to the original.
9. The pre-deploy snapshot is available.

**Real phones** (synthetic data):
1. **Owner:** shows OWNER VIEW with your name; the logo upload appears in the header for the manager and caregiver too; the colour change applies; Home financial cards appear, with cost and margin "Unavailable".
2. **Manager:** shows MANAGER VIEW; NEEDS ATTENTION shows a count and opens the exceptions list.
   - Approves one Billing Ready visit and sees no dollar amounts.
   - Voids it with a reason.
   - Correcting an approved visit is refused until the approval is voided.
3. **Manager:** Visit records appear as cards on the phone. The Clients page sets a synthetic name, and the calendar print shows "Client: name (code)" with per-service totals in landscape.
4. **Caregiver:** shows CAREGIVER VIEW, with no Clients or billing menus and no names. My documents: upload a photo, then "Uploaded – awaiting review".
5. **Manager or owner:** reject without a reason is refused; verify works; the owner can verify their own upload, and the audit row shows it as an owner self-review.
6. **Isolation:** the second (test-slice) agency's manager sees none of this agency's data.

## 7. Cost and security

- **Cost:** no new fixed cost. Variable costs are Lambda invocations, S3 storage for documents and logos (MB scale), and KMS requests (S3 bucket keys enabled). The snapshot adds a small storage cost until it is deleted.
- **Security:**
  - IAM grows by two prefix-scoped statements.
  - No public access, no CORS, no new secrets.
  - Names and documents are stored only in TEST, and only synthetic data is allowed until the BAA and security gate.
