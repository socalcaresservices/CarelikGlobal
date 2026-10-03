# AWS TEST deployment: SCS pilot build

**Status:** Prepared and rehearsed. Not executed in AWS. You approved the plan; the workflow still asks for your **DEPLOY** confirmation once, after it has shown the live scope.
**Environment:** AWS TEST only. Account `300094796789`, `us-west-2`, database `ogevia_sv_test`. **Synthetic data only.**
**Not touched:**
- Netlify, Supabase, DNS and `main`; no merge.
- The `ogevia-web` app client.
- RDS security-group rules.
- Any production user or real client.

## How it runs

| Step | Who | What |
| --- | --- | --- |
| 1 | You | Open AWS CloudShell (`us-west-2`) from your IAM Identity Center sign-in (AdministratorAccess). |
| 2 | You | Paste the bootstrap block, with the commit Claude gave you. It is `infra/aws/slice/pilot-bootstrap.sh`. |
| **Checkpoint 1** | You | GitHub device sign-in in your browser: a one-time code, no password typed into CloudShell. It is signed out again right after the download. |
| 3 | Automatic | Prerequisites and versions, AWS identity, read-only inventory and the shared-resource report, then build + lint + typecheck + all tests + `cdk synth` on the exact commit. |
| 4 | You | Enter the 3 pilot emails and names (asked once; stored mode 600 in `~/ogevia-pilot-run`). |
| 5 | Automatic | Capture the rollback versions, then run the scope gate: deployed templates vs this build. |
| **Checkpoint 2** | You | Read the printed scope and type **DEPLOY**. This is the only approval. |
| 6 | Automatic | Snapshot, DB window, API deploy, web upload, smoke suites, report. |

**The workflow stops by itself if any of these fail:**
- the account or role;
- RDS status, privacy, encryption or backup retention;
- a stack that is not `*_COMPLETE`;
- the API Lambda not pointing at `ogevia_sv_test`;
- a custom domain on the TEST distribution;
- any test, lint, type or synth failure;
- the scope gate;
- an unexpected migration ledger;
- a migration or verification error;
- **any existing visit's timestamps changing**;
- the pilot seed read-back;
- the admin host's security groups not being restored;
- AWS drifting between approval and deploy (the scope gate runs again);
- stack status after deploy, or the Lambda database after deploy;
- site reachability;
- either smoke suite.

Re-running the bootstrap resumes after the last completed step.

## Exact change scope

| Resource | Change | Verified how |
| --- | --- | --- |
| RDS `ogevia-prod-postgres` | Manual snapshot `ogevia-prod-postgres-pre-pilot-<date>` | Waits until it is `available` |
| Database `ogevia_sv_test` only | Migrations **0012–0018**. Only 0015 touches a table (2 nullable columns); the rest are functions. Each runs in its own transaction. | Ledger must be 0001–0011…0018 before; `verify.ts` after; visit fingerprint before == after |
| Cognito pool `us-west-2_849AYz5J7` | +3 individual users (email invitation, password + TOTP at first sign-in) | Subs read back |
| Pilot organization `scs-pilot-synthetic` | Synthetic seed: 3 clients, 2 services, 4 authorizations, 4 assignments | Read-back `3 \| 2 \| 4 \| 4` |
| Admin host `ogevia-db-admin-temp` | AppSG attached **only during the DB window** | Original groups restored and re-checked |
| Stack `Ogevia-prod-ServiceVerificationApi` | +2 routes, +2 route-scoped `lambda:InvokeFunction` permissions, new Lambda code | Scope gate. Proven locally on the real templates of the deployed commit `d775647` against this build: exactly these 5 changes. |
| Other 4 stacks | **None** | Scope gate (any change stops) |
| Site bucket + CloudFront | New web build + `config.json`, invalidation | Site reachable |

CDK runs with `--require-approval never`. The scope gate has just proven, for that exact `cdk.out`, that the change set equals the approved scope, and your DEPLOY covers it. This replaces CDK's separate IAM prompt so there is exactly one approval.

## Resources shared with production (checked live before approval)

The workflow writes `~/ogevia-pilot-run/SHARED_RESOURCES.md` from live reads. The expected picture:

- **RDS instance `ogevia-prod-postgres`:** production-named, but production runs on Supabase. Its databases are listed in the DB window before any change. Only `ogevia_sv_test` is modified; the snapshot covers the whole instance.
- **`Ogevia-prod-*` stacks, the API Lambda (`DB_NAME=ogevia_sv_test`), the site bucket and CloudFront:** production-named TEST slice. The workflow stops if the Lambda serves another database, or if CloudFront serves a custom domain.
- **Cognito pool:** shared. `ogevia-web` is reserved for a future production cutover and is untouched; only 3 users are added.
- **Netlify, Supabase, DNS:** production. Not accessed.

## Rollback (captured before anything changes)

`~/ogevia-pilot-run/rollback/` holds:
- the 5 deployed stack templates;
- the Lambda `CodeSha256`, last-modified time and `DB_NAME`;
- the API route list;
- a copy of the previous web files, including `config.json`;
- the visit fingerprint;
- the admin host's original security groups.

`bash infra/aws/slice/pilot-rollback.sh <layer>` runs **newest first**, and each layer asks you to type its name:

| Layer | Action | Data effect |
| --- | --- | --- |
| `web` | Restore the previous web files and config, then invalidate | None |
| `api` | Update the API stack to the captured template (after checking its Lambda package still exists), then verify the Lambda code equals the captured `CodeSha256` | None |
| `users` | Disable the 3 pilot sign-ins (never deleted) | None |
| `db` | Down-migrations 0018…0012 on `ogevia_sv_test`, through the same DB window | 0015 drops who closed a missed clock-out, and why (synthetic; held by the snapshot) |
| full DB | `status` prints the restore-to-a-**new**-instance command for the snapshot | Not automated |

## Expected interruption

- **Production:** none.
- **TEST:**
  - each migration holds locks for its own transaction only (milliseconds to seconds);
  - the Lambda swap is atomic, with cold starts of about 1–3 s;
  - CloudFront takes minutes to refresh.
- **Total run:** about 30–50 minutes. Most of it is the test suite, the snapshot and CloudFront. Keep CloudShell open; if the session times out, re-paste and it resumes.

## Reviews completed for this deployment

- **Manager permissions:** AWS matches production #46. Managers keep operational approval (`billing.approve`) and `billing.visits.read`. They have no `billing.submit` and no `billing.read`, no AWS route exposes rates, and an authorization amendment carries the existing rate forward.
- **New public route** `GET /v1/public/care-portals/{token}/requests`: kept. It returns only future requests created through that same active link: same organization, revocation and expiry enforced, at most 50. Fields are service, times, status, and the assigned caregiver's first name, the same exposure as the already-approved single-request route. There are no client identifiers, payer data or rates. The 256-bit token is hashed before the database, and the API access log records the route template, not the token.

## After deployment

Run the real-phone test in [PILOT_PHONE_ACCEPTANCE.md](PILOT_PHONE_ACCEPTANCE.md). The pilot is accepted on TEST only when every row passes. **Real clients** still require the confirmed AWS BAA, the Phase 7 security sign-off and a separately approved production cutover.
