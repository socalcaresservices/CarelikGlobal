# Release 0037 to 0038 runbook: overnight availability, print letterhead, environment marker

7 October 2026. **Prepared, not executed. Nothing in this document has been applied to any AWS resource.** Deploying is an owner-run action (typing DEPLOY in CloudShell, as for release 0036). This runbook says what changes, in what order, how to check it, and how to undo it.

## 0. What is ready and what is not

| Item | State |
| --- | --- |
| Migration 0037 overnight availability, with rollback | Written; passes 30 local PostgreSQL tests (local scratch database, synthetic data) |
| Migration 0038 print letterhead, with rollback | Written; passes 21 local database tests and 3 API-handler tests |
| API: one new route `POST /v1/branding/letterhead`; `GET /v1/branding` returns more fields | Written; route added to the API stack definition; handler tests pass |
| Web: caregiver availability editor, Branding settings (letterhead), environment banner, print headers | Written; unit tests pass; checked in Chromium with faked data |
| Deploy scripts that write `config.json` now include the environment label | Edited (`finish.sh`, `pilot-deploy.sh`, `deploy-test-slice.sh`); not run |
| **Gated release scripts for 0037 to 0038** | **Not created.** Release 0036's scripts are the template (`release-0036-bootstrap.sh`, `release-0036-deploy.sh`, `release-0036-rollback.sh`, `release-0036-verify.sh`, `release_0036_gate.py` and its self-test, `release_0036_live.py`, `release-0036-expected/`). They must be copied, the final migration set to 0038, the new-route count set (one new route over the deployed set), rehearsed on the local database and reviewed before use. Until then there is no gated way to deploy; this document is the checklist for those scripts. |
| `infra/aws/db/verification/01_schema_version.sql` | Already updated to "latest is 0038, 38 migrations". It will report a failure against the live database until 0037 and 0038 are applied, which is intended. |

Cost impact: none (no new AWS resource). Security impact: one new authenticated route, scoped to the current agency and the existing `organization.update` role; no new permission; no public route; no secret in `config.json`.

## 1. Order, and why

1. **`config.json` first** (the environment label). The current web build ignores an unknown key, so this is harmless on its own, and it means the new web never shows "Environment not verified" on TEST.
2. **Database** (0037, then 0038). Both are backward compatible with the currently deployed API: 0037 keeps every function signature; 0038 only adds columns and a function and makes `get_organization_branding` return extra columns (the deployed handler selects `*`, so it keeps working).
3. **API** (code package and the one new route). Needs 0038.
4. **Web** (new files, then `index.html`; `config.json` is excluded from the sync, as in 0036).
5. **Read-only live checks** (section 4).

Never as part of this release: Netlify, Supabase, DNS, Cognito, the other four stacks, RDS security-group rules, IAM policies, any modification of an applied migration (ledger checksums must match), deleting anything.

## 2. Before DEPLOY (read-only, can be run now)

- Local gate: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.
- Local database suites (disposable local PostgreSQL, never a remote one): `OGEVIA_TEST_DATABASE_URL=postgres://<local admin>@127.0.0.1:5432/postgres pnpm --filter @carelik/infra-aws test:db` and `pnpm --filter @carelik/sv-api test:db`.
- CDK: `cdk synth` and `cdk diff` for `Ogevia-prod-ServiceVerificationApi` must show exactly one new `AWS::ApiGatewayV2::Route` (`POST /v1/branding/letterhead`, JWT authorizer) and the Lambda code change; nothing replaced or deleted.
- Confirm the live schema is at 0036 (`select max(version) from ogevia_meta.schema_migrations`) and take the snapshot named in the deploy script (`ogevia-prod-postgres-pre-0038-<date>`).

## 3. Steps after the owner approves (owner-run, yellow actions)

**3.1 config.json (label).** Keep a copy first.
```
aws s3 cp "s3://$BUCKET/config.json" ./config.json.before
python3 - <<'PY'
import json
c = json.load(open("config.json.before"))
c["VITE_APP_ENV"] = "test"          # test | development | production, written explicitly
json.dump(c, open("config.json", "w"), indent=2)
PY
aws s3 cp config.json "s3://$BUCKET/config.json" --content-type application/json --cache-control no-store
```
Only the label is added. No credential or secret belongs in this file; the smoke check already fails if a key looks like a secret.

**3.2 Database.** Apply 0037 then 0038 through the migration runner on the agreed target (each file in one transaction; the runner refuses a numbering gap and any checksum drift).

**3.3 API.** Deploy the API stack with the new code and route.

**3.4 Web.** Upload the new assets and `index.html` (`config.json` stays as written in 3.1), then invalidate CloudFront.

## 4. Verification after DEPLOY (read-only)

Database:
```sql
select max(version), count(*) from ogevia_meta.schema_migrations;                         -- 0038, 38
select conname, pg_get_constraintdef(oid) from pg_constraint where conname = 'availability_time';  -- CHECK (start_local <> end_local)
select to_regprocedure('ogevia.availability_covers(uuid,uuid,text,timestamptz,timestamptz,date,date)');  -- not null
select to_regprocedure('ogevia_api.set_organization_letterhead(uuid,text,text,text,text,text,text,text,uuid)');  -- not null
select column_name from information_schema.columns where table_schema='ogevia' and table_name='organizations'
  and column_name in ('legal_name','address_street','address_city','address_state','address_zip','contact_phone','contact_email');  -- 7 rows
```
Behaviour (TEST agency, synthetic data only):
1. Caregiver account: Availability, choose Saturday, From 10:00 PM, To 6:00 AM, Save. Reload: the same values show. The page explains "ends the next morning".
2. Office account: create a synthetic care request Saturday 11:00 PM to Sunday 5:00 AM; that caregiver appears as available; a caregiver without that window does not. A normal daytime request still matches as before.
3. Administrator: Settings, Branding, Print letterhead, enter the agency's own details, Save. Open Client monthly calendar, choose a client, print preview: the agency name, address, phone and email appear on page one, and agency, report, client, month, the environment label and "Page N of M" appear on every page.
4. A manager account sees the Branding page refuse, and the letterhead route returns 403.
5. Every page of the TEST site shows "TEST — synthetic data only"; a build or config with no valid label shows "Environment not verified".
6. `GET /v1/me`, a visit start and end, and Home still work (nothing else changed).

## 5. Rollback (one layer at a time: web, API, then database only if really needed)

- **Web:** restore the previous web files and `index.html` from the pre-deploy capture; `config.json` can stay (the label is ignored by the old web). Optional: restore `config.json.before`.
- **API:** deploy the previous template and Lambda code. The old API never calls the new functions or columns, so they stay unused.
- **Database:** `0038` down, then `0037` down, in that order.
  - `0038` down **refuses while any agency has letterhead details stored** (it would lose them). Export them first (they are also in the audit trail), clear them in Settings, run again. It restores the 0020 four-column `get_organization_branding`.
  - `0037` down **refuses while any overnight window (end earlier than start) is stored**. Export or delete those windows first. It restores the 0011 constraint and the 0011 matcher exactly.
  - A refusal changes nothing.
- A full restore goes to a NEW instance from the pre-deploy snapshot, never in place.
- Rollback of the label: `config.json.before`.

## 6. Known limits to state to the owner
- With the old matcher restored (rollback), overnight requests match incorrectly again; daytime matching is unaffected.
- The availability editor still saves one time range for all selected days. It now warns when the saved schedule is more detailed than that (different times per day, or single dates), instead of replacing it silently.
- The printed running header and page numbers use CSS page margin boxes (Chromium browsers). Support elsewhere is not verified.
- Local database tests used a disposable PostgreSQL 16 on a local machine, not the AWS database. Nothing in this runbook has been verified against AWS.
