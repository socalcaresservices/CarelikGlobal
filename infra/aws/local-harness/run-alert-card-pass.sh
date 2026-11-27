#!/bin/bash
# Resets the LOCAL harness (synthetic data), seeds the open-shift scenario, builds and serves the web app, and runs the alert-card browser checks: run-alert-card-pass.sh <output dir>
set -u
out=${1:?output dir}
here=$(cd "$(dirname "$0")" && pwd); cd "$here/.."
fuser -k 443/tcp 2>/dev/null; sleep 1
pnpm harness:setup >/tmp/ogevia-ac-setup.log 2>&1 || { echo "setup failed"; tail /tmp/ogevia-ac-setup.log; exit 2; }
pnpm exec tsx local-harness/seed-open-shift.ts >>/tmp/ogevia-ac-setup.log 2>&1 || { echo "seed failed"; tail -5 /tmp/ogevia-ac-setup.log; exit 2; }
pnpm harness:build >/tmp/ogevia-ac-build.log 2>&1 || { echo "build failed"; tail /tmp/ogevia-ac-build.log; exit 2; }
nohup pnpm harness:serve >/tmp/ogevia-ac-serve.log 2>&1 &
for _ in $(seq 1 40); do curl -sk -o /dev/null https://localhost/ && break; sleep 1; done
cd "$here" && node alert-card-checks.mjs "$out"
