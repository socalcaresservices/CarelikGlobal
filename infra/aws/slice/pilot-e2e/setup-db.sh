#!/usr/bin/env bash
# Fresh local PG18 database with migrations 0001-0018, the app login, the
# test-slice seed (second tenant) and the SCS pilot seed. Synthetic only.
set -euo pipefail
R=/home/user/CarelikGlobal/infra/aws; DB=ogevia_pilot_e2e
ADMIN=postgres://ogevia_admin@127.0.0.1:5432
psql -X -q "$ADMIN/postgres" -c "drop database if exists $DB with (force)" -c "create database $DB"
psql -X -q "$ADMIN/postgres" -c "do \$\$ begin if not exists (select 1 from pg_roles where rolname='e2e_app_login') then create role e2e_app_login; end if; end \$\$" 2>/dev/null || true
(cd $R && OGEVIA_DATABASE_URL="$ADMIN/$DB" npx tsx db/scripts/migrate.ts | tail -1)
psql -X -q "$ADMIN/$DB" -v ON_ERROR_STOP=1 -v app_user=e2e_app_login -v app_password=e2e-local-only -f $R/db/deploy/01_app_login_role.sql >/dev/null
psql -X -q "$ADMIN/$DB" -v ON_ERROR_STOP=1 -v caregiver_sub=$TEST_CG -v manager_sub=$TEST_MG -f $R/db/deploy/02_seed_synthetic_test_slice.sql | tail -2
psql -X -q "$ADMIN/$DB" -v ON_ERROR_STOP=1 -v manager_sub=$PILOT_MG -v manager_name="Pilot Manager" \
  -v caregiver_a_sub=$PILOT_CA -v caregiver_a_code=SCS-CG-A -v caregiver_a_first=Pilot -v caregiver_a_last="Caregiver A" \
  -v caregiver_b_sub=$PILOT_CB -v caregiver_b_code=SCS-CG-B -v caregiver_b_first=Pilot -v caregiver_b_last="Caregiver B" \
  -f $R/db/deploy/04_seed_scs_pilot_synthetic.sql | tail -2
