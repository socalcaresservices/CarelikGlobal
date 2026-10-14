#!/usr/bin/env bash
# Runs infra/aws/slice/pilot_regression.py in LOCAL mode against a throwaway database seeded exactly like the pilot
# (migrations, test-slice seed, SCS pilot seed), through apps/sv-api/test/local-invoke.ts. Use it to test the runner itself and
# to rehearse Phase C locally. Synthetic data only. Needs: PostgreSQL superuser on THIS computer, psql, node, python3, pnpm install.
#
#   HARNESS_PG=postgres://postgres:<pw>@127.0.0.1:5432 bash infra/aws/slice/pilot-regression-local.sh [runner options]
#
# Default report directory: ~/ogevia-regression-reports. Exit codes are the runner's (0 pass, 1 fail, 3 a case could not run).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PG="${HARNESS_PG:-postgres://postgres@127.0.0.1:5432}"
case "$PG" in *127.0.0.1*|*localhost*) ;; *) echo "HARNESS_PG must point at a database on this computer." >&2; exit 2;; esac
DB="${REGRESSION_DB:-ogevia_regression_local}"
# shellcheck source=pilot-e2e/subs.env
source "$REPO/infra/aws/slice/pilot-e2e/subs.env"
E2E_PG="$PG" E2E_DB="$DB" bash "$REPO/infra/aws/slice/pilot-e2e/setup-db.sh" >/dev/null
HOSTPART="${PG#*@}"
export OGEVIA_LOCAL_DB_URL="postgres://e2e_app_login:e2e-local-only@$HOSTPART/$DB"
export OGEVIA_LOCAL_ADMIN_URL="$PG/$DB"
export OGEVIA_LOCAL_POOL=us-west-2_849AYz5J7 OGEVIA_LOCAL_CLIENT=localregressionclient000000
export OGEVIA_LOCAL_EVIDENCE_DIR="${TMPDIR:-/tmp}/ogevia-regression-evidence-$DB"
mkdir -p "$OGEVIA_LOCAL_EVIDENCE_DIR"
TSX="$REPO/infra/aws/node_modules/.bin/tsx"
INV="cd $REPO/apps/sv-api && $TSX test/local-invoke.ts"
exec python3 "$REPO/infra/aws/slice/pilot_regression.py" --mode local --client-id "$OGEVIA_LOCAL_CLIENT" --pool "$OGEVIA_LOCAL_POOL" \
  --manager-sub "$PILOT_MG" --caregiver-a-sub "$PILOT_CA" --caregiver-b-sub "$PILOT_CB" --caregiver-a-code SCS-CG-A --caregiver-b-code SCS-CG-B \
  --other-manager-sub "$TEST_MG" --test-caregiver-sub "$TEST_CG" --test-manager-sub "$TEST_MG" \
  --local-invoker "$INV" --age-cmd "$INV age" "$@"
