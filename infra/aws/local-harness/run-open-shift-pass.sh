#!/bin/bash
# Resets the LOCAL harness (synthetic data), seeds the open-shift scenario, serves it, and runs the browser checks: run-open-shift-pass.sh <output dir>
# Needs a local PostgreSQL superuser (HARNESS_ADMIN_URL) and playwright (see open-shift-checks.mjs). Local only.
set -u
out=${1:?output dir}
here=$(cd "$(dirname "$0")" && pwd); cd "$here/.."
fuser -k 443/tcp 2>/dev/null; sleep 1
pnpm harness:setup >/tmp/ogevia-os-setup.log 2>&1 || { echo "setup failed"; tail /tmp/ogevia-os-setup.log; exit 2; }
pnpm exec tsx local-harness/seed-open-shift.ts >>/tmp/ogevia-os-setup.log 2>&1 || { echo "seed failed"; tail -5 /tmp/ogevia-os-setup.log; exit 2; }
nohup pnpm harness:serve >/tmp/ogevia-os-serve.log 2>&1 &
for _ in $(seq 1 40); do curl -sk -o /dev/null https://localhost/ && break; sleep 1; done
cd "$here" && node open-shift-checks.mjs "$out"
