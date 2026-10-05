# SCS pilot browser acceptance (local, synthetic)

Runs the exact AWS-mode web build in mobile Chromium (390x844, touch) against
the real `sv-api` handler and a local PostgreSQL 18 with migrations 0001-0018,
the test-slice seed and the SCS pilot seed. Synthetic data only; no AWS calls.

Stand-ins: Cognito login/token endpoints are answered by Playwright routes with
unsigned tokens (the API Gateway JWT authorizer is NOT exercised; the
handler's claims checks are), S3 evidence is a local file store, and "time
passing" is simulated by moving a caregiver's visits back with admin SQL.

```bash
docker run -d --name ogv-pg -e POSTGRES_USER=ogevia_admin -e POSTGRES_DB=postgres \
  -e POSTGRES_HOST_AUTH_METHOD=trust -p 5432:5432 postgres:18
export E2E_DIR=/tmp/ogevia-pilot-e2e && mkdir -p $E2E_DIR && cd $E2E_DIR && npm i playwright-core@1.56 tsx@4
cd <repo>/apps/web && VITE_APP_ENV=production VITE_AUTH_PROVIDER=cognito VITE_COGNITO_REGION=us-west-2 \
  VITE_COGNITO_USER_POOL_ID=us-west-2_PILOTE2E1 VITE_COGNITO_CLIENT_ID=pilote2eclient000000000000 \
  VITE_COGNITO_DOMAIN=https://pilot-e2e.auth.us-west-2.amazoncognito.com \
  VITE_COGNITO_REDIRECT_URI=http://127.0.0.1:4173/auth/callback VITE_COGNITO_LOGOUT_URI=http://127.0.0.1:4173/ \
  VITE_COGNITO_REFRESH_PERSISTENCE=session VITE_SV_API_BASE_URL=https://api.pilot-e2e.test \
  npx vite build --outDir $E2E_DIR/dist --emptyOutDir
npx vite preview --outDir $E2E_DIR/dist --host 127.0.0.1 --port 4173 --strictPort &
cd <repo>/infra/aws/slice/pilot-e2e && source subs.env && bash setup-db.sh
$E2E_DIR/node_modules/.bin/tsx pilot-e2e.ts
```

Re-run `setup-db.sh` before every run (it recreates `ogevia_pilot_e2e`).
Exit 0 = every check passed; results in `$E2E_DIR/e2e-results.json`,
screenshots in `$E2E_DIR/shots/`.

## Client and authorization administration (0022)

`clients-e2e.ts` uses the same setup, with database `ogevia_clients_e2e` migrated to 0022. It checks:
- manager: add a client, add an authorization, refused overlap, amendment with history, balances, status change;
- the Administrator's rate is hidden from the manager;
- caregiver: no access;
- audit and version rows in the database.

Result 2026-10-04: 28/28 PASS at 390 px.

## Care Team and services (0023)

`care-team-e2e.ts` uses the same setup, with database `ogevia_careteam_e2e` migrated to 0023. It checks:
- manager: add and rename a caregiver;
- inactive status: assignments end, the sign-in is suspended, and the caregiver loses access at their next request; reactivation restores the sign-in only;
- services: read-only for managers; the Administrator adds a service, an in-use deactivation is refused, and an unused service is deactivated;
- audit rows in the database.

Result 2026-10-04: 20/20 PASS at 390 px.

## Assignments (0024)

`assignments-e2e.ts` uses the same setup, with database `ogevia_assign_e2e` migrated to 0024. It checks:
- manager: add a client and authorization, assign a signed-in caregiver, who then sees the client on Verify visit;
- an uncovered assignment is flagged; a caregiver without a sign-in cannot be chosen;
- cancel an upcoming assignment and end a current one;
- audit and assignment rows in the database.

Result 2026-10-04: 19/19 PASS at 390 px.

## Invitations, planned assignments and schedule (0025, 0026)

`schedule-e2e.ts` uses the same setup, with database `ogevia_sched_e2e` migrated to 0026 and an in-memory identity service (no Cognito call). It checks:
- manager: plan an assignment for a caregiver without a sign-in ("no access yet"), invite them, see "Invited — has not signed in yet", resend; the identity service receives only the email; audit rows and API logs carry no email address;
- schedule: 3 h reserved with the hours left; more hours than authorized refused with the minutes left;
- caregiver: My shifts by client code only; "I can't make it" with a reason;
- manager: NEEDS COVERAGE count and reason, replacement, history; coverage events in the database;
- no horizontal scroll at 390 px on the caregiver page, Schedule and My shifts; no page errors.

Result 2026-10-04: 22/22 PASS at 390 px (after renaming the ambiguous "Start"/"End" fields to "Start time"/"End time").

## Outage continuity (0027–0028)

`continuity-e2e.ts` uses the same setup with database `ogevia_cont_e2e` (`E2E_DB=ogevia_cont_e2e bash setup-db.sh`; `E2E_PG` selects the server). It checks:
- the manager's outage-readiness warning on Home;
- the continuity pack download: file name, data-as-of time, every active client of the agency, none of the other agency's, no money, the audit row;
- the file opened offline at 390 px;
- an outage record entered (administrator review, 0 billable), reconciliation counts, and the duplicate number refused;
- a caregiver offered neither screen.

Result 2026-10-05: 23/23 PASS at 390 px.

## Main menu (navigation fix, 2026-10-05)

`nav-e2e.ts` uses the same setup and database as `continuity-e2e.ts`. On desktop (1280 px) and on a phone (390 px) it checks that exactly one menu item is current: it carries `aria-current="page"` and is the only one with the highlight (with the pointer moved off the menu). It covers:
- direct loads of Visit records, the exceptions view, Home and Schedule;
- a reload;
- a click to Verify visit, then Back and Forward;
- the caregiver menu.

Result 2026-10-05: 23/23 PASS.
