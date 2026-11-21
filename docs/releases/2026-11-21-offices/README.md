# Offices (minimal): migration 0110 and the Office filters

**Owner request (2026-11-21):** the Billing review should filter by review reason **and** by office ("both"). There was no office in the data, so the owner approved building a **minimal Offices feature** first ("Yes, minimal offices").

**Status: IMPLEMENTED AND TESTED LOCALLY. NOT DEPLOYED ANYWHERE. Release switch OFF everywhere** (`features.offices` is absent in every environment, so no route exists and no synthesized template changes).

## What it is
| Layer | Change |
|---|---|
| Database (pending `0110_offices.sql`, additive) | Table `offices` (agency, name 2 to 80 characters, unique per agency ignoring case, active flag, who and when). Nullable `clients.responsible_office_id` with a composite foreign key (a client can only point at an office of its own agency). Six functions: `create_office`, `rename_office`, `retire_office`, `list_offices`, `list_client_offices`, `set_client_office`. Rollback: `pending/rollback/0110_offices.down.sql`. |
| API (six routes, all behind the switch) | `GET /v1/offices`, `GET /v1/client-offices`, `POST /v1/offices`, `POST /v1/offices/{officeId}/rename`, `POST /v1/offices/{officeId}/retire`, `POST /v1/clients/{clientId}/office`. |
| Web | Settings > Offices (Administrator); a "Responsible office" control on the client page (clients.manage); an **Office** filter on Billing review, on the Reports record lists and on the Clients list. Every office control stays hidden unless the office list actually loaded (so nothing shows, and nothing breaks, where the switch is off). |

## Rules
- Only the agency Administrator (`organization.update`) creates, renames or retires offices; a manager with `clients.manage` assigns a client; reading needs `clients.names.read` or `billing.read` (a caregiver sees none).
- A retired office keeps its history and its clients, appears as "(retired)", and cannot be chosen for new assignments.
- **Responsible office is one thing only.** It is not the service location, the payer or the authorization, and it does not change who can see what. No office-based permissions yet.
- Existing clients have no office until someone assigns one. Nothing existing changes: no current function, report or hour calculation is touched. The Office filter in Billing review maps the visit's client code to an office; it never changes a record.

## Tests (local)
Database `offices-0110.db.test.ts` (9: rules, idempotency, permissions, tenant isolation, history, rollback and re-apply); API `offices.db.test.ts` (3) and the tenant-isolation sweep (a real office row is created so the six routes are probed); CDK `offices-switch.test.ts` (3: absent everywhere; exactly six JWT routes when on); web `offices.test.tsx` (8). Full suites: web 1382 passed.

## Not done / next
- No release tooling yet for 0110 (TEST ledger tool, production SQL helper, route change set): to be built on the owner's GO for a TEST release, like 0109.
- Not covered by a page-level automated test: the Office select on the Reports page (the filter rule itself is tested once and shared by all three screens).
- Out of scope, still open from the 2026-11-18 checklist: office-based permissions, caregivers shared across offices, per-office finance totals, payer and service-location fields.

## TEST deployment record (2026-11-21, owner GO for Offices TEST only)
- Release commit `9f21c499fe4fa06937d29d1d59c4ddbe6aad5bb5` (CI green: harness, validate, postgres). Run with `TEST_H3_OFFICES.sh` from CloudShell; operator output: `H3 COMPLETE (TEST)`.
- Starting point: ledger 108/0109, 259 routes (request cleanup OFF on TEST). After: ledger 109/0110, 265 routes (six office routes), web serves the release commit.
- First attempts stopped safely before any change: the confirmation prompt was answered by pasted input; then the reused `OPERATOR_TEST_DB.sh isolated-backup` refused (it hard-codes ledger 107/0107). The release script now takes the backup itself.
- Capture and rollback reference (CloudShell, ephemeral): `/tmp/ogevia-h3-11211126/h3-20261121T114802Z`.
- TEST human checks (owner report, 2026-11-21): steps 1 to 5 all PASS on https://d2xumch5w0izfg.cloudfront.net:
  1. Administrator: create two offices, rename, duplicate name in a different case refused ("already exists"), retire without a reason refused, both offices show 0 clients. PASS
  2. Manager: no Offices link, Offices page refuses; Responsible office set under Details and kept after reload; test clients with visits assigned. PASS
  3. Retire North: shows Retired with its client count, no Rename/Retire; the North client shows "North (retired)"; North not offered to other clients. PASS
  4. Filters (Clients, Billing Review, Reports): South shows its client's records; North (retired) still shows historical visits; No office excludes both assigned clients; clearing Reports filters resets the dropdown. PASS
  5. Caregiver: no Offices link, no Office filter on the three pages, Offices page denies access. PASS
  Evidence is the owner's statement; no screenshots were attached. The sign-ins used were the owner's existing TEST accounts (the account listing was never sent).
- Production: NOT deployed. Needs its own owner GO; the production request-cleanup switch-on is a separate, still-unconfirmed step.

## Production release (prepared 2026-11-21; owner: "All steps go"; NOT yet run)
Production today (owner's read-only status output): 258 routes, request cleanup OFF (retire route 404), no office routes (404), web `26f58384`. `PRD_OFFICES_RELEASE.sh` (+ `infra/aws/scripts/production-offices-release.py`) does, in order and stopping on any failed check: logical backup of ogevia_prd to the private encrypted bucket; migration 0110 with its ledger row in one transaction (guards the exact 108-row ledger); Handler code update (the code running on TEST: source trees of apps/sv-api, packages and the lockfile equal TEST's release commit, and the TEST Handler's index.js hash equals the asset); nine routes added (three request cleanup, six offices) from the live template, with a smoke check and automatic route rollback; production web publish. Rollback: `rollback-api-web`, then `rollback-db`. Tests with stand-ins and a real Postgres exist for the helper and the SQL; the script itself has not run against AWS.

## PRODUCTION RELEASE RUN (owner, CloudShell, 2026-11-21 ~14:2x UTC) - DONE
`PRD_OFFICES_RELEASE.sh` at release commit `aeaed3045ea9e31feb15883774974b8be1897cd2` (CI green). Operator output: "PRODUCTION DEPLOYED: migration 0110 applied (109 verified ledger rows), Handler code 98f0b4df84e7c93fd54296548cf9fcc8b2a0eb4eb4bd8cadaa00f8ffed3fa534, nine routes live (request cleanup ON, offices), production web published at aeaed3045ea9e31feb15883774974b8be1897cd2; TEST unchanged". Release state database=1 api-code=1 api-routes=1 website-started=1. ADMIN HOST RESTORED.
Seen in the pasted output: step 4 (ledger 109 rows, VERIFY_0110 37 checks 0 failing), step 5 (code-only change set, deployed Handler = release code, nine routes still 404 and /v1/me 401 afterwards), step 6 (change set adds exactly nine routes), step 7 (web upload to the production bucket, production web origin https://d3l4psdkokkvnb.cloudfront.net). The step 6 smoke lines (nine routes 401) were not in the pasted part; the script stops and rolls the routes back by itself if they fail, and it reported success.
Rollback workspace: `/tmp/ogevia-production-release.kOp7NX`; private recovery: `s3://cdk-hnb659fds-assets-300094796789-us-west-2/ogevia-production-release/ogevia-production-release.kOp7NX/before-update.tgz`.
NOT yet verified by the owner in the app: Settings > Offices, retire a document type, the Active/History schedule, the error messages. Production requests cleared and retired on production are the owner's to test with synthetic data.
