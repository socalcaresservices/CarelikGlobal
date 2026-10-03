# SCS pilot browser acceptance (local, synthetic)

Runs the exact AWS-mode web build in mobile Chromium (390x844, touch) against
the real `sv-api` handler and a local PostgreSQL 18 with migrations 0001-0016,
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
