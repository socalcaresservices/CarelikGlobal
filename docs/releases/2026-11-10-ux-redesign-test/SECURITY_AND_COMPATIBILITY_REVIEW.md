> Current owner decisions (2026-11-10): Excel/ZIP parsing and exceljs are removed; the Excel-library options below are historical and require no selection. SEC-5 privacy is accepted as built. Duplicate merge stays OFF in both environments. CPR/TB remains one-click. Current evidence/commands: RELEASE_READINESS.md and TEST_DEPLOYMENT_PLAN.md. No new sign-off form is requested. The prepared DB script uses a TEST-only logical dump, refuses instance snapshots, and records migration checksums transactionally. Nothing deployed or applied to AWS.

# Security review and Lambda/API compatibility review: 2026-11-10-ux-redesign-test

Prepared by Claude Code (AI assistant) on 2026-11-10/11 at commit `d7f7147` (plus later docs). **This is an analysis, not a sign-off.** A human reviewer must read it, may disagree, and signs at the bottom (Phase A, checklist item "security review"). Method: `docs/security-review-checklist.md` applied to every new or changed `SECURITY DEFINER` function, grants, and tables in pending 0090 to 0094; direct inspection of the local database (privileges, search paths, row-level security); targeted attack tests; dependency audit; bundling and load measurements.

## 1. Checklist, per function (VERIFIED on the local database unless stated)
| Function | Definer | search_path pinned | EXECUTE granted to | Validates org membership first | Requires the relationship it implies | Trusts a client-supplied org/user? |
|---|---|---|---|---|---|---|
| `ogevia_api.approve_signin_override` (0090) | yes | `ogevia, pg_temp` | `ogevia_app` only (PUBLIC revoked) | yes (`caregivers.signin_override` permission via guard) | target caregiver must belong to the org (404 otherwise, tested); background must be approved | org id is re-validated against the session; identity from `require_actor()` |
| `ogevia_api.list_signin_overrides` (0090) | yes | pinned | `ogevia_app` only | yes; reason and approver shown only with `caregivers.manage` | n/a | no |
| `ogevia_api.list_assigned_visit_clients` (0091, changed) | yes | pinned | `ogevia_app` only | yes (`is_active_member`) | **label returned only when the caller is assigned or scheduled with that client**; others get no row (tested) | no |
| `ogevia_api.list_open_shifts` (0091, changed) | yes | pinned | `ogevia_app` only | yes; caregiver with an active assignment | unchanged; adds `city`, never a name | no |
| `ogevia_api.import_rows` (0092) | yes | pinned | `ogevia_app` only | yes; `staff_guard` or `client_admin_guard` first; caregiver rows need `caregiver_admin_guard` from the preview on | tenant comes from the session; the file never names an organization | no; file content is data only |
| `ogevia_api.list_possible_duplicate_staff` (0093) | yes | pinned | `ogevia_app` only | `staff_guard(write)` | report limited to the caller's org | no |
| `ogevia_api.merge_staff_profiles` (0093) | yes | pinned | `ogevia_app` only | `staff_guard(write)` | both profiles must be in the org (404 for another agency's id, tested); hard match required; refuses sign-in, invitation, inactive, already merged | org id re-validated |
| `ogevia.ensure_standard_document_types` (0094) | yes | pinned | owner only (no app role) | internal; called by the migration or a bootstrap | per-agency, attributed to the agency's own active owner | no |
| `ogevia.caregiver_has_signin_override` (0090) | no (invoker) | pinned | owner only | internal helper | n/a | no |

New tables (`caregiver_signin_overrides`, `import_batches`, `staff_merge_links`): row-level security enabled; only a `readonly_select` policy for `ogevia_readonly`; **no grant to the application role**, so every write goes through the functions above; each has an append-only trigger. Cross-tenant: swept for all 5 routes by the tenant isolation sweep (9/9, run with all pending migrations applied).
Other items: PHI in logs: a test asserts neither file content, names nor override reason text reaches the logs (import and override). URLs and object paths carry no identifiers new to this release. No new secret, IAM role, bucket or network path.

## 2. Findings
| ID | Severity | Finding | Status |
|---|---|---|---|
| SEC-1 | **High** (availability) | A ~190 KB `.xlsx` that expands to 200 MB made the Node process die with an out-of-memory error: one authenticated administrator request could crash a Lambda instance (the 2 MB upload limit did not limit the expanded size). | **FIXED** (`assertWorkbookNotTooLarge`: the zip's own declared sizes are checked before decompression; more than 25 MB total or 300 parts is refused with 422). Tests added; the real 200 MB bomb is now refused in 0 ms. |
| SEC-2 | Low (latent) | The import preview of caregiver rows told a caller with staff rights but without caregiver rights whether a caregiver name existed. No built-in role has that combination today, so it is latent. | **FIXED** in pending 0092 (caregiver permission checked from the preview). |
| SEC-3 | Moderate, needs your decision | `exceljs` brings 8 advisories through its dependencies (`brace-expansion` in `archiver`/`readdir-glob`, `uuid` 8.3.2). **Assessment: not reachable from our use** (we only read a workbook with `xlsx.load`; we never call the archive or glob-pattern code with user input; `uuid` is used without a caller-supplied buffer). The code is still bundled. | **OPEN.** Options: accept with this note; replace `exceljs` with a read-only parser; or accept CSV only. |
| SEC-4 | Info, adjacent, not from this work | The same audit lists high advisories in `react-router` (apps/web, `<7.18.2`), `zod` (shared, `<4.6.6`) and `qs` via `stripe` (netlify-functions). | **OPEN, not changed** (outside this assignment). Recommend a separate dependency-update change. |
| SEC-5 | Info | Caregivers now see first name + last initial for their own clients and a client's city on open shifts (owner decision R23). That is client personal information on the caregiver screen. | Owner decision recorded; confirm the BAA/privacy position is acceptable. |
| SEC-6 | Info | Two administrators importing different files at the same moment are serialized by an advisory lock; not stress-tested. | Accepted; noted in the test plan. |

## 3. Lambda / API compatibility (measured locally; TEST re-measure PENDING)
| Item | Result | Limit | Verdict |
|---|---|---|---|
| Handler bundle (`apps/sv-api/src/index.ts`, esbuild, CJS, node22, minified, as CDK) | 1.12 MB (was 0.22 MB without `exceljs`: +0.9 MB) | Lambda zip 50 MB, unzipped 250 MB | OK |
| Cold load of the bundle (local, AWS SDK resolved from disk) | 193 ms vs 119 ms before: about +75 ms | function timeout 10 s | OK; real Lambda cold start is PENDING on TEST |
| Parse 2,000 rows | CSV 13 ms; XLSX 213 ms; heap about 40 to 50 MB | memory 512 MB | OK |
| Worst-case upload | 2 MB file: about 2.8 MB base64 inside JSON | API Gateway HTTP API 10 MB, Lambda synchronous 6 MB; app limit `MAX_IMPORT_BYTES` 2 MB (body cap 1.4x) | OK |
| Database time for 1,000 rows (one transaction) | about 0.4 s locally | Lambda 10 s; RDS `db.t4g.micro` latency PENDING | OK locally; re-measure on TEST (UXR-08c) |
| Routes vs stack contract | 5 new routes, each `feature`-gated and OFF in every real stack; with the switch on they require a JWT (nothing public) | `slice-contract.test.ts`, three `*-switch.test.ts` | OK |
| Runtime | Handler is Node 24 in CDK, bundle target node22; no new native module (`pg-native` stays external) | | OK |
| Not testable here | real JWT authorizer, IAM, VPC path to RDS, CloudWatch limits | | PENDING TEST |

## 4. Human sign-off
Reviewer name ____________ date ____________ ☐ I have read sections 1 to 3 ☐ SEC-3 decision: accept / replace / CSV only ☐ SEC-5 confirmed
