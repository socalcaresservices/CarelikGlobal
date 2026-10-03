# SCS pilot readiness — Monday 2026-10-05

**Status:** NOT DEPLOYED. Nothing was merged, and nothing in AWS, Netlify or Supabase changed.
**Pilot branch:** `claude/ogevia-socal-pilot-prep-vfu5tf`. The report covers the code at `454f934` plus the harness/docs commit that adds this file.
**Data:** synthetic only until the BAA and live-data gates in §5 pass.

## 1. Branch, commit, deployed version, PR dependencies

| Item | Value | Evidence |
| --- | --- | --- |
| AWS PR chain | `main` ← #68 `claude/phase3-cognito-auth` ← #51 ← #52 ← #60 ← #62 ← #64 ← #66 ← #67 (tip `cf47421`) | VERIFIED: GitHub PR bases and `git merge-base --is-ancestor` |
| Chain defect | #51 and everything above it sit on `7ed453c`. They do **not** contain #68's head `4b5c401`, which merged `main`'s production fixes #59/#61/#63/#65. | VERIFIED |
| Pilot integration | `4ed681a` = tip `cf47421` + merge of `4b5c401`. The 5 conflicts were all in the Service Verification web pages, which the AWS chain had already re-implemented. The adapter-based versions were kept, and production `supabase/migrations` and DB tests merged in unchanged. | VERIFIED: full gate green on `4ed681a` before any change |
| Deployed in AWS TEST | Lambda from `998e871`, web from `d775647`, DB `ogevia_sv_test` at migration **0011** | Taken from the deployment log (TEST_SLICE_DEPLOYMENT_APPROVAL.md §8.4–8.5). It could **not** be re-checked live, because AWS rejects this environment's credentials (`InvalidClientTokenId`). |
| Missing from TEST | Migrations **0012–0017**, the Lambda code for #60–#67, the web build for #60–#67, and this branch's changes | INFERRED from the log; no later deploy is recorded |
| Merge path | #68 must merge first. Netlify builds production from `main`, so #68 changes the production web build (Supabase stays the default backend). After that, #51 → #67 merge in order. Each later PR needs the same one merge commit as `4ed681a`. | VERIFIED: PR #68 body and test merges |

## 2. Changes on the pilot branch (beyond the integration merge)

| Commit | Change |
| --- | --- |
| `2dabafa` | **Caregiver entry point.** The screen now opens on "Today's visits": the caregiver's own shifts today as tappable cards (client code and AM/PM window), then "Other assigned clients" marked *Not scheduled today*. A Visit details card shows client, service, date and scheduled times, followed by one **Start visit** button. The service picker appears only for multi-service clients. "Scheduled today" uses the server's `next_scheduled_*` window, which both backends already return. There is no schema, API or permission change. |
| `523fe02` | **Manager Time Out.** Entry is now date + hour + minute + explicit AM/PM, all in **Pacific time** (previously it used the manager's device timezone). Only the date is pre-filled; the old form pre-filled the *scheduled* end. Before saving, the form shows Time In → Time Out → Duration. It gives specific messages for each problem: missing parts, a time that doesn't exist on a DST date, a future time, a time not after Time In (naming both times), and a visit over 24 h. **Fix:** server refusals such as "overlaps another visit" were replaced by a generic message on Supabase; they are now shown. |
| `9f6f0eb` | `04_seed_scs_pilot_synthetic.sql` creates a separate pilot org. It has 1 manager and 2 caregivers as individual Cognito users, 3 clients with random codes, and authorizations sized for the clean, limit and over-limit cases. It seeds **no shifts**: those are created through Care Requests, which reserves the authorization. Adds guarded `pilot-users` / `pilot-seed` steps to `deploy-test-slice.sh`. None of this has been run against AWS. |
| `92d7012` | **Submitted screen** now shows Worked, Billable and the billing state: "Billing ready — does not mean billed", or "Needs manager review — not billable". |
| `454f934` | Fixes found in browser QA: accessible names for the hour/minute/date controls, a stale error left on screen after correcting the time, and a duplicated "Client" label. |
| this commit | `infra/aws/slice/pilot-e2e/` (re-runnable browser acceptance) and this report |

## 3. Verification on the pilot code (`454f934`)

| Check | Result |
| --- | --- |
| `pnpm typecheck` / `lint` / `build` | PASS |
| `turbo run test --force` | PASS: web 556, infra-aws 102, sv-api 54, auth 138, ui 73, shared 118 |
| AWS DB suite, PostgreSQL **18** | PASS 140/140. Covers tenant isolation, authorization caps and concurrency, amendments, idempotency, signature/correction, close-out, shift access, remaining hours, rollback, and the pilot seed. |
| sv-api workflow DB suite | PASS 28/28 |
| Production Supabase SV DB tests (shift link, shift access, close-out) | PASS, including the negative controls |
| `cdk synth` (plan mode) | PASS. Deploy mode correctly refuses without `OGEVIA_DEPLOY_APPROVAL`. |
| **Browser acceptance** (`infra/aws/slice/pilot-e2e`) | **68/68 PASS** at `e8b351e`. Exact AWS-mode build in 390×844 touch Chromium, real `sv-api` handler, PG18 with 0001–0017 and both seeds. Adds multi-service preselection, a correction entered on a New York-timezone device, and the authorized-hour cap. |

Covered in the browser:
- Starting today's scheduled visit (linked to the shift on the server).
- A double tap on Start creates exactly one visit.
- Refreshing mid-visit returns to the same visit.
- Signature leads to Billing ready (not billed).
- An unscheduled visit gives a warning; a visit with no confirmation goes to administrator review with 0 billable.
- Call-out then reassignment reuses the same shift. The replacement sees it under Scheduled today; the original caregiver no longer does.
- A missed clock-out is closed by the manager. A wrong AM/PM is refused with both times named. The stored Time Out equals the entered Pacific minute. The caregiver sees "entered by your agency", signs, and the visit becomes Billing ready.
- The billing review page says "not approved, billed, or submitted".
- In the monthly summary, remaining = authorized − billable − reserved, and the reservation is released on signing.
- Cross-tenant: another org's manager and caregivers see none of the pilot data.
- No horizontal scroll on any screen, and no page errors.

**Stand-ins:** Cognito tokens are unsigned, so the API Gateway JWT authorizer was **not** exercised (the handler's claims checks were). S3 was replaced by a local file store. Time passing was simulated with SQL.

## 4. Not verified

- Live AWS state, TEST deployment, CloudTrail/CloudWatch, budgets, and the KMS/S3 configuration. All BLOCKED: this environment's AWS credentials are invalid.
- A real Cognito sign-in with TOTP, and the API Gateway authorizer.
- A real phone (only emulated mobile Chromium was tested).
- Backup **restore**. 7-day automated RDS backups are recorded as VERIFIED in CURRENT_AWS_INVENTORY.md, but no restore drill has been run.
- The Supabase/Netlify production path with these UI changes. It is covered only by unit tests; not deployed.

## 5. Launch blockers and decision gates

1. **BAA / live data (BLOCKER for real clients).** Neither an AWS BAA nor a Supabase BAA is documented as confirmed (SECURITY_DECISIONS.md: HIPAA is "not yet applicable"; the Phase 7 gate has not been run). Until it is, Monday can only be a **synthetic-data dry run** with real staff accounts. *Recommended:* run Monday on AWS TEST with the pilot seed, and confirm the AWS BAA in AWS Artifact before any real client.
2. **TEST deployment (YELLOW, needs owner approval).** It needs a DB window to apply 0012–0017 to `ogevia_sv_test`. The concrete plan is in [TEST_PILOT_DEPLOYMENT_PLAN.md](TEST_PILOT_DEPLOYMENT_PLAN.md), then `pilot-users`, `pilot-seed`, and the Lambda + web update from this branch (§6).
3. **Cognito MFA is ON for the whole pool.** Every caregiver must set up a TOTP authenticator app at first sign-in. *Recommended:* keep it, and onboard caregivers in person on Monday morning. Turning it off weakens authentication and needs explicit approval.
4. **Manager role has `billing.approve` in AWS** (0002 role_permissions). This conflicts with production's manager/financial separation (#46). AWS has no approve route yet, so the issue is latent. *Recommended:* fix before any approval route ships.
5. **Residual risks (not blockers):**
   - Fixed in `420122a`: the visit correction form now uses Pacific date/hour/minute/AM-PM. Corrected times are whole minutes, so the seconds of an unchanged Time In are dropped (the summary shows it).
   - Fixed in `e8b351e` (AWS 0017): the start screen preselects the scheduled shift's service. Production Supabase does not return it, so the explicit choice remains there.
   - The 1:00–2:00 AM fall-back hour resolves to the first occurrence.
   - RDS is single-AZ.
   - Lambda concurrency is 10.

## 6. Owner-run commands (YELLOW — run only after approval)

```bash
# from infra/aws, admin profile, after approval reference is issued
export OGEVIA_DEPLOY_APPROVAL=<ref> AWS_PROFILE=<admin>
./scripts/deploy-test-slice.sh preflight
./scripts/deploy-test-slice.sh database          # applies pending 0012-0017 (re-runnable)
OGEVIA_PILOT_MANAGER_EMAIL=... OGEVIA_PILOT_CAREGIVER_A_EMAIL=... OGEVIA_PILOT_CAREGIVER_B_EMAIL=... \
  ./scripts/deploy-test-slice.sh pilot-users
OGEVIA_PILOT_MANAGER_NAME=... OGEVIA_PILOT_CAREGIVER_A_FIRST=... OGEVIA_PILOT_CAREGIVER_A_LAST=... \
OGEVIA_PILOT_CAREGIVER_B_FIRST=... OGEVIA_PILOT_CAREGIVER_B_LAST=... \
  ./scripts/deploy-test-slice.sh pilot-seed
./scripts/deploy-test-slice.sh infra && ./scripts/deploy-test-slice.sh web && ./scripts/deploy-test-slice.sh smoke
```
